import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Stage B rollback deactivates the poller before gateway and controller', () => {
  const result = spawnSync('bash', ['tests/stage-b-disable.test.sh'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `disable harness failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /stage B disable order test: PASS/);
});
