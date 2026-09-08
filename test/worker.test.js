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
  return new Request(`https://example.test${path}`, path === "/update" ? {
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
  assert.deepEqual(JSON.parse(values.get("now")), { received_at: NOW, data: first });
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
