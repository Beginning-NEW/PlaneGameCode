import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const changedDigest = `sha256:${'c'.repeat(64)}`;
const headerMaxBytes = 1024 * 1024;
const tokenBodyMaxBytes = 64 * 1024;
const manifestBodyMaxBytes = 1024 * 1024;

const [pipeline, casc, job, images, pullHelper] = await Promise.all([
  readFile(new URL('../Jenkinsfile', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/controller-stage-b/casc.yaml', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/controller-stage-b/plane-game-job.groovy', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/public-source-images.env', import.meta.url), 'utf8'),
  readFile(new URL('../ops/jenkins/pull-public-images.sh', import.meta.url), 'utf8'),
]);
const gatewayImage = images.match(/^GATEWAY_IMAGE=(.+)$/m)?.[1] ?? '';

const mockCurl = String.raw`#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$(ulimit -c)" >> "$MOCK_PUBLIC_FIXTURE/curl-core-limits.log"

body=''
headers=''
url=''
max_filesize=''
proxy_marker=unset
noproxy=''
proto=''
max_redirs=''
while (($#)); do
  case "$1" in
    --dump-header|--output)
      option=$1
      value=$2
      shift 2
      [[ "$option" == --dump-header ]] && headers=$value || body=$value
      ;;
    --max-filesize)
      max_filesize=$2
      shift 2
      ;;
    --proxy)
      proxy_marker=$2
      shift 2
      ;;
    --noproxy)
      noproxy=$2
      shift 2
      ;;
    --proto)
      proto=$2
      shift 2
      ;;
    --max-redirs)
      max_redirs=$2
      shift 2
      ;;
    --write-out|--retry|--connect-timeout|--max-time|--config|--header|-H)
      shift 2
      ;;
    --silent|--show-error)
      shift
      ;;
    *)
      url=$1
      shift
      ;;
  esac
done

[[ -n "$body" && -n "$headers" && -n "$url" ]]
if [[ "$url" == https://api.github.com/* ]]; then
  printf '%s\t%s\t%s\t%s\t%s\n' "$url" "$proxy_marker" "$noproxy" "$proto" "$max_redirs" \
    >> "$MOCK_PUBLIC_FIXTURE/github-direct-calls.log"
fi
: > "$headers"
status=200
case "$url" in
  https://api.github.com/*/actions/runs/*)
    [[ "$proxy_marker" == '' && "$noproxy" == api.github.com && "$proto" == '=https' && "$max_redirs" == 0 ]]
    [[ "$MOCK_PUBLIC_MODE" != github-timeout ]] || exit 28
    [[ "$MOCK_PUBLIC_MODE" != github-504 ]] || status=504
    [[ "$MOCK_PUBLIC_MODE" != github-rate ]] || printf 'X-RateLimit-Remaining: 0\r\n' >> "$headers"
    cp "$MOCK_PUBLIC_FIXTURE/run.json" "$body"
    ;;
  https://api.github.com/*/git/ref/heads/main)
    [[ "$proxy_marker" == '' && "$noproxy" == api.github.com && "$proto" == '=https' && "$max_redirs" == 0 ]]
    cp "$MOCK_PUBLIC_FIXTURE/main.json" "$body"
    ;;
  https://ghcr.io/token*)
    [[ "$proxy_marker" == '' && "$noproxy" == ghcr.io && "$proto" == '=https' && "$max_redirs" == 0 ]]
    [[ "$max_filesize" == 65536 ]]
    [[ "$MOCK_PUBLIC_MODE" != registry-timeout ]] || exit 28
    [[ "$MOCK_PUBLIC_MODE" != registry-redirect ]] || {
      status=302
      printf 'Location: https://example.invalid/redirect\r\n' >> "$headers"
    }
    [[ "$MOCK_PUBLIC_MODE" != registry-504 ]] || status=504
    [[ "$MOCK_PUBLIC_MODE" != registry-rate ]] || printf 'RateLimit-Remaining: 0\r\n' >> "$headers"
    [[ "$MOCK_PUBLIC_MODE" != registry-header-at-cap ]] ||
      dd if=/dev/zero of="$headers" bs=1048576 count=1 status=none
    [[ "$MOCK_PUBLIC_MODE" != registry-header-over-cap ]] || {
      trap 'wc -c < "$headers" > "$MOCK_PUBLIC_FIXTURE/header-bytes.log"' EXIT
      dd if=/dev/zero of="$headers" bs=1048577 count=1 status=none
    }
    cp "$MOCK_PUBLIC_FIXTURE/token.json" "$body"
    ;;
  https://ghcr.io/v2/beginning-new/planegamecode/manifests/*)
    [[ "$proxy_marker" == '' && "$noproxy" == ghcr.io && "$proto" == '=https' && "$max_redirs" == 0 ]]
    [[ "$max_filesize" == 1048576 ]]
    cp "$MOCK_PUBLIC_FIXTURE/manifest.json" "$body"
    case "$MOCK_PUBLIC_MODE" in
      digest-malformed) printf 'Docker-Content-Digest: latest\r\n' >> "$headers" ;;
      digest-multiple)
        printf 'Docker-Content-Digest: %s\r\nDocker-Content-Digest: %s\r\n' "$MOCK_DIGEST" "$MOCK_CHANGED_DIGEST" >> "$headers"
        ;;
      *) printf 'Docker-Content-Digest: %s\r\n' "$MOCK_DIGEST" >> "$headers" ;;
    esac
    ;;
  *)
    printf 'unexpected mock URL: %s\n' "$url" >&2
    exit 64
    ;;
esac
printf '%s' "$status"
`;

const mockDocker = String.raw`#!/usr/bin/env bash
set -euo pipefail
[[ "$(tr -d '[:space:]' < "$DOCKER_CONFIG/config.json")" == '{}' ]]
printf '%s\n' "$*" >> "$MOCK_DOCKER_EVENTS"
[[ "$1" == pull ]]
[[ "$MOCK_DOCKER_FAIL_ON" != "$2" ]]
`;

function shellAvailable() {
  if (process.platform === 'win32') return false;
  return spawnSync('bash', ['-lc', 'command -v jq >/dev/null'], { encoding: 'utf8' }).status === 0;
}

const canRunShellDrills = shellAvailable();

function expectedRun(overrides = {}) {
  return {
    id: 9001,
    run_attempt: 2,
    run_number: 77,
    name: 'Checks',
    path: '.github/workflows/checks.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
    head_repository: { full_name: 'Beginning-NEW/PlaneGameCode' },
    ...overrides,
  };
}

async function createFixture({
  run = expectedRun(),
  mainSha = sha,
  manifest = { schemaVersion: 2 },
  manifestRaw,
  token = 'fixture-public-token=',
  tokenRaw,
  mode = '',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'plane-public-source-'));
  const bin = join(root, 'bin');
  const dockerConfig = join(root, 'docker-config');
  await mkdir(bin);
  await mkdir(dockerConfig);
  await writeFile(join(root, 'run.json'), JSON.stringify(run));
  await writeFile(join(root, 'main.json'), JSON.stringify({ object: { sha: mainSha } }));
  await writeFile(join(root, 'token.json'), tokenRaw ?? JSON.stringify({ token }));
  await writeFile(join(root, 'manifest.json'), manifestRaw ?? JSON.stringify(manifest));
  await writeFile(join(dockerConfig, 'config.json'), '{}\n');
  await writeFile(join(bin, 'curl'), mockCurl, { mode: 0o755 });
  await writeFile(join(bin, 'docker'), mockDocker, { mode: 0o755 });
  await chmod(join(bin, 'curl'), 0o755);
  await chmod(join(bin, 'docker'), 0o755);
  return {
    root,
    dockerConfig,
    events: join(root, 'docker-events.log'),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'Beginning-NEW/PlaneGameCode',
      MOCK_PUBLIC_FIXTURE: root,
      MOCK_PUBLIC_MODE: mode,
      MOCK_DIGEST: digest,
      MOCK_CHANGED_DIGEST: changedDigest,
      MOCK_DOCKER_EVENTS: join(root, 'docker-events.log'),
      MOCK_DOCKER_FAIL_ON: '',
      DOCKER_CONFIG: dockerConfig,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'socks5h://127.0.0.1:9',
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function run(script, args, fixture, extraEnv = {}) {
  return spawnSync('bash', [join(repositoryRoot, script), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...fixture.env, ...extraEnv },
  });
}

function runWithNonzeroCoreLimit(script, args, fixture) {
  return spawnSync('bash', [
    '-c',
    'ulimit -c 1024; exec bash "$@"',
    'bounded-ghcr-core',
    join(repositoryRoot, script),
    ...args,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: fixture.env,
  });
}

test('SCM, Actions, and public image proof have no Jenkins credential path', () => {
  assert.match(job, /url\('https:\/\/github[.]com\/Beginning-NEW\/PlaneGameCode[.]git'\)/);
  assert.doesNotMatch(job, /credentials\(/);
  assert.doesNotMatch(casc, /scope: GLOBAL|PLANE_(?:GITHUB|GHCR)_/);
  assert.doesNotMatch(pipeline, /withCredentials|credentialsId/);
  assert.match(images, /^NGINX_BASE_IMAGE=.*@sha256:[0-9a-f]{64}$/m);
  assert.match(images, /^GATEWAY_IMAGE=.*@sha256:[0-9a-f]{64}$/m);
  assert.doesNotMatch(pullHelper, /docker login|GHCR_(?:USER|TOKEN)|GH_API_TOKEN/);
});

test('production shell accepts one exact anonymous run, main ref, and registry digest', { skip: !canRunShellDrills }, async () => {
  const fixture = await createFixture();
  try {
    const result = run('ops/jenkins/verify-candidate.sh', [sha, '9001', '2'], fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${digest}\t${gatewayImage}\t77\t2`);
  } finally {
    await fixture.cleanup();
  }
});

test('production candidate revalidation bypasses hostile proxies and redirects for every GitHub call', { skip: !canRunShellDrills }, async () => {
  const fixture = await createFixture();
  try {
    const result = run('ops/jenkins/verify-candidate.sh', [sha, '9001', '2'], fixture);
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(join(fixture.root, 'github-direct-calls.log'), 'utf8')).trim().split('\n');
    assert.deepEqual(calls, [
      `https://api.github.com/repos/Beginning-NEW/PlaneGameCode/actions/runs/9001/attempts/2\t\tapi.github.com\t=https\t0`,
      `https://api.github.com/repos/Beginning-NEW/PlaneGameCode/git/ref/heads/main\t\tapi.github.com\t=https\t0`,
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('production shell rejects run, attempt, SHA, conclusion, repository, and main-ref mismatches', { skip: !canRunShellDrills }, async () => {
  const cases = [
    { label: 'run id', run: expectedRun({ id: 9002 }) },
    { label: 'attempt', run: expectedRun({ run_attempt: 3 }) },
    { label: 'SHA', run: expectedRun({ head_sha: 'e'.repeat(40) }) },
    { label: 'conclusion', run: expectedRun({ conclusion: 'failure' }) },
    { label: 'repository', run: expectedRun({ repository: { full_name: 'fork/PlaneGameCode' } }) },
    { label: 'main ref', mainSha: 'f'.repeat(40) },
  ];
  for (const scenario of cases) {
    const fixture = await createFixture(scenario);
    try {
      const result = run('ops/jenkins/verify-candidate.sh', [sha, '9001', '2'], fixture);
      assert.notEqual(result.status, 0, `${scenario.label} unexpectedly passed`);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('production shell fails closed on public API and registry transport, HTTP, rate, and metadata faults', { skip: !canRunShellDrills }, async () => {
  const cases = [
    { mode: 'github-timeout', error: /unavailable or timed out/i },
    { mode: 'github-504', error: /HTTP 504/ },
    { mode: 'github-rate', error: /rate limit exhausted/i },
    { mode: 'registry-timeout', error: /unavailable or timed out/i },
    { mode: 'registry-504', error: /HTTP 504/ },
    { mode: 'registry-redirect', error: /HTTP 302/ },
    { mode: 'registry-rate', error: /rate limit is exhausted/i },
    { mode: 'digest-malformed', error: /canonical sha256 digest/i },
    { mode: 'digest-multiple', error: /canonical sha256 digest/i },
    { token: 'fixture-token\nAuthorization: malicious', error: /token response is malformed/i },
    { token: 'fixture-token=malformed', error: /token response is malformed/i },
    { manifest: { schemaVersion: 1 }, error: /manifest is malformed/i },
  ];
  for (const scenario of cases) {
    const fixture = await createFixture(scenario);
    try {
      const result = run('ops/jenkins/verify-candidate.sh', [sha, '9001', '2'], fixture);
      assert.notEqual(result.status, 0, `${scenario.mode ?? 'malformed manifest'} unexpectedly passed`);
      assert.match(result.stderr, scenario.error);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('GHCR succeeds without Content-Length while hostile inherited proxies remain set', { skip: !canRunShellDrills }, async () => {
  const fixture = await createFixture({ mode: 'registry-no-content-length' });
  try {
    const result = runWithNonzeroCoreLimit(
      'ops/jenkins/resolve-public-ghcr-digest.sh',
      ['Beginning-NEW/PlaneGameCode', sha],
      fixture,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), digest);
    assert.deepEqual(
      (await readFile(join(fixture.root, 'curl-core-limits.log'), 'utf8')).trim().split('\n'),
      ['0', '0'],
    );
  } finally {
    await fixture.cleanup();
  }
});
test('GHCR transport bounds header, token, and manifest files and rejects every reached cap', { skip: !canRunShellDrills }, async () => {
  const cases = [
    { mode: 'registry-header-at-cap', error: /headers reached the size limit/i },
    {
      mode: 'registry-header-over-cap',
      error: /size limit/i,
      observedHeaderBytes: headerMaxBytes,
    },
    { tokenRaw: ' '.repeat(tokenBodyMaxBytes), error: /body reached the size limit/i },
    { manifestRaw: ' '.repeat(manifestBodyMaxBytes),
      error: /body reached the size limit|response exceeded a size limit/i },
  ];
  for (const scenario of cases) {
    const fixture = await createFixture(scenario);
    try {
      const result = run('ops/jenkins/verify-candidate.sh', [sha, '9001', '2'], fixture);
      assert.notEqual(result.status, 0, `${scenario.mode ?? 'body cap'} unexpectedly passed`);
      assert.match(result.stderr, scenario.error);
      if (scenario.observedHeaderBytes) {
        const observed = Number.parseInt(
          await readFile(join(fixture.root, 'header-bytes.log'), 'utf8'),
          10,
        );
        assert.equal(observed, scenario.observedHeaderBytes);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test('GHCR file-size ceilings remain explicit and independently bounded', () => {
  assert.equal(headerMaxBytes, manifestBodyMaxBytes);
  assert.ok(tokenBodyMaxBytes < manifestBodyMaxBytes);
});

test('digest-only pull helper re-resolves then pulls both exact public images with an empty config', { skip: !canRunShellDrills }, async () => {
  const fixture = await createFixture();
  try {
    const result = run(
      'ops/jenkins/pull-public-images.sh',
      [sha, 'ghcr.io/beginning-new/planegamecode', digest, gatewayImage],
      fixture,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(fixture.events, 'utf8')).trim().split('\n'), [
      `pull ghcr.io/beginning-new/planegamecode@${digest}`,
      `pull ${gatewayImage}`,
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('digest change and ambient auth fail before any public image pull', { skip: !canRunShellDrills }, async () => {
  for (const scenario of [
    { expected: changedDigest, error: /digest changed before pull/, env: {} },
    { expected: digest, error: /ambient registry authentication is forbidden/, env: { DOCKER_AUTH_CONFIG: '{}' } },
  ]) {
    const fixture = await createFixture();
    try {
      const result = run(
        'ops/jenkins/pull-public-images.sh',
        [sha, 'ghcr.io/beginning-new/planegamecode', scenario.expected, gatewayImage],
        fixture,
        scenario.env,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, scenario.error);
      assert.equal(existsSync(fixture.events), false, 'docker must not run before the trust gate passes');
    } finally {
      await fixture.cleanup();
    }
  }
});

test('a public pull failure is fatal and does not continue to the gateway pull', { skip: !canRunShellDrills }, async () => {
  const fixture = await createFixture();
  const application = `ghcr.io/beginning-new/planegamecode@${digest}`;
  try {
    const result = run(
      'ops/jenkins/pull-public-images.sh',
      [sha, 'ghcr.io/beginning-new/planegamecode', digest, gatewayImage],
      fixture,
      { MOCK_DOCKER_FAIL_ON: application },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public application pull failed/);
    assert.equal((await readFile(fixture.events, 'utf8')).trim(), `pull ${application}`);
  } finally {
    await fixture.cleanup();
  }
});
