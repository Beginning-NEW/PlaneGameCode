import { spawnSync } from 'node:child_process';
const files = [
  'src/main.js',
  'src/game.js',
  'src/words.js',
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
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('JavaScript syntax verified');
