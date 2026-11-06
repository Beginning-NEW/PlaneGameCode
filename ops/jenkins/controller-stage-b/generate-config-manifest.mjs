#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const directory = new URL('.', import.meta.url);
const rootPath = decodeURIComponent(directory.pathname).replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1));

async function walk(relative = '') {
  const entries = await readdir(new URL(relative || '.', directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && path !== 'config-files.sha256') files.push(path);
  }
  return files;
}

const files = (await walk()).sort();
const lines = [];
for (const file of files) {
  const bytes = await readFile(new URL(file, directory));
  lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
}
const manifest = `${lines.join('\n')}\n`;
await writeFile(new URL('config-files.sha256', directory), manifest);
console.log(JSON.stringify({ root: rootPath, files: files.length, sha256: createHash('sha256').update(manifest).digest('hex') }));
