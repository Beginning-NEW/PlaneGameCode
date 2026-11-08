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

export function assertStageBContract({ runtime, dockerfile, casc, job, gateway, scripts,
  init, health, tokenHelper, credentialManifest }) {
  const manifest = typeof runtime === 'string' ? JSON.parse(runtime) : runtime;
  const credentialMetadata = typeof credentialManifest === 'string'
    ? JSON.parse(credentialManifest) : credentialManifest;
  const controller = manifest.controller;
  if (manifest.defaultState !== 'disabled') throw new Error('Stage B must default disabled');
  if (manifest.triggerSelector?.default !== 'disabled' ||
      manifest.triggerSelector?.allowed?.join(',') !== 'disabled,poller,webhook' ||
      manifest.triggerSelector?.simultaneousPathsAllowed !== false) {
    throw new Error('trigger selector contract changed');
  }
  if (manifest.poller?.defaultState !== 'disabled' || manifest.poller?.interval !== '5m' ||
      manifest.poller?.requestCeilingPerRollingHour !== 30 ||
      manifest.poller?.candidateCeilingPerRollingHour !== 1 || manifest.poller?.candidateGraphRequests !== 16 ||
      manifest.poller?.credentialFile !== '~/.local/state/plane-game-poller/jenkins-api-token') {
    throw new Error('poller budget/default contract changed');
  }
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
  requireMatch(dockerfile, /-Djenkins[.]install[.]runSetupWizard=false/, 'setup wizard must remain disabled');
  requireMatch(dockerfile, /CASC_STRICT_SECRET_RESOLUTION=true/, 'JCasC strict secret resolution is not enabled');
  requireMatch(dockerfile, /-Dcasc[.]strict[.]secret[.]resolution=true/, 'JCasC strict system property is missing');
  for (const option of controller.jvm) {
    if (!dockerfile.includes(option)) throw new Error(`Dockerfile missing ${option}`);
  }
  requireMatch(casc, /numExecutors: 0/, 'controller must have zero executors');
  requireMatch(casc, /authorizationStrategy:\s*projectMatrix:/, 'project-level job grants require projectMatrix');
  forbid(casc, /authorizationStrategy:\s*globalMatrix:/, 'globalMatrix does not apply job grants');
  requireMatch(casc, /slaveAgentPort: -1/, 'inbound agent port must be disabled');
  requireMatch(casc, /crumbIssuer:\s*standard: \{\}/, 'default CSRF crumb issuer is missing');
  forbid(casc, /excludeClientIPFromCrumb/, 'removed Jenkins crumb IP option is unsupported');
  requireMatch(casc, /name: "plane-admin"[\s\S]*"Overall\/Administer"/, 'fixed admin grant is missing');
  requireMatch(casc, /name: "authenticated"[\s\S]*"Overall\/Read"/, 'authenticated read grant is missing');
  requireMatch(casc, /name: "plane-game-cd-rootless"/, 'bounded agent name missing');
  requireMatch(casc, /remoteFS: "\/home\/plane-preflight\//, 'agent remote root is not bounded');
  requireMatch(casc, /numExecutors: 1/, 'agent must have one executor');
  requireMatch(casc, /mode: EXCLUSIVE/, 'agent must be matching-label-only');
  requireMatch(casc, /prefixStartSlaveCmd: "exec systemd-run --user --scope --quiet -p MemoryMax=384M -p CPUQuota=25% \/bin\/sh -c '"/, 'SSH remoting scope must have the reviewed memory and CPU limits');
  requireMatch(casc, /suffixStartSlaveCmd: "'"/, 'SSH remoting scope must close the command');
  requireMatch(casc, /scope: SYSTEM/, 'agent credential must be SYSTEM scoped');
  requireMatch(casc, /privateKeySource:\s*directEntry:/, 'JCasC SSH private-key source must use directEntry');
  requireMatch(casc, /manuallyProvidedKeyVerificationStrategy:/, 'fixed host-key verifier missing');
  requireMatch(casc, /sshHostKeyVerificationStrategy:/, 'SSH launcher host-key field is missing');
  requireMatch(casc, /key: "CD_TRIGGER_MODE"\s+value: "disabled"/, 'global trigger selector must default disabled');
  forbid(casc, /\s+hostKeyVerificationStrategy:/, 'obsolete SSH launcher host-key field is unsupported');
  requireMatch(init, /getSshHostKeyVerificationStrategy\(\)/, 'SSH launcher readiness check uses an obsolete getter');
  requireMatch(init, /getPrefixStartSlaveCmd\(\)/, 'SSH launcher readiness must verify the bounded command');
  requireMatch(init, /getSuffixStartSlaveCmd\(\)/, 'SSH launcher readiness must verify the bounded command');
  requireMatch(casc, /PLANE_AGENT_ED25519_HOST_KEY/, 'Ed25519 host-key file reference missing');
  for (const source of [
    'PLANE_AGENT_HOST',
    'PLANE_AGENT_ED25519_HOST_KEY',
    'PLANE_AGENT_PRIVATE_KEY',
  ]) {
    if (!casc.includes(`\${trim:\${readFile:/run/secrets/${source}}}`)) {
      throw new Error(`strict file secret source missing for ${source}`);
    }
  }
  forbid(casc, /scope: GLOBAL|PLANE_GITHUB_|PLANE_GHCR_/, 'public-source controller must not define GitHub or registry credentials');
  forbid(casc, /nonVerifyingKeyVerificationStrategy|manuallyTrustedKeyVerificationStrategy/, 'host-key bypass is forbidden');
  requireMatch(job, /disabled\(true\)/, 'job must default disabled');
  requireMatch(job, /userPermission\('hudson[.]model[.]Item[.]Read', 'plane-webhook-gateway'\)/,
    'gateway folder/job grants must identify a user');
  requireMatch(job, /userPermission\('hudson[.]model[.]Item[.]Build', 'plane-webhook-gateway'\)/,
    'gateway job build grant must identify a user');
  requireMatch(job, /folder\('plane-game'\)[\s\S]*Item[.]Read[\s\S]*plane-webhook-gateway/, 'gateway folder read grant missing');
  requireMatch(job, /userPermission\('hudson[.]model[.]Item[.]Read', 'plane-actions-poller'\)/,
    'poller folder/job read grant missing');
  requireMatch(job, /userPermission\('hudson[.]model[.]Item[.]Build', 'plane-actions-poller'\)/,
    'poller job build grant missing');
  requireMatch(job, /folder\('plane-game'\)[\s\S]*Item[.]Read[\s\S]*plane-actions-poller/,
    'poller folder read grant missing');
  forbid(job, /Item[.](Configure|Delete).*plane-actions-poller/, 'poller has a forbidden job grant');
  for (const parameter of ['TRIGGER_SOURCE', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'TRIGGER_ID', 'WEBHOOK_DELIVERY_UUID']) {
    requireMatch(job, new RegExp(`stringParam\\('${parameter}'`), `poller-compatible parameter missing: ${parameter}`);
  }
  requireMatch(job, /Item[.]Read'[\s\S]*plane-webhook-gateway[\s\S]*Item[.]Build'[\s\S]*plane-webhook-gateway/, 'gateway job read/build grants missing');
  requireMatch(job, /url\('https:\/\/github[.]com\/Beginning-NEW\/PlaneGameCode[.]git'\)/, 'anonymous SCM allowlist is missing');
  forbid(job, /credentials\(/, 'public SCM checkout must not use a credential ID');
  forbid(job, /Item[.](Configure|Delete).*plane-webhook-gateway/, 'gateway has a forbidden job grant');
  forbid(job, /triggers\s*\{|githubPush\(\)/, 'job must not install a webhook trigger');

  requireMatch(init, /fresh home requires the one-time admin bcrypt bootstrap file/, 'fresh-home fail-closed gate missing');
  requireMatch(init, /createAccountWithHashedPassword\(adminId, hashedPassword\)/, 'bcrypt bootstrap API missing');
  requireMatch(init, /bootstrap file must be removed after its one-time application/, 'one-time bootstrap replay rejection missing');
  requireMatch(init, /plane-actions-poller/, 'dedicated poller principal readiness check missing');
  requireMatch(init, /poller global authorization is not least privilege/, 'poller global denial proof missing');
  requireMatch(init, /poller job authorization or disabled state is invalid/, 'poller job denial proof missing');

  requireMatch(init, /CredentialsProvider[.]VIEW/, 'gateway credential-view denial proof missing');
  requireMatch(init, /Jenkins[.]RUN_SCRIPTS/, 'gateway Script Console denial proof missing');
  requireMatch(init, /stage-b-ready-v2/, 'authorization readiness marker missing');
  requireMatch(init, /controller[.]reload\(\)[\s\S]*job = controller[.]getItemByFullName\('plane-game\/main-cd'\)/,
    'fresh-home Job DSL catalog must reload before live authorization checks');
  requireMatch(health, /stage-b-ready-v2/, 'healthcheck does not require authorization readiness');

  forbid(scripts, /github-(?:scm|actions)|ghcr-(?:username|token)|PLANE_(?:GITHUB|GHCR)_/,
    'runner must not mount public-source credentials');
  requireMatch(scripts, /stat -c '%u'/, 'secret ownership validation missing');
  requireMatch(scripts, /440\|640/, 'strict secret mode validation missing');
  requireMatch(scripts, /getfacl -n -c/, 'narrow mapped-Jenkins ACL validation missing');
  requireMatch(scripts, /JENKINS_MAPPED_HOST_UID/, 'mapped Jenkins host UID must be checked');
  requireMatch(scripts, /\/proc\/\$\{daemon_pids\[0\]\}\/uid_map/, 'live rootless user mapping must be checked');
  requireMatch(scripts, /stage-b-secret-preflight/, 'rootless image-user readability proof missing');
  requireMatch(scripts, /PLANE_ADMIN_BOOTSTRAP_BCRYPT/, 'optional bootstrap mount missing');
  requireMatch(scripts, /index [. ]Config[.]Labels "io[.]paperclip[.]plane-game[.]stage"/, 'stopped-container label guard missing');
  requireMatch(scripts, /docker rm "\$JENKINS_CONTAINER"/, 'bounded stopped-container recreation missing');
  forbid(scripts, /docker rm\s+(?:--force|-f)/, 'forced controller removal is forbidden');

  if (credentialMetadata.valuesAreMetadataOnly !== true || credentialMetadata.credentials.length !== 1) {
    throw new Error('credential metadata manifest is incomplete');
  }
  const metadataById = new Map(credentialMetadata.credentials.map((entry) => [entry.id, entry]));
  for (const [id, kind, scope] of [
    ['plane-game-agent-ssh', 'basicSSHUserPrivateKey', 'SYSTEM'],
  ]) {
    const entry = metadataById.get(id);
    if (entry?.kind !== kind || entry?.scope !== scope) throw new Error(`credential manifest mismatch for ${id}`);
  }
  if (credentialMetadata.publicSource?.scmAuthentication !== 'none' ||
      credentialMetadata.publicSource?.actionsAuthentication !== 'none' ||
      credentialMetadata.publicSource?.registryAuthentication !== 'none') {
    throw new Error('public-source no-auth metadata is incomplete');
  }
  requireMatch(tokenHelper, /jenkins_url=http:\/\/127[.]0[.]0[.]1:18080/, 'token helper is not fixed loopback-only');
  requireMatch(tokenHelper, /create\|rotate\|prune\|revoke/, 'token lifecycle operations are incomplete');
  requireMatch(tokenHelper, /flock -x 9/, 'token lifecycle lock is missing');
  requireMatch(tokenHelper, /sync -f "\$token_tmp"[\s\S]*mv -f -- "\$token_tmp" "\$token_file"/,
    'token and UUID must be published as one durable file');
  forbid(tokenHelper, /uuid_file=/, 'separate token UUID sidecar breaks atomic publication');
  forbid(tokenHelper, /--user\s+[^\n]*:/, 'token helper must not pass a password in arguments');
  forbid(tokenHelper, /export\s+[^\n]*(TOKEN|PASSWORD|SECRET)/i, 'token helper must not export secrets');
  forbid(dockerfile, /\b(?:ENV|ARG)\s+PLANE_[A-Z0-9_]*(?:TOKEN|PASSWORD|PRIVATE_KEY)=/,
    'image metadata must not carry credential values');
  forbid(scripts, /docker\s+run[^\n]*(?:--env|-e\s+)[^\n]*(?:TOKEN|PASSWORD|PRIVATE_KEY)/,
    'Docker arguments must not carry credential values');

  requireMatch(gateway, /DOCKER_HOST=unix:\/\/\/run\/user\/1003\/docker[.]sock/, 'gateway must use rootless Docker');
  requireMatch(gateway, /JENKINS_URL=http:\/\/127[.]0[.]0[.]1:18080/, 'gateway must reach loopback Jenkins only');
  requireMatch(gateway, /Restart=no/, 'gateway must not auto-restart');
  requireMatch(gateway, /WEBHOOK_SECRET_FILE=%h\/.config\/plane-game\/credentials\/webhook-secret/, 'gateway credential must be a file reference');
  forbid(gateway, /^User=|^Group=|^\[Install\]|^WantedBy=/m, 'root-level or enableable gateway unit is forbidden');

  const all = [dockerfile, casc, job, gateway, scripts, init, health, tokenHelper].join('\n');
  forbid(all, /-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/, 'plaintext credential material is forbidden');
  forbid(all, /PLANE_GAME_GITHUB_TOKEN/, 'legacy shared GitHub token must not be reused');
  forbid(all, /\/var\/run\/docker[.]sock|docker[.]sock.*group|\bsudo\b|docker\s+(system|image|volume|network)\s+prune|rm\s+-rf/, 'broad or rootful privilege is forbidden');
  requireMatch(scripts, /io[.]paperclip[.]plane-game[.]stage=controller-b/, 'bounded Stage B cleanup label missing');
  requireMatch(scripts, /plane-game-jenkins-stage-b/, 'bounded controller name missing');
  return true;
}

async function main() {
  const directory = new URL('.', import.meta.url);
  const [runtime, dockerfile, casc, job, gateway, init, health, tokenHelper, credentialManifest, ...scriptTexts] = await Promise.all([
    readFile(new URL('runtime-manifest.json', directory), 'utf8'),
    readFile(new URL('Dockerfile', directory), 'utf8'),
    readFile(new URL('casc.yaml', directory), 'utf8'),
    readFile(new URL('plane-game-job.groovy', directory), 'utf8'),
    readFile(new URL('systemd-user/plane-game-webhook-gateway.service', directory), 'utf8'),
    readFile(new URL('init.groovy', directory), 'utf8'),
    readFile(new URL('healthcheck.sh', directory), 'utf8'),
    readFile(new URL('manage-gateway-token.sh', directory), 'utf8'),
    readFile(new URL('credential-manifest.json', directory), 'utf8'),
    ...['build-image.sh', 'generate-admin-bootstrap.sh', 'run-controller.sh', 'manage-actions-poller.sh', 'disable-stage-b.sh', 'backup-home.sh',
      'restore-home.sh', 'rollback-stage-b.sh'].map((file) => readFile(new URL(file, directory), 'utf8')),
  ]);
  assertStageBContract({ runtime, dockerfile, casc, job, gateway, scripts: scriptTexts.join('\n'),
    init, health, tokenHelper, credentialManifest });
  console.log('Stage B static contract: PASS');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
