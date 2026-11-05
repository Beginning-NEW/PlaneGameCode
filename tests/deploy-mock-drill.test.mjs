import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseSha = '0123456789abcdef0123456789abcdef01234567';
const approvedDigest = `sha256:${'a'.repeat(64)}`;
const gatewayImage = `nginxinc/nginx-unprivileged@sha256:${'c'.repeat(64)}`;
const mismatchedDigest = `sha256:${'b'.repeat(64)}`;

const mockDocker = `#!/usr/bin/env bash
set -euo pipefail

state="\${MOCK_DOCKER_STATE:?}"
mkdir -p "$state"

event() { printf '%s\\n' "$1" >> "$state/events.log"; }
last_arg() { printf '%s\\n' "\${!#}"; }

command="$1"
shift
case "$command" in
  info) exit 0 ;;
  compose)
    if [[ "$1" == config ]]; then
      [[ "\${2:-}" == --images ]] && printf '%s\\n' "$GATEWAY_IMAGE"
      exit 0
    fi
    [[ "$1" == ps ]] && exit 0
    exit 1
    ;;
  image)
    [[ "$1" == inspect ]] || exit 1
    if [[ "\${2:-}" == --format ]]; then
      case "$3" in
        *org.opencontainers.image.revision*) printf '%s\\n' "$MOCK_IMAGE_SHA" ;;
        *RepoDigests*) printf '%s@%s\\n' "$MOCK_IMAGE_REPOSITORY" "$MOCK_APPROVED_DIGEST" ;;
        *'{{.Id}}'*) printf 'sha256:%s\\n' "$(printf c%.0s {1..64})" ;;
        *) exit 1 ;;
      esac
    fi
    exit 0
    ;;
  network)
    action="$1"
    shift
    case "$action" in
      inspect)
        target=$(last_arg "$@")
        [[ -f "$state/network.id" ]] || exit 1
        [[ "$target" == plane-game_default || "$target" == "$(<"$state/network.id")" ]] || exit 1
        if [[ "\${1:-}" == --format ]]; then
          printf '%s %s plane-game default\\n' "$(<"$state/network.id")" "$(<"$state/network.deployment")"
        fi
        ;;
      create)
        deployment=''
        while (($#)); do
          if [[ "$1" == --label ]]; then
            shift
            [[ "$1" == com.plane-game.deployment-id=* ]] && deployment="\${1#*=}"
          fi
          shift || true
        done
        printf 'owned-nid\\n' > "$state/network.id"
        printf '%s\\n' "$deployment" > "$state/network.deployment"
        event 'network-create:owned-nid'
        printf 'owned-nid\\n'
        ;;
      ls)
        [[ -f "$state/network.id" ]] && cat "$state/network.id"
        ;;
      rm)
        target=$(last_arg "$@")
        [[ "$target" == "$(<"$state/network.id")" ]] || exit 1
        event "network-rm:$target"
        rm -f "$state/network.id" "$state/network.deployment"
        ;;
      *) exit 1 ;;
    esac
    ;;
  container)
    [[ "$1" == inspect ]] || exit 1
    shift
    target=$(last_arg "$@")
    [[ "$target" == owned-cid && -f "$state/candidate.id" ]] || exit 1
    if [[ "\${1:-}" == --format ]]; then
      printf '%s %s %s %s\\n' \
        "$(<"$state/candidate.id")" \
        "$(<"$state/candidate.deployment")" \
        "$(<"$state/candidate.sha")" \
        "$(<"$state/candidate.digest")"
    fi
    ;;
  ps)
    [[ -f "$state/candidate.id" ]] && cat "$state/candidate.id"
    ;;
  run)
    deployment=''
    sha=''
    digest=''
    while (($#)); do
      if [[ "$1" == --label ]]; then
        shift
        case "$1" in
          com.plane-game.deployment-id=*) deployment="\${1#*=}" ;;
          com.plane-game.release-sha=*) sha="\${1#*=}" ;;
          com.plane-game.image-digest=*) digest="\${1#*=}" ;;
        esac
      fi
      shift || true
    done
    printf 'owned-cid\\n' > "$state/candidate.id"
    printf '%s\\n' "$deployment" > "$state/candidate.deployment"
    printf '%s\\n' "$sha" > "$state/candidate.sha"
    printf '%s\\n' "\${MOCK_CANDIDATE_DIGEST:-$digest}" > "$state/candidate.digest"
    event 'candidate-run:owned-cid'
    exit 72
    ;;
  rm)
    target=$(last_arg "$@")
    [[ "$target" == owned-cid && -f "$state/candidate.id" ]] || exit 1
    event "candidate-rm:$target"
    rm -f "$state/candidate.id" "$state/candidate.deployment" "$state/candidate.sha" "$state/candidate.digest"
    ;;
  *) exit 1 ;;
esac
`;

function resolveBashExecutable() {
  if (process.platform === 'win32') {
    const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
    const gitBash = join(resolve(gitExecPath, '../../..'), 'bin', 'bash.exe');
    if (existsSync(gitBash)) return gitBash;
  }
  return 'bash';
}

