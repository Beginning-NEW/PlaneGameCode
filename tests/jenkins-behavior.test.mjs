import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
function findBash() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH;
  if (process.platform !== 'win32') return 'bash';
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout
    .split(/\r?\n/)
    .find(Boolean);
  if (git) {
    const candidate = join(dirname(dirname(git)), 'bin', 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

const bash = findBash();

function run(script, args, options = {}) {
  const env = { ...process.env, ...options.env };
  let bashArgs = [script, ...args];
  if (options.bin) {
    if (process.platform === 'win32') {
      env.FAKE_BIN = options.bin;
      bashArgs = [
        '-c',
        'export PATH="$(cygpath -u "$FAKE_BIN"):$PATH"; exec bash "$@"',
        'behavior-test',
        script,
        ...args,
      ];
    } else {
      env.PATH = `${options.bin}${delimiter}${env.PATH}`;
    }
  }
  return spawnSync(bash, bashArgs, {
    cwd: options.cwd ?? root,
    env,
    encoding: 'utf8',
  });
}

async function executable(path, body) {
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
}

test('release ordering advances only for a newer workflow run number', async () => {
  const work = await mkdtemp(join(tmpdir(), 'plane-order-'));
  await writeFile(join(work, 'last_run_number'), '10\n');
  await writeFile(join(work, 'last_run_attempt'), '1\n');
  const script = join(root, 'deploy/check-release-order.sh');
  const env = { PLANE_GAME_RUNTIME_DIR: work };

  const older = run(script, ['9', '1'], { env });
  assert.notEqual(older.status, 0);
  assert.match(older.stderr, /Stale run number 9/);

  const newer = run(script, ['11', '1'], { env });
  assert.equal(newer.status, 0, newer.stderr);

  const rerun = run(script, ['10', '2'], { env });
  assert.notEqual(rerun.status, 0);
  assert.match(rerun.stderr, /rerun attempt 2 cannot supersede/);
});

test('main movement after image pull fails the immediate pre-promote check', async () => {
  const work = await mkdtemp(join(tmpdir(), 'plane-main-moved-'));
  const scripts = join(work, 'ops/jenkins');
  const bin = join(work, 'bin');
  await mkdir(scripts, { recursive: true });
  await mkdir(bin);
  await copyFile(join(root, 'ops/jenkins/pre-promote-check.sh'), join(scripts, 'pre-promote-check.sh'));
  const sha = 'a'.repeat(40);
  const moved = 'b'.repeat(40);
  const digest = `sha256:${'c'.repeat(64)}`;
  const gateway = `nginxinc/nginx-unprivileged@sha256:${'d'.repeat(64)}`;
  await executable(join(scripts, 'verify-candidate.sh'), `#!/usr/bin/env bash
printf '%s\\t%s\\t%s\\t%s\\n' '${digest}' '${gateway}' '77' '1'
`);
  await executable(join(bin, 'git'), `#!/usr/bin/env bash
if [[ "$1" == fetch ]]; then exit 0; fi
if [[ "$1 $2" == 'rev-parse FETCH_HEAD' ]]; then printf '%s\\n' '${moved}'; exit 0; fi
exit 2
`);
  const result = run(join(scripts, 'pre-promote-check.sh'), [sha, '9001', '1', digest, gateway, '77'], {
    cwd: work,
    bin,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCM main moved after image pull/);

  const localDeploy = await readFile(join(root, 'ops/jenkins/deploy-local.sh'), 'utf8');
  const pull = localDeploy.indexOf('docker pull "$gateway_image"');
  const gate = localDeploy.indexOf('bash ops/jenkins/resource-gate.sh');
  const revalidate = localDeploy.indexOf('pre-promote-check.sh');
  const promote = localDeploy.indexOf('bash "$stage/deploy/promote.sh"');
  assert.ok(pull >= 0 && pull < gate && gate < revalidate && revalidate < promote);
});

test('post-promote health failure restores the previous active release and order marker', async () => {
  const work = await mkdtemp(join(tmpdir(), 'plane-post-check-'));
  const home = join(work, 'home');
  const plane = join(home, 'plane-game');
  const runtime = join(plane, 'runtime');
  const bin = join(work, 'bin');
  const oldSha = '1'.repeat(40);
  const nextSha = '2'.repeat(40);
  const digest = `sha256:${'3'.repeat(64)}`;
  const gateway = `nginxinc/nginx-unprivileged@sha256:${'4'.repeat(64)}`;
  const stage = join(plane, `incoming/${nextSha}-11-1`);
  await mkdir(join(stage, 'deploy'), { recursive: true });
  await mkdir(join(stage, 'ops/jenkins'), { recursive: true });
  await mkdir(join(plane, 'deploy'), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(bin);
  await writeFile(join(runtime, 'active_sha'), `${oldSha}\n`);
  await writeFile(join(runtime, 'last_run_number'), '10\n');
  await writeFile(join(runtime, 'last_run_attempt'), '1\n');
  await writeFile(join(plane, 'compose.yaml'), 'services: {}\n');
  await writeFile(join(stage, 'compose.yaml'), 'services: {}\n');
  await copyFile(join(root, 'deploy/promote.sh'), join(stage, 'deploy/promote.sh'));
  await copyFile(join(root, 'deploy/check-release-order.sh'), join(stage, 'deploy/check-release-order.sh'));
  await executable(join(stage, 'deploy/plane-preflight'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(join(stage, 'ops/jenkins/resource-gate.sh'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(join(stage, 'deploy/deploy.sh'), `#!/usr/bin/env bash
printf '%s\\n' "$1" > "$PLANE_GAME_RUNTIME_DIR/active_sha"
`);
  await executable(join(plane, 'deploy/rollback.sh'), `#!/usr/bin/env bash
printf '%s\\n' "$1" > "$PLANE_GAME_RUNTIME_DIR/active_sha"
`);
  await executable(join(bin, 'id'), `#!/usr/bin/env bash
if [[ "$1" == '-un' ]]; then printf 'plane-preflight\\n'; else printf '1001\\n'; fi
`);
  await executable(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(join(bin, 'docker'), `#!/usr/bin/env bash
case "$1" in
  info) printf '["name=rootless"]\\n' ;;
  compose) printf 'gateway\\n' ;;
  exec) exit 0 ;;
  *) exit 0 ;;
esac
`);
  await executable(join(bin, 'curl'), `#!/usr/bin/env bash
url=''
for arg in "$@"; do url="$arg"; done
active=$(<"$PLANE_GAME_RUNTIME_DIR/active_sha")
if [[ "$url" == */healthz ]]; then
  [[ "$active" != "$NEW_SHA" ]] || exit 22
  printf 'ok\\n'
elif [[ "$url" == */version.json ]]; then
  printf '{"sha":"%s"}' "$active"
else
  exit 2
fi
`);
  const result = run(join(stage, 'deploy/promote.sh'), [
    nextSha,
    'ghcr.io/beginning-new/planegamecode',
    digest,
    '8080',
    '11',
    '1',
    gateway,
    'ops/jenkins/resource-gate.sh',
  ], {
    cwd: plane,
    bin,
    env: {
      HOME: home,
      NEW_SHA: nextSha,
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal((await readFile(join(runtime, 'active_sha'), 'utf8')).trim(), oldSha);
  assert.equal((await readFile(join(runtime, 'last_run_number'), 'utf8')).trim(), '10');
  assert.equal((await readFile(join(runtime, 'last_run_attempt'), 'utf8')).trim(), '1');
  assert.match(result.stderr, /health=failed recovery=restored/);
  assert.doesNotMatch(result.stderr, /ALERT:/);
});

test('post-CD resource gate failure restores the previous active release and order marker', async () => {
  const work = await mkdtemp(join(tmpdir(), 'plane-post-resource-gate-'));
  const home = join(work, 'home');
  const plane = join(home, 'plane-game');
  const runtime = join(plane, 'runtime');
  const bin = join(work, 'bin');
  const oldSha = '8'.repeat(40);
  const nextSha = '9'.repeat(40);
  const digest = `sha256:${'a'.repeat(64)}`;
  const gateway = `nginxinc/nginx-unprivileged@sha256:${'b'.repeat(64)}`;
  const stage = join(plane, `incoming/${nextSha}-21-1`);
  await mkdir(join(stage, 'deploy'), { recursive: true });
  await mkdir(join(stage, 'ops/jenkins'), { recursive: true });
  await mkdir(join(plane, 'deploy'), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(bin);
  await writeFile(join(runtime, 'active_sha'), `${oldSha}\n`);
  await writeFile(join(runtime, 'last_run_number'), '20\n');
  await writeFile(join(runtime, 'last_run_attempt'), '1\n');
  await writeFile(join(plane, 'compose.yaml'), 'services: {}\n');
  await writeFile(join(stage, 'compose.yaml'), 'services: {}\n');
  await copyFile(join(root, 'deploy/promote.sh'), join(stage, 'deploy/promote.sh'));
  await copyFile(join(root, 'deploy/check-release-order.sh'), join(stage, 'deploy/check-release-order.sh'));
  await executable(join(stage, 'deploy/plane-preflight'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(
    join(stage, 'ops/jenkins/resource-gate.sh'),
    '#!/usr/bin/env bash\necho "post-cd resource gate injected failure" >&2\nexit 42\n',
  );
  await executable(join(stage, 'deploy/deploy.sh'), `#!/usr/bin/env bash
printf '%s\n' "$1" > "$PLANE_GAME_RUNTIME_DIR/active_sha"
`);
  await executable(join(plane, 'deploy/rollback.sh'), `#!/usr/bin/env bash
printf '%s\n' "$1" > "$PLANE_GAME_RUNTIME_DIR/active_sha"
`);
  await executable(join(bin, 'id'), `#!/usr/bin/env bash
if [[ "$1" == '-un' ]]; then printf 'plane-preflight\n'; else printf '1001\n'; fi
`);
  await executable(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(join(bin, 'docker'), `#!/usr/bin/env bash
case "$1" in
  info) printf '["name=rootless"]\n' ;;
  compose) printf 'gateway\n' ;;
  exec) exit 0 ;;
  *) exit 0 ;;
esac
`);
  await executable(join(bin, 'curl'), `#!/usr/bin/env bash
url=''
for arg in "$@"; do url="$arg"; done
active=$(<"$PLANE_GAME_RUNTIME_DIR/active_sha")
if [[ "$url" == */healthz ]]; then
  printf 'ok\n'
elif [[ "$url" == */version.json ]]; then
  printf '{"sha":"%s"}' "$active"
else
  exit 2
fi
`);
  const result = run(join(stage, 'deploy/promote.sh'), [
    nextSha,
    'ghcr.io/beginning-new/planegamecode',
    digest,
    '8080',
    '21',
    '1',
    gateway,
    'ops/jenkins/resource-gate.sh',
  ], {
    cwd: plane,
    bin,
    env: { HOME: home },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 42, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal((await readFile(join(runtime, 'active_sha'), 'utf8')).trim(), oldSha);
  assert.equal((await readFile(join(runtime, 'last_run_number'), 'utf8')).trim(), '20');
  assert.equal((await readFile(join(runtime, 'last_run_attempt'), 'utf8')).trim(), '1');
  assert.match(result.stderr, /post-cd resource gate injected failure/);
  assert.match(result.stderr, /health=failed recovery=restored/);
  assert.doesNotMatch(result.stderr, /ALERT:/);
});

test('first-release post-check failure removes the active route and marker', async () => {
  const work = await mkdtemp(join(tmpdir(), 'plane-first-post-check-'));
  const home = join(work, 'home');
  const plane = join(home, 'plane-game');
  const runtime = join(plane, 'runtime');
  const bin = join(work, 'bin');
  const nextSha = '5'.repeat(40);
  const digest = `sha256:${'6'.repeat(64)}`;
  const gateway = `nginxinc/nginx-unprivileged@sha256:${'7'.repeat(64)}`;
  const stage = join(plane, `incoming/${nextSha}-1-1`);
  await mkdir(join(stage, 'deploy'), { recursive: true });
  await mkdir(join(stage, 'ops/jenkins'), { recursive: true });
  await mkdir(join(plane, 'deploy'), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(bin);
  await writeFile(join(stage, 'compose.yaml'), 'services: {}\n');
  await copyFile(join(root, 'deploy/promote.sh'), join(stage, 'deploy/promote.sh'));
  await copyFile(join(root, 'deploy/check-release-order.sh'), join(stage, 'deploy/check-release-order.sh'));
  await executable(join(stage, 'deploy/plane-preflight'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(join(stage, 'ops/jenkins/resource-gate.sh'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(join(stage, 'deploy/deploy.sh'), `#!/usr/bin/env bash
mkdir -p "$PLANE_GAME_RUNTIME_DIR/active"
printf '%s\\n' "$1" > "$PLANE_GAME_RUNTIME_DIR/active_sha"
printf 'set backend\\n' > "$PLANE_GAME_RUNTIME_DIR/active/upstream.inc"
`);
  await executable(join(bin, 'id'), `#!/usr/bin/env bash
if [[ "$1" == '-un' ]]; then printf 'plane-preflight\\n'; else printf '1001\\n'; fi
`);
  await executable(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  await executable(join(bin, 'docker'), `#!/usr/bin/env bash
case "$1" in
  info) printf '["name=rootless"]\\n' ;;
  compose) printf 'gateway\\n' ;;
  rm) exit 0 ;;
  *) exit 0 ;;
esac
`);
  await executable(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 22\n');
  const result = run(join(stage, 'deploy/promote.sh'), [
    nextSha,
    'ghcr.io/beginning-new/planegamecode',
    digest,
    '8080',
    '1',
    '1',
    gateway,
    'ops/jenkins/resource-gate.sh',
  ], {
    cwd: plane,
    bin,
    env: { HOME: home },
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(runtime, 'active_sha')), false);
  assert.equal(existsSync(join(runtime, 'active/upstream.inc')), false);
  assert.match(result.stderr, /health=failed recovery=first_reverted/);
  assert.doesNotMatch(result.stderr, /ALERT:/);
});
