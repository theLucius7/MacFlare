import installedIcons from "../docs/public/app-icons/index.json" with { type: "json" };
import { findAppIcon } from "../docs/.vitepress/theme/app-icon-catalog.js";
import { safeAppleUrl } from "../shared/music-artwork.js";
import { TIMELINE_POLICY, replayWindow } from "../shared/timeline.js";

const LEGACY_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_BATCH_BYTES = 512 * 1024;
const BATCH_RETENTION_MS = 600_000;
const CHANGE_FIELDS = ["active_app", "running_apps", "battery", "system", "music"];
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

function timestampMs(value, strict = false) {
  if (typeof value !== "string"
    || !(strict ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u).test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  const canonical = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/u, (_, fraction) => `.${fraction.padEnd(3, "0")}Z`)
    : value.replace(/Z$/u, ".000Z");
  return new Date(parsed).toISOString() === canonical ? parsed : NaN;
}

function invalidPayload() { throw new ClientError(400, "invalid_payload"); }

function statusField(name, value) {
  if (name === "active_app") {
    if (!nullableText(value, 200)) invalidPayload();
    return value;
  }
  if (name === "running_apps") {
    if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length
      || !value.every((name) => name !== null && nullableText(name, 200))) invalidPayload();
    return [...value];
  }
  if (name === "battery") {
    if (!keysMatch(value, ["percent", "charging", "power_source"])
      || !nullableNumber(value.percent, 100)
      || !(value.charging === null || typeof value.charging === "boolean")
      || !["ac", "battery", "unknown"].includes(value.power_source)) invalidPayload();
    return { percent: value.percent, charging: value.charging, power_source: value.power_source };
  }
  if (name === "system") {
    if (!keysMatch(value, ["load_1m", "load_5m", "load_15m"])
      || !Object.values(value).every((load) => nullableNumber(load, 100_000))) invalidPayload();
    return { load_1m: value.load_1m, load_5m: value.load_5m, load_15m: value.load_15m };
  }
  if (name !== "music" || !keysMatch(value, ["state", "track", "artist"], ["artwork_url", "track_url"])
    || !["playing", "paused", "stopped", "unavailable"].includes(value.state)
    || !nullableText(value.track, 500) || !nullableText(value.artist, 500)) invalidPayload();
  const hasArtwork = Object.hasOwn(value, "artwork_url");
  const hasTrackUrl = Object.hasOwn(value, "track_url");
  if (hasArtwork !== hasTrackUrl || (hasArtwork
    && !(value.artwork_url === null && value.track_url === null)
    && !(typeof value.artwork_url === "string" && typeof value.track_url === "string"
      && nullableText(value.artwork_url, 2048) && nullableText(value.track_url, 2048)
      && safeAppleUrl(value.artwork_url, true) && safeAppleUrl(value.track_url, false)
      && ["playing", "paused"].includes(value.state) && value.track?.trim() && value.artist?.trim()))) invalidPayload();
  return {
    state: value.state, track: value.track, artist: value.artist,
    ...(hasArtwork ? { artwork_url: value.artwork_url, track_url: value.track_url } : {}),
  };
}

function validateStatus(data, now, historical = false) {
  if (!keysMatch(data, ["schema_version", "collected_at", "active_app", "battery", "system", "music"], ["running_apps"])
    || data.schema_version !== 1) invalidPayload();
  const collected = timestampMs(data.collected_at);
  if (!Number.isFinite(collected) || (!historical && Math.abs(now - collected) > MAX_CLOCK_SKEW_MS)) invalidPayload();
  // Construct only known protocol fields; unrelated local data is never reflected.
  const result = { schema_version: 1, collected_at: data.collected_at };
  for (const field of CHANGE_FIELDS) {
    if (Object.hasOwn(data, field)) result[field] = statusField(field, data[field]);
  }
  return result;
}

