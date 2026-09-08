import { EMPTY_TTL_MS, SUCCESS_TTL_MS, matchedArtwork, normalized, safeAppleUrl } from '../shared/music-artwork.js';

const MAX_ENTRIES = 50;
const MAX_SEARCH_BYTES = 128 * 1024;

async function searchJson(response) {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SEARCH_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function validRecord(record, now) {
  if (!record || record.version !== 1 || !Number.isSafeInteger(record.expiresAt)
    || record.expiresAt <= now) return false;
  const value = record.value;
  const ttl = value === null ? EMPTY_TTL_MS : SUCCESS_TTL_MS;
  return record.expiresAt <= now + ttl && (value === null || (value
    && safeAppleUrl(value.artworkUrl, true) && safeAppleUrl(value.trackUrl, false)));
}

function copy(value) {
  return value ? { artworkUrl: value.artworkUrl, trackUrl: value.trackUrl } : null;
}

/** Cache public Apple catalogue matches only; device state always comes from KV. */
export function createMusicArtworkLookup({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  getCache = () => globalThis.caches?.default,
  timeoutMs = 4500,
} = {}) {
  const memory = new Map();
  const pending = new Map();

  function remember(key, record) {
    for (const [oldKey, entry] of memory) {
      if (entry.expiresAt <= now()) memory.delete(oldKey);
    }
    memory.delete(key);
    memory.set(key, record);
    while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
  }

  async function search(music, track, artist) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    const parameters = new URLSearchParams({
      term: `${music.track.trim()} ${music.artist.trim()}`,
      entity: 'song', country: 'us', limit: '5',
    });
    const request = (async () => {
      try {
        const response = await fetchImpl(`https://itunes.apple.com/search?${parameters}`, {
          method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
          // workerd accepts only follow/manual. searchJson rejects every 3xx.
          redirect: 'manual', signal: controller.signal,
        });
        return matchedArtwork(await searchJson(response), track, artist);
      } catch {
        return null;
      }
    })();
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolve(key, music, track, artist, origin) {
    let cache;
    let cacheRequest;
    try {
      const url = new URL(origin);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port) {
        cache = getCache();
        if (cache) {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
          const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
          // v2 discards negative entries from the unsupported redirect mode.
          cacheRequest = new Request(`${url.origin}/__macflare/artwork/v2/${hash}`);
          const cached = await cache.match(cacheRequest);
          if (cached) {
            const record = await cached.json();
            if (validRecord(record, now())) {
              remember(key, record);
              return copy(record.value);
            }
          }
        }
      }
    } catch {
      // Cache failure or local HTTP development must not prevent a lookup.
    }
    const value = await search(music, track, artist);
    const ttl = value ? SUCCESS_TTL_MS : EMPTY_TTL_MS;
    const record = { version: 1, expiresAt: now() + ttl, value: copy(value) };
    remember(key, record);
    if (cache && cacheRequest) {
      try {
        await cache.put(cacheRequest, new Response(JSON.stringify(record), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl / 1000}` },
        }));
      } catch {
        // The in-memory cache still reduces repeat searches if the edge is full.
      }
    }
    return copy(value);
  }

  return async function lookupMusicArtwork(music, { origin } = {}) {
    const track = normalized(music?.track);
    const artist = normalized(music?.artist);
    if (!['playing', 'paused'].includes(music?.state) || !track || !artist) return null;
    const key = JSON.stringify([track, artist]);
    const cached = memory.get(key);
    if (cached && validRecord(cached, now())) {
      memory.delete(key);
      memory.set(key, cached);
      return copy(cached.value);
    }
    memory.delete(key);
    if (pending.has(key)) return copy(await pending.get(key));
    if (pending.size >= MAX_ENTRIES) return null;
    const task = resolve(key, music, track, artist, origin);
    pending.set(key, task);
    try {
      return copy(await task);
    } finally {
      pending.delete(key);
    }
  };
}

export const lookupMusicArtwork = createMusicArtworkLookup();
