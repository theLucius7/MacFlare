import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// Wrangler's locked development dependencies provide the real workerd runtime.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

test('artwork fetch options work in real workerd and reject redirects without external network access', async (t) => {
  const value = {
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/example/100x100bb.jpg',
    trackUrl: 'https://music.apple.com/us/album/example/123?i=456',
  };
  const bundled = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      contents: `
        import { createMusicArtworkLookup } from './worker/music-artwork.js';
        export default { async fetch(request) {
          const music = { state: 'playing', track: 'Example Song', artist: 'Example Artist' };
          const value = ${JSON.stringify(value)};
          const calls = [];
          const redirected = new URL(request.url).pathname === '/redirect';
          const lookup = createMusicArtworkLookup({
            now: () => 1000,
            getCache: () => undefined,
            fetchImpl: async (url, options) => {
              // This is workerd's native Request, not Node's implementation.
              // It rejects unsupported fetch options before the fixture runs.
              const upstream = new Request(url, options);
              calls.push({ url: upstream.url, method: upstream.method, redirect: upstream.redirect });
              return Response.json({ results: [{
                kind: 'song', trackName: music.track, artistName: music.artist,
                artworkUrl100: value.artworkUrl, trackViewUrl: value.trackUrl,
              }] }, redirected ? { status: 302, headers: { Location: 'https://untrusted.example/search' } } : {});
            },
          });
          return Response.json({
            value: await lookup(music, { origin: 'https://macflare.example' }), calls,
          });
        } }
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral',
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-09-08', script: bundled.outputFiles[0].text,
  }));
  t.after(() => runtime.dispose());

  for (const path of ['/match', '/redirect']) {
    const response = await runtime.dispatchFetch(`https://macflare.example${path}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.value, path === '/match' ? value : null);
    assert.equal(body.calls.length, 1);
    assert.equal(body.calls[0].method, 'GET');
    assert.equal(body.calls[0].redirect, 'manual');
    const url = new URL(body.calls[0].url);
    assert.equal(url.origin, 'https://itunes.apple.com');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      term: 'Example Song Example Artist', entity: 'song', country: 'us', limit: '5',
    });
  }
});
