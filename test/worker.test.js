import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleRequest } from "../worker/index.js";

const NOW = Date.parse("2026-09-08T10:00:00.000Z");
const TOKEN = "test-secret-0123456789-abcdefghijklmnop";
const ARTWORK = {
  artwork_url: "https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg",
  track_url: "https://music.apple.com/us/album/example/123?i=456",
};

function sample() {
  return {
    schema_version: 1,
    collected_at: new Date(NOW).toISOString(),
    active_app: "Visual Studio Code",
    running_apps: ["Finder", "Visual Studio Code"],
    battery: { percent: 80, charging: true, power_source: "ac" },
    system: { load_1m: 1.2, load_5m: 0.9, load_15m: 0.7 },
    music: { state: "playing", track: "A song", artist: "An artist" },
  };
}

function setup() {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    env: {
      INGEST_TOKEN: TOKEN,
      STATUS_KV: {
        async get(key, options) { calls.push({ method: "get", key, options }); return values.get(key) ?? null; },
        async put(key, value, options) { calls.push({ method: "put", key, options }); values.set(key, value); },
      },
    },
  };
}

function request(path = "/update", payload = sample(), options = {}) {
  return new Request(`https://example.test${path}`, ["/update", "/api/update", "/api/batch"].includes(path) ? {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json", ...options.headers },
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== "headers")),
  } : options);
}

test("ingress stores only one latest record with exact TTL and server timestamps", async () => {
  const { env, calls, values } = setup();
  const first = sample();
  first.collected_at = new Date(NOW - 30_000).toISOString();
  const response = await handleRequest(request("/update", first), env, NOW);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, updated_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 60_000).toISOString() });
  assert.deepEqual(calls[0], { method: "put", key: "now", options: { expirationTtl: 60 } });
  assert.deepEqual(JSON.parse(values.get("now")), { received_at: NOW, expires_at: NOW + 60_000, data: first });
  await handleRequest(request("/update", { ...sample(), active_app: "Terminal" }), env, NOW + 10_000);
  assert.equal(values.size, 1);
  assert.equal(JSON.parse(values.get("now")).data.active_app, "Terminal");
});

test("public status is available without bearer token and cannot be cached", async () => {
  const { env } = setup();
  await handleRequest(request(), env, NOW);
  const response = await handleRequest(request("/now"), env, NOW + 59_999);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "online", updated_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 60_000).toISOString(), ...sample(),
  });
  for (const name of ["cache-control", "cdn-cache-control", "cloudflare-cdn-cache-control"]) {
    assert.match(response.headers.get(name), /no-store/u);
  }
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("missing and >=60-second-old cached KV values produce only offline", async () => {
  const { env, calls } = setup();
  assert.deepEqual(await (await handleRequest(request("/now"), env, NOW)).json(), { status: "offline" });
  await handleRequest(request(), env, NOW);
  for (const age of [60_000, 60_001, 300_000, -1]) {
    assert.deepEqual(await (await handleRequest(request("/now"), env, NOW + age)).json(), { status: "offline" });
  }
  assert.deepEqual(calls[0].options, { type: "text", cacheTtl: 30 });
});

test("configured TTL accepts decimal strings and integer numbers, preserving protocol fields", async () => {
  for (const configured of [60, "60", 180, "180", 3600, "3600"]) {
    const { env, calls, values } = setup();
    env.STATUS_TTL_SECONDS = configured;
    const ttl = Number(configured);
    const response = await handleRequest(request(), env, NOW);
    assert.equal(response.status, 200, String(configured));
    assert.deepEqual(await response.json(), {
      ok: true, updated_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + ttl * 1000).toISOString(),
    });
    assert.deepEqual(calls[0], { method: "put", key: "now", options: { expirationTtl: ttl } });
    assert.deepEqual(JSON.parse(values.get("now")), { received_at: NOW, expires_at: NOW + ttl * 1000, data: sample() });
    const online = await (await handleRequest(request("/now"), env, NOW + ttl * 1000 - 1)).json();
    assert.deepEqual(online, {
      status: "online", updated_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + ttl * 1000).toISOString(), ...sample(),
    });
    const badge = await (await handleRequest(request("/badge.svg"), env, NOW + ttl * 1000 - 1)).text();
    assert.match(badge, /A song/u);
    for (const age of [ttl * 1000, ttl * 1000 + 1]) {
      assert.deepEqual(await (await handleRequest(request("/now"), env, NOW + age)).json(), { status: "offline" });
      const offlineBadge = await (await handleRequest(request("/badge.svg"), env, NOW + age)).text();
      assert.match(offlineBadge, /offline/u);
      assert.doesNotMatch(offlineBadge, /A song/u);
    }
  }
});

test("invalid TTL configuration fails closed before any KV operation", async () => {
  for (const configured of [null, true, false, 0, 59, 3601, 60.5, NaN, Infinity, "", "060", " 180", "180 ", "180.0", "1.8e2", "+180", "-60", "60seconds", {}, []]) {
    const { env, calls } = setup();
    env.STATUS_TTL_SECONDS = configured;
    for (const path of ["/update", "/now", "/badge.svg"]) {
      const response = await handleRequest(request(path), env, NOW);
      assert.equal(response.status, 503, `${String(configured)} ${path}`);
      assert.deepEqual(await response.json(), { error: "service_unavailable" });
    }
    assert.equal(calls.length, 0);
  }
});

test("legacy records retain their original 60-second deadline under longer deployment TTL", async () => {
  const { env, values } = setup();
  env.STATUS_TTL_SECONDS = "180";
  values.set("now", JSON.stringify({ received_at: NOW, data: sample() }));
  const online = await (await handleRequest(request("/now"), env, NOW + 59_999)).json();
  assert.equal(online.status, "online");
  assert.equal(online.expires_at, new Date(NOW + 60_000).toISOString());
  for (const age of [60_000, 90_000, 180_000]) {
    assert.deepEqual(await (await handleRequest(request("/now"), env, NOW + age)).json(), { status: "offline" });
  }
});

test("extending configured TTL cannot extend or revive a record past its original expiry", async () => {
  const { env } = setup();
  env.STATUS_TTL_SECONDS = "60";
  await handleRequest(request(), env, NOW);
  env.STATUS_TTL_SECONDS = "180";
  const online = await (await handleRequest(request("/now"), env, NOW + 59_999)).json();
  assert.equal(online.expires_at, new Date(NOW + 60_000).toISOString());
  for (const age of [60_000, 120_000]) {
    assert.deepEqual(await (await handleRequest(request("/now"), env, NOW + age)).json(), { status: "offline" });
  }
});

test("shorter configured TTL caps existing records and their advertised deadline", async () => {
  const { env } = setup();
  env.STATUS_TTL_SECONDS = "180";
  await handleRequest(request(), env, NOW);
  env.STATUS_TTL_SECONDS = "60";
  const online = await (await handleRequest(request("/now"), env, NOW + 59_999)).json();
  assert.equal(online.status, "online");
  assert.equal(online.expires_at, new Date(NOW + 60_000).toISOString());
  assert.deepEqual(await (await handleRequest(request("/now"), env, NOW + 60_000)).json(), { status: "offline" });
  const offlineBadge = await (await handleRequest(request("/badge.svg"), env, NOW + 60_000)).text();
  assert.match(offlineBadge, /offline/u);
  assert.doesNotMatch(offlineBadge, /A song/u);
});

