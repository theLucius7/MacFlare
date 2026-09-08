import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';

const root = resolve('docs/.vitepress/dist');
const api = new Set(['/api/now', '/api/update', '/api/badge.svg', '/api/health', '/now', '/update', '/badge.svg', '/health']);
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
    if (!decoded || api.has(decoded)) continue;
    const pathname = decoded.startsWith('/') ? decoded.slice(1)
      : posix.join(posix.dirname(relative(root, page)), decoded);
    const candidates = [pathname, `${pathname}.html`, posix.join(pathname, 'index.html')];
    assert.ok(candidates.some((candidate) => existsSync(join(root, candidate))), `${relative(root, page)} contains broken link: ${href}`);
    checked++;
  }
}
assert.ok(readFileSync(join(root, 'index.html'), 'utf8').includes('Mac 当前状态'), 'Home status panel is missing.');
console.log(`PASS: ${pages.length} static pages, ${checked} local asset/link references, and OpenAPI download`);
