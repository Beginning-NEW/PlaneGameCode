import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

const sha = 'a'.repeat(40);
const probe = (payload) =>
  spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
source deploy/common.sh
RELEASE_SHA=${sha}
docker() { printf %s ${Buffer.from(payload).toString('base64')} | base64 -d; }
verify_candidate_version candidate`,
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    },
  );

test('candidate version accepts an exact top-level full SHA', () => {
  const result = probe(JSON.stringify({ sha, build: 'trusted' }));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('candidate version rejects a SHA substring, nested SHA, wrong type, and malformed JSON', () => {
  for (const payload of [
    JSON.stringify({ sha: `prefix-${sha}-suffix` }),
    JSON.stringify({ metadata: { sha } }),
    JSON.stringify({ sha: [sha] }),
    `not-json-${sha}`,
  ]) {
    const result = probe(payload);
    assert.notEqual(result.status, 0, `unexpectedly accepted ${payload}`);
  }
});
