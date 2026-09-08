import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  for (const [, href] of html.matchAll(/(?:href|src)="([^"<>]+)"/g)) {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
    const decoded = decodeURI(href.split(/[?#]/)[0]);
    if (!decoded || api.has(decoded) || decoded === '/api/icons') continue;
    if (/^\/api\/icons\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/u.test(decoded)) {
      assert.ok(existsSync(join(root, 'app-icons', decoded.split('/').pop())), `Missing native icon: ${decoded}`);
      checked++;
      continue;
    }
    const pathname = decoded.startsWith('/') ? decoded.slice(1)
      : posix.join(posix.dirname(relative(root, page)), decoded);
    const candidates = [pathname, `${pathname}.html`, posix.join(pathname, 'index.html')];
    assert.ok(candidates.some((candidate) => existsSync(join(root, candidate))), `${relative(root, page)} contains broken link: ${href}`);
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
console.log(`PASS: ${pages.length} static pages, ${checked} local asset/link references, ${icons.icons.length} native PNGs, and OpenAPI download`);