export function validateTimeline(data, now) {
  if (!keysMatch(data, ["schema_version", "session_id", "batch_seq", "generated_at", "window_start", "window_end", "baseline", "events", "gaps", "dropped_events"])
    || data.schema_version !== 2
    || typeof data.session_id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(data.session_id)
    || !Number.isSafeInteger(data.batch_seq) || data.batch_seq < 1
    || !Number.isSafeInteger(data.dropped_events) || data.dropped_events < 0
    || !Array.isArray(data.events) || data.events.length > 2048
    || !Array.isArray(data.gaps) || data.gaps.length > 128) invalidPayload();
  const generated = timestampMs(data.generated_at, true);
  const start = timestampMs(data.window_start, true);
  const end = timestampMs(data.window_end, true);
  if (![generated, start, end].every(Number.isFinite)
    || Math.abs(now - generated) > MAX_CLOCK_SKEW_MS
    || start > end || end - start > TIMELINE_POLICY.window_seconds * 1000
    || end > generated || generated - end > 30_000) invalidPayload();
  const baseline = validateStatus(data.baseline, now, true);
  if (baseline.collected_at !== data.window_start) invalidPayload();
  let sequence = 0;
  let previousAt = start;
  const events = data.events.map((event) => {
    if (!keysMatch(event, ["seq", "at", "changes"])
      || !Number.isSafeInteger(event.seq) || event.seq <= sequence
      || !keysMatch(event.changes, [], CHANGE_FIELDS)
      || Object.keys(event.changes).length === 0) invalidPayload();
    const at = timestampMs(event.at, true);
    if (!Number.isFinite(at) || at < previousAt || at > end) invalidPayload();
    sequence = event.seq;
    previousAt = at;
    const changes = {};
    for (const field of CHANGE_FIELDS) {
      if (Object.hasOwn(event.changes, field)) changes[field] = statusField(field, event.changes[field]);
    }
    return { seq: event.seq, at: event.at, changes };
  });
  let previousEnd = start;
  const gaps = data.gaps.map((gap) => {
    if (!keysMatch(gap, ["start_at", "end_at", "reason"])
      || !["sleep", "restart", "collection", "overflow", "clock"].includes(gap.reason)) invalidPayload();
    const gapStart = timestampMs(gap.start_at, true);
    const gapEnd = timestampMs(gap.end_at, true);
    if (!Number.isFinite(gapStart) || !Number.isFinite(gapEnd)
      || gapStart < previousEnd || gapEnd > end || gapStart >= gapEnd) invalidPayload();
    previousEnd = gapEnd;
    return { start_at: gap.start_at, end_at: gap.end_at, reason: gap.reason };
  });
  return {
    schema_version: 2, session_id: data.session_id, batch_seq: data.batch_seq,
    generated_at: data.generated_at, window_start: data.window_start, window_end: data.window_end,
    baseline, events, gaps, dropped_events: data.dropped_events,
  };
}

