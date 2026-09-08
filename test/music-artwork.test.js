import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtworkLookup, lookupArtwork } from '../docs/.vitepress/theme/music-artwork.js';

const ARTWORK = 'https://is1-ssl.mzstatic.com/image/thumb/Music/example/100x100bb.jpg';
const TRACK_URL = 'https://music.apple.com/us/album/example/123?i=456';
const MUSIC = { state: 'playing', track: 'Example Song', artist: 'Example Artist' };
const EXPECTED = { artworkUrl: ARTWORK, trackUrl: TRACK_URL };

function candidate(overrides = {}) {
  return { kind: 'song', trackName: MUSIC.track, artistName: MUSIC.artist,
    artworkUrl100: ARTWORK, trackViewUrl: TRACK_URL, ...overrides };
}

function response(results = [candidate()]) {
  return { ok: true, async json() { return { resultCount: results.length, results }; } };
}

function harness(implementation = async () => response()) {
  const calls = [];
  let time = 0;
  const lookup = createArtworkLookup({
    fetchImpl: async (...args) => { calls.push(args); return implementation(...args); },
    now: () => time,
  });
  return { calls, lookup, setTime(value) { time = value; } };
}

test('artwork lookup exports the browser function and skips stopped or incomplete metadata', async () => {
  assert.equal(typeof lookupArtwork, 'function');
  const { lookup, calls } = harness();
  for (const music of [null, {}, { ...MUSIC, state: 'stopped' }, { ...MUSIC, state: 'unavailable' },
    { ...MUSIC, track: '' }, { ...MUSIC, track: '  ' }, { ...MUSIC, artist: null },
    { ...MUSIC, artist: ' \n\t' }, { ...MUSIC, track: 42 }]) {
    assert.equal(await lookup(music), null);
  }
  assert.equal(calls.length, 0);
});

test('query parameters safely encode track/artist and use direct credential-free Apple GET', async () => {
  const track = '星空 & A+B / Café';
  const artist = 'Artist? #1';
  const { lookup, calls } = harness(async () => response([candidate({ trackName: track, artistName: artist })]));
  const controller = new AbortController();
  assert.deepEqual(await lookup({ state: 'paused', track, artist }, { signal: controller.signal }), EXPECTED);
  const [rawUrl, options] = calls[0];
  const url = new URL(rawUrl);
  assert.equal(url.origin, 'https://itunes.apple.com');
  assert.equal(url.pathname, '/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    term: `${track} ${artist}`, entity: 'song', country: 'us', limit: '5',
  });
  assert.equal(url.hash, '');
  assert.match(rawUrl, /%26/u);
  assert.match(rawUrl, /%2B/u);
  assert.deepEqual(options, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
});

test('matching checks normalized artist and title instead of taking the first result', async () => {
  const candidates = [
    candidate({ artistName: 'Another Artist', artworkUrl100: 'https://is1-ssl.mzstatic.com/wrong-artist.jpg' }),
    candidate({ trackName: 'Another Song', artworkUrl100: 'https://is1-ssl.mzstatic.com/wrong-song.jpg' }),
    candidate({ kind: 'music-video', artworkUrl100: 'https://is1-ssl.mzstatic.com/video.jpg' }),
    candidate({ trackName: ' ＥＸＡＭＰＬＥ   SONG ', artistName: ' example\tARTIST ' }),
  ];
  const { lookup } = harness(async () => response(candidates));
  assert.deepEqual(await lookup(MUSIC), EXPECTED);
});

test('a censored track title can match while the artist still must match', async () => {
  const { lookup } = harness(async () => response([
    candidate({ trackName: 'Explicit Word', trackCensoredName: 'E******t Word', artistName: 'Wrong Artist' }),
    candidate({ trackName: 'Explicit Word', trackCensoredName: 'E******t Word' }),
  ]));
  assert.deepEqual(await lookup({ ...MUSIC, track: 'E******t Word' }), EXPECTED);
});

test('an absent exact title/artist match resolves to null', async () => {
  const { lookup } = harness(async () => response([
    candidate({ trackName: 'Example Song (Live)' }),
    candidate({ artistName: 'Example Artist Tribute' }),
  ]));
  assert.equal(await lookup(MUSIC), null);
});

test('successful artwork uses the original API URL and stays cached for one hour', async () => {
  const { lookup, calls, setTime } = harness();
  const first = await lookup(MUSIC);
  assert.deepEqual(first, EXPECTED);
  first.artworkUrl = 'https://untrusted.example/changed.jpg';
  setTime(3_599_999);
  assert.deepEqual(await lookup({ state: 'paused', track: ' example  song ', artist: 'EXAMPLE ARTIST' }), EXPECTED);
  assert.equal(calls.length, 1);
  setTime(3_600_000);
  assert.deepEqual(await lookup(MUSIC), EXPECTED);
  assert.equal(calls.length, 2);
});

