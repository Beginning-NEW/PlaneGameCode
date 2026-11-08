import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('poller token create/rotate/prune/revoke lifecycle is executable and secret-safe', {
  skip: process.platform === 'win32',
}, () => {
  const result = spawnSync('bash', ['tests/poller-token-lifecycle.test.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /poller token lifecycle test: PASS/);
});
