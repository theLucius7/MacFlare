import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve('docs/.vitepress/dist');
const api = new Set(['/api/batch', '/api/timeline', '/api/now', '/api/music', '/api/apps/active', '/api/apps/running', '/api/device', '/api/update', '/api/badge.svg', '/api/health', '/now', '/update', '/badge.svg', '/health']);
function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(join(folder, entry.name)) : [join(folder, entry.name)]);
}
assert.ok(existsSync(join(root, 'index.html')), 'Build the site before checking it.');
assert.ok(existsSync(join(root, 'openapi.yaml')), 'Public OpenAPI download is missing.');
const pages = walk(root).filter((file) => file.endsWith('.html'));
let checked = 0;
let anchors = 0;
const ids = new Map();
function pageIds(file) {
  if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\bid="([^"<>]+)"/g)].map((match) => match[1])));
  return ids.get(file);
}
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  for (const [, href] of html.matchAll(/(?:href|src)="([^"<>]+)"/g)) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
    const decoded = decodeURI(href.split(/[?#]/)[0]);
    if (api.has(decoded) || decoded === '/api/icons') continue;
    if (/^\/api\/icons\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/u.test(decoded)) {
      assert.ok(existsSync(join(root, 'app-icons', decoded.split('/').pop())), `Missing native icon: ${decoded}`);
      checked++;
      continue;
    }
    const pathname = !decoded ? relative(root, page) : decoded.startsWith('/') ? decoded.slice(1)
      : posix.join(posix.dirname(relative(root, page)), decoded);
    const candidates = [pathname, `${pathname}.html`, posix.join(pathname, 'index.html')];
    const destination = candidates.map((candidate) => join(root, candidate))
      .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    assert.ok(destination, `${relative(root, page)} contains broken link: ${href}`);
    const fragment = href.includes('#') ? decodeURIComponent(href.slice(href.indexOf('#') + 1)) : '';
    if (fragment && destination.endsWith('.html')) {
      assert.ok(pageIds(destination).has(fragment), `${relative(root, page)} contains broken anchor: ${href}`);
      anchors++;
    }
    checked++;
  }
}
assert.ok(readFileSync(join(root, 'index.html'), 'utf8').includes('Mac 当前状态'), 'Home status panel is missing.');
const icons = JSON.parse(readFileSync(join(root, 'app-icons/index.json'), 'utf8'));
assert.equal(icons.version, 1);
assert.ok(icons.icons.length > 0, 'The repository app icon collection is empty.');
for (const icon of icons.icons) {
  assert.equal(icon.source, 'installed-app');
  assert.match(icon.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  assert.equal(icon.imageUrl, `/api/icons/${icon.id}.png`);
  const bytes = readFileSync(join(root, 'app-icons', `${icon.id}.png`));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `Invalid PNG for ${icon.id}`);
  if (icon.sha256) assert.equal(createHash('sha256').update(bytes).digest('hex'), icon.sha256, `Icon checksum mismatch: ${icon.id}`);
}
console.log(`PASS: ${pages.length} static pages, ${checked} local asset/link references, ${anchors} anchors, ${icons.icons.length} native PNGs, and OpenAPI download`);
