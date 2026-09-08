import test from 'node:test';
import assert from 'node:assert/strict';
import { findAppIcon } from '../docs/.vitepress/theme/app-icon-catalog.js';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
function entry(overrides = {}) {
  return {
    app: 'Visual Studio Code', aliases: ['Code', 'VS Code'],
    imageUrl: 'https://s3-new.macosicons.com/icons/code.png',
    sourceUrl: 'https://macosicons.com/#/?icon=code',
    credit: 'Example Creator', creditUrl: 'https://macosicons.com/#/u/creator',
    fetchedAt: new Date(NOW - DAY).toISOString(), expiresAt: new Date(NOW + 29 * DAY).toISOString(),
    ...overrides,
  };
}
function catalog(...icons) { return { version: 1, icons }; }
function lookup(name, icon = entry(), now = NOW) { return findAppIcon(name, catalog(icon), now); }

test('matches only normalized exact application names and explicit aliases', () => {
  for (const name of ['Visual Studio Code', ' code ', ' ＶＳ\tＣＯＤＥ ', 'visual   studio code']) {
    const result = lookup(name);
    assert.equal(result.app, 'Visual Studio Code');
    assert.equal(result.imageUrl, entry().imageUrl);
    assert.equal(result.credit, 'Example Creator');
  }
  for (const name of ['Code Insiders', 'Studio', 'Visual Studio', 'Code.app', 42, null, undefined, '', ' \n\t ']) {
    assert.equal(lookup(name), null);
  }
});

test('System and prototype keys never resolve to an external image', () => {
  for (const name of ['System', ' ＳＹＳＴＥＭ ', '__proto__', 'constructor', 'prototype']) {
    assert.equal(lookup(name, entry({ aliases: [name] })), null);
  }
  for (const name of ['toString', 'hasOwnProperty']) assert.equal(lookup(name), null);
  assert.equal(findAppIcon('Code', Object.create(catalog(entry())), NOW), null);
  assert.equal(findAppIcon('Code', catalog(Object.create(entry())), NOW), null);
});

test('missing or malformed catalogs fall back without throwing', () => {
  for (const value of [null, undefined, {}, [], { version: 2, icons: [entry()] }, { version: 1, icons: {} }]) {
    assert.equal(findAppIcon('Code', value, NOW), null);
  }
  assert.equal(findAppIcon('Code', catalog(null, {}, { app: 42 }, entry({ aliases: null })), NOW), null);
  assert.equal(lookup('Visual Studio Code', entry({ aliases: null })).app, 'Visual Studio Code');
});

test('source links must use the exact official HTTPS host with no credentials or ports', () => {
  for (const sourceUrl of ['http://macosicons.com/icon', 'https://macosicons.com.evil.test/icon',
    'https://evil.test/macosicons.com', 'https://user@macosicons.com/icon',
    'https://user:pass@macosicons.com/icon', 'https://macosicons.com:443/icon',
    'https://macosicons.com:8443/icon', 'https://macosicons.com\\@evil.test/icon',
    'https://macosicons.com/\nicon', '//macosicons.com/icon', 'javascript:alert(1)', null]) {
    assert.equal(lookup('Code', entry({ sourceUrl })), null, String(sourceUrl));
  }
  const result = lookup('Code', entry({ sourceUrl: 'HTTPS://WWW.MACOSICONS.COM/#/icon/code' }));
  assert.equal(result.sourceUrl, 'https://www.macosicons.com/#/icon/code');
});

test('image URLs require the official storage host, HTTPS and no credentials or explicit ports', () => {
  for (const imageUrl of ['http://s3-new.macosicons.com/icon.png', 'data:image/svg+xml,test',
    'javascript:alert(1)', 'https://user@s3-new.macosicons.com/icon.png',
    'https://s3-new.macosicons.com:443/icon.png', 'https://s3-new.macosicons.com:8080/icon.png',
    'https://s3-new.macosicons.com/\nicon.png', 'https://s3-new.macosicons.com\\icon.png',
    'https://s3-new.macosicons.com.evil.test/icon.png', 'https://macosicons.com/icon.png',
    'https://images.example.test/icon.png', '', null]) {
    assert.equal(lookup('Code', entry({ imageUrl })), null, String(imageUrl));
  }
  const imageUrl = 'https://s3-new.macosicons.com/icons/code.png?key=a%2Fb&size=128&token=x+y';
  assert.equal(lookup('Code', entry({ imageUrl })).imageUrl, imageUrl);
});

test('only entries within their fetched-to-expiry interval of at most 30 days are served', () => {
  const item = entry();
  const fetched = Date.parse(item.fetchedAt);
  const expires = Date.parse(item.expiresAt);
  assert.ok(lookup('Code', item, fetched));
  assert.ok(lookup('Code', item, expires - 1));
  assert.equal(lookup('Code', item, fetched - 1), null);
  assert.equal(lookup('Code', item, expires), null);
  assert.equal(lookup('Code', entry({ expiresAt: new Date(expires + 1).toISOString() })), null);
  for (const field of ['fetchedAt', 'expiresAt']) {
    for (const value of [undefined, null, 'not-a-date', '09/08/2026', '2026-99-08T12:00:00Z']) {
      assert.equal(lookup('Code', entry({ [field]: value })), null);
    }
  }
  for (const now of [NaN, Infinity, -Infinity, '2026-09-08']) assert.equal(lookup('Code', item, now), null);
});

test('invalid records cannot hide a later valid exact match and returned records are independent', () => {
  const item = entry();
  const data = catalog(entry({ sourceUrl: 'https://evil.test/icon' }), item);
  const result = findAppIcon('Code', data, NOW);
  assert.equal(result.sourceUrl, item.sourceUrl);
  result.imageUrl = 'https://evil.test/replaced.png';
  assert.equal(findAppIcon('Code', data, NOW).imageUrl, item.imageUrl);
  assert.equal(lookup('Code', entry({ credit: null, creditUrl: 'javascript:alert(1)' })).creditUrl, null);
});

test('repository icons use fixed same-origin assets without a third-party cache deadline', () => {
  const local = { id: 'visual-studio-code', app: 'Visual Studio Code', aliases: ['Code'],
    source: 'installed-app', imageUrl: '/api/icons/visual-studio-code.png',
    sourceUrl: null, credit: 'Application publisher' };
  const icon = lookup('Code', local, NOW + 365 * DAY);
  assert.equal(icon.imageUrl, '/api/icons/visual-studio-code.png');
  assert.equal(icon.assetUrl, '/app-icons/visual-studio-code.png');
  assert.equal(icon.source, 'installed-app');
  assert.equal(icon.sourceUrl, null);
  assert.equal(icon.credit, 'Application publisher');
  assert.equal(lookup('System', { ...local, aliases: ['System'] }), null);
  for (const imageUrl of ['https://example.com/icon.png', '//example.com/icon.png', '/api/icons/other.png', '/app-icons/visual-studio-code.png', '/api/icons/visual-studio-code.svg']) {
    assert.equal(lookup('Code', { ...local, imageUrl }), null);
  }
  for (const id of ['../private', 'a/b', 'icon?key=test', '__proto__', '']) {
    assert.equal(lookup('Code', { ...local, id, imageUrl: `/api/icons/${id}.png` }), null);
  }
});
