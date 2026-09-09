import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = [
  'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
  'LICENSE', '.editorconfig', '.gitattributes', '.gitignore', '.nvmrc',
  '.github/workflows/ci.yml', '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/pull_request_template.md', 'agent/config.example.json', '.dev.vars.example',
  'wrangler.jsonc', 'docs/guide.md', 'docs/getting-started.md', 'docs/api.md',
  'docs/openapi.yaml', 'docs/public/app-icons/NOTICE.txt',
];

// This is a path guard, not a general secret scanner. Example files stay public.
export function checkTrackedPaths(files) {
  const privatePath = /(?:^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|wrangler\.local\..+|[^/]*\.token|token|cloudflare-api-token|ingest-token|macosicons-api-key|last-result\.json|(?:artwork|window)-cache\.json(?:\.tmp)?|window-lock)$/u;
  const generatedPath = /(?:^|\/)(?:node_modules|\.wrangler|coverage|work)\/|^docs\/\.vitepress\/(?:cache\/|dist\/|theme\/app-icons\.json(?:\.tmp)?$)/u;
  for (const file of files) {
    const example = /(?:^|\/)(?:\.env|\.dev\.vars)\.example$/u.test(file);
    assert.ok(example || !privatePath.test(file), `Local credentials/state must not be tracked: ${file}`);
    assert.ok(!generatedPath.test(file), `Generated/local files must not be tracked: ${file}`);
  }
}

// Cover inline links and reference definitions used by this repository. Fenced
// examples and inline code are excluded; this does not lint all Markdown syntax.
export function markdownTargets(markdown) {
  let fence = null;
  const prose = markdown.split('\n').map((line) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line;
  }).join('\n').replace(/(`+)[\s\S]*?\1/gu, '');
  return [
    ...prose.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/gu),
    ...prose.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gmu),
  ].map((match) => match[1] ?? match[2]);
}

export function checkMarkdownLinks(root, file) {
  let count = 0;
  for (const target of markdownTargets(readFileSync(resolve(root, file), 'utf8'))) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(target)) continue;
    const pathname = decodeURIComponent(target.split(/[?#]/u)[0]);
    if (!pathname) continue;
    const inDocs = file.startsWith('docs/');
    const base = target.startsWith('/') ? resolve(root, inDocs ? 'docs' : '.') : dirname(resolve(root, file));
    const path = resolve(base, pathname.replace(/^\//u, ''));
    assert.ok(path === root || path.startsWith(root + sep), `${file} links outside the repository: ${target}`);
    const candidates = [path];
    if (inDocs) candidates.push(`${path}.md`, resolve(path, 'index.md'));
    if (inDocs && target.startsWith('/')) candidates.push(resolve(root, 'docs/public', pathname.slice(1)));
    assert.ok(candidates.some(existsSync), `${file} contains a broken local file link: ${target}`);
    count++;
  }
  return count;
}

export function checkRepository(root = process.cwd()) {
  root = resolve(root);
  for (const file of required) assert.ok(existsSync(resolve(root, file)), `Required repository file is missing: ${file}`);
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  for (const field of ['name', 'version']) assert.equal(lock[field], pkg[field], `Lockfile ${field} differs from package.json`);
  assert.equal(lock.lockfileVersion, 3, 'Use the committed npm lockfile format.');
  for (const field of ['name', 'version', 'license', 'engines', 'dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.deepEqual(lock.packages[''][field], pkg[field], `Lockfile root ${field} differs from package.json`);
  }
  const gitFiles = (...args) => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  checkTrackedPaths(gitFiles('--cached'));
  const markdown = [...new Set(gitFiles('--cached', '--others', '--exclude-standard'))]
    .filter((file) => file.endsWith('.md') && (file.startsWith('docs/') || file.startsWith('.github/') || !file.includes('/')));
  const links = markdown.reduce((count, file) => count + checkMarkdownLinks(root, file), 0);
  console.log(`PASS: repository files, lockfile metadata, tracked paths, ${markdown.length} Markdown files and ${links} local file links`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkRepository();
