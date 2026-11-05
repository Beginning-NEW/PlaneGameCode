import { mkdir, copyFile, writeFile } from 'node:fs/promises';
for (const dir of ['dist', 'dist/src']) await mkdir(dir, { recursive: true });
for (const file of ['index.html', 'src/main.js', 'src/game.js', 'src/words.js', 'src/style.css']) await copyFile(file, `dist/${file}`);
await writeFile('dist/version.json', JSON.stringify({ sha: process.env.GIT_SHA || 'local' }));
console.log('Built static site in dist/');
