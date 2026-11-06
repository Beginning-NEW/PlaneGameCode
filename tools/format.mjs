import { readFile, writeFile } from 'node:fs/promises';
const files = [
  'index.html',
  'src/main.js',
  'src/game.js',
  'src/words.js',
  'src/style.css',
  'tests/game.test.mjs',
  'tests/jenkins-webhook-admission.test.mjs',
  'tests/e2e/game.spec.mjs',
  'playwright.config.mjs',
  'ops/jenkins/webhook-admission.mjs',
  'ops/jenkins/webhook-gateway.mjs',
  'ops/jenkins/webhook-contract-dry-run.mjs',
  'tools/build.mjs',
  'tools/serve.mjs',
  'tools/lint.mjs',
  'tools/format.mjs',
];
let dirty = false;
for (const file of files) {
  const body = await readFile(file, 'utf8');
  const formatted = body.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');
  if (body !== formatted) { if (process.argv.includes('--check')) { console.error(`Formatting differs: ${file}`); dirty = true; } else await writeFile(file, formatted); }
}
if (dirty) process.exitCode = 1;
else console.log(process.argv.includes('--check') ? 'Formatting verified' : 'Formatting normalized');
