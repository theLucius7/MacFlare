import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApps, selectAppIcon, cachedAppIcon, hasNativeIcon, ICON_TTL_MS, REFRESH_WINDOW_MS } from '../scripts/app-icon-sync.mjs';
import { readFileSync } from 'node:fs';

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
  const apps = Array.from({ length: 129 }, (_, i) => ({ ...app, app: `App ${i}`, aliases: [`App ${i}`] }));
  assert.throws(() => validateApps({ version: 1, apps }));
  assert.equal(validateApps({ version: 1, apps: apps.slice(0, 128) }).length, 128);
});

test('all configured native app icons can skip third-party searches', () => {
  const apps = validateApps(JSON.parse(readFileSync(new URL('../config/app-icons.json', import.meta.url), 'utf8')));
  const catalog = JSON.parse(readFileSync(new URL('../docs/public/app-icons/index.json', import.meta.url), 'utf8'));
  assert.ok(apps.length > 0);
  for (const app of apps) assert.equal(hasNativeIcon(app, catalog), true, app.app);
  assert.equal(hasNativeIcon({ app: 'Unknown App' }, catalog), false);
  assert.equal(hasNativeIcon({ app: 'System' }, catalog), false);
});
