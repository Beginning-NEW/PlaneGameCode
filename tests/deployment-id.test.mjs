import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

function findBash() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH;
  if (process.platform !== 'win32') return 'bash';
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout
    .split(/\r?\n/)
    .find(Boolean);
  if (git) {
    const candidate = join(dirname(dirname(git)), 'bin', 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

const bash = findBash();
const sha = '5'.repeat(40);

function isValid(deploymentId, expectedSha = sha) {
  return spawnSync(
    bash,
    ['-c', 'source deploy/deployment-id.sh; valid_deployment_id "$1" "$2"', 'deployment-id-test', deploymentId, expectedSha],
    { cwd: root, encoding: 'utf8' },
  ).status === 0;
}

test('deployment ID validator accepts canonical UTC calendar values and bounded PIDs', () => {
  for (const deploymentId of [
    `${sha.slice(0, 12)}-20000229T235959Z-1`,
    `${sha.slice(0, 12)}-20240229T000000Z-4194304`,
    `${sha.slice(0, 12)}-20260430T120305Z-999`,
    `${sha.slice(0, 12)}-20261231T235959Z-42`,
  ]) {
    assert.equal(isValid(deploymentId), true, deploymentId);
  }
});

test('deployment ID validator rejects impossible UTC dates and times', () => {
  for (const timestamp of [
    '19000229T000000Z',
    '20230229T000000Z',
    '20260431T000000Z',
    '20261301T000000Z',
    '20261106T240000Z',
    '20261106T236000Z',
    '20261106T235960Z',
  ]) {
    assert.equal(isValid(`${sha.slice(0, 12)}-${timestamp}-99`), false, timestamp);
  }
});

test('deployment ID validator rejects noncanonical and out-of-range PIDs', () => {
  for (const pid of ['0', '01', '4194305', '9'.repeat(1024)]) {
    assert.equal(isValid(`${sha.slice(0, 12)}-20261106T120000Z-${pid}`), false, pid.slice(0, 32));
  }
});

test('deployment ID validator binds the prefix to a well-formed full SHA', () => {
  const validId = `${sha.slice(0, 12)}-20261106T120000Z-99`;
  assert.equal(isValid(`${'f'.repeat(12)}-20261106T120000Z-99`), false);
  for (const malformedSha of ['', '5'.repeat(39), '5'.repeat(41), 'G'.repeat(40), 'A'.repeat(40)]) {
    assert.equal(isValid(validId, malformedSha), false, malformedSha);
  }
});
