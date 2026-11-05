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
  assert.match(workflow, /docker pull '\$repo@\$IMAGE_DIGEST'/);
});

test('first-release cleanup and failure rollback are scoped to plane-game state', () => {
  const candidateOwnership = deploy.match(/candidate_owned_by_run\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const candidateDiscovery = deploy.match(/candidate_container_for_run\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(deploy, /candidate_owned_by_run\(\)/);
  assert.match(deploy, /candidate_container_for_run\(\)/);
  assert.match(candidateOwnership, /com\.plane-game\.image-digest/);
  assert.match(candidateOwnership, /\$id \$deployment_id \$RELEASE_SHA \$IMAGE_DIGEST/);
  assert.match(candidateDiscovery, /candidate container digest label mismatch/);
  assert.match(candidateDiscovery, /return 1/);
  assert.match(deploy, /network_for_run\(\)/);
  assert.match(deploy, /revert_incomplete/);
  assert.match(deploy, /network_owned_by_run\(\)/);
  assert.match(deploy, /gateway_container_for_run\(\)/);
  assert.match(deploy, /docker rm -f "\$gateway_id"/);
  assert.match(deploy, /docker rm -f "\$candidate_id"/);
  assert.match(deploy, /docker network rm "\$network_id"/);
  assert.match(deploy, /candidate_removed=false/);
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

test('automatic release is gated on successful push CI and transports matching source', async () => {
  const promote = await readFile(new URL('../deploy/promote.sh', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_run:\s+workflows: \[Checks\]/);
  assert.match(workflow, /workflow_run.conclusion == 'success'/);
  assert.match(workflow, /workflow_run.event == 'push'/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /git archive --format=tar.gz --output=release.tar.gz "\$VERIFIED_SHA" compose.yaml deploy/);
  assert.match(workflow, /sha256sum -c -/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /DOCKER_HOST=unix:\/\/\/run\/user/);
  assert.match(promote, /grep -q rootless/);
  assert.match(promote, /last_run_number/);
  assert.match(promote, /Stale run .* cannot supersede run/);
  assert.match(promote, /trap failed EXIT/);
  assert.match(common, /\$url\/healthz/);
  assert.match(common, /\$url\/"/);
  assert.match(common, /\$url\/version.json/);
  assert.match(deploy, /previous healthy route could not be verified after recovery/);
});
