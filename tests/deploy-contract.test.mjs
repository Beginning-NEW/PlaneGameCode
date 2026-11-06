import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const [common, deploy, rollback, checks, compose, promote, releaseOrder] = await Promise.all([
  readFile(new URL('../deploy/common.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/deploy.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/rollback.sh', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8'),
  readFile(new URL('../compose.yaml', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/promote.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/check-release-order.sh', import.meta.url), 'utf8'),
]);

test('deployment preflight is read-only and pins the approved revision and digest', () => {
  const preflight = common.match(/preflight_readonly\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(preflight, /verify_image_binding/);
  assert.doesNotMatch(preflight, /docker run|docker compose up|docker pull|nginx -s reload/);
  assert.match(common, /org\.opencontainers\.image\.revision/);
  assert.match(common, /python3 required for exact version[.]json validation/);
  assert.match(deploy, /APPROVED_IMAGE_DIGEST/);
});

test('first-release cleanup and rollback remain scoped to plane-game state', () => {
  assert.match(deploy, /candidate_owned_by_run\(\)/);
  assert.match(deploy, /candidate_container_for_run\(\)/);
  assert.match(deploy, /com\.plane-game\.deployment-id=\$deployment_id/);
  assert.match(deploy, /network_owned_by_run\(\)/);
  assert.match(deploy, /gateway_container_for_run\(\)/);
  assert.match(deploy, /revert_incomplete/);
  assert.doesNotMatch(deploy, /docker compose down/);
  assert.match(deploy, /flock -n 9/);
  assert.match(rollback, /Only the recorded previous release must be healthy/);
  assert.match(rollback, /restore_release_gateway_config/);
  assert.match(rollback, /duration_seconds/);
  assert.match(promote, /trap failed EXIT/);
  assert.match(releaseOrder, /Stale run number .* cannot supersede/);
  assert.match(releaseOrder, /rerun attempt .* cannot supersede/);
  assert.match(promote, /incoming\/\$sha-\$run-\$attempt/);
});

test('Checks is heavy CI and protected-main-only GHCR publication', () => {
  assert.match(checks, /pull_request:/);
  assert.match(checks, /push:\s+branches: \[main\]/);
  for (const command of ['pnpm lint', 'pnpm format --check', 'pnpm test', 'pnpm build', 'pnpm test:e2e']) {
    assert.ok(checks.includes(command), `missing Actions check: ${command}`);
  }
  const publish = checks.split(/^  publish:$/m)[1] ?? '';
  assert.match(publish, /github[.]event_name == 'push'/);
  assert.match(publish, /github[.]ref == 'refs\/heads\/main'/);
  assert.match(publish, /github[.]repository == 'Beginning-NEW\/PlaneGameCode'/);
  assert.match(publish, /packages: write/);
  assert.match(publish, /docker push "\$image_repository:\$GITHUB_SHA"/);
  assert.match(publish, /expected_version=\$\(printf '\{"sha":"%s"\}' "\$GITHUB_SHA"\)/);
  assert.match(publish, /release-candidate-\$\{\{ github[.]sha \}\}/);
  assert.match(publish, /image_digest.*gateway_image.*run_id/s);
  assert.doesNotMatch(publish, /ssh|DEPLOY_HOST|DEPLOY_SSH/);
});

test('legacy Actions CD is absent so Jenkins is the sole automatic deploy path', async () => {
  await assert.rejects(access(new URL('../.github/workflows/deploy.yml', import.meta.url)));
});

test('Compose gateway and recorded rollback state use immutable reviewed digests', () => {
  assert.match(compose, /image: \$\{GATEWAY_IMAGE:\?/);
  assert.match(common, /docker compose config --images/);
  assert.match(common, /running gateway differs from approved digest/);
  assert.match(common, /printf 'GATEWAY_IMAGE=%s/);
  assert.match(rollback, /verify_gateway_binding/);
});
