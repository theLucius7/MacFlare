import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApps, selectAppIcon, cachedAppIcon, ICON_TTL_MS, REFRESH_WINDOW_MS } from '../scripts/app-icon-sync.mjs';

const now = Date.parse('2026-09-08T00:00:00Z');
const app = { app: 'Example App', query: 'Example', aliases: ['Example'], matchNames: ['Example App'] };
const hit = { appName: 'Example App', appSlug: 'example', objectID: 'abc123', lowResPngUrl: 'https://s3-new.macosicons.com/example.png', credit: null, usersName: 'Icon Author', uploadedBy: 'https://macosicons.com/u/author' };

test('sync matches app identity instead of blindly picking a popular unrelated icon', () => {
  const result = selectAppIcon({ hits: [{ ...hit, appName: 'Other App' }, hit] }, app, now);
  assert.equal(result.credit, 'Icon Author');
  assert.equal(result.creditUrl, 'https://macosicons.com/u/author');
  assert.equal(result.sourceUrl, 'https://macosicons.com/icon/example-abc123');
  assert.equal(Date.parse(result.expiresAt) - Date.parse(result.fetchedAt), ICON_TTL_MS);
  assert.equal(selectAppIcon({ hits: [{ ...hit, appName: 'Example App Pro' }] }, app, now), null);
});

test('sync preserves explicit creator attribution and rejects unsupported image hosts', () => {
  assert.equal(selectAppIcon({ hits: [{ ...hit, credit: 'Original Creator', creditUrl: 'https://example.com/author' }] }, app, now).credit, 'Original Creator');
  assert.equal(selectAppIcon({ hits: [{ ...hit, lowResPngUrl: 'https://untrusted.example/icon.png' }] }, app, now), null);
});

test('cache reuse never extends provider retention and refreshes in its final two days', () => {
  const icon = selectAppIcon({ hits: [hit] }, app, now);
  const catalog = { version: 1, icons: [icon] };
  assert.equal(cachedAppIcon(catalog, app, now + 10000).expiresAt, icon.expiresAt);
  assert.equal(cachedAppIcon(catalog, app, now + ICON_TTL_MS - REFRESH_WINDOW_MS), null);
  assert.equal(cachedAppIcon(catalog, app, now + ICON_TTL_MS), null);
});

test('configuration rejects ambiguous, private and oversized query sets', () => {
  assert.deepEqual(validateApps({ version: 1, apps: [app] }), [app]);
  assert.throws(() => validateApps({ version: 1, apps: [app, { ...app, app: 'Second App' }] }));
  assert.throws(() => validateApps({ version: 1, apps: [{ ...app, aliases: ['System'] }] }));
  assert.throws(() => validateApps({ version: 1, apps: Array.from({ length: 33 }, () => app) }));
});
