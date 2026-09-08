import { findAppIcon } from '../docs/.vitepress/theme/app-icon-catalog.js';

export const ICON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const normalized = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 300) : '';

export function validateApps(config) {
  if (config?.version !== 1 || !Array.isArray(config.apps) || config.apps.length > 32) throw new Error('Expected version 1 and at most 32 configured apps.');
  const names = new Set();
  for (const app of config.apps) {
    if (![app?.app, app?.query].every(value => typeof value === 'string' && value.trim() && value.length <= 100)
      || ![app.aliases, app.matchNames].every(list => Array.isArray(list) && list.length > 0 && list.length <= 20
        && list.every(value => typeof value === 'string' && value.trim() && value.length <= 100))) throw new Error('Each app needs app, query, aliases and matchNames.');
    for (const alias of new Set([app.app, ...app.aliases].map(normalized))) {
      if (['system', '__proto__', 'constructor', 'prototype'].includes(alias) || names.has(alias)) throw new Error('App aliases must be unique and must not include reserved names.');
      names.add(alias);
    }
  }
  return config.apps;
}

export function selectAppIcon(body, app, now) {
  if (!Array.isArray(body?.hits)) return null;
  const accepted = app.matchNames.map(normalized);
  for (const hit of body.hits.slice(0, 20)) {
    if (!accepted.includes(normalized(hit?.appName))) continue;
    const id = typeof hit.objectID === 'string' && /^[a-zA-Z0-9_-]+$/u.test(hit.objectID) ? hit.objectID : null;
    const slug = typeof hit.appSlug === 'string' && /^[a-zA-Z0-9_-]+$/u.test(hit.appSlug) ? hit.appSlug : null;
    const uploadedBy = text(hit.uploadedBy);
    let uploader = uploadedBy;
    if (/^https?:/u.test(uploader)) {
      try { uploader = decodeURIComponent(new URL(uploader).href.split('/').filter(Boolean).pop()); } catch { uploader = ''; }
    }
    const entry = {
      app: app.app, aliases: [...app.aliases], imageUrl: hit.lowResPngUrl,
      sourceUrl: id && slug ? `https://macosicons.com/icon/${slug}-${id}` : 'https://macosicons.com/',
      credit: text(hit.credit) || text(hit.usersName) || text(uploader),
      creditUrl: text(hit.creditUrl) || (/^https:/u.test(uploadedBy) ? uploadedBy : null),
      fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + ICON_TTL_MS).toISOString(),
    };
    const checked = findAppIcon(app.app, { version: 1, icons: [entry] }, now);
    if (checked) return { ...entry, ...checked, aliases: [...entry.aliases] };
  }
  return null;
}

export function cachedAppIcon(catalog, app, now) {
  const icon = findAppIcon(app.app, catalog, now);
  if (!icon || Date.parse(icon.expiresAt) - now <= REFRESH_WINDOW_MS) return null;
  return { ...icon, aliases: [...app.aliases] };
}