test("malformed stored deadlines never become public", async () => {
  const { env, values } = setup();
  env.STATUS_TTL_SECONDS = "180";
  for (const expiresAt of [null, "2026-09-08T10:03:00Z", NOW, NOW - 1, NOW + 59_000, NOW + 60_001, NOW + 3_601_000]) {
    values.set("now", JSON.stringify({ received_at: NOW, expires_at: expiresAt, data: sample() }));
    assert.deepEqual(await (await handleRequest(request("/now"), env, NOW)).json(), { status: "offline" });
  }
});

test("bearer authentication fails closed without touching KV or parsing invalid JSON", async () => {
  const { env, calls } = setup();
  for (const header of ["", "Bearer wrong", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${"x".repeat(1100)}`]) {
    const response = await handleRequest(request("/update", sample(), { body: "not json", headers: { Authorization: header } }), env, NOW);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
  assert.equal(calls.length, 0);
});

test("missing/short/whitespace tokens and missing binding return generic 503", async () => {
  const { env } = setup();
  for (const token of [undefined, "short", `${TOKEN} `, "x".repeat(1025)]) {
    assert.equal((await handleRequest(request(), { ...env, INGEST_TOKEN: token }, NOW)).status, 503);
  }
  assert.equal((await handleRequest(request("/now"), {}, NOW)).status, 503);
});

test("schema rejects unknown top-level and nested fields, bad types, ranges, and timestamps", async () => {
  const cases = [
    (d) => { d.secret = "must not leak"; },
    (d) => { d.ttl_seconds = 3600; },
    (d) => { d.expires_at = new Date(NOW + 3_600_000).toISOString(); },
    (d) => { d.battery.serial_number = "private"; },
    (d) => { d.system.command_line = "private"; },
    (d) => { d.music.album = "unsupported"; },
    (d) => { delete d.active_app; },
    (d) => { d.schema_version = 2; },
    (d) => { d.active_app = 1; },
    (d) => { d.active_app = "x".repeat(201); },
    (d) => { d.active_app = "private\nwindow"; },
    (d) => { d.running_apps = ["Finder", "Finder"]; },
    (d) => { d.running_apps = [null]; },
    (d) => { d.running_apps = Array.from({ length: 65 }, (_, i) => `App ${i}`); },
    (d) => { d.battery.percent = 101; },
    (d) => { d.battery.percent = -1; },
    (d) => { d.battery.percent = "80"; },
    (d) => { d.battery.charging = "yes"; },
    (d) => { d.battery.power_source = "solar"; },
    (d) => { d.system.load_1m = -0.1; },
    (d) => { d.system.load_5m = 100_001; },
    (d) => { d.music.state = "unknown"; },
    (d) => { d.music.track = "x".repeat(501); },
    (d) => { d.collected_at = "invalid"; },
    (d) => { d.collected_at = new Date(NOW - 120_001).toISOString(); },
    (d) => { d.collected_at = new Date(NOW + 120_001).toISOString(); },
  ];
  const { env, calls } = setup();
  for (const mutate of cases) {
    const data = sample();
    mutate(data);
    const response = await handleRequest(request("/update", data), env, NOW);
    assert.equal(response.status, 400, mutate.toString());
    assert.deepEqual(await response.json(), { error: "invalid_payload" });
  }
  for (const payload of [null, [], {}, "text"]) {
    assert.equal((await handleRequest(request("/update", payload), env, NOW)).status, 400);
  }
  // JSON permits this numeric syntax, but JS parses it as Infinity.
  const overflow = JSON.stringify(sample()).replace('"percent":80', '"percent":1e999');
  assert.equal((await handleRequest(request("/update", sample(), { body: overflow }), env, NOW)).status, 400);
  assert.equal(calls.length, 0);
});

test("privacy-disabled fields and non-Latin Unicode are accepted", async () => {
  const { env } = setup();
  const data = sample();
  data.active_app = null;
  delete data.running_apps;
  data.battery = { percent: null, charging: null, power_source: "unknown" };
  data.system = { load_1m: null, load_5m: null, load_15m: null };
  data.music = { state: "unavailable", track: null, artist: null };
  assert.equal((await handleRequest(request("/update", data), env, NOW)).status, 200);
  data.active_app = "🎵".repeat(200);
  data.music = { state: "playing", track: "夜曲", artist: "周杰伦" };
  assert.equal((await handleRequest(request("/update", data), env, NOW)).status, 200);
});

test("timestamps accept UTC second/fraction precision and reject impossible calendar dates", async () => {
  const { env } = setup();
  for (const stamp of ["2026-09-08T10:00:00Z", "2026-09-08T10:00:00.0Z", "2026-09-08T10:00:00.00Z"]) {
    assert.equal((await handleRequest(request("/update", { ...sample(), collected_at: stamp }), env, NOW)).status, 200);
  }
  const rollover = Date.parse("2026-10-01T10:00:00Z");
  assert.equal((await handleRequest(request("/update", { ...sample(), collected_at: "2026-09-31T10:00:00Z" }), env, rollover)).status, 400);
});

test("Cloudflare entrypoint treats third argument as ExecutionContext, not a timestamp", async () => {
  const { env, values } = setup();
  const collected = new Date().toISOString();
  const response = await worker.fetch(request("/update", { ...sample(), collected_at: collected }), env, {
    waitUntil() {}, passThroughOnException() {},
  });
  assert.equal(response.status, 200);
  assert.equal(typeof JSON.parse(values.get("now")).received_at, "number");
  const status = await worker.fetch(request("/now"), env, {});
  assert.equal((await status.json()).status, "online");
});

test("invalid JSON, UTF-8, media type and oversized declared body are rejected", async () => {
  const { env, calls } = setup();
  for (const body of ["", "{", new Uint8Array([0xc3, 0x28])]) {
    assert.equal((await handleRequest(request("/update", sample(), { body }), env, NOW)).status, 400);
  }
  assert.equal((await handleRequest(request("/update", sample(), { headers: { "Content-Type": "text/plain" } }), env, NOW)).status, 415);
  assert.equal((await handleRequest(request("/update", sample(), { headers: { "Content-Encoding": "gzip" } }), env, NOW)).status, 415);
  assert.equal((await handleRequest(request("/update", sample(), { headers: { "Content-Length": "16385" } }), env, NOW)).status, 413);
  assert.equal(calls.length, 0);
});

test("streamed size limit applies without Content-Length and cancels input", async () => {
  const { env, calls } = setup();
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8193)); },
    cancel() { cancelled = true; },
  });
  const response = await handleRequest(request("/update", sample(), { body, duplex: "half" }), env, NOW);
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
});

test("storage failure is 503 with no private error details; corrupt records are offline", async () => {
  const { env, values } = setup();
  for (const raw of ["not json", "null", JSON.stringify({ received_at: NOW, data: { secret: "private" } })]) {
    values.set("now", raw);
    assert.deepEqual(await (await handleRequest(request("/now"), env, NOW)).json(), { status: "offline" });
  }
  env.STATUS_KV.put = env.STATUS_KV.get = async () => { throw new Error(`private vendor error ${TOKEN}`); };
  for (const path of ["/now", "/update", "/badge.svg"]) {
    const response = await handleRequest(request(path), env, NOW);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }
});

test("SVG escapes supplied text in XML and attributes, and offline badge has no previous data", async () => {
  const { env } = setup();
  const data = sample();
  data.music.track = '<script>&"\'';
  data.music.artist = null;
  await handleRequest(request("/update", data), env, NOW);
  const response = await handleRequest(request("/badge.svg"), env, NOW);
  const svg = await response.text();
  assert.match(response.headers.get("content-type"), /^image\/svg\+xml/u);
  assert.match(response.headers.get("content-security-policy"), /sandbox/u);
  assert.match(svg, /&lt;script&gt;&amp;&quot;&apos;/u);
  assert.doesNotMatch(svg, /<script>/u);
  const offline = await (await handleRequest(request("/badge.svg"), env, NOW + 60_000)).text();
  assert.match(offline, /offline/u);
  assert.doesNotMatch(offline, /script/u);
});

test("health, OPTIONS, methods and unknown routes behave without reading status", async () => {
  const { env, calls } = setup();
  assert.deepEqual(await (await worker.fetch(request("/health"), {})).json(), { ok: true, service: "macflare" });
  for (const path of ["/now", "/update", "/badge.svg", "/health"]) {
    const response = await handleRequest(request(path, sample(), { method: "OPTIONS", body: undefined }), env, NOW);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  }
  assert.equal((await handleRequest(request("/unknown"), env, NOW)).status, 404);
  const response = await handleRequest(request("/now", sample(), { method: "POST" }), env, NOW);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, OPTIONS");
  assert.equal((await handleRequest(request("/update", sample(), { method: "GET", body: undefined }), env, NOW)).status, 405);
  assert.equal(calls.length, 0);
});

test("canonical API routes and legacy aliases return identical bodies and headers without redirects", async () => {
  const { env, values } = setup();
  env.STATUS_TTL_SECONDS = "180";
  const canonicalWrite = await handleRequest(request("/api/update"), env, NOW);
  const legacyWrite = await handleRequest(request("/update"), env, NOW);
  assert.equal(canonicalWrite.status, 200);
  assert.equal(legacyWrite.status, 200);
  assert.deepEqual([...canonicalWrite.headers], [...legacyWrite.headers]);
  assert.equal(canonicalWrite.headers.get("location"), null);
  assert.equal(await canonicalWrite.text(), await legacyWrite.text());
  assert.equal(values.size, 1);

  for (const path of ["/now", "/badge.svg", "/health"]) {
    for (const age of [0, 180_000]) {
      const canonical = await handleRequest(request(`/api${path}`), env, NOW + age);
      const legacy = await handleRequest(request(path), env, NOW + age);
      assert.equal(canonical.status, 200, path);
      assert.equal(legacy.status, 200, path);
      assert.deepEqual([...canonical.headers], [...legacy.headers]);
      assert.equal(canonical.headers.get("location"), null);
      assert.equal(await canonical.text(), await legacy.text());
    }
  }
});

test("canonical ingress rejects missing and invalid authorization before KV access", async () => {
  const { env, calls } = setup();
  for (const authorization of ["", "Bearer wrong"]) {
    const response = await handleRequest(request("/api/update", sample(), {
      headers: { Authorization: authorization },
    }), env, NOW);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
  assert.equal(calls.length, 0);
});

test("canonical and legacy OPTIONS and method restrictions match", async () => {
  const { env, calls } = setup();
  for (const prefix of ["", "/api"]) {
    for (const route of ["/now", "/update", "/badge.svg", "/health"]) {
      const path = `${prefix}${route}`;
      const preflight = await handleRequest(request(path, sample(), { method: "OPTIONS", body: undefined }), env, NOW);
      assert.equal(preflight.status, 204, path);
      assert.equal(await preflight.text(), "");
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
      const wrongMethod = route === "/update" ? "GET" : "POST";
      const response = await handleRequest(request(path, sample(), { method: wrongMethod, body: undefined }), env, NOW);
      assert.equal(response.status, 405, path);
      assert.equal(response.headers.get("allow"), `${route === "/update" ? "POST" : "GET"}, OPTIONS`);
      assert.deepEqual(await response.json(), { error: "method_not_allowed" });
    }
  }
  assert.equal(calls.length, 0);
});

test("unknown API paths always return JSON 404, including preflight", async () => {
  const { env, calls } = setup();
  for (const path of ["/api", "/api/", "/api/unknown", "/api/now/", "/api/api/now", "/api//now"]) {
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await handleRequest(request(path, sample(), { method }), env, NOW);
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.match(response.headers.get("content-type"), /^application\/json/u);
      assert.equal(response.headers.get("location"), null);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
  }
  assert.equal(calls.length, 0);
});

function iconSetup(respond) {
  const calls = [];
  let stateReads = 0;
  const env = { ASSETS: { async fetch(assetRequest) {
    calls.push(assetRequest);
    return respond(assetRequest);
  } } };
  for (const name of ["STATUS_KV", "INGEST_TOKEN", "STATUS_TTL_SECONDS"]) {
    Object.defineProperty(env, name, { get() {
      stateReads += 1;
      throw new Error("Icon routes must not access device configuration.");
    } });
  }
  return { env, calls, stateReads: () => stateReads };
}

test("icon catalog and PNG API proxy only fixed same-origin assets without device state or credentials", async () => {
  const catalog = JSON.stringify({ version: 1, icons: [{
    id: "example-app", app: "Example App", aliases: [], imageUrl: "/api/icons/example-app.png",
    source: "installed-app", credit: "Example creator", sourceUrl: null,
  }] });
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const [path, assetPath, body, type] of [
    ["/api/icons", "/app-icons/index.json", catalog, "application/json"],
    ["/api/icons/example-app.png", "/app-icons/example-app.png", png, "image/png"],
  ]) {
    const { env, calls, stateReads } = iconSetup(() => new Response(body, { headers: {
      "Content-Type": type, ETag: '"content-hash"', "Last-Modified": "Tue, 08 Sep 2026 10:00:00 GMT",
      "Set-Cookie": "must-not-propagate=value", "Cache-Control": "private, no-store",
    } }));
    const response = await handleRequest(request(`${path}?ignored=1`, sample(), { headers: {
      Authorization: `Bearer ${TOKEN}`, Cookie: "session=private", "X-Private": "private",
      "If-None-Match": '"old-hash"', "If-Modified-Since": "Tue, 08 Sep 2026 09:00:00 GMT",
    } }), env, NOW);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://example.test${assetPath}`);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].redirect, "manual");
    assert.deepEqual([...calls[0].headers], [
      ["if-modified-since", "Tue, 08 Sep 2026 09:00:00 GMT"], ["if-none-match", '"old-hash"'],
    ]);
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(response.headers.get("cdn-cache-control"), null);
    assert.equal(response.headers.get("cloudflare-cdn-cache-control"), null);
    assert.equal(response.headers.get("etag"), '"content-hash"');
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), type === "image/png" ? type : `${type}; charset=utf-8`);
    if (type === "image/png") assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
    else assert.equal(await response.text(), catalog);
    assert.equal(stateReads(), 0);
  }
});

