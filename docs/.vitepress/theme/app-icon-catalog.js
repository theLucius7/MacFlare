const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RESERVED_NAMES = new Set(['system', '__proto__', 'prototype', 'constructor']);
const SOURCE_HOSTS = new Set(['macosicons.com', 'www.macosicons.com']);
const IMAGE_HOSTS = new Set(['s3-new.macosicons.com']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

function normalizeName(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase() : '';
}

function own(object, key) {
  return object !== null && typeof object === 'object' && Object.hasOwn(object, key);
}

function httpsUrl(value, allowedHosts) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  // URL.port omits an explicit default :443, so check the original authority too.
  const authority = /^https:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || authority.includes(':') || authority.includes('@')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (allowedHosts && !allowedHosts.has(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function timestamp(value) {
  return typeof value === 'string' && ISO_DATE.test(value) ? Date.parse(value) : NaN;
}

/** Return an exact, valid catalog match; unknown or expired applications use a local placeholder. */
export function findAppIcon(name, catalog, now = Date.now()) {
  const key = normalizeName(name);
  if (!key || RESERVED_NAMES.has(key) || !Number.isFinite(now)
    || !own(catalog, 'version') || catalog.version !== 1
    || !own(catalog, 'icons') || !Array.isArray(catalog.icons)) return null;

  for (const entry of catalog.icons) {
    if (!own(entry, 'app') || typeof entry.app !== 'string') continue;
    const names = [entry.app];
    if (own(entry, 'aliases') && Array.isArray(entry.aliases)) names.push(...entry.aliases);
    if (!names.some((candidate) => normalizeName(candidate) === key)) continue;

    const fetched = own(entry, 'fetchedAt') ? timestamp(entry.fetchedAt) : NaN;
    const expires = own(entry, 'expiresAt') ? timestamp(entry.expiresAt) : NaN;
    if (!Number.isFinite(fetched) || !Number.isFinite(expires)
      || now < fetched || now >= expires || expires - fetched > MAX_AGE_MS) continue;
    const imageUrl = own(entry, 'imageUrl') ? httpsUrl(entry.imageUrl, IMAGE_HOSTS) : null;
    const sourceUrl = own(entry, 'sourceUrl') ? httpsUrl(entry.sourceUrl, SOURCE_HOSTS) : null;
    if (!imageUrl || !sourceUrl) continue;
    return {
      app: entry.app.trim(),
      imageUrl,
      sourceUrl,
      credit: own(entry, 'credit') && typeof entry.credit === 'string' ? entry.credit.trim() : '',
      creditUrl: own(entry, 'creditUrl') ? httpsUrl(entry.creditUrl) : null,
      fetchedAt: entry.fetchedAt,
      expiresAt: entry.expiresAt,
    };
  }
  return null;
}
