import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleRequest } from "../worker/index.js";

const NOW = Date.parse("2026-09-08T10:00:00.000Z");
const TOKEN = "test-secret-0123456789-abcdefghijklmnop";

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
  return new Request(`https://example.test${path}`, ["/update", "/api/update"].includes(path) ? {
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

test("music slice enriches only the stored song and preserves the shared status deadline", async () => {
  const { env, calls } = sliceSetup();
  const lookups = [];
  const artwork = {
    artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg",
    trackUrl: "https://music.apple.com/us/album/example/123?i=456",
  };
  const response = await handleRequest(request("/api/music?track=private&artist=other"), env, NOW, {
    now: () => NOW,
    async lookupArtwork(music, options) {
      lookups.push({ music, options });
      return artwork;
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ...sliceEnvelope(), music: { ...sample().music, artwork_url: artwork.artworkUrl, track_url: artwork.trackUrl },
  });
  assert.deepEqual(lookups, [{ music: sample().music, options: { origin: "https://example.test" } }]);
  assert.deepEqual(calls, [{ method: "get", key: "now", options: { type: "text", cacheTtl: 30 } }]);
  for (const header of ["cache-control", "cdn-cache-control", "cloudflare-cdn-cache-control"]) {
    assert.match(response.headers.get(header), /no-store/u);
  }
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("music slices retain metadata when artwork is absent or fails, and skip incomplete or inactive songs", async () => {
  for (const music of [
    { state: "playing", track: "A song", artist: "An artist" },
    { state: "paused", track: "A song", artist: "An artist" },
    { state: "stopped", track: "A song", artist: "An artist" },
    { state: "unavailable", track: null, artist: null },
    { state: "playing", track: null, artist: "An artist" },
    { state: "playing", track: "A song", artist: null },
    { state: "paused", track: "   ", artist: "An artist" },
  ]) {
    for (const fails of [false, true]) {
      const { env, calls } = sliceSetup({ ...sample(), music });
      let lookups = 0;
      const response = await handleRequest(request("/api/music"), env, NOW, {
        now: () => NOW,
        async lookupArtwork() {
          lookups += 1;
          if (fails) throw new Error("Private Apple lookup error");
          return null;
        },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ...sliceEnvelope(), music: { ...music, artwork_url: null, track_url: null },
      });
      assert.equal(lookups, ["playing", "paused"].includes(music.state) && music.track?.trim() && music.artist?.trim() ? 1 : 0);
      assert.equal(calls.length, 1);
    }
  }
});

test("a slow artwork success or failure cannot return status at or beyond its original expiry", async () => {
  for (const elapsed of [59_999, 60_000, 60_001]) {
    for (const fails of [false, true]) {
      const { env, calls } = sliceSetup();
      let time = NOW;
      const response = await handleRequest(request("/api/music"), env, NOW, {
        now: () => time,
        async lookupArtwork() {
          time += elapsed;
          if (fails) throw new Error("Artwork service unavailable");
          return { artworkUrl: "https://is1-ssl.mzstatic.com/example.jpg", trackUrl: "https://music.apple.com/us/song/123" };
        },
      });
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
      lookupArtwork() { assert.fail("Application slices must not query artwork."); },
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
      lookupArtwork() { assert.fail("Application slices must not query artwork."); },
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
      lookupArtwork() { assert.fail("Device slices must not query artwork."); },
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
        lookupArtwork() { assert.fail("Offline slices must not query artwork."); },
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