test("icon HEAD preserves representation headers with no response body", async () => {
  for (const path of ["/api/icons", "/api/icons/example-app.png"]) {
    const { env, calls, stateReads } = iconSetup(() => new Response(null, { headers: {
      "Content-Type": path === "/api/icons" ? "application/json" : "image/png",
      "Content-Length": "123", ETag: '"content-hash"',
    } }));
    const response = await handleRequest(request(path, sample(), { method: "HEAD" }), env, NOW);
    assert.equal(response.status, 200);
    assert.equal(calls[0].method, "HEAD");
    assert.equal(response.headers.get("content-length"), "123");
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(response.headers.get("etag"), '"content-hash"');
    assert.equal(await response.text(), "");
    assert.equal(stateReads(), 0);
  }
});

test("icon conditional requests preserve 304 validators and cache policy", async () => {
  const { env, calls, stateReads } = iconSetup(() => new Response(null, {
    status: 304, headers: { ETag: '"content-hash"' },
  }));
  const response = await handleRequest(request("/api/icons/example-app.png", sample(), {
    headers: { "If-None-Match": '"content-hash"' },
  }), env, NOW);
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
  assert.equal(calls[0].headers.get("if-none-match"), '"content-hash"');
  assert.equal(response.headers.get("etag"), '"content-hash"');
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(stateReads(), 0);
});

