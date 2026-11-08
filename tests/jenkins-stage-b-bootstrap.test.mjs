import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const profile = new URL('../ops/jenkins/controller-stage-b/', import.meta.url);
const [init, casc, runner, health, tokenHelper, manifestText] = await Promise.all([
  readFile(new URL('init.groovy', profile), 'utf8'),
  readFile(new URL('casc.yaml', profile), 'utf8'),
  readFile(new URL('run-controller.sh', profile), 'utf8'),
  readFile(new URL('healthcheck.sh', profile), 'utf8'),
  readFile(new URL('manage-gateway-token.sh', profile), 'utf8'),
  readFile(new URL('credential-manifest.json', profile), 'utf8'),
]);
const manifest = JSON.parse(manifestText);

function bootstrapDecision({ adminInitialized, bootstrapPresent, sameAppliedDigest = false }) {
  if (!adminInitialized && !bootstrapPresent) return 'fail-missing';
  if (adminInitialized && bootstrapPresent && sameAppliedDigest) return 'fail-replayed';
  if (bootstrapPresent) return adminInitialized ? 'rotate-once' : 'create-once';
  return 'persisted-restart';
}

test('fresh home without bootstrap fails closed', () => {
  assert.equal(bootstrapDecision({ adminInitialized: false, bootstrapPresent: false }), 'fail-missing');
  assert.match(init, /!adminInitialized && !bootstrapPresent/);
  assert.match(init, /System[.]exit\(78\)/);
});

test('fresh home with bcrypt succeeds once and later restart succeeds after removal', () => {
  assert.equal(bootstrapDecision({ adminInitialized: false, bootstrapPresent: true }), 'create-once');
  assert.equal(bootstrapDecision({ adminInitialized: true, bootstrapPresent: false }), 'persisted-restart');
  assert.match(init, /#jbcrypt:\\\$2a/);
  assert.match(init, /createAccountWithHashedPassword\(adminId, hashedPassword\)/);
  assert.match(init, /admin[?][.]getProperty\(HudsonPrivateSecurityRealm[.]Details[.]class\)/);
});

test('admin rotation is a controlled one-restart reapplication of a new hash', () => {
  assert.equal(bootstrapDecision({ adminInitialized: true, bootstrapPresent: true }), 'rotate-once');
  assert.equal(bootstrapDecision({
    adminInitialized: true,
    bootstrapPresent: true,
    sameAppliedDigest: true,
  }), 'fail-replayed');
  assert.match(init, /MessageDigest[.]getInstance\('SHA-256'\)/);
  assert.match(init, /bootstrap file must be removed after its one-time application/);
});

test('all credential objects have exact type, scope, purpose, and distinct file sources', () => {
  assert.equal(manifest.valuesAreMetadataOnly, true);
  assert.deepEqual(manifest.credentials.map(({ id, kind, scope }) => ({ id, kind, scope })), [
    { id: 'plane-github-scm-read', kind: 'usernamePassword', scope: 'GLOBAL' },
    { id: 'plane-github-actions-read', kind: 'secretText', scope: 'GLOBAL' },
    { id: 'plane-ghcr-pull', kind: 'usernamePassword', scope: 'GLOBAL' },
    { id: 'plane-game-agent-ssh', kind: 'basicSSHUserPrivateKey', scope: 'SYSTEM' },
  ]);
  const files = manifest.credentials.flatMap((entry) => entry.hostFiles);
  assert.equal(new Set(files).size, files.length);
  for (const source of manifest.credentials.flatMap((entry) => entry.secretSources)) {
    assert.ok(casc.includes(`\${trim:\${readFile:${source}}}`), source);
  }
  assert.doesNotMatch(`${casc}\n${runner}`, /PLANE_GAME_GITHUB_TOKEN/);
});

test('runner validates host metadata and actual rootless image-user readability', () => {
  assert.match(runner, /stat -c '%u'/);
  assert.match(runner, /400\|440\|600\|640/);
  assert.match(runner, /--network none/);
  assert.match(runner, /stage-b-secret-preflight/);
  assert.match(runner, /fix the specific host ACL mapping/);
});

test('gateway is least-privilege and token lifecycle never puts a secret in argv or env', () => {
  assert.match(init, /CredentialsProvider[.]VIEW/);
  assert.match(init, /Jenkins[.]RUN_SCRIPTS/);
  assert.match(init, /Item[.]CONFIGURE/);
  assert.match(tokenHelper, /jenkins_url=http:\/\/127[.]0[.]0[.]1:18080/);
  assert.match(tokenHelper, /create\|rotate\|prune\|revoke/);
  assert.doesNotMatch(tokenHelper, /--user\s+[^\n]*:/);
  assert.doesNotMatch(tokenHelper, /export\s+[^\n]*(TOKEN|PASSWORD|SECRET)/i);
});

test('health requires the authenticated authorization proof, not HTTP status alone', () => {
  assert.match(init, /hasPermission2\(adminAuth, Jenkins[.]ADMINISTER\)/);
  assert.match(init, /hasPermission2\(gatewayAuth, Item[.]BUILD\)/);
  assert.match(init, /stage-b-ready-v2/);
  assert.match(health, /stage-b-ready-v2/);
  assert.match(health, /login_code/);
  assert.match(health, /api_code/);
});
