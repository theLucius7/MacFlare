import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { findAppIcon } from '../docs/.vitepress/theme/app-icon-catalog.js';

const target = new URL('../docs/.vitepress/theme/app-icons.json', import.meta.url);
let catalog;
try {
  catalog = JSON.parse(await readFile(target, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Invalid local app icon cache; run icons:sync to rebuild it.');
  catalog = { version: 1, icons: [] };
}
if (catalog.version !== 1 || !Array.isArray(catalog.icons)) throw new Error('Unsupported app icon cache.');
const now = Date.now();
const valid = catalog.icons.filter(icon => findAppIcon(icon?.app, { version: 1, icons: [icon] }, now));
await mkdir(new URL('.', target), { recursive: true });
await writeFile(target, JSON.stringify({ version: 1, icons: valid }, null, 2) + '\n');
console.log(`App icons: ${valid.length} unexpired mappings; missing icons use the built-in placeholder.`);
