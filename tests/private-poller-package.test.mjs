import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const profile = new URL('../ops/jenkins/controller-stage-b/', import.meta.url);
const [manifestText, job, casc, service, timer, activationDropin, webhookService, docs, tokenHelper, pipeline, localDeploy, promote] = await Promise.all([
  readFile(new URL('runtime-manifest.json', profile), 'utf8'),
  readFile(new URL('plane-game-job.groovy', profile), 'utf8'),
  readFile(new URL('casc.yaml', profile), 'utf8'),
  readFile(new URL('systemd-user/plane-game-actions-poller.service', profile), 'utf8'),
  readFile(new URL('systemd-user/plane-game-actions-poller.timer', profile), 'utf8'),
  readFile(new URL('systemd-user-activation/plane-game-actions-poller.service.d/10-trigger-mode.conf', profile), 'utf8'),
  readFile(new URL('systemd-user/plane-game-webhook-gateway.service', profile), 'utf8'),
  readFile(new URL('../ops/jenkins/PRIVATE-POLLER.md', import.meta.url), 'utf8'),
  readFile(new URL('create-poller-token.sh', profile), 'utf8'),
  readFile(new URL('../Jenkinsfile', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/deploy-local.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/promote.sh', import.meta.url), 'utf8'),
]);

test('poller package is disabled, five-minute bounded, and mutually exclusive with webhook', () => {
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.triggerSelector, {
    default: 'disabled',
    allowed: ['disabled', 'poller', 'webhook'],
    simultaneousPathsAllowed: false,
  });
  assert.equal(manifest.poller.defaultState, 'disabled');
  assert.equal(manifest.poller.interval, '5m');
  assert.equal(manifest.poller.requestCeilingPerRollingHour, 30);
  assert.equal(manifest.poller.candidateCeilingPerRollingHour, 1);
  assert.equal(manifest.poller.candidateGraphRequests, 16);
  assert.deepEqual(manifest.poller.limits, {
    memoryMax: '256M', cpuQuota: '25%', tasksMax: 64,
    timeoutStartSec: '4min',
    logRateLimitIntervalSec: '1min', logRateLimitBurst: 30,
  });
  assert.deepEqual(manifest.poller.ledgerRetention, {
    compactAtBytes: 4194304, hardMaxBytes: 8388608, archiveCount: 4,
  });
  assert.match(casc, /key: "CD_TRIGGER_MODE"[\s\S]*PLANE_CD_TRIGGER_MODE/);
  assert.match(service, /Environment=CD_TRIGGER_MODE=disabled/);
  assert.match(webhookService, /Environment=CD_TRIGGER_MODE=disabled/);
  for (const unit of [service, webhookService]) {
    assert.match(unit, /UnsetEnvironment=.*HTTP_PROXY.*http_proxy.*NODE_OPTIONS.*NODE_USE_ENV_PROXY/);
  }
  assert.match(service, /PLANE_POLLER_JENKINS_CREDENTIAL_FILE=%h\/.local\/state\/plane-game-poller\/jenkins-api-token/);
  for (const name of ['jenkins-api-token', 'journal.ndjson', 'snapshot.json', '.shared.lock']) {
    assert.ok(service.split('\n').includes(`ConditionPathExists=%h/.local/state/plane-game-poller/${name}`));
  }
  for (const name of ['webhook-secret', 'jenkins-api-token']) {
    assert.ok(webhookService.split('\n').includes(`ConditionPathExists=%h/.config/plane-game/credentials/${name}`));
  }
  assert.doesNotMatch(service + webhookService, /ConditionPathIsRegular/);
  assert.match(timer, /OnBootSec=5min[\s\S]*OnUnitActiveSec=5min/);
  assert.doesNotMatch(service, /^\[Install\]|^WantedBy=/m);
  assert.match(timer, /^\[Install\]\nWantedBy=timers[.]target$/m);
  assert.match(activationDropin, /Environment=CD_TRIGGER_MODE=poller/);
  assert.match(service, /flock --no-fork --nonblock %h\/.local\/state\/plane-game-poller\/\.shared\.lock/);
  for (const limit of ['MemoryMax=256M', 'CPUQuota=25%', 'TasksMax=64',
    'TimeoutStartSec=4min', 'LogRateLimitIntervalSec=1min',
    'LogRateLimitBurst=30']) assert.match(service, new RegExp(limit));
  assert.doesNotMatch(service, /RuntimeMaxSec=/);
  assert.match(pipeline, /flock --no-fork --nonblock "\$PLANE_POLLER_STATE_DIR\/\.shared\.lock"/);
  assert.match(localDeploy, /state_call\(\)[\s\S]*flock --no-fork --nonblock "\$state_lock"/);
  assert.match(promote, /state_call\(\)[\s\S]*flock --no-fork --nonblock "\$PLANE_LEDGER_LOCK_FILE"/);
});

test('Jenkins job has dedicated poller least privilege and mutually exclusive parameters', () => {
  assert.match(job, /folder\('plane-game'\)[\s\S]*Item[.]Read'[\s\S]*plane-actions-poller/);
  assert.match(job, /Item[.]Read'[\s\S]*plane-actions-poller[\s\S]*Item[.]Build'[\s\S]*plane-actions-poller/);
  assert.doesNotMatch(job, /Item[.](Configure|Delete).*plane-actions-poller/);
  for (const parameter of ['TRIGGER_SOURCE', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'TRIGGER_ID', 'WEBHOOK_DELIVERY_UUID']) {
    assert.match(job, new RegExp(`stringParam\\('${parameter}'`));
  }
  assert.match(job, /PLANE_CD_TRIGGER_MODE/);
  assert.match(job, /disabled\(triggerMode == 'disabled'\)/);
});

test('disabled or missing mode refuses both executable trigger paths before startup', () => {
  const poller = spawnSync(process.execPath, ['ops/jenkins/private-actions-poller.mjs'], {
    cwd: root,
    env: { ...process.env, CD_TRIGGER_MODE: 'disabled' },
    encoding: 'utf8',
  });
  assert.notEqual(poller.status, 0);
  assert.match(poller.stderr, /trigger mode must be poller/i);
  const webhook = spawnSync(process.execPath, ['ops/jenkins/webhook-gateway.mjs'], {
    cwd: root,
    env: { ...process.env, CD_TRIGGER_MODE: 'disabled' },
    encoding: 'utf8',
  });
  assert.notEqual(webhook.status, 0);
  assert.match(webhook.stderr, /Webhook trigger mode is not exclusively enabled/);
});

test('credential helper writes one file-backed username/token document without argv or environment secrets', () => {
  assert.match(tokenHelper, /poller_user=plane-actions-poller/);
  assert.match(tokenHelper, /\.local\/state\/plane-game-poller\/jenkins-api-token/);
  assert.match(tokenHelper, /create\|rotate\|prune\|revoke/);
  assert.match(tokenHelper, /"username":"%s","token":"%s","uuid":"%s"/);
  assert.match(tokenHelper, /flock -x 9/);
  assert.match(tokenHelper, /sync -f "\$token_tmp"[\s\S]*mv -f -- "\$token_tmp" "\$token_file"/);
  assert.match(tokenHelper, /curl --proxy '' --noproxy 127[.]0[.]0[.]1 --proto '=http' --max-redirs 0/);
  assert.doesNotMatch(tokenHelper, /--user\s+[^\n]*:|export\s+[^\n]*(TOKEN|PASSWORD|SECRET)/i);
  assert.match(docs, /same service UID remains explicitly out of scope|same-service-UID replay/i);
  assert.match(docs, /attempt 1 cannot authorize attempt 2/);
  assert.match(docs, /not independent GitHub approval/);
});