test("valid icon OPTIONS and unsupported methods do not access assets or device configuration", async () => {
  const { env, calls, stateReads } = iconSetup(() => { throw new Error("Unexpected fetch."); });
  for (const path of ["/api/icons", "/api/icons/example-app.png"]) {
    const options = await handleRequest(request(path, sample(), { method: "OPTIONS" }), env, NOW);
    assert.equal(options.status, 204);
    assert.equal(await options.text(), "");
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    assert.equal(options.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await handleRequest(request(path, sample(), { method }), env, NOW);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
      assert.deepEqual(await response.json(), { error: "method_not_allowed" });
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(stateReads(), 0);
});

test("icon paths reject non-PNG files, unsafe IDs, and encoded traversal without touching assets or KV", async () => {
  const { env, calls, stateReads } = iconSetup(() => { throw new Error("Unexpected fetch."); });
  for (const path of [
    "/api/icons/", "/api/icons/index.json", "/api/icons/app.svg", "/api/icons/app.PNG",
    "/api/icons/.png", "/api/icons/-app.png", "/api/icons/app-.png", "/api/icons/app--name.png",
    "/api/icons/App.png", "/api/icons/app_name.png", "/api/icons/app.png/extra", "/api/icons//app.png",
    "/api/icons/%2e%2e%2fnow", "/api/icons/%2E%2E%5Cnow", "/api/icons/app%2fname.png",
    "/api/icons/https%3A%2F%2Fexample.com%2Fapp.png", "/api/icons/app%00.png",
    "/icons", "/icons/example-app.png",
  ]) {
    for (const method of ["GET", "OPTIONS"]) {
      const response = await handleRequest(request(path, sample(), { method }), env, NOW);
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(stateReads(), 0);
});

test("missing icon assets and HTML fallbacks are JSON 404; asset failures are generic 503", async () => {
  for (const [respond, expected] of [
    [() => new Response("Missing page", { status: 404, headers: { "Content-Type": "text/html" } }), 404],
    [() => new Response("SPA fallback", { headers: { "Content-Type": "text/html" } }), 404],
    [() => new Response("Upstream private error", { status: 500 }), 503],
    [() => new Response(null, { status: 302, headers: { Location: "https://external.test/private" } }), 503],
    [() => { throw new Error(`Private asset details ${TOKEN}`); }, 503],
  ]) {
    const { env, stateReads } = iconSetup(respond);
    for (const path of ["/api/icons", "/api/icons/missing.png"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await handleRequest(request(path, sample(), { method }), env, NOW);
        assert.equal(response.status, expected);
        assert.match(response.headers.get("content-type"), /^application\/json/u);
        assert.match(response.headers.get("cache-control"), /no-store/u);
        assert.equal(response.headers.get("location"), null);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        if (method === "HEAD") assert.equal(await response.text(), "");
        else assert.deepEqual(await response.json(), { error: expected === 404 ? "not_found" : "service_unavailable" });
      }
    }
    assert.equal(stateReads(), 0);
  }
  for (const env of [{}, { ASSETS: {} }]) {
    const response = await handleRequest(request("/api/icons/example-app.png"), env, NOW);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }
});

const SLICES = ["/api/music", "/api/apps/active", "/api/apps/running", "/api/device"];

function sliceSetup(data = sample()) {
  const context = setup();
  context.values.set("now", JSON.stringify({ received_at: NOW, expires_at: NOW + 60_000, data }));
  return context;
}

function sliceEnvelope() {
  return {
    status: "online", updated_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(), collected_at: sample().collected_at,
  };
}

function plainApp(name) {
  return { name, icon_url: null, icon_api_url: null };
}

test("music slice returns only the pushed song and artwork with the shared status deadline", async () => {
  const music = { ...sample().music, ...ARTWORK };
  const { env, calls } = sliceSetup({ ...sample(), music });
  const response = await handleRequest(request("/api/music?track=private&artist=other"), env, NOW, {
    now: () => NOW,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...sliceEnvelope(), music });
  assert.deepEqual(calls, [{ method: "get", key: "now", options: { type: "text", cacheTtl: 30 } }]);
  for (const header of ["cache-control", "cdn-cache-control", "cloudflare-cdn-cache-control"]) {
    assert.match(response.headers.get(header), /no-store/u);
  }
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("music slices preserve metadata and return null URLs when artwork was omitted or unavailable", async () => {
  for (const music of [
    { state: "playing", track: "A song", artist: "An artist" },
    { state: "paused", track: "A song", artist: "An artist" },
    { state: "stopped", track: "A song", artist: "An artist" },
    { state: "unavailable", track: null, artist: null },
    { state: "playing", track: null, artist: "An artist" },
    { state: "playing", track: "A song", artist: null },
    { state: "paused", track: "   ", artist: "An artist" },
  ]) {
    for (const reported of [{}, { artwork_url: null, track_url: null }]) {
      const { env, calls } = sliceSetup({ ...sample(), music: { ...music, ...reported } });
      const response = await handleRequest(request("/api/music"), env, NOW, {
        now: () => NOW,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ...sliceEnvelope(), music: { ...music, artwork_url: null, track_url: null },
      });
      assert.equal(calls.length, 1);
    }
  }
});

test("a slow KV read cannot return any slice at or beyond the original snapshot expiry", async () => {
  for (const elapsed of [59_999, 60_000, 60_001]) {
    for (const path of SLICES) {
      const { env, calls } = sliceSetup();
      let time = NOW;
      const get = env.STATUS_KV.get;
      env.STATUS_KV.get = async (...args) => {
        const stored = await get(...args);
        time += elapsed;
        return stored;
      };
      const response = await handleRequest(request(path), env, NOW, { now: () => time });
      assert.equal(response.status, 200);
      const data = await response.json();
      if (elapsed < 60_000) {
        assert.equal(data.status, "online");
        assert.equal(data.expires_at, new Date(NOW + 60_000).toISOString());
      } else assert.deepEqual(data, { status: "offline" });
      assert.equal(calls.length, 1);
    }
  }
});

test("active app slices match committed icon aliases and never construct paths from unknown names", async () => {
  for (const [name, id] of [
    ["Visual Studio Code", "visual-studio-code"], ["Code", "visual-studio-code"],
    ["访达", "finder"], ["  music  ", "music"], ["System", null],
    ["../private", null], ["https://example.test/icon.png", null], ["__proto__", null], [null, null],
  ]) {
    const { env, calls } = sliceSetup({ ...sample(), active_app: name });
    const response = await handleRequest(request("/api/apps/active?app=Finder"), env, NOW, {
      now: () => NOW,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...sliceEnvelope(), active_app: name === null ? null : {
        name, icon_url: id ? `/app-icons/${id}.png` : null, icon_api_url: id ? `/api/icons/${id}.png` : null,
      },
    });
    assert.equal(calls.length, 1);
  }
});

test("running app slices distinguish disabled collection from an empty report and enrich each stored name", async () => {
  for (const [running, expected] of [
    [undefined, null], [[], []],
    [["Finder", "Unknown App", "System"], [
      { name: "Finder", icon_url: "/app-icons/finder.png", icon_api_url: "/api/icons/finder.png" },
      plainApp("Unknown App"), plainApp("System"),
    ]],
  ]) {
    const data = sample();
    if (running === undefined) delete data.running_apps;
    else data.running_apps = running;
    const { env, calls } = sliceSetup(data);
    const response = await handleRequest(request("/api/apps/running"), env, NOW, {
      now: () => NOW,
    });
    assert.deepEqual(await response.json(), { ...sliceEnvelope(), running_apps: expected });
    assert.equal(calls.length, 1);
  }
});

test("device slices return only the battery and system aggregate, including privacy-disabled values", async () => {
  for (const device of [
    { battery: sample().battery, system: sample().system },
    { battery: { percent: null, charging: null, power_source: "unknown" }, system: { load_1m: null, load_5m: null, load_15m: null } },
  ]) {
    const { env, calls } = sliceSetup({ ...sample(), ...device });
    const response = await handleRequest(request("/api/device"), env, NOW, {
      now: () => NOW,
    });
    assert.deepEqual(await response.json(), { ...sliceEnvelope(), device });
    assert.equal(calls.length, 1);
  }
});

test("all slices use one status read and return exact offline without enriching absent, expired, or corrupt data", async () => {
  for (const stored of [null, "invalid JSON", JSON.stringify({ received_at: NOW - 60_000, data: sample() })]) {
    for (const path of SLICES) {
      const { env, values, calls } = setup();
      if (stored !== null) values.set("now", stored);
      const response = await handleRequest(request(path), env, NOW, {
        now: () => NOW,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "offline" });
      assert.equal(calls.length, 1);
    }
  }
});

test("slice routes support canonical GET and OPTIONS only and retain generic service errors", async () => {
  for (const path of SLICES) {
    const { env, calls } = setup();
    const options = await handleRequest(request(path, sample(), { method: "OPTIONS" }), env, NOW);
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    assert.equal(await options.text(), "");
    for (const method of ["HEAD", "POST", "PUT"]) {
      const response = await handleRequest(request(path, sample(), { method }), env, NOW);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, OPTIONS");
    }
    for (const route of [path.slice(4), `${path}/`]) {
      for (const method of ["GET", "OPTIONS"]) {
        const response = await handleRequest(request(route, sample(), { method }), env, NOW);
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "not_found" });
      }
    }
    assert.equal(calls.length, 0);
    env.STATUS_KV.get = async () => { throw new Error(`Private vendor detail ${TOKEN}`); };
    for (const unavailable of [{}, env, { ...env, STATUS_TTL_SECONDS: "bad" }]) {
      const response = await handleRequest(request(path), unavailable, NOW);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "service_unavailable" });
      assert.match(response.headers.get("cache-control"), /no-store/u);
    }
  }
});

test("optional paired artwork is stored in the same snapshot while legacy now responses keep their original shape", async () => {
  const maximum = (prefix) => prefix + "a".repeat(2048 - prefix.length);
  for (const [state, artwork] of [
    ["playing", {}], ["paused", {}],
    ["playing", { artwork_url: null, track_url: null }],
    ["stopped", { artwork_url: null, track_url: null }],
    ["unavailable", { artwork_url: null, track_url: null }],
    ["playing", ARTWORK], ["paused", ARTWORK],
    ["playing", { ...ARTWORK, track_url: "https://itunes.apple.com/us/album/example/123?i=456" }],
    ["playing", { artwork_url: "HTTPS://IS1-SSL.MZSTATIC.COM:443/example.jpg", track_url: "https://music.apple.com:443/us/song/123" }],
    ["playing", { artwork_url: maximum("https://is1-ssl.mzstatic.com/"), track_url: maximum("https://music.apple.com/") }],
  ]) {
    const { env, values, calls } = setup();
    const music = { ...sample().music, state, ...artwork };
    const data = { ...sample(), music };
    const uploaded = await handleRequest(request("/api/update", data), env, NOW);
    assert.equal(uploaded.status, 200);
    assert.deepEqual(calls, [{ method: "put", key: "now", options: { expirationTtl: 60 } }]);
    assert.deepEqual(JSON.parse(values.get("now")), { received_at: NOW, expires_at: NOW + 60_000, data });
    for (const path of ["/now", "/api/now"]) {
      const current = await (await handleRequest(request(path), env, NOW)).json();
      assert.deepEqual(current, { ...sliceEnvelope(), ...data });
      assert.equal(Object.hasOwn(current.music, "artwork_url"), Object.hasOwn(artwork, "artwork_url"));
      assert.equal(Object.hasOwn(current.music, "track_url"), Object.hasOwn(artwork, "track_url"));
    }
    const slice = await (await handleRequest(request("/api/music"), env, NOW)).json();
    assert.deepEqual(slice, { ...sliceEnvelope(), music: {
      ...music, artwork_url: artwork.artwork_url ?? null, track_url: artwork.track_url ?? null,
    } });
    assert.equal(values.size, 1);
  }
});

test("artwork fields reject incomplete pairs, unsafe URLs, excessive lengths and inappropriate song states before writing KV", async () => {
  const invalid = [
    (music) => { delete music.artwork_url; },
    (music) => { delete music.track_url; },
    (music) => { delete music.artwork_url; music.track_url = null; },
    (music) => { delete music.track_url; music.artwork_url = null; },
    (music) => { music.artwork_url = null; },
    (music) => { music.track_url = null; },
    (music) => { music.artwork_url = 1; },
    (music) => { music.track_url = true; },
    (music) => { music.artwork_url = []; },
    (music) => { music.track_url = {}; },
    (music) => { music.artwork_url = ""; },
    (music) => { music.artwork_url = "http://is1-ssl.mzstatic.com/x.jpg"; },
    (music) => { music.artwork_url = "https://mzstatic.com/x.jpg"; },
    (music) => { music.artwork_url = "https://is1-ssl.mzstatic.com.evil.example/x.jpg"; },
    (music) => { music.artwork_url = "https://user@is1-ssl.mzstatic.com/x.jpg"; },
    (music) => { music.artwork_url = "https://is1-ssl.mzstatic.com:8443/x.jpg"; },
    (music) => { music.artwork_url = "https://is1-ssl.mzstatic.com/x\ny.jpg"; },
    (music) => { music.artwork_url = ` ${ARTWORK.artwork_url}`; },
    (music) => { music.artwork_url = ARTWORK.artwork_url + "a".repeat(2049 - ARTWORK.artwork_url.length); },
    (music) => { music.track_url = ARTWORK.track_url + "a".repeat(2049 - ARTWORK.track_url.length); },
    (music) => { music.track_url = "javascript:alert(1)"; },
    (music) => { music.track_url = "/music/example"; },
    (music) => { music.track_url = "https://sub.music.apple.com/us/song/123"; },
    (music) => { music.track_url = "https://music.apple.com.evil.example/us/song/123"; },
    (music) => { music.track_url = "https://user:pass@music.apple.com/us/song/123"; },
    (music) => { music.track_url = "https://music.apple.com:8080/us/song/123"; },
    (music) => { music.state = "stopped"; },
    (music) => { music.state = "unavailable"; },
    (music) => { music.track = null; },
    (music) => { music.artist = null; },
    (music) => { music.track = "  "; },
    (music) => { music.artist = "  "; },
  ];
  const { env, calls } = setup();
  for (const mutate of invalid) {
    const data = sample();
    data.music = { ...data.music, ...ARTWORK };
    mutate(data.music);
    const response = await handleRequest(request("/api/update", data), env, NOW);
    assert.equal(response.status, 400, mutate.toString());
    assert.deepEqual(await response.json(), { error: "invalid_payload" });
  }
  assert.equal(calls.length, 0);
});

test("invalid artwork in stored data cannot become public through status or slice routes", async () => {
  const { env, values, calls } = sliceSetup();
  const data = { ...sample(), music: { ...sample().music, ...ARTWORK, artwork_url: "https://untrusted.example/art.jpg" } };
  values.set("now", JSON.stringify({ received_at: NOW, expires_at: NOW + 60_000, data }));
  for (const path of ["/api/now", ...SLICES]) {
    assert.deepEqual(await (await handleRequest(request(path), env, NOW)).json(), { status: "offline" });
  }
  assert.equal(calls.length, SLICES.length + 1);
});

test("pushing and reading music never use external fetch or Cache API, with or without artwork", async (t) => {
  const outbound = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected outbound request"); });
  const previousCache = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let cacheReads = 0;
  Object.defineProperty(globalThis, "caches", { configurable: true, get() {
    cacheReads += 1;
    throw new Error("Unexpected Cache API access");
  } });
  t.after(() => {
    if (previousCache) Object.defineProperty(globalThis, "caches", previousCache);
    else delete globalThis.caches;
  });
  for (const artwork of [{}, { artwork_url: null, track_url: null }, ARTWORK]) {
    const { env, calls } = setup();
    const data = { ...sample(), music: { ...sample().music, ...artwork } };
    assert.equal((await handleRequest(request("/api/update", data), env, NOW)).status, 200);
    for (const path of ["/now", "/api/now", ...SLICES]) {
      const response = await handleRequest(request(`${path}?track=other&app=other`), env, NOW);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "online");
    }
    assert.equal(calls.filter((call) => call.method === "put").length, 1);
    assert.equal(calls.filter((call) => call.method === "get").length, 2 + SLICES.length);
  }
  assert.equal(outbound.mock.callCount(), 0);
  assert.equal(cacheReads, 0);
});

const SESSION = "a791cf39-11f2-4ac7-9c08-ab0c5db561b0";
const iso = (at) => new Date(at).toISOString();
function batchSample() {
  const start = NOW - 900_000;
  return {
    schema_version: 2,
    session_id: SESSION,
    batch_seq: 1,
    generated_at: iso(NOW),
    window_start: iso(start),
    window_end: iso(NOW),
    baseline: { ...sample(), collected_at: iso(start) },
    events: [
      { seq: 7, at: iso(NOW - 420_002), changes: { active_app: "Safari", music: { state: "playing", track: "First", artist: "Artist" } } },
      { seq: 8, at: iso(NOW - 420_001), changes: { active_app: "Terminal", music: { state: "playing", track: "Second", artist: "Artist", ...ARTWORK } } },
      { seq: 9, at: iso(NOW - 420_000), changes: { active_app: "Music", music: { state: "paused", track: "Third", artist: "Artist", ...ARTWORK } } },
      { seq: 10, at: iso(NOW - 300_000), changes: { active_app: "Finder", music: { state: "playing", track: "Latest", artist: "Artist" } } },
    ],
    gaps: [],
    dropped_events: 0,
  };
}
const steadyClock = { now: () => NOW };

async function uploadBatch(payload = batchSample(), now = NOW, state = setup()) {
  const response = await handleRequest(request("/api/batch", payload), state.env, now, steadyClock);
  return { ...state, response };
}

test("one self-contained window uses one KV write, no read, and the observation-based deadline", async () => {
  const data = batchSample();
  const { env, values, calls, response } = await uploadBatch(data);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, updated_at: iso(NOW), expires_at: iso(NOW + 600_000) });
  assert.deepEqual(calls, [{ method: "put", key: "now", options: { expiration: Math.ceil((NOW + 600_000) / 1000) } }]);
  assert.deepEqual(JSON.parse(values.get("now")), { received_at: NOW, expires_at: NOW + 600_000, data });
  const read = await handleRequest(request("/api/timeline"), env, NOW, steadyClock);
  assert.deepEqual(await read.json(), {
    status: "online", mode: "window", server_time: iso(NOW), updated_at: iso(NOW), expires_at: iso(NOW + 600_000),
    policy: { upload_interval_seconds: 300, window_seconds: 900, playback_delay_seconds: 420, poll_interval_seconds: 60, sample_interval_seconds: 2, metrics_interval_seconds: 30 },
    window: data,
  });
  assert.equal(calls.filter((call) => call.method === "get").length, 1);
  assert.equal(values.size, 1);
  assert.match(read.headers.get("cache-control"), /no-store/u);
  assert.equal(read.headers.get("access-control-allow-origin"), "*");
});

