import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [common, deploy, rollback, workflow] = await Promise.all([
  readFile(new URL('../deploy/common.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/deploy.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/rollback.sh', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'),
]);

test('deployment preflight is metadata-only and pins digest to the approved revision', () => {
  const preflight = common.match(/preflight_readonly\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(preflight, /verify_image_binding/);
  assert.doesNotMatch(preflight, /docker run|docker compose up|docker pull|nginx -s reload/);
  assert.match(common, /org\.opencontainers\.image\.revision/);
  assert.match(deploy, /APPROVED_IMAGE_DIGEST/);
  assert.match(workflow, /docker pull '\$repo@\$image_digest'/);
});

test('first-release cleanup and failure rollback are scoped to plane-game state', () => {
  assert.match(deploy, /docker compose rm -sf gateway/);
  assert.match(deploy, /docker rm -f "\$container"/);
  assert.match(deploy, /docker network rm plane-game_default/);
  assert.match(deploy, /restore_snapshot_route/);
  assert.doesNotMatch(deploy, /docker compose down/);
  assert.match(rollback, /Only the recorded previous release must be healthy/);
  assert.doesNotMatch(rollback, /current version unhealthy/);
  assert.match(rollback, /restore_release_gateway_config/);
  assert.match(rollback, /duration_seconds/);
});
