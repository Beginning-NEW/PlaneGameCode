#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) throw new Error(message);
}

function forbid(text, pattern, message) {
  if (pattern.test(text)) throw new Error(message);
}

export function assertStageBContract({ runtime, dockerfile, casc, job, gateway, scripts }) {
  const manifest = typeof runtime === 'string' ? JSON.parse(runtime) : runtime;
  const controller = manifest.controller;
  if (manifest.defaultState !== 'disabled') throw new Error('Stage B must default disabled');
  if (controller.hostBinding !== '127.0.0.1:18080:8080') throw new Error('controller must be loopback-only on 18080');
  if (controller.forbiddenHostPorts.join(',') !== '8080,50000') throw new Error('forbidden port contract changed');
  if (controller.executors !== 0 || controller.inboundAgentPort !== -1) throw new Error('controller executor or agent port changed');
  if (controller.restart !== 'no' || !controller.readOnlyRootfs || !controller.noNewPrivileges) throw new Error('controller hardening changed');
  if (controller.capDrop.join(',') !== 'ALL') throw new Error('controller capabilities changed');
  const limits = controller.limits;
  if (limits.memory !== '1g' || limits.memoryReservation !== '768m' || limits.memorySwap !== '1g' ||
      limits.cpus !== '0.50' || limits.pidsLimit !== 256) throw new Error('controller limit contract changed');
  if (controller.jvm.join(' ') !== '-Xms128m -Xmx512m -XX:MaxMetaspaceSize=256m -XX:+ExitOnOutOfMemoryError') {
    throw new Error('JVM budget changed');
  }

  requireMatch(dockerfile, /jenkins\/jenkins@sha256:[0-9a-f]{64}/, 'base image is not digest pinned');
  for (const option of controller.jvm) {
    if (!dockerfile.includes(option)) throw new Error(`Dockerfile missing ${option}`);
  }
  requireMatch(casc, /numExecutors: 0/, 'controller must have zero executors');
  requireMatch(casc, /slaveAgentPort: -1/, 'inbound agent port must be disabled');
  requireMatch(casc, /name: "plane-game-cd-rootless"/, 'bounded agent name missing');
  requireMatch(casc, /remoteFS: "\/home\/plane-preflight\//, 'agent remote root is not bounded');
  requireMatch(casc, /numExecutors: 1/, 'agent must have one executor');
  requireMatch(casc, /mode: EXCLUSIVE/, 'agent must be matching-label-only');
  requireMatch(casc, /scope: SYSTEM/, 'agent credential must be SYSTEM scoped');
  requireMatch(casc, /manuallyProvidedKeyVerificationStrategy:/, 'fixed host-key verifier missing');
  requireMatch(casc, /PLANE_AGENT_ED25519_HOST_KEY/, 'Ed25519 host-key file reference missing');
  forbid(casc, /nonVerifyingKeyVerificationStrategy|manuallyTrustedKeyVerificationStrategy/, 'host-key bypass is forbidden');
  requireMatch(job, /disabled\(true\)/, 'job must default disabled');
  forbid(job, /triggers\s*\{|githubPush\(\)/, 'job must not install a webhook trigger');

  requireMatch(gateway, /DOCKER_HOST=unix:\/\/\/run\/user\/1003\/docker[.]sock/, 'gateway must use rootless Docker');
  requireMatch(gateway, /JENKINS_URL=http:\/\/127[.]0[.]0[.]1:18080/, 'gateway must reach loopback Jenkins only');
  requireMatch(gateway, /Restart=no/, 'gateway must not auto-restart');
  requireMatch(gateway, /WEBHOOK_SECRET_FILE=%h\/.config\/plane-game\/credentials\/webhook-secret/, 'gateway credential must be a file reference');
  forbid(gateway, /^User=|^Group=|^\[Install\]|^WantedBy=/m, 'root-level or enableable gateway unit is forbidden');

  const all = [dockerfile, casc, job, gateway, scripts].join('\n');
  forbid(all, /-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/, 'plaintext credential material is forbidden');
  forbid(all, /\/var\/run\/docker[.]sock|docker[.]sock.*group|\bsudo\b|docker\s+(system|image|volume|network)\s+prune|rm\s+-rf/, 'broad or rootful privilege is forbidden');
  requireMatch(scripts, /io[.]paperclip[.]plane-game[.]stage=controller-b/, 'bounded Stage B cleanup label missing');
  requireMatch(scripts, /plane-game-jenkins-stage-b/, 'bounded controller name missing');
  return true;
}

async function main() {
  const directory = new URL('.', import.meta.url);
  const [runtime, dockerfile, casc, job, gateway, ...scriptTexts] = await Promise.all([
    readFile(new URL('runtime-manifest.json', directory), 'utf8'),
    readFile(new URL('Dockerfile', directory), 'utf8'),
    readFile(new URL('casc.yaml', directory), 'utf8'),
    readFile(new URL('plane-game-job.groovy', directory), 'utf8'),
    readFile(new URL('systemd-user/plane-game-webhook-gateway.service', directory), 'utf8'),
    ...['build-image.sh', 'run-controller.sh', 'disable-stage-b.sh', 'backup-home.sh',
      'restore-home.sh', 'rollback-stage-b.sh'].map((file) => readFile(new URL(file, directory), 'utf8')),
  ]);
  assertStageBContract({ runtime, dockerfile, casc, job, gateway, scripts: scriptTexts.join('\n') });
  console.log('Stage B static contract: PASS');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