test("old status and focused APIs replay rapid app and song switches instead of the latest upload", async () => {
  const { env, calls } = await uploadBatch();
  const now = await (await handleRequest(request("/api/now"), env, NOW, steadyClock)).json();
  assert.equal(now.schema_version, 1);
  assert.equal(now.active_app, "Music");
  assert.equal(now.music.track, "Third");
  assert.equal(now.music.state, "paused");
  assert.equal(now.music.artwork_url, ARTWORK.artwork_url);
  assert.equal(now.collected_at, iso(NOW - 420_000));
  assert.equal(now.expires_at, iso(NOW + 420_000));
  assert.deepEqual(now.playback, { mode: "delayed", delay_seconds: 420, at: iso(NOW - 420_000), window_end: iso(NOW) });
  for (const path of ["/now", "/api/now"]) {
    assert.deepEqual(await (await handleRequest(request(path), env, NOW, steadyClock)).json(), now);
  }
  const music = await (await handleRequest(request("/api/music"), env, NOW, steadyClock)).json();
  assert.deepEqual(music.music, now.music);
  assert.deepEqual(music.playback, now.playback);
  const active = await (await handleRequest(request("/api/apps/active"), env, NOW, steadyClock)).json();
  assert.deepEqual(active.active_app, { name: "Music", icon_url: "/app-icons/music.png", icon_api_url: "/api/icons/music.png" });
  const running = await (await handleRequest(request("/api/apps/running"), env, NOW, steadyClock)).json();
  assert.equal(running.running_apps.length, 2);
  const device = await (await handleRequest(request("/api/device"), env, NOW, steadyClock)).json();
  assert.deepEqual(device.device, { battery: sample().battery, system: sample().system });
  const svg = await (await handleRequest(request("/api/badge.svg"), env, NOW, steadyClock)).text();
  assert.match(svg, /Music/u);
  assert.doesNotMatch(svg, /Latest/u);
  assert.equal(calls.filter((call) => call.method === "put").length, 1);
});