const bashExecutable = resolveBashExecutable();

function bashIsAvailable() {
  return spawnSync(bashExecutable, ['--version'], { encoding: 'utf8' }).status === 0;
}

const canRunMockDockerDrill = process.platform !== 'win32' && bashIsAvailable();

async function createFixture(candidateDigest) {
  const root = await mkdtemp(join(tmpdir(), 'plane-game-deploy-drill-'));
  const bin = join(root, 'bin');
  const state = join(root, 'mock-state');
  const runtime = join(root, 'runtime');
  await cp(join(repositoryRoot, 'deploy'), join(root, 'deploy'), { recursive: true });
  await cp(join(repositoryRoot, 'compose.yaml'), join(root, 'compose.yaml'));
  await writeFile(join(root, 'deploy', 'common.sh'), '\nport_is_available() { return 0; }\n', { flag: 'a' });
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(bin, 'docker'), mockDocker, { mode: 0o755 });
  await writeFile(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await chmod(join(bin, 'docker'), 0o755);
  await chmod(join(bin, 'flock'), 0o755);
  await chmod(join(bin, 'curl'), 0o755);

  return {
    root,
    state,
    runtime,
    candidateDigest,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function runPartialCandidateCreate(fixture) {
  return spawnSync(
    bashExecutable,
    [
      '-c',
      'to_shell_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf "%s\\n" "$1"; fi; }; bin=$(to_shell_path "$1"); deploy=$(to_shell_path "$2"); export PATH="$bin:$PATH"; export MOCK_DOCKER_STATE="$(to_shell_path "$8")"; export PLANE_GAME_RUNTIME_DIR="$(to_shell_path "$9")"; exec "$BASH" "$deploy" "$3" "$4" "$5" "$6" "$7"',
      'deploy-mock-drill',
      join(fixture.root, 'bin'),
      join(fixture.root, 'deploy', 'deploy.sh'),
      releaseSha,
      'example/plane-game',
      approvedDigest,
      '65535',
      gatewayImage,
      fixture.state,
      fixture.runtime,
    ],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLANE_GAME_RUNTIME_DIR: fixture.runtime,
        MOCK_DOCKER_STATE: fixture.state,
        GATEWAY_IMAGE: gatewayImage,
        MOCK_IMAGE_SHA: releaseSha,
        MOCK_IMAGE_REPOSITORY: 'example/plane-game',
        MOCK_APPROVED_DIGEST: approvedDigest,
        MOCK_CANDIDATE_DIGEST: fixture.candidateDigest,
      },
    },
  );
}

async function snapshotState(runtime) {
  const snapshots = await readdir(join(runtime, 'deployment-snapshots'));
  assert.equal(snapshots.length, 1);
  return readFile(join(runtime, 'deployment-snapshots', snapshots[0], 'state.env'), 'utf8');
}

test('mock Docker first-release failure removes only a fully matching candidate before its network', { skip: !canRunMockDockerDrill }, async () => {
  const fixture = await createFixture(approvedDigest);
  try {
    const result = runPartialCandidateCreate(fixture);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /candidate container failed to start; candidate and this run's plane-game route\/resources were reverted/);
    assert.deepEqual(
      (await readFile(join(fixture.state, 'events.log'), 'utf8')).trim().split('\n'),
      ['network-create:owned-nid', 'candidate-run:owned-cid', 'candidate-rm:owned-cid', 'network-rm:owned-nid'],
    );
    assert.equal(existsSync(join(fixture.state, 'candidate.id')), false);
    assert.equal(existsSync(join(fixture.state, 'network.id')), false);
    assert.equal(existsSync(join(fixture.runtime, 'active', 'upstream.inc')), false);
    assert.equal(existsSync(join(fixture.runtime, 'previous_healthy_sha')), false);
    assert.match(await snapshotState(fixture.runtime), /outcome=reverted/);
    assert.match(await snapshotState(fixture.runtime), /gateway_image=nginxinc\/nginx-unprivileged@sha256:/);
  } finally {
    await fixture.cleanup();
  }
});

test('mock Docker digest mismatch preserves the ambiguous candidate and network as revert_incomplete', { skip: !canRunMockDockerDrill }, async () => {
  const fixture = await createFixture(mismatchedDigest);
  try {
    const result = runPartialCandidateCreate(fixture);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /candidate container digest label mismatch; preserving this run-scoped resource/);
    assert.match(result.stderr, /cleanup is incomplete for deployment-id=/);
    assert.deepEqual(
      (await readFile(join(fixture.state, 'events.log'), 'utf8')).trim().split('\n'),
      ['network-create:owned-nid', 'candidate-run:owned-cid'],
    );
    assert.equal(existsSync(join(fixture.state, 'candidate.id')), true);
    assert.equal(existsSync(join(fixture.state, 'network.id')), true);
    assert.match(await snapshotState(fixture.runtime), /outcome=revert_incomplete/);
    assert.match(await snapshotState(fixture.runtime), /gateway_image=nginxinc\/nginx-unprivileged@sha256:/);
  } finally {
    await fixture.cleanup();
  }
});