async function readJson(request, maximumBytes = MAX_BODY_BYTES) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ClientError(415, "unsupported_media_type");
  }
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) {
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
      if (total > maximumBytes) {
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

async function currentRecord(env, now, ttlSeconds, completedTime) {
  // KV cache hits still count as reads; every public data request uses one get.
  const raw = await env.STATUS_KV.get(STATUS_KEY, { type: "text", cacheTtl: 30 });
  const completedAt = completedTime();
  if (raw === null || raw.length > MAX_BATCH_BYTES + 512) return null;
  try {
    const record = JSON.parse(raw);
    if (!keysMatch(record, ["received_at", "data"], ["expires_at"])
      || !Number.isSafeInteger(record.received_at) || record.received_at <= 0
      || now < record.received_at || completedAt < record.received_at) return null;
    if (record.data?.schema_version === 2) {
      const data = validateTimeline(record.data, record.received_at);
      const expiresAt = Date.parse(data.window_end) + BATCH_RETENTION_MS;
      if (record.expires_at !== expiresAt || completedAt >= expiresAt) return null;
      return { mode: "window", receivedAt: record.received_at, expiresAt, data };
    }
    // Configuration changes must never revive a legacy snapshot's old deadline.
    const storedExpiresAt = Object.hasOwn(record, "expires_at")
      ? record.expires_at : record.received_at + LEGACY_TTL_SECONDS * 1000;
    const storedTtlMs = storedExpiresAt - record.received_at;
    if (!Number.isSafeInteger(storedExpiresAt)
      || storedTtlMs < LEGACY_TTL_SECONDS * 1000 || storedTtlMs > MAX_TTL_SECONDS * 1000
      || storedTtlMs % 1000 !== 0) return null;
    const expiresAt = Math.min(storedExpiresAt, record.received_at + ttlSeconds * 1000);
    if (completedAt >= expiresAt) return null;
    return {
      mode: "snapshot", receivedAt: record.received_at, expiresAt,
      data: validateStatus(record.data, record.received_at),
    };
  } catch {
    // Corrupt or expired data is never reflected into a public response.
    return null;
  }
}

function projectedStatus(record, now) {
  if (!record || now >= record.expiresAt) return { status: "offline" };
  if (record.mode === "snapshot") {
    return { status: "online", ...timestamps(record.receivedAt, record.expiresAt), ...record.data };
  }
  const delay = TIMELINE_POLICY.playback_delay_seconds;
  const replay = replayWindow(record.data, now - delay * 1000);
  const expiresAt = Date.parse(record.data.window_end) + delay * 1000;
  // A retained window is not evidence that observation continued beyond its end.
  if (replay.state !== "playing" || now >= expiresAt) return { status: "offline" };
  return {
    status: "online", ...timestamps(record.receivedAt, expiresAt), ...replay.snapshot,
    playback: { mode: "delayed", delay_seconds: delay, at: replay.at, window_end: record.data.window_end },
  };
}

function timelineStatus(record, now) {
  if (!record || now >= record.expiresAt) return { status: "offline" };
  if (record.mode === "snapshot") {
    return { ...projectedStatus(record, now), mode: "snapshot", server_time: new Date(now).toISOString() };
  }
  return {
    status: "online", mode: "window", server_time: new Date(now).toISOString(),
    ...timestamps(record.receivedAt, record.expiresAt), policy: TIMELINE_POLICY, window: record.data,
  };
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

function statusSlice(pathname, status) {
  const envelope = {
    status: "online",
    updated_at: status.updated_at,
    expires_at: status.expires_at,
    collected_at: status.collected_at,
    ...(status.playback ? { playback: status.playback } : {}),
  };
  if (pathname === "/api/music") {
    return { ...envelope, music: {
      ...status.music,
      artwork_url: status.music.artwork_url ?? null,
      track_url: status.music.track_url ?? null,
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
    const batch = pathname === "/api/batch";
    const timeline = pathname === "/api/timeline";
    const method = path === "/update" || batch ? "POST" : "GET";
    const slice = SLICE_ROUTES.has(pathname);
    if (!slice && !batch && !timeline && !["/update", "/now", "/badge.svg", "/health"].includes(path)) {
      return json({ error: "not_found" }, 404);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== method) return json({ error: "method_not_allowed" }, 405, { Allow: `${method}, OPTIONS` });
    if (path === "/health") return json({ ok: true, service: "macflare" });
    if (!env?.STATUS_KV || typeof env.STATUS_KV.get !== "function" || typeof env.STATUS_KV.put !== "function") {
      return json({ error: "service_unavailable" }, 503);
    }
    const ttlSeconds = statusTtlSeconds(env);
    if (path === "/update" || batch) {
      if (typeof env.INGEST_TOKEN !== "string" || env.INGEST_TOKEN.length < 32
        || env.INGEST_TOKEN.length > 1024 || /\s/u.test(env.INGEST_TOKEN)) {
        return json({ error: "service_unavailable" }, 503);
      }
      if (!(await authorized(request, env.INGEST_TOKEN))) {
        return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
      }
      const body = await readJson(request, batch ? MAX_BATCH_BYTES : MAX_BODY_BYTES);
      // Streaming a body takes time. Judge batch freshness after it is complete,
      // then use an absolute KV expiry so slow writes cannot renew retention.
      const receivedAt = batch ? now + Math.max(0, clock() - startedAt) : now;
      const data = batch ? validateTimeline(body, receivedAt) : validateStatus(body, receivedAt);
      const expiresAt = batch ? Date.parse(data.window_end) + BATCH_RETENTION_MS : receivedAt + ttlSeconds * 1000;
      const expiration = batch ? { expiration: Math.ceil(expiresAt / 1000) } : { expirationTtl: ttlSeconds };
      await env.STATUS_KV.put(STATUS_KEY, JSON.stringify({ received_at: receivedAt, expires_at: expiresAt, data }), expiration);
      return json({ ok: true, ...timestamps(receivedAt, expiresAt) });
    }
    const completedTime = () => now + Math.max(0, clock() - startedAt);
    const record = await currentRecord(env, now, ttlSeconds, completedTime);
    const completedAt = completedTime();
    if (timeline) return json(timelineStatus(record, completedAt));
    const status = projectedStatus(record, completedAt);
    if (slice) return json(status.status === "offline" ? status : statusSlice(pathname, status));
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