test("batch validation rejects bad shape, sequence, timestamps, field patches, gaps, and URLs before KV", async () => {
  const mutations = [
    (d) => { d.extra = true; },
    (d) => { d.schema_version = 1; },
    (d) => { d.session_id = SESSION.toUpperCase(); },
    (d) => { d.session_id = "device-name"; },
    (d) => { d.batch_seq = 0; },
    (d) => { d.batch_seq = Number.MAX_SAFE_INTEGER + 1; },
    (d) => { d.dropped_events = -1; },
    (d) => { d.dropped_events = 0.5; },
    (d) => { d.generated_at = iso(NOW - 120_001); },
    (d) => { d.generated_at = iso(NOW + 120_001); },
    (d) => { d.generated_at = "2026-09-08T10:00:00Z"; },
    (d) => { d.window_start = iso(NOW - 900_001); },
    (d) => { d.window_start = iso(NOW + 1); },
    (d) => { d.window_end = iso(NOW + 1); },
    (d) => { d.generated_at = iso(NOW + 30_001); },
    (d) => { d.baseline.collected_at = iso(NOW - 899_999); },
    (d) => { d.baseline.battery.serial_number = "private"; },
    (d) => { d.events[0].secret = "private"; },
    (d) => { d.events[0].seq = 0; },
    (d) => { d.events[0].seq = 0.5; },
    (d) => { d.events[1].seq = d.events[0].seq; },
    (d) => { d.events[1].seq = d.events[0].seq - 1; },
    (d) => { d.events[0].at = iso(NOW - 900_001); },
    (d) => { d.events[0].at = iso(NOW + 1); },
    (d) => { d.events[1].at = d.window_start; },
    (d) => { d.events[0].changes = {}; },
    (d) => { d.events[0].changes = { collected_at: iso(NOW) }; },
    (d) => { d.events[0].changes = { window_title: "private" }; },
    (d) => { d.events[0].changes = { active_app: "x".repeat(201) }; },
    (d) => { d.events[0].changes = { running_apps: ["Finder", "Finder"] }; },
    (d) => { d.events[0].changes = { battery: { percent: 20 } }; },
    (d) => { d.events[0].changes = { system: { load_1m: 0, load_5m: 0, load_15m: -1 } }; },
    (d) => { d.events[0].changes.music.artwork_url = ARTWORK.artwork_url; },
    (d) => { d.events[0].changes.music = { ...sample().music, ...ARTWORK, artwork_url: "https://evil.example/x.jpg" }; },
    (d) => { d.gaps = [{ start_at: d.window_start, end_at: iso(NOW - 900_001), reason: "sleep" }]; },
    (d) => { d.gaps = [{ start_at: d.window_start, end_at: d.window_start, reason: "sleep" }]; },
    (d) => { d.gaps = [{ start_at: d.window_start, end_at: iso(NOW + 1), reason: "sleep" }]; },
    (d) => { d.gaps = [{ start_at: d.window_start, end_at: iso(NOW - 800_000), reason: "secret" }]; },
    (d) => { d.gaps = [{ start_at: d.window_start, end_at: iso(NOW - 800_000), reason: "sleep", private: 1 }]; },
    (d) => { d.gaps = [{ start_at: d.window_start, end_at: iso(NOW - 800_000), reason: "sleep" }, { start_at: iso(NOW - 850_000), end_at: iso(NOW - 700_000), reason: "collection" }]; },
    (d) => { d.events = Array.from({ length: 2049 }, (_, index) => ({ seq: index + 1, at: d.window_start, changes: { active_app: "Finder" } })); },
    (d) => { d.gaps = Array.from({ length: 129 }, (_, index) => ({ start_at: iso(NOW - 900_000 + index * 2), end_at: iso(NOW - 899_999 + index * 2), reason: "clock" })); },
  ];
  const state = setup();
  for (const mutate of mutations) {
    const payload = batchSample();
    mutate(payload);
    const { response } = await uploadBatch(payload, NOW, state);
    assert.equal(response.status, 400, mutate.toString());
    assert.deepEqual(await response.json(), { error: "invalid_payload" });
  }
  for (const invalid of [null, [], {}, "text"]) {
    assert.equal((await uploadBatch(invalid, NOW, state)).response.status, 400);
  }
  assert.equal(state.calls.length, 0);
});

