const SUCCESS_TTL_MS = 60 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;

function normalized(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
    : '';
}

function safeAppleUrl(value, artwork) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return artwork ? url.hostname.length > '.mzstatic.com'.length && url.hostname.endsWith('.mzstatic.com')
      : ['itunes.apple.com', 'music.apple.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Artwork lookup aborted', 'AbortError');
}

function matchedArtwork(body, track, artist) {
  if (!Array.isArray(body?.results)) return null;
  for (const candidate of body.results.slice(0, 5)) {
    if (candidate?.kind !== 'song' || normalized(candidate.artistName) !== artist
      || ![candidate.trackName, candidate.trackCensoredName].some((name) => normalized(name) === track)
      || !safeAppleUrl(candidate.artworkUrl100, true)
      || !safeAppleUrl(candidate.trackViewUrl, false)) continue;
    // Use the URL Apple returned; do not invent other artwork resolutions.
    return { artworkUrl: candidate.artworkUrl100, trackUrl: candidate.trackViewUrl };
  }
  return null;
}

/**
 * Create an isolated artwork lookup/cache. Ordinary failures resolve to null;
 * cancellation rejects with AbortError and never creates a cache entry.
 */
export function createArtworkLookup({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();

  function remember(key, value) {
    const time = now();
    for (const [cachedKey, entry] of cache) {
      if (entry.expiresAt <= time) cache.delete(cachedKey);
    }
    cache.delete(key);
    cache.set(key, { value, expiresAt: time + (value ? SUCCESS_TTL_MS : EMPTY_TTL_MS) });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  return async function lookup(music, { signal } = {}) {
    const track = normalized(music?.track);
    const artist = normalized(music?.artist);
    if (!['playing', 'paused'].includes(music?.state) || !track || !artist) return null;
    checkAbort(signal);
    const key = JSON.stringify([track, artist]);
    const cached = cache.get(key);
    if (cached && now() < cached.expiresAt) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.value ? { ...cached.value } : null;
    }
    cache.delete(key);
    const parameters = new URLSearchParams({
      term: `${music.track.trim()} ${music.artist.trim()}`,
      entity: 'song', country: 'us', limit: '5',
    });
    try {
      const response = await fetchImpl(`https://itunes.apple.com/search?${parameters}`, {
        method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
        redirect: 'error', signal,
      });
      checkAbort(signal);
      if (!response.ok) throw new Error('Artwork request failed');
      const body = await response.json();
      checkAbort(signal);
      const value = matchedArtwork(body, track, artist);
      remember(key, value);
      return value ? { ...value } : null;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        throw new DOMException('Artwork lookup aborted', 'AbortError');
      }
      remember(key, null);
      return null;
    }
  };
}

export const lookupArtwork = createArtworkLookup();
