import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [pipeline, verify, resolveDigest, pullHelper, publicImages, gate, preflight, sudoPolicy, localDeploy,
  promote, docs, checks, jobDsl] = await Promise.all([
  readFile(new URL('../Jenkinsfile', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/verify-candidate.sh', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/resolve-public-ghcr-digest.sh', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/pull-public-images.sh', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/public-source-images.env', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/resource-gate.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/plane-preflight', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/preflight_sudo_policy.py', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/deploy-local.sh', import.meta.url), 'utf8'),
  readFile(new URL('../deploy/promote.sh', import.meta.url), 'utf8'),
  readFile(new URL('../RUNBOOK.md', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/config/plane-game-job.groovy', import.meta.url), 'utf8'),
]);

function assertPinnedJenkinsJob(candidate) {
  assert.match(candidate, /env[.]JOB_NAME != 'plane-game\/main-cd'/);
  assert.match(candidate, /DEPLOY_PORT = '18081'/);
  assert.doesNotMatch(candidate, /BRANCH_NAME|CHANGE_ID/);
}

test('Jenkins is main-only, lightweight, single-concurrency CD', () => {
  assert.match(pipeline, /agent \{ label 'plane-game-cd-rootless' \}/);
  assert.match(pipeline, /disableConcurrentBuilds\(abortPrevious: false\)/);
  assert.match(pipeline, /lock\(resource: 'plane-game-production-cd'/);
  assertPinnedJenkinsJob(pipeline);
  assert.match(jobDsl, /pipelineJob\('plane-game\/main-cd'\)/);
  assert.match(jobDsl, /branch\('\*\/main'\)/);
  assert.doesNotMatch(jobDsl, /stringParam\('DEPLOY_PORT'/);
  assert.match(pipeline, /git rev-parse FETCH_HEAD/);
  assert.match(pipeline, /verify-candidate[.]sh/);
  assert.match(pipeline, /resource-gate[.]sh/);
  for (const forbidden of ['pnpm ', 'playwright', 'docker build', 'docker push']) {
    assert.doesNotMatch(pipeline.toLowerCase(), new RegExp(forbidden));
  }
});

test('missing or tampered job identity and deployment port fail the static contract', () => {
  for (const mutation of [
    pipeline.replace("env.JOB_NAME != 'plane-game/main-cd'", 'false'),
    pipeline.replace('plane-game/main-cd', 'plane-game/untrusted-cd'),
    pipeline.replace("DEPLOY_PORT = '18081'", ''),
    pipeline.replace("DEPLOY_PORT = '18081'", "DEPLOY_PORT = '9999'"),
  ]) {
    assert.throws(() => assertPinnedJenkinsJob(mutation));
  }
});

test('webhook metadata is verified through the anonymous exact-attempt and main-ref APIs', () => {
  for (const field of [
    '.name == "Checks"',
    '.path == ".github/workflows/checks.yml"',
    '.event == "push"',
    '.head_branch == "main"',
    '.status == "completed"',
    '.conclusion == "success"',
    '.repository.full_name == $repository',
    '.head_repository.full_name == $repository',
  ]) {
    assert.ok(verify.includes(field), `missing trusted-run assertion: ${field}`);
  }
  assert.match(verify, /actions\/runs\/\$run_id\/attempts\/\$run_attempt/);
  assert.match(verify, /git\/ref\/heads\/main/);
  assert.match(verify, /Protected main moved; stale candidate rejected/);
  assert.match(verify, /resolve-public-ghcr-digest[.]sh/);
  assert.doesNotMatch(verify, /Authorization:|artifacts\/|GH_API_TOKEN/);
});

test('public registries use no login, a blank Docker config, re-resolution, and digest-only pulls', () => {
  assert.doesNotMatch(pipeline, /withCredentials|credentialsId/);
  assert.match(resolveDigest, /ghcr[.]io\/token[?]scope=/);
  assert.match(resolveDigest, /docker-content-digest/);
  assert.match(resolveDigest, /--retry 0.*--connect-timeout 10.*--max-time 30/s);
  assert.match(resolveDigest, /rate limit is exhausted/);
  assert.match(publicImages, /^NGINX_BASE_IMAGE=.*@sha256:[0-9a-f]{64}$/m);
  assert.match(publicImages, /^GATEWAY_IMAGE=.*@sha256:[0-9a-f]{64}$/m);
  assert.match(localDeploy, /mktemp -d .*docker-public/);
  assert.match(localDeploy, /printf '\{\}\\n' > "\$DOCKER_CONFIG\/config[.]json"/);
  assert.match(localDeploy, /unset DOCKER_AUTH_CONFIG REGISTRY_AUTH_FILE/);
  assert.match(localDeploy, /pull-public-images[.]sh/);
  assert.match(localDeploy, /trap cleanup EXIT/);
  assert.match(pullHelper, /resolve-public-ghcr-digest[.]sh/);
  assert.match(pullHelper, /docker pull "\$repository@\$digest"/);
  assert.match(pullHelper, /docker pull "\$gateway_image"/);
  assert.doesNotMatch(`${localDeploy}\n${pullHelper}`, /docker login|GHCR_(?:USER|TOKEN)|GH_API_TOKEN/);
  assert.match(promote, /expected_version=\$\(printf '\{"sha":"%s"\}' "\$sha"\)/);
  assert.match(localDeploy, /deploy\/promote[.]sh/);
  assert.doesNotMatch(`${pipeline}\n${verify}\n${gate}\n${localDeploy}\n${pullHelper}\n${docs}`, /ACR_|aliyuncs/i);
  assert.doesNotMatch(`${localDeploy}\n${pullHelper}`, /GITHUB_TOKEN/);
});

test('same-host executor and resource stop gates match the operations budget', () => {
  assert.match(gate, /plane-preflight/);
  assert.match(gate, /minimum_mem_kib=3670016/);
  assert.match(gate, /minimum_disk_kib=36700160/);
  assert.match(gate, /memory_max.*402653184/);
  assert.match(gate, /cpu_period \* 25/);
  assert.match(preflight, /\/usr\/bin\/python3/);
  assert.doesNotMatch(preflight, /command -v sudo|PATH=/);
  assert.match(sudoPolicy, /SUDO_BINARY = "\/usr\/bin\/sudo"/);
  assert.match(sudoPolicy, /\[SUDO_BINARY, "-n", "-l"\]/);
  assert.match(sudoPolicy, /REPORT_PATH = "\/usr\/local\/sbin\/plane-game-preflight-report"/);
  assert.match(sudoPolicy, /EXPECTED_COMMAND = f'\(root\) NOPASSWD: \{REPORT_PATH\} ""'/);
  const preGate = localDeploy.indexOf('bash ops/jenkins/resource-gate.sh');
  const promoter = localDeploy.indexOf('bash "$stage/deploy/promote.sh"');
  assert.ok(preGate >= 0 && preGate < promoter);
  assert.match(pipeline, /"ops\/jenkins\/resource-gate[.]sh"/);
  assert.match(localDeploy, /"\$post_cd_resource_gate"/);
  const health = promote.indexOf('curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz"');
  const postGate = promote.indexOf('bash "$post_cd_resource_gate"');
  const commitOrder = promote.indexOf('> "$PLANE_GAME_RUNTIME_DIR/last_run_number"');
  const releaseTrap = promote.lastIndexOf('trap - EXIT');
  assert.ok(health >= 0 && health < postGate && postGate < commitOrder && commitOrder < releaseTrap);
  assert.match(docs, /p5 `MemAvailable >= 3[.]5 GiB`/);
  assert.match(docs, /p95 CPU busy.*2/);
  assert.match(docs, /`MemAvailable < 2 GiB`.*5 分钟/);
  assert.match(docs, /任何一次 `< 1[.]5 GiB`/);
  assert.match(docs, /根盘可用 `< 30 GiB`/);
  assert.match(docs, /本节定义资源入场线，不陈述当前目标主机状态/);
  assert.match(docs, /Operations.*当次连续 24 小时证据/);
  assert.match(docs, /历史容量快照不得作为当前 Go\/No-Go 结论/);
  assert.match(docs, /artifact.*非权威输出/);
  assert.match(docs, /Jenkins 不枚举、下载或解析该 artifact/);
});

test('Actions gives PR checks no CD secret path and main is the only image publisher', () => {
  const publish = checks.split(/^  publish:$/m)[1] ?? '';
  assert.match(checks, /^permissions:\s+contents: read/m);
  assert.match(publish, /packages: write/);
  assert.match(
    publish,
    /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4[.]4[.]0/,
  );
  assert.match(
    publish,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4[.]6[.]2/,
  );
  for (const action of publish.matchAll(/^\s*- uses: ([^\s#]+)/gm)) {
    assert.match(action[1], /^[^@]+@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(checks, /DEPLOY_SSH|DEPLOY_HOST|GHCR_READ_TOKEN/);
  assert.match(docs, /anonymous HTTPS/i);
  assert.match(docs, /exact-attempt/i);
  assert.doesNotMatch(docs, /plane-(?:github-(?:scm|actions)-read|ghcr-pull)/);
  assert.match(docs, /plane-github-webhook-secret/);
});