test("equal-time changes preserve sequence and 2048 events plus 128 gaps remain accepted", async () => {
  const batch = batchSample();
  batch.events = Array.from({ length: 2048 }, (_, index) => ({ seq: index + 1, at: batch.window_start, changes: { active_app: `App ${index}` } }));
  batch.gaps = Array.from({ length: 128 }, (_, index) => ({ start_at: iso(NOW - 850_000 + index * 2), end_at: iso(NOW - 849_999 + index * 2), reason: "clock" }));
  batch.dropped_events = 12;
  const { env, response } = await uploadBatch(batch);
  assert.equal(response.status, 200);
  const current = await (await handleRequest(request("/api/now"), env, NOW, steadyClock)).json();
  assert.equal(current.active_app, "App 2047");
  const timeline = await (await handleRequest(request("/api/timeline"), env, NOW, steadyClock)).json();
  assert.equal(timeline.window.dropped_events, 12);
  assert.equal(timeline.window.events.length, 2048);
  assert.equal(timeline.window.gaps.length, 128);
});

test("batch body cap is 512 KiB for declared and streamed UTF-8 while v1 stays 16 KiB", async () => {
  const data = batchSample();
  const encoded = JSON.stringify(data);
  const exactBody = encoded + " ".repeat(512 * 1024 - new TextEncoder().encode(encoded).byteLength);
  const state = setup();
  const accepted = await handleRequest(request("/api/batch", data, { body: exactBody }), state.env, NOW, steadyClock);
  assert.equal(accepted.status, 200);
  for (const options of [{ body: exactBody + " " }, { body: encoded, headers: { "Content-Length": String(512 * 1024 + 1) } }]) {
    const rejected = await handleRequest(request("/api/batch", data, options), state.env, NOW, steadyClock);
    assert.equal(rejected.status, 413);
  }
  const v1 = JSON.stringify(sample()) + " ".repeat(16 * 1024);
  assert.equal((await handleRequest(request("/api/update", sample(), { body: v1 }), state.env, NOW, steadyClock)).status, 413);
  assert.equal(state.calls.length, 1);
});

test("batch authentication and route/method restrictions happen before parsing or storage", async () => {
  const state = setup();
  for (const header of ["", "Bearer wrong"]) {
    const result = await handleRequest(request("/api/batch", batchSample(), { body: "not json", headers: { Authorization: header } }), state.env, NOW, steadyClock);
    assert.equal(result.status, 401);
    assert.equal(result.headers.get("www-authenticate"), "Bearer");
  }
  for (const path of ["/api/batch", "/api/timeline"]) {
    const options = await handleRequest(new Request(`https://example.test${path}`, { method: "OPTIONS" }), state.env, NOW, steadyClock);
    assert.equal(options.status, 204);
    for (const method of ["HEAD", "PUT", path === "/api/batch" ? "GET" : "POST"]) {
      const result = await handleRequest(new Request(`https://example.test${path}`, { method }), state.env, NOW, steadyClock);
      assert.equal(result.status, 405);
      assert.equal(result.headers.get("allow"), path === "/api/batch" ? "POST, OPTIONS" : "GET, OPTIONS");
    }
  }
  for (const path of ["/batch", "/timeline", "/api/batch/", "/api/timeline/"]) {
    for (const method of ["GET", "OPTIONS"]) {
      assert.equal((await handleRequest(new Request(`https://example.test${path}`, { method }), state.env, NOW, steadyClock)).status, 404);
    }
  }
  assert.equal(state.calls.length, 0);
});

