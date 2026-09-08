import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { validateApps, selectAppIcon, cachedAppIcon, hasNativeIcon } from './app-icon-sync.mjs';
import { findAppIcon } from '../docs/.vitepress/theme/app-icon-catalog.js';

async function main() {
  const args = process.argv.slice(2);
  let keyFile;
  let force = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--key-file' && args[index + 1]) keyFile = args[++index];
    else if (args[index] === '--force') force = true;
    else if (args[index] === '--help') {
      console.log('Usage: npm run icons:sync -- --key-file /path/to/key [--force]\nAlternatively set MACOSICONS_API_KEY. Native icons are always skipped. Provider matches are reused until their final 2 days unless --force is set.');
      return;
    } else throw new Error('Unknown option. Run icons:sync -- --help.');
  }
  const apiKey = (keyFile ? await readFile(keyFile, 'utf8') : process.env.MACOSICONS_API_KEY || '').trim();
  if (!apiKey || /\s/u.test(apiKey)) throw new Error('Provide a valid macOSicons API key via --key-file or MACOSICONS_API_KEY.');
  const apps = validateApps(JSON.parse(await readFile(new URL('../config/app-icons.json', import.meta.url), 'utf8')));
  let native = { version: 1, icons: [] };
  try { native = JSON.parse(await readFile(new URL('../docs/public/app-icons/index.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read the native app icon catalog.'); }
  const destination = new URL('../docs/.vitepress/theme/app-icons.json', import.meta.url);
  const temporary = new URL('./app-icons.json.tmp', destination);
  let old = { version: 1, icons: [] };
  try { old = JSON.parse(await readFile(destination, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read local app icon cache.'); }
  if (old.version !== 1 || !Array.isArray(old.icons)) throw new Error('Unsupported local app icon cache.');
  const catalog = { version: 1, icons: apps.flatMap(app => {
    const icon = findAppIcon(app.app, old);
    return icon ? [{ ...icon, aliases: [...app.aliases] }] : [];
  }) };
  async function save() {
    await mkdir(new URL('.', destination), { recursive: true });
    await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n');
    await rename(temporary, destination);
  }
  let searches = 0;
  for (const app of apps) {
    if (hasNativeIcon(app, native)) {
      console.log(`Native: ${app.app}`);
      continue;
    }
    if (!force && cachedAppIcon(catalog, app, Date.now())) {
      console.log(`Cached: ${app.app}`);
      continue;
    }
    // No automatic retries: each search consumes the provider's monthly quota.
    const response = await fetch('https://api.macosicons.com/api/v1/search', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ query: app.query, searchOptions: { hitsPerPage: 20, sort: ['downloads:desc'] } }),
    });
    searches++;
    if (!response.ok) throw new Error(`macOSicons search returned HTTP ${response.status}; stopping without retries.`);
    const icon = selectAppIcon(await response.json(), app, Date.now());
    if (icon) {
      catalog.icons = [...catalog.icons.filter(entry => entry.app !== app.app), icon];
      console.log(`Matched: ${app.app}`);
    } else console.log(`No exact match: ${app.app}; keeping an unexpired icon or the placeholder.`);
    // Persist progress after each response so an interrupted run reuses successes.
    await save();
  }
  await save();
  console.log(`Ready: ${catalog.icons.length} app mappings; ${searches} search requests. Run npm run deploy to publish.`);
}

main().catch(() => {
  // Do not print upstream errors or response bodies that may include credentials.
  console.error('Icon sync failed. Check the key file, configured app names, network and macOSicons usage. Cached progress is preserved.');
  process.exitCode = 1;
});