test('HTTP, JSON, network failures and empty or unmatched results cache null for five minutes', async () => {
  for (const implementation of [
    async () => ({ ok: false, status: 503 }),
    async () => { throw new TypeError('Network unavailable'); },
    async () => ({ ok: true, async json() { throw new SyntaxError('Malformed JSON'); } }),
    async () => response([]),
    async () => ({ ok: true, async json() { return {}; } }),
    async () => response([candidate({ artistName: 'Another artist' })]),
  ]) {
    const { lookup, calls, setTime } = harness(implementation);
    assert.equal(await lookup(MUSIC), null);
    setTime(299_999);
    assert.equal(await lookup(MUSIC), null);
    assert.equal(calls.length, 1);
    setTime(300_000);
    assert.equal(await lookup(MUSIC), null);
    assert.equal(calls.length, 2);
  }
});

test('pre-aborted requests and AbortError failures do not create a negative cache entry', async () => {
  const controller = new AbortController();
  controller.abort();
  const { lookup, calls } = harness();
  await assert.rejects(lookup(MUSIC, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await lookup(MUSIC), EXPECTED);

  let aborted = true;
  const other = harness(async () => {
    if (aborted) throw new DOMException('Cancelled', 'AbortError');
    return response();
  });
  await assert.rejects(other.lookup(MUSIC), { name: 'AbortError' });
  aborted = false;
  assert.deepEqual(await other.lookup(MUSIC), EXPECTED);
  assert.equal(other.calls.length, 2);
});

test('cancellation during response decoding cannot populate the cache with late artwork', async () => {
  const controller = new AbortController();
  let cancel = true;
  const { lookup, calls } = harness(async () => ({
    ok: true,
    async json() {
      if (cancel) controller.abort();
      return { results: [candidate()] };
    },
  }));
  await assert.rejects(lookup(MUSIC, { signal: controller.signal }), { name: 'AbortError' });
  cancel = false;
  assert.deepEqual(await lookup(MUSIC), EXPECTED);
  assert.equal(calls.length, 2);
});

test('unsafe artwork or track URLs are rejected and cached as no result', async () => {
  const unsafe = [
    { artworkUrl100: 'http://is1-ssl.mzstatic.com/cover.jpg' },
    { artworkUrl100: 'https://mzstatic.com/cover.jpg' },
    { artworkUrl100: 'https://.mzstatic.com/cover.jpg' },
    { artworkUrl100: 'https://is1-ssl.mzstatic.com.evil.example/cover.jpg' },
    { artworkUrl100: 'https://user:pass@is1-ssl.mzstatic.com/cover.jpg' },
    { artworkUrl100: 'https://is1-ssl.mzstatic.com:8443/cover.jpg' },
    { artworkUrl100: 'data:image/png;base64,abc' },
    { artworkUrl100: ' https://is1-ssl.mzstatic.com/cover.jpg' },
    { artworkUrl100: null },
    { trackViewUrl: 'http://itunes.apple.com/song/123' },
    { trackViewUrl: 'https://music.apple.com.evil.example/song/123' },
    { trackViewUrl: 'https://subdomain.music.apple.com/song/123' },
    { trackViewUrl: 'https://user:pass@itunes.apple.com/song/123' },
    { trackViewUrl: 'javascript:alert(1)' },
    { trackViewUrl: null },
  ];
  for (const urls of unsafe) {
    const { lookup, calls } = harness(async () => response([candidate(urls)]));
    assert.equal(await lookup(MUSIC), null, JSON.stringify(urls));
    assert.equal(await lookup(MUSIC), null);
    assert.equal(calls.length, 1);
  }
});

test('matching can skip an unsafe result and accepts exact Apple track-link hosts', async () => {
  for (const trackViewUrl of [TRACK_URL, 'https://itunes.apple.com/us/album/example/123?i=456']) {
    const { lookup } = harness(async () => response([
      candidate({ artworkUrl100: 'https://evil.example/cover.jpg' }),
      candidate({ trackViewUrl }),
    ]));
    assert.deepEqual(await lookup(MUSIC), { artworkUrl: ARTWORK, trackUrl: trackViewUrl });
  }
});

test('memory cache holds at most fifty successful or negative entries using least-recently-used eviction', async () => {
  for (const succeed of [true, false]) {
    const { lookup, calls } = harness(async (rawUrl) => {
      const term = new URL(rawUrl).searchParams.get('term');
      return response(succeed ? [candidate({ trackName: term.slice(0, -` ${MUSIC.artist}`.length) })] : []);
    });
    for (let index = 0; index < 50; index += 1) await lookup({ ...MUSIC, track: `Song ${index}` });
    assert.equal(calls.length, 50);
    await lookup({ ...MUSIC, track: 'Song 0' });
    assert.equal(calls.length, 50);
    await lookup({ ...MUSIC, track: 'Song 50' });
    assert.equal(calls.length, 51);
    await lookup({ ...MUSIC, track: 'Song 0' });
    assert.equal(calls.length, 51);
    await lookup({ ...MUSIC, track: 'Song 1' });
    assert.equal(calls.length, 52);
  }
});
