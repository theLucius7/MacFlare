import installedIcons from "../docs/public/app-icons/index.json" with { type: "json" };
import { findAppIcon } from "../docs/.vitepress/theme/app-icon-catalog.js";
import { lookupMusicArtwork } from "./music-artwork.js";

const LEGACY_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_MS = 120_000;
const STATUS_KEY = "now";
const SLICE_ROUTES = new Set(["/api/music", "/api/apps/active", "/api/apps/running", "/api/device"]);
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
const ICON_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "If-None-Match, If-Modified-Since",
  "Access-Control-Expose-Headers": "ETag, Last-Modified",
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

function statusTtlSeconds(env) {
  const configured = env.STATUS_TTL_SECONDS;
  if (configured === undefined) return LEGACY_TTL_SECONDS;
  if ((typeof configured !== "number" && typeof configured !== "string")
    || (typeof configured === "string" && !/^[1-9]\d*$/u.test(configured))) {
    throw new Error("Invalid status TTL configuration.");
  }
  const seconds = Number(configured);
  if (!Number.isInteger(seconds) || seconds < LEGACY_TTL_SECONDS || seconds > MAX_TTL_SECONDS) {
    throw new Error("Invalid status TTL configuration.");
  }
  return seconds;
}

function timestamps(receivedAt, expiresAt) {
  return {
    updated_at: new Date(receivedAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
}

async function currentStatus(env, now, ttlSeconds) {
  // 30 seconds is KV's minimum edge cache TTL. HTTP caches remain disabled.
  const raw = await env.STATUS_KV.get(STATUS_KEY, { type: "text", cacheTtl: 30 });
  if (raw === null) return { status: "offline" };
  try {
    const record = JSON.parse(raw);
    if (!keysMatch(record, ["received_at", "data"], ["expires_at"])
      || !Number.isSafeInteger(record.received_at)
      || record.received_at <= 0
      || now < record.received_at) {
      return { status: "offline" };
    }
    // Legacy records were written with a fixed 60-second retention window.
    // A later deployment must never extend the original stored deadline.
    const storedExpiresAt = Object.hasOwn(record, "expires_at")
      ? record.expires_at : record.received_at + LEGACY_TTL_SECONDS * 1000;
    const storedTtlMs = storedExpiresAt - record.received_at;
    if (!Number.isSafeInteger(storedExpiresAt)
      || storedTtlMs < LEGACY_TTL_SECONDS * 1000
      || storedTtlMs > MAX_TTL_SECONDS * 1000
      || storedTtlMs % 1000 !== 0) {
      return { status: "offline" };
    }
    const expiresAt = Math.min(storedExpiresAt, record.received_at + ttlSeconds * 1000);
    if (now >= expiresAt) return { status: "offline" };
    const data = validateStatus(record.data, record.received_at);
    return { status: "online", ...timestamps(record.received_at, expiresAt), ...data };
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

function iconError(request, status, code, headers = {}) {
  const response = json({ error: code }, status, { ...ICON_HEADERS, ...headers });
  return request.method === "HEAD" ? new Response(null, response) : response;
}

async function iconAsset(request, env, pathname) {
  const catalog = pathname === "/api/icons";
  const match = /^\/api\/icons\/([a-z0-9]+(?:-[a-z0-9]+)*)\.png$/u.exec(pathname);
  if (!catalog && !match) return iconError(request, 404, "not_found");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: ICON_HEADERS });
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    return iconError(request, 405, "method_not_allowed", { Allow: "GET, HEAD, OPTIONS" });
  }
  if (typeof env?.ASSETS?.fetch !== "function") {
    return iconError(request, 503, "service_unavailable");
  }

  try {
    const url = new URL(request.url);
    url.pathname = catalog ? "/app-icons/index.json" : `/app-icons/${match[1]}.png`;
    url.search = "";
    const forwarded = new Headers();
    // Static requests never carry a visitor's credentials or arbitrary headers.
    for (const name of ["If-None-Match", "If-Modified-Since"]) {
      if (request.headers.has(name)) forwarded.set(name, request.headers.get(name));
    }
    const asset = await env.ASSETS.fetch(new Request(url, {
      method: request.method, headers: forwarded, redirect: "manual",
    }));
    if (![200, 304].includes(asset.status)) {
      await asset.body?.cancel();
      return asset.status === 404
        ? iconError(request, 404, "not_found")
        : iconError(request, 503, "service_unavailable");
    }
    const contentType = catalog ? "application/json" : "image/png";
    if (asset.status === 200 && asset.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== contentType) {
      await asset.body?.cancel();
      return iconError(request, 404, "not_found");
    }
    const headers = new Headers({
      ...ICON_HEADERS,
      "Cache-Control": "public, max-age=3600",
      "Content-Type": catalog ? "application/json; charset=utf-8" : "image/png",
    });
    for (const name of ["ETag", "Last-Modified", "Content-Length"]) {
      if (asset.headers.has(name) && (name !== "Content-Length" || asset.status === 200)) {
        headers.set(name, asset.headers.get(name));
      }
    }
    if (request.method === "HEAD") await asset.body?.cancel();
    return new Response(request.method === "HEAD" ? null : asset.body, { status: asset.status, headers });
  } catch {
    return iconError(request, 503, "service_unavailable");
  }
}

function appWithIcon(name) {
  if (name === null) return null;
  const icon = findAppIcon(name, installedIcons);
  return {
    name,
    icon_url: icon?.source === "installed-app" ? icon.assetUrl : null,
    icon_api_url: icon?.source === "installed-app" ? icon.imageUrl : null,
  };
}

async function statusSlice(pathname, status, origin, lookupArtwork) {
  const envelope = {
    status: "online",
    updated_at: status.updated_at,
    expires_at: status.expires_at,
    collected_at: status.collected_at,
  };
  if (pathname === "/api/music") {
    let artwork = null;
    if (["playing", "paused"].includes(status.music.state)
      && status.music.track?.trim() && status.music.artist?.trim()) {
      try {
        artwork = await lookupArtwork(status.music, { origin });
      } catch {
        // Artwork availability never removes the current song's metadata.
      }
    }
    return { ...envelope, music: {
      ...status.music,
      artwork_url: artwork?.artworkUrl ?? null,
      track_url: artwork?.trackUrl ?? null,
    } };
  }
  if (pathname === "/api/apps/active") {
    return { ...envelope, active_app: appWithIcon(status.active_app) };
  }
  if (pathname === "/api/apps/running") {
    return { ...envelope, running_apps: status.running_apps?.map(appWithIcon) ?? null };
  }
  return { ...envelope, device: { battery: status.battery, system: status.system } };
}

export async function handleRequest(request, env, now = Date.now(), dependencies = {}) {
  try {
    const clock = dependencies.now ?? Date.now;
    const startedAt = clock();
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/api/icons" || pathname.startsWith("/api/icons/")) {
      return await iconAsset(request, env, pathname);
    }
    // /api/* is canonical. Legacy paths share the handler without redirects,
    // so installed agents can keep posting their authenticated request bodies.
    const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
    const method = path === "/update" ? "POST" : "GET";
    const slice = SLICE_ROUTES.has(pathname);
    if (!slice && !["/update", "/now", "/badge.svg", "/health"].includes(path)) {
      return json({ error: "not_found" }, 404);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== method) return json({ error: "method_not_allowed" }, 405, { Allow: `${method}, OPTIONS` });
    if (path === "/health") return json({ ok: true, service: "macflare" });
    if (!env?.STATUS_KV || typeof env.STATUS_KV.get !== "function" || typeof env.STATUS_KV.put !== "function") {
      return json({ error: "service_unavailable" }, 503);
    }
    const ttlSeconds = statusTtlSeconds(env);
    if (path === "/update") {
      if (typeof env.INGEST_TOKEN !== "string" || env.INGEST_TOKEN.length < 32
        || env.INGEST_TOKEN.length > 1024 || /\s/u.test(env.INGEST_TOKEN)) {
        return json({ error: "service_unavailable" }, 503);
      }
      if (!(await authorized(request, env.INGEST_TOKEN))) {
        return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
      }
      const data = validateStatus(await readJson(request), now);
      const expiresAt = now + ttlSeconds * 1000;
      await env.STATUS_KV.put(STATUS_KEY, JSON.stringify({ received_at: now, expires_at: expiresAt, data }), { expirationTtl: ttlSeconds });
      return json({ ok: true, ...timestamps(now, expiresAt) });
    }
    const status = await currentStatus(env, now, ttlSeconds);
    if (slice) {
      if (status.status === "offline") return json(status);
      const result = await statusSlice(pathname, status, url.origin, dependencies.lookupArtwork ?? lookupMusicArtwork);
      // Keep the injected request timestamp while accounting for time spent in
      // KV and artwork lookup; slow enrichment cannot expose expired status.
      const completedAt = now + Math.max(0, clock() - startedAt);
      return json(completedAt >= Date.parse(status.expires_at) ? { status: "offline" } : result);
    }
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
