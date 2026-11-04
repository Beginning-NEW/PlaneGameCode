import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [common, deploy, rollback, workflow, compose] = await Promise.all([
  readFile(new URL('../deploy/common.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/deploy.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/rollback.sh', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'),
  readFile(new URL('../compose.yaml', import.meta.url), 'utf8'),
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
  assert.match(deploy, /container_owned_by_run\(\)/);
  assert.match(deploy, /network_owned_by_run\(\)/);
  assert.match(deploy, /gateway_container_for_run\(\)/);
  assert.match(deploy, /docker rm -f "\$gateway_id"/);
  assert.match(deploy, /docker rm -f "\$candidate_id"/);
  assert.match(deploy, /docker network rm "\$network_id"/);
  assert.match(deploy, /restore_snapshot_route/);
  assert.doesNotMatch(deploy, /docker compose down/);
  assert.match(deploy, /network_id=\$\(docker network create/);
  assert.match(deploy, /candidate_id=\$\(docker run/);
  assert.match(deploy, /gateway_id=\$\(gateway_container_for_run/);
  assert.match(deploy, /gateway container already exists; refusing to adopt or remove it/);
  assert.match(deploy, /flock -n 9/);
  assert.match(rollback, /Only the recorded previous release must be healthy/);
  assert.doesNotMatch(rollback, /current version unhealthy/);
  assert.match(rollback, /restore_release_gateway_config/);
  assert.match(rollback, /duration_seconds/);
});

test('first-release resources carry a unique per-run ownership label', () => {
  assert.match(deploy, /PLANE_GAME_DEPLOYMENT_ID/);
  assert.match(deploy, /com\.plane-game\.deployment-id=\$deployment_id/);
  assert.match(common, /gateway_container_any_state/);
  assert.match(common, /gateway container exists but is stopped/);
  assert.match(compose, /com\.plane-game\.deployment-id/);
});
