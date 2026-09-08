const TTL_SECONDS = 60;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_MS = 120_000;
const STATUS_KEY = "now";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Cache-Control": "no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

class ClientError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysMatch(value, required, optional = []) {
  return isObject(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function nullableText(value, maximum) {
  return value === null || (typeof value === "string" && value.length > 0
    && [...value].length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value));
}

function nullableNumber(value, maximum) {
  return value === null || (typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= maximum);
}

function validTimestamp(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || Math.abs(now - parsed) > MAX_CLOCK_SKEW_MS) return false;
  const canonical = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/u, (_, fraction) => `.${fraction.padEnd(3, "0")}Z`)
    : value.replace(/Z$/u, ".000Z");
  return new Date(parsed).toISOString() === canonical;
}

function validateStatus(data, now) {
  if (!keysMatch(data, ["schema_version", "collected_at", "active_app", "battery", "system", "music"], ["running_apps"])
    || data.schema_version !== 1
    || !validTimestamp(data.collected_at, now)
    || !nullableText(data.active_app, 200)) {
    throw new ClientError(400, "invalid_payload");
  }

  if (Object.hasOwn(data, "running_apps") && (!Array.isArray(data.running_apps)
    || data.running_apps.length > 64
    || new Set(data.running_apps).size !== data.running_apps.length
    || !data.running_apps.every((name) => name !== null && nullableText(name, 200)))) {
    throw new ClientError(400, "invalid_payload");
  }

  const { battery, system, music } = data;
  if (!keysMatch(battery, ["percent", "charging", "power_source"])
    || !nullableNumber(battery.percent, 100)
    || !(battery.charging === null || typeof battery.charging === "boolean")
    || !["ac", "battery", "unknown"].includes(battery.power_source)
    || !keysMatch(system, ["load_1m", "load_5m", "load_15m"])
    || !Object.values(system).every((value) => nullableNumber(value, 100_000))
    || !keysMatch(music, ["state", "track", "artist"])
    || !["playing", "paused", "stopped", "unavailable"].includes(music.state)
    || !nullableText(music.track, 500)
    || !nullableText(music.artist, 500)) {
    throw new ClientError(400, "invalid_payload");
  }

  // Construct the stored record explicitly; only protocol fields become public.
  return {
    schema_version: 1,
    collected_at: data.collected_at,
    active_app: data.active_app,
    ...(Object.hasOwn(data, "running_apps") ? { running_apps: [...data.running_apps] } : {}),
    battery: { percent: battery.percent, charging: battery.charging, power_source: battery.power_source },
    system: { load_1m: system.load_1m, load_5m: system.load_5m, load_15m: system.load_15m },
    music: { state: music.state, track: music.track, artist: music.artist },
  };
}

async function readJson(request) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ClientError(415, "unsupported_media_type");
  }
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new ClientError(413, "payload_too_large");
  }
  if (request.headers.get("Content-Encoding") && request.headers.get("Content-Encoding") !== "identity") {
    throw new ClientError(415, "unsupported_media_type");
  }
  if (!request.body) throw new ClientError(400, "invalid_json");

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ClientError(413, "payload_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(400, "invalid_json");
  } finally {
    reader.releaseLock();
  }
}

async function authorized(request, token) {
  const header = request.headers.get("Authorization") ?? "";
  if (header.length > 1100 || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  // Compare fixed-size SHA-256 digests without an early string mismatch exit.
  const encoder = new TextEncoder();
  const [expectedDigest, actualDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const expected = new Uint8Array(expectedDigest);
  const actual = new Uint8Array(actualDigest);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ actual[index];
  return difference === 0;
}

function timestamps(receivedAt) {
  return {
    updated_at: new Date(receivedAt).toISOString(),
    expires_at: new Date(receivedAt + TTL_SECONDS * 1000).toISOString(),
  };
}

async function currentStatus(env, now) {
  // 30 seconds is KV's minimum edge cache TTL. HTTP caches remain disabled.
  const raw = await env.STATUS_KV.get(STATUS_KEY, { type: "text", cacheTtl: 30 });
  if (raw === null) return { status: "offline" };
  try {
    const record = JSON.parse(raw);
    if (!keysMatch(record, ["received_at", "data"])
      || !Number.isSafeInteger(record.received_at)
      || record.received_at <= 0
      || now < record.received_at
      || now - record.received_at >= TTL_SECONDS * 1000) {
      return { status: "offline" };
    }
    const data = validateStatus(record.data, record.received_at);
    return { status: "online", ...timestamps(record.received_at), ...data };
  } catch {
    // Corrupt or expired data is never reflected into a public response.
    return { status: "offline" };
  }
}

function escapeXml(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function badge(status) {
  let message = "offline";
  if (status.status === "online") {
    message = status.music.state === "playing" && status.music.track
      ? `♫ ${status.music.track}${status.music.artist ? ` — ${status.music.artist}` : ""}`
      : status.active_app || "online";
  }
  const characters = [...message];
  if (characters.length > 64) message = `${characters.slice(0, 61).join("")}…`;
  const text = escapeXml(message);
  const labelWidth = 76;
  const messageWidth = Math.max(60, [...message].reduce((sum, character) => sum + (/[^\x00-\x7f]/u.test(character) ? 14 : 8), 0) + 20);
  const width = labelWidth + messageWidth;
  const color = status.status === "online" ? "#17724b" : "#65717c";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24" role="img" aria-label="Macflare: ${text}"><title>Macflare: ${text}</title><clipPath id="r"><rect width="${width}" height="24" rx="5"/></clipPath><g clip-path="url(#r)"><rect width="${labelWidth}" height="24" fill="#25313b"/><rect x="${labelWidth}" width="${messageWidth}" height="24" fill="${color}"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${labelWidth / 2}" y="16">Macflare</text><text x="${labelWidth + messageWidth / 2}" y="16">${text}</text></g></svg>`;
  return new Response(svg, { headers: {
    ...CORS_HEADERS,
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'none'; sandbox",
  } });
}

export async function handleRequest(request, env, now = Date.now()) {
  try {
    const path = new URL(request.url).pathname;
    const method = path === "/update" ? "POST" : "GET";
    if (!["/update", "/now", "/badge.svg", "/health"].includes(path)) {
      return json({ error: "not_found" }, 404);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== method) return json({ error: "method_not_allowed" }, 405, { Allow: `${method}, OPTIONS` });
    if (path === "/health") return json({ ok: true, service: "macflare" });
    if (!env?.STATUS_KV || typeof env.STATUS_KV.get !== "function" || typeof env.STATUS_KV.put !== "function") {
      return json({ error: "service_unavailable" }, 503);
    }
    if (path === "/update") {
      if (typeof env.INGEST_TOKEN !== "string" || env.INGEST_TOKEN.length < 32
        || env.INGEST_TOKEN.length > 1024 || /\s/u.test(env.INGEST_TOKEN)) {
        return json({ error: "service_unavailable" }, 503);
      }
      if (!(await authorized(request, env.INGEST_TOKEN))) {
        return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
      }
      const data = validateStatus(await readJson(request), now);
      await env.STATUS_KV.put(STATUS_KEY, JSON.stringify({ received_at: now, data }), { expirationTtl: TTL_SECONDS });
      return json({ ok: true, ...timestamps(now) });
    }
    const status = await currentStatus(env, now);
    return path === "/badge.svg" ? badge(status) : json(status);
  } catch (error) {
    if (error instanceof ClientError) return json({ error: error.code }, error.status);
    // No request bodies, bearer secrets, or vendor error details enter logs/API.
    return json({ error: "service_unavailable" }, 503);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
