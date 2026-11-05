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
  assert.match(workflow, /NODE_BASE_IMAGE: \$\{\{ vars[.]NODE_BASE_IMAGE \}\}/);
  assert.match(workflow, /docker build --platform linux\/amd64 --build-arg "NODE_BASE_IMAGE=\$NODE_BASE_IMAGE"/);
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

test('archived host preflight enforces a dedicated unprivileged rootless identity before any transfer', async () => {
  const hostGate = await readFile(new URL('../deploy/plane-preflight', import.meta.url), 'utf8');
  assert.match(workflow, /git archive --format=tar.gz --output=release.tar.gz "\$VERIFIED_SHA" compose.yaml deploy/);
  const gateCall = workflow.indexOf('tar -xOf release.tar.gz deploy/plane-preflight | ssh');
  assert.ok(gateCall > workflow.indexOf('sha256sum release.tar.gz'));
  for (const later of ['scp "${ssh_opts[@]}"', "docker login ghcr.io -u '$GITHUB_ACTOR'", "docker pull '$repo@$IMAGE_DIGEST'"]) {
    assert.ok(workflow.indexOf(later) > gateCall, `${later} must happen after preflight`);
  }
  assert.match(workflow, /test "\$DEPLOY_USER" = plane-preflight/);
  assert.match(workflow, /PasswordAuthentication=no/);
  assert.match(workflow, /KbdInteractiveAuthentication=no/);
  assert.match(hostGate, /id -un.*plane-preflight/);
  assert.match(hostGate, /id -u/);
  assert.match(hostGate, /docker\|sudo\|wheel\|admin/);
  assert.match(hostGate, /sudo -n -l/);
  assert.match(hostGate, /cannot prove absence of sudo entitlement/);
  assert.match(hostGate, /\/var\/run\/docker[.]sock/);
  assert.match(hostGate, /-S "\$socket" && -O "\$socket" && -w "\$socket"/);
  assert.match(hostGate, /docker --host "unix:\/\/\$socket" info/);
  assert.match(hostGate, /rootless/);
});

test('deploy reads GHCR with only the run-scoped token and removes remote Docker credentials', () => {
  const deployJob = workflow.split(/^  deploy:$/m)[1];
  assert.ok(deployJob, 'deploy job must exist');
  assert.match(deployJob, /permissions:\s+contents: read\s+actions: read\s+packages: read/);
  assert.match(deployJob, /GH_TOKEN: \$\{\{ github[.]token \}\}/);
  assert.doesNotMatch(deployJob, /GHCR_READ_TOKEN|GHCR_READ_USER/);
  assert.match(deployJob, /docker_config=\\\$\(mktemp -d/);
  assert.match(deployJob, /export DOCKER_CONFIG=/);
  assert.match(deployJob, /trap 'rm -rf -- .*docker_config.*' EXIT/);
  assert.ok(deployJob.indexOf('sha256sum -c -') < deployJob.indexOf('docker login ghcr.io'));
  assert.ok(deployJob.indexOf('docker login ghcr.io') < deployJob.indexOf("docker pull '$repo@$IMAGE_DIGEST'"));
});

test('Compose gateway is bound to the reviewed digest in rendered config and rollback state', () => {
  assert.match(compose, /image: \$\{GATEWAY_IMAGE:\?/);
  assert.doesNotMatch(compose, /image: nginxinc\/nginx-unprivileged:1[.]29-alpine\s*$/m);
  assert.match(workflow, /gateway_image="\$\{NGINX_BASE_IMAGE\/:1[.]29-alpine@\/@\}"/);
  assert.match(workflow, /gateway_image: \$\{\{ steps[.]image[.]outputs[.]gateway_image \}\}/);
  assert.match(workflow, /docker pull '\$GATEWAY_IMAGE'/);
  assert.match(common, /images=\$\(docker compose config --images\)/);
  assert.match(common, /\[\[ "\$images" == "\$GATEWAY_IMAGE" \]\]/);
  assert.match(common, /running gateway differs from approved digest/);
  assert.match(common, /printf 'GATEWAY_IMAGE=%s/);
  assert.match(common, /gateway_image=%s/);
  assert.match(common, /gateway_image=\$\(record_value "\$record" GATEWAY_IMAGE\)/);
  assert.match(rollback, /verify_gateway_binding/);
});