test("duplicate batches never extend their original observation deadline and stale retries fail closed", async () => {
  const payload = batchSample();
  const state = await uploadBatch(payload);
  const second = await uploadBatch(payload, NOW + 60_500, state);
  assert.equal(second.response.status, 200);
  assert.deepEqual(await second.response.json(), { ok: true, updated_at: iso(NOW + 60_500), expires_at: iso(NOW + 600_000) });
  assert.deepEqual(state.calls[1], { method: "put", key: "now", options: { expiration: Math.ceil((NOW + 600_000) / 1000) } });
  assert.equal((await uploadBatch(payload, NOW + 120_001, state)).response.status, 400);
  state.env.STATUS_TTL_SECONDS = "3600";
  const retained = await (await handleRequest(request("/api/timeline"), state.env, NOW + 599_999, steadyClock)).json();
  assert.equal(retained.expires_at, iso(NOW + 600_000));
  for (const age of [600_000, 600_001, 3_600_000]) {
    assert.deepEqual(await (await handleRequest(request("/api/timeline"), state.env, NOW + age, steadyClock)).json(), { status: "offline" });
  }
  assert.equal(state.calls.filter((call) => call.method === "put").length, 2);
});

test("first-window warming, capture gaps, and post-window playback never pretend to be online", async () => {
  for (const mode of ["warming", "gap", "ended"]) {
    const data = batchSample();
    let readAt = NOW;
    if (mode === "warming") {
      data.window_start = iso(NOW - 60_000);
      data.baseline.collected_at = data.window_start;
      data.events = [];
    } else if (mode === "gap") {
      data.gaps = [{ start_at: iso(NOW - 421_000), end_at: iso(NOW - 419_000), reason: "sleep" }];
    } else readAt = NOW + 420_000;
    const { env } = await uploadBatch(data);
    for (const path of ["/api/now", "/now", ...SLICES]) {
      assert.deepEqual(await (await handleRequest(request(path), env, readAt, steadyClock)).json(), { status: "offline" }, `${mode} ${path}`);
    }
    const timeline = await (await handleRequest(request("/api/timeline"), env, readAt, steadyClock)).json();
    assert.equal(timeline.mode, "window");
    assert.equal(timeline.status, "online");
    assert.match(await (await handleRequest(request("/api/badge.svg"), env, readAt, steadyClock)).text(), /offline/u);
  }
});

test("slow KV reads re-evaluate playhead, gaps, playback cutoff, and absolute window expiry", async () => {
  for (const [elapsed, expected, expectedTrack] of [
    [120_000, "online", "Latest"], [420_000, "offline", null], [600_000, "offline", null],
  ]) {
    for (const path of ["/api/now", "/now", ...SLICES, "/api/timeline"]) {
      const state = await uploadBatch();
      let clock = NOW;
      const original = state.env.STATUS_KV.get;
      state.env.STATUS_KV.get = async (...args) => { const raw = await original(...args); clock += elapsed; return raw; };
      const result = await (await handleRequest(request(path), state.env, NOW, { now: () => clock })).json();
      const status = path === "/api/timeline" && elapsed < 600_000 ? "online" : expected;
      assert.equal(result.status, status, `${path} ${elapsed}`);
      if (status === "offline") assert.deepEqual(result, { status: "offline" });
      if (result.music) assert.equal(result.music.track, expectedTrack);
    }
  }
  const payload = batchSample();
  payload.gaps = [{ start_at: iso(NOW - 419_000), end_at: iso(NOW - 415_000), reason: "collection" }];
  const state = await uploadBatch(payload);
  let clock = NOW;
  const original = state.env.STATUS_KV.get;
  state.env.STATUS_KV.get = async (...args) => { const raw = await original(...args); clock += 2_000; return raw; };
  assert.deepEqual(await (await handleRequest(request("/api/music"), state.env, NOW, { now: () => clock })).json(), { status: "offline" });
});

test("corrupt stored windows and forged retention deadlines never become public", async () => {
  for (const mutate of [
    (r) => { r.expires_at += 1000; },
    (r) => { delete r.expires_at; },
    (r) => { r.data.baseline.secret = "private"; },
    (r) => { r.data.events[0].changes.music.track_url = "https://evil.example"; },
    (r) => { r.data.generated_at = iso(NOW - 121_000); },
  ]) {
    const state = await uploadBatch();
    const record = JSON.parse(state.values.get("now"));
    mutate(record);
    state.values.set("now", JSON.stringify(record));
    for (const path of ["/api/timeline", "/api/now", ...SLICES]) {
      assert.deepEqual(await (await handleRequest(request(path), state.env, NOW, steadyClock)).json(), { status: "offline" });
    }
  }
});

test("timeline wraps valid old snapshots without changing the v1 interfaces or expiry", async () => {
  const state = setup();
  await handleRequest(request("/api/update"), state.env, NOW, steadyClock);
  const timeline = await (await handleRequest(request("/api/timeline"), state.env, NOW, steadyClock)).json();
  assert.deepEqual(timeline, { status: "online", updated_at: iso(NOW), expires_at: iso(NOW + 60_000), ...sample(), mode: "snapshot", server_time: iso(NOW) });
  assert.deepEqual(await (await handleRequest(request("/api/timeline"), state.env, NOW + 60_000, steadyClock)).json(), { status: "offline" });
  const fresh = batchSample();
  await uploadBatch(fresh, NOW, state);
  await handleRequest(request("/api/update", { ...sample(), active_app: "Safari" }), state.env, NOW, steadyClock);
  const snapshot = await (await handleRequest(request("/api/now"), state.env, NOW, steadyClock)).json();
  assert.equal(snapshot.active_app, "Safari");
  assert.equal(Object.hasOwn(snapshot, "playback"), false);
  assert.equal(state.values.size, 1);
});

test("window ingestion and reads never call third parties or Cache API", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected fetch"); });
  const cacheDescriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let cacheCalls = 0;
  Object.defineProperty(globalThis, "caches", { configurable: true, get() { cacheCalls += 1; throw new Error("Unexpected cache"); } });
  t.after(() => {
    if (cacheDescriptor) Object.defineProperty(globalThis, "caches", cacheDescriptor);
    else delete globalThis.caches;
  });
  const { env, calls } = await uploadBatch();
  for (const path of ["/api/timeline", "/api/now", ...SLICES, "/api/badge.svg"]) {
    assert.equal((await handleRequest(request(path), env, NOW, steadyClock)).status, 200);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(cacheCalls, 0);
  assert.equal(calls.filter((call) => call.method === "put").length, 1);
  assert.equal(calls.filter((call) => call.method === "get").length, 7);
});

test("slow batch body reads use completion time for freshness and absolute KV expiration", async () => {
  for (const elapsed of [60_500, 120_001, 610_000]) {
    const state = setup();
    let time = NOW;
    const body = new TextEncoder().encode(JSON.stringify(batchSample()));
    const stream = new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } });
    const clock = { now() { const current = time; time = NOW + elapsed; return current; } };
    const result = await handleRequest(new Request("https://example.test/api/batch", {
      method: "POST", body: stream, duplex: "half",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    }), state.env, NOW, clock);
    if (elapsed <= 120_000) {
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { ok: true, updated_at: iso(NOW + elapsed), expires_at: iso(NOW + 600_000) });
      assert.deepEqual(state.calls, [{ method: "put", key: "now", options: { expiration: Math.ceil((NOW + 600_000) / 1000) } }]);
    } else {
      assert.equal(result.status, 400);
      assert.equal(state.calls.length, 0);
    }
  }
});
