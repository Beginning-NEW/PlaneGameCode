import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertStageBContract } from '../ops/jenkins/controller-stage-b/validate-contract.mjs';

const profile = new URL('../ops/jenkins/controller-stage-b/', import.meta.url);

function dataLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

function parseDirect(text) {
  return new Map(dataLines(text).map((line) => {
    const separator = line.indexOf(':');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function parseLock(text) {
  return new Map(dataLines(text).map((line) => {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    return [line.slice(0, first), {
      version: line.slice(first + 1, second),
      sha256: line.slice(second + 1),
    }];
  }));
}

async function walk(relative = '') {
  const entries = await readdir(new URL(relative || '.', profile), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && path !== 'config-files.sha256') files.push(path);
  }
  return files;
}

const scriptNames = [
  'build-image.sh',
  'generate-admin-bootstrap.sh',
  'run-controller.sh',
  'manage-actions-poller.sh',
  'disable-stage-b.sh',
  'backup-home.sh',
  'restore-home.sh',
  'rollback-stage-b.sh',
];
const [runtimeText, dockerfile, casc, job, gateway, directText, lockText, installText,
  hashesText, snapshotText, supplementsText, provenanceText, manifestText, rollback,
  init, health, tokenHelper, credentialManifestText, ...scriptTexts] = await Promise.all([
  readFile(new URL('runtime-manifest.json', profile), 'utf8'),
  readFile(new URL('Dockerfile', profile), 'utf8'),
  readFile(new URL('casc.yaml', profile), 'utf8'),
  readFile(new URL('plane-game-job.groovy', profile), 'utf8'),
  readFile(new URL('systemd-user/plane-game-webhook-gateway.service', profile), 'utf8'),
  readFile(new URL('direct-plugins.txt', profile), 'utf8'),
  readFile(new URL('plugins.lock', profile), 'utf8'),
  readFile(new URL('plugins.install.txt', profile), 'utf8'),
  readFile(new URL('plugins.sha256', profile), 'utf8'),
  readFile(new URL('update-center.snapshot.json', profile), 'utf8'),
  readFile(new URL('plugin-supplements.json', profile), 'utf8'),
  readFile(new URL('plugin-lock.provenance.json', profile), 'utf8'),
  readFile(new URL('config-files.sha256', profile), 'utf8'),
  readFile(new URL('ROLLBACK.md', profile), 'utf8'),
  readFile(new URL('init.groovy', profile), 'utf8'),
  readFile(new URL('healthcheck.sh', profile), 'utf8'),
  readFile(new URL('manage-gateway-token.sh', profile), 'utf8'),
  readFile(new URL('credential-manifest.json', profile), 'utf8'),
  ...scriptNames.map((name) => readFile(new URL(name, profile), 'utf8')),
]);
const runtime = JSON.parse(runtimeText);
const direct = parseDirect(directText);
const lock = parseLock(lockText);
const snapshot = JSON.parse(snapshotText);
const supplements = JSON.parse(supplementsText);
const provenance = JSON.parse(provenanceText);
const metadata = new Map([...Object.entries(snapshot.plugins), ...Object.entries(supplements.plugins)]);
const scripts = scriptTexts.join('\n');

test('Stage B plugin and artifact lock is a complete 66-item closure', () => {
  assert.equal(direct.size, 10);
  assert.equal(lock.size, 66);
  assert.equal(provenance.directCount, 10);
  assert.equal(provenance.pluginCount, 66);

  const closure = new Set();
  const queue = [...direct.keys()];
  while (queue.length) {
    const id = queue.shift();
    if (closure.has(id)) continue;
    const plugin = metadata.get(id);
    assert.ok(plugin, `missing metadata for ${id}`);
    closure.add(id);
    for (const dependency of plugin.dependencies ?? []) {
      if (!dependency.optional) queue.push(dependency.name);
    }
  }
  assert.deepEqual([...closure].sort(), [...lock.keys()].sort());

  const installs = new Map(dataLines(installText).map((line) => {
    const separator = line.indexOf(':');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const hashes = new Map(dataLines(hashesText).map((line) => {
    const match = line.match(/^([0-9a-f]{64})  plugins\/([a-z0-9_.-]+)[.]jpi$/);
    assert.ok(match, `invalid artifact hash line: ${line}`);
    return [match[2], match[1]];
  }));
  for (const [id, entry] of lock) {
    assert.equal(entry.version, metadata.get(id).version, `${id} version`);
    assert.equal(entry.sha256, metadata.get(id).sha256, `${id} hash`);
    assert.equal(installs.get(id), entry.version, `${id} install version`);
    assert.equal(hashes.get(id), Buffer.from(entry.sha256, 'base64').toString('hex'), `${id} artifact hash`);
  }
  assert.equal(hashes.get('ssh-slaves'), '8d6c4996aad23c885928a0d0dc742200ed94473189434a93833b8f0de306597f');
  assert.equal(hashes.get('trilead-api'), '7e8c00767ac24d017e262665d676ccd74b1b22028f7210f85520ff139bd821ed');
});

test('controller runtime is loopback-only, hardened, persistent, and bounded to 1 GiB', () => {
  assert.equal(assertStageBContract({ runtime, dockerfile, casc, job, gateway, scripts,
    init, health, tokenHelper, credentialManifest: credentialManifestText }), true);
  const runner = scriptTexts[scriptNames.indexOf('run-controller.sh')];
  for (const required of [
    '--publish "$JENKINS_HOST_IP:$JENKINS_HOST_PORT:$JENKINS_CONTAINER_PORT"',
    '--read-only',
    '--security-opt no-new-privileges:true',
    '--cap-drop ALL',
    '--restart no',
    '--memory "$JENKINS_MEMORY"',
    '--memory-reservation "$JENKINS_MEMORY_RESERVATION"',
    '--memory-swap "$JENKINS_MEMORY_SWAP"',
    '--cpus "$JENKINS_CPU_CORES"',
    '--pids-limit "$JENKINS_PIDS_LIMIT"',
  ]) assert.ok(runner.includes(required), `runner missing ${required}`);
  assert.doesNotMatch(runner, /50000|0[.]0[.]0[.]0|\/var\/run\/docker[.]sock/);
  assert.match(runner, /JENKINS_HOME_VOLUME/);
  assert.match(runner, /PLANE_PREFLIGHT_UID/);
  assert.match(runner, /ROOTLESS_DOCKER_HOST/);
});

test('SSH agent and gateway use fixed identity, file references, and disabled defaults', () => {
  assert.deepEqual(runtime.agent.remoting, {
    prefixStartSlaveCmd: "exec systemd-run --user --scope --quiet -p MemoryMax=384M -p CPUQuota=25% /bin/sh -c '",
    suffixStartSlaveCmd: "'",
    memoryMax: '384M',
    cpuQuota: '25%',
  });
  assert.match(casc, /name: "plane-game-cd-rootless"/);
  assert.match(casc, /remoteFS: "\/home\/plane-preflight\/jenkins-agent"/);
  assert.match(casc, /numExecutors: 1/);
  assert.match(casc, /mode: EXCLUSIVE/);
  assert.match(casc, /prefixStartSlaveCmd: "exec systemd-run --user --scope --quiet -p MemoryMax=384M -p CPUQuota=25% \/bin\/sh -c '"/);
  assert.match(casc, /suffixStartSlaveCmd: "'"/);
  assert.match(casc, /scope: SYSTEM/);
  assert.match(casc, /manuallyProvidedKeyVerificationStrategy:/);
  assert.match(casc, /PLANE_AGENT_PRIVATE_KEY/);
  assert.match(casc, /PLANE_AGENT_ED25519_HOST_KEY/);
  assert.match(job, /PLANE_CD_TRIGGER_MODE/);
  assert.match(job, /disabled\(triggerMode == 'disabled'\)/);
  assert.match(job, /Item[.]Read', 'plane-webhook-gateway'/);
  assert.match(job, /Item[.]Build', 'plane-webhook-gateway'/);
  assert.doesNotMatch(job, /triggers\s*\{|githubPush\(\)/);
  assert.doesNotMatch(gateway, /^\[Install\]|^WantedBy=|^User=|^Group=/m);
  assert.match(gateway, /Restart=no/);
  assert.match(gateway, /DOCKER_HOST=unix:\/\/\/run\/user\/1003\/docker[.]sock/);
  assert.match(gateway, /JENKINS_URL=http:\/\/127[.]0[.]0[.]1:18080/);
  assert.match(gateway, /UnsetEnvironment=.*HTTP_PROXY.*http_proxy.*NODE_OPTIONS.*NODE_USE_ENV_PROXY/);
  assert.match(health, /curl --proxy '' --noproxy 127[.]0[.]0[.]1 --proto '=http' --max-redirs 0/);
  assert.match(tokenHelper, /curl --proxy '' --noproxy 127[.]0[.]0[.]1 --proto '=http' --max-redirs 0/);
  assert.match(rollback, /job -> poller -> gateway -> controller/);
  assert.match(rollback, /verify-disabled-restart/);
  assert.match(rollback, /first-release/);
  assert.match(rollback, /last-healthy/);
  assert.match(rollback, /checksum/);
});

test('negative contract rejects exposure, root units, executors, enabled jobs, bypass, secrets, and prune', () => {
  const check = (overrides) => () => assertStageBContract({
    runtime,
    dockerfile,
    casc,
    job,
    gateway,
    scripts,
    init,
    health,
    tokenHelper,
    credentialManifest: credentialManifestText,
    ...overrides,
  });
  assert.throws(check({ runtime: { ...runtime, controller: { ...runtime.controller, hostBinding: '0.0.0.0:18080:8080' } } }), /loopback-only/);
  assert.throws(check({ runtime: { ...runtime, controller: { ...runtime.controller, executors: 1 } } }), /executor/);
  assert.throws(check({
    job: job.replace("disabled(triggerMode == 'disabled')", 'disabled(false)'),
  }), /job enablement/);
  assert.throws(check({ gateway: `${gateway}\n[Install]\nWantedBy=default.target\n` }), /root-level or enableable/);
  assert.throws(check({ casc: casc.replace('manuallyProvidedKeyVerificationStrategy', 'nonVerifyingKeyVerificationStrategy') }), /host-key/);
  assert.throws(check({ casc: casc.replace('CPUQuota=25%', 'CPUQuota=50%') }), /SSH remoting JCasC/);
  assert.throws(check({ runtime: {
    ...runtime,
    agent: { ...runtime.agent, remoting: { ...runtime.agent.remoting, memoryMax: '512M' } },
  } }), /SSH remoting runtime manifest/);
  assert.throws(check({ casc: `${casc}\n-----BEGIN PRIVATE KEY-----\n` }), /plaintext credential/);
  assert.throws(check({ scripts: `${scripts}\ndocker system prune\n` }), /broad or rootful/);
});

test('configuration manifest covers every Stage B file and every digest matches', async () => {
  const expected = (await walk()).sort();
  const actual = [];
  for (const line of dataLines(manifestText)) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    assert.ok(match, `invalid manifest line: ${line}`);
    actual.push(match[2]);
    const bytes = await readFile(new URL(match[2], profile));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), match[1], match[2]);
  }
  assert.deepEqual(actual, expected);
});

test('no plaintext private key, token, rootful socket, sudo, prune, or wildcard deletion is committed', async () => {
  const operational = [dockerfile, casc, job, gateway, scripts].join('\n');
  assert.doesNotMatch(operational, /-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/);
  assert.doesNotMatch(operational, /\/var\/run\/docker[.]sock|\bsudo\b|docker\s+(system|image|volume|network)\s+prune|rm\s+-rf/);
});
