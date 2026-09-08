import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicArtworkLookup } from '../worker/music-artwork.js';

const MUSIC = { state: 'playing', track: 'Example Song', artist: 'Example Artist' };
const VALUE = { artworkUrl: 'https://is1-ssl.mzstatic.com/image/example/100x100bb.jpg', trackUrl: 'https://music.apple.com/us/album/example/123?i=456' };
const origin = 'https://macflare.example';
const candidate = { kind: 'song', trackName: MUSIC.track, artistName: MUSIC.artist, artworkUrl100: VALUE.artworkUrl, trackViewUrl: VALUE.trackUrl };
const response = (results = [candidate]) => Response.json({ results });

function harness({ fetchImpl = async () => response(), cache, timeoutMs = 4500 } = {}) {
  let time = 1000;
  const calls = [];
  const lookup = createMusicArtworkLookup({ fetchImpl: async (...args) => {
    calls.push(args); return fetchImpl(...args);
  }, now: () => time, getCache: () => cache, timeoutMs });
  return { lookup, calls, setTime(value) { time = value; } };
}

test('Worker artwork search uses a fixed Apple endpoint and normalized exact matching', async () => {
  const { lookup, calls } = harness({ fetchImpl: async () => response([
    { ...candidate, artistName: 'Unrelated Artist' },
    { ...candidate, trackName: ' ＥＸＡＭＰＬＥ  SONG ', artistName: ' example artist ' },
  ]) });
  for (const music of [null, { ...MUSIC, state: 'stopped' }, { ...MUSIC, state: 'unavailable' }, { ...MUSIC, artist: null }]) {
    assert.equal(await lookup(music, { origin }), null);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await lookup(MUSIC, { origin }), VALUE);
  const [url, options] = calls[0];
  assert.equal(new URL(url).origin, 'https://itunes.apple.com');
  assert.deepEqual(Object.fromEntries(new URL(url).searchParams), { term: 'Example Song Example Artist', entity: 'song', country: 'us', limit: '5' });
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers, undefined);
  const result = await lookup({ ...MUSIC, state: 'paused' }, { origin });
  result.artworkUrl = 'https://untrusted.example/';
  assert.deepEqual(await lookup(MUSIC, { origin }), VALUE);
  assert.equal(calls.length, 1);
});

test('a fresh isolate reuses only unexpired safe public artwork from the edge cache', async () => {
  const records = new Map();
  const puts = [];
  const cache = {
    async match(request) { return records.get(request.url)?.clone(); },
    async put(request, body) {
      records.set(request.url, body.clone());
      puts.push({ request, body: await body.json() });
    },
  };
  const first = harness({ cache });
  assert.deepEqual(await first.lookup(MUSIC, { origin }), VALUE);
  assert.equal(puts.length, 1);
  const { request, body } = puts[0];
  assert.match(request.url, /^https:\/\/macflare\.example\/__macflare\/artwork\/v2\/[a-f0-9]{64}$/u);
  assert.equal(request.headers.has('Authorization'), false);
  assert.deepEqual(body, { version: 1, expiresAt: 3_601_000, value: VALUE });
  assert.equal(JSON.stringify(body).includes(MUSIC.track), false);
  const second = harness({ cache });
  second.setTime(3_600_999);
  assert.deepEqual(await second.lookup(MUSIC, { origin }), VALUE);
  assert.equal(second.calls.length, 0);
  second.setTime(3_601_000);
  assert.deepEqual(await second.lookup(MUSIC, { origin }), VALUE);
  assert.equal(second.calls.length, 1);
});

test('poisoned, stale or broken edge caches cannot inject images or prevent valid lookups', async () => {
  for (const cached of [
    { version: 1, expiresAt: 900, value: VALUE },
    { version: 1, expiresAt: 4_000_000, value: VALUE },
    { version: 1, expiresAt: 5000, value: { ...VALUE, artworkUrl: 'https://untrusted.example/x.png' } },
    { version: 1, expiresAt: 5000, value: { ...VALUE, trackUrl: 'javascript:alert(1)' } },
    null,
  ]) {
    const { lookup, calls } = harness({ cache: { match: async () => Response.json(cached), put: async () => { throw new Error('full'); } } });
    assert.deepEqual(await lookup(MUSIC, { origin }), VALUE);
    assert.equal(calls.length, 1);
  }
  const { lookup } = harness({ cache: { match: async () => { throw new Error('unavailable'); } } });
  assert.deepEqual(await lookup(MUSIC, { origin }), VALUE);
});

test('empty, failed, oversized and unsafe search results retry after five minutes', async () => {
  for (const fetchImpl of [
    async () => response([]),
    async () => new Response('down', { status: 503 }),
    async () => new Response('{broken'),
    async () => new Response('x'.repeat(128 * 1024 + 1)),
    async () => { throw new Error('network'); },
    async () => response([{ ...candidate, artworkUrl100: 'http://is1-ssl.mzstatic.com/x.png' }]),
  ]) {
    const { lookup, calls, setTime } = harness({ fetchImpl });
    assert.equal(await lookup(MUSIC, { origin }), null);
    setTime(300_999);
    assert.equal(await lookup(MUSIC, { origin }), null);
    assert.equal(calls.length, 1);
    setTime(301_000);
    assert.equal(await lookup(MUSIC, { origin }), null);
    assert.equal(calls.length, 2);
  }
});

test('a stalled upstream is aborted and negatively cached without delaying metadata indefinitely', async () => {
  let signal;
  const { lookup, calls } = harness({ timeoutMs: 10, fetchImpl: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  assert.equal(await lookup(MUSIC, { origin }), null);
  assert.equal(signal.aborted, true);
  assert.equal(await lookup(MUSIC, { origin }), null);
  assert.equal(calls.length, 1);
});

test('Apple redirects are rejected without following their destination or accepting their body', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { lookup, calls } = harness({ fetchImpl: async (_, options) => {
      assert.equal(options.redirect, 'manual');
      return Response.json({ results: [candidate] }, {
        status, headers: { Location: 'https://untrusted.example/search' },
      });
    } });
    assert.equal(await lookup(MUSIC, { origin }), null);
    assert.equal(await lookup(MUSIC, { origin }), null);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0][0]).origin, 'https://itunes.apple.com');
  }
});

test('concurrent requests for one song share one upstream request', async () => {
  let release;
  const { lookup, calls } = harness({ fetchImpl: async () => new Promise(resolve => { release = resolve; }) });
  const first = lookup(MUSIC, { origin });
  const second = lookup({ ...MUSIC, state: 'paused' }, { origin });
  release(response());
  assert.deepEqual(await Promise.all([first, second]), [VALUE, VALUE]);
  assert.equal(calls.length, 1);
});

test('memory retains at most fifty public catalogue matches', async () => {
  const { lookup, calls } = harness({ fetchImpl: async url => {
    const term = new URL(url).searchParams.get('term');
    return response([{ ...candidate, trackName: term.slice(0, -` ${MUSIC.artist}`.length) }]);
  } });
  for (let i = 0; i < 51; i++) await lookup({ ...MUSIC, track: `Song ${i}` });
  await lookup({ ...MUSIC, track: 'Song 50' });
  assert.equal(calls.length, 51);
  await lookup({ ...MUSIC, track: 'Song 0' });
  assert.equal(calls.length, 52);
});
