import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

test('poller activation and idempotent deactivation survive simulated host restarts', () => {
  const result = spawnSync('bash', ['tests/private-poller-activation.test.sh'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `activation harness failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /private poller persistent activation and deactivation test: PASS/);
});
