import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

test('fixed preflight sudo exception remains fail closed', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(
    'python3',
    ['-m', 'unittest', 'tests/test_preflight_sudo_policy.py'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
