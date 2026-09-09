import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkMarkdownLinks, checkTrackedPaths, markdownTargets } from '../scripts/check-repository.mjs';

test('repository guard rejects local state and build paths while allowing examples and icons', () => {
  checkTrackedPaths(['.env.example', '.dev.vars.example', 'wrangler.jsonc', 'docs/public/app-icons/music.png']);
  for (const file of ['.dev.vars', '.env.production', 'wrangler.local.json', 'config/private.token', 'token', 'config/token', 'ingest-token', 'last-result.json', 'window-cache.json', 'work/upload.json', 'node_modules/pkg/index.js', 'docs/.vitepress/theme/app-icons.json', 'docs/.vitepress/dist/index.html']) {
    assert.throws(() => checkTrackedPaths([file]), /must not be tracked/u, file);
  }
});

test('Markdown examples are ignored while image links, reference definitions and titled links are inspected', () => {
  assert.deepEqual(markdownTargets([
    '[guide](guide.md "Read more") ![flow](assets/flow.svg)',
    '[download]: <openapi.yaml>',
    '`[inline example](not-a-file)`',
    '```md', '[sample](not-a-file)', '```',
    '~~~md', '[sample](not-a-file)', '~~~',
    '[space](<a file.md>)',
  ].join('\n')), ['guide.md', 'assets/flow.svg', 'a file.md', 'openapi.yaml']);
});

test('local links resolve from their page, support clean URLs and public assets, and reject broken or escaping targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'macflare-repo-'));
  try {
    mkdirSync(join(root, 'docs/public'), { recursive: true });
    writeFileSync(join(root, 'docs/guide.md'), '# Guide');
    writeFileSync(join(root, 'docs/public/icon.png'), 'fixture');
    writeFileSync(join(root, 'README.md'), '# Readme');
    const page = join(root, 'docs/index.md');
    writeFileSync(page, '[guide](guide.md#part) [clean](/guide) [asset](/icon.png) [root](../README.md) [external](https://example.test/)');
    assert.equal(checkMarkdownLinks(root, 'docs/index.md'), 4);
    writeFileSync(page, '[broken](missing.md)');
    assert.throws(() => checkMarkdownLinks(root, 'docs/index.md'), /broken local file link/u);
    writeFileSync(page, '[escape](../../private.md)');
    assert.throws(() => checkMarkdownLinks(root, 'docs/index.md'), /outside the repository/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
