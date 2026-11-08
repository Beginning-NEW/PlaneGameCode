#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 11 ]] || { echo 'Usage: deploy-local.sh MODE STATE_DIR SHA REPOSITORY DIGEST PORT RUN_ID RUN_NUMBER RUN_ATTEMPT GATEWAY_IMAGE POST_CD_RESOURCE_GATE' >&2; exit 1; }
mode=$1
state_dir=$2
sha=$3
repository=$4
digest=$5
port=$6
run_id=$7
run_number=$8
run_attempt=$9
gateway_image=${10}
post_cd_resource_gate=${11}

[[ "$mode" == poller || "$mode" == webhook ]] || { echo 'Unknown CD trigger mode' >&2; exit 1; }
[[ "${CD_TRIGGER_MODE:-}" == "$mode" ]] || { echo 'CD trigger mode mismatch' >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$repository" == ghcr.io/beginning-new/planegamecode ]] || { echo 'Unexpected GHCR repository' >&2; exit 1; }
[[ "$port" == 18081 ]] || { echo 'DEPLOY_PORT must be the versioned value 18081' >&2; exit 1; }
[[ "$run_id" =~ ^[1-9][0-9]*$ && ${#run_id} -le 20 ]] || exit 1
[[ "$run_number" =~ ^[1-9][0-9]*$ && ${#run_number} -le 15 ]] || exit 1
[[ "$run_attempt" =~ ^[1-9][0-9]*$ && ${#run_attempt} -le 10 ]] || exit 1
[[ "$gateway_image" =~ ^nginxinc/nginx-unprivileged@sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$post_cd_resource_gate" == ops/jenkins/resource-gate.sh ]] || { echo 'Unexpected post-CD resource gate' >&2; exit 1; }
[[ "$(id -un)" == plane-preflight && "$(id -u)" -ne 0 ]] || exit 1
[[ "$(git rev-parse HEAD)" == "$sha" ]] || { echo 'Trusted checkout changed before deployment' >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo 'Jenkins checkout is dirty' >&2; exit 1; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
state_cli="$script_dir/deployment-state.mjs"
trigger_id="$sha:$run_id:$run_attempt"
root="$HOME/plane-game"
incoming="$root/incoming"
stage="$incoming/$sha-$run_number-$run_attempt"
mkdir -p "$incoming"
[[ ! -e "$stage" ]] || { echo 'Run-specific deployment source already exists' >&2; exit 1; }

if [[ "$mode" == poller ]]; then
  [[ "$state_dir" == "$HOME/.local/state/plane-game-poller" && -f "$state_cli" && ! -L "$state_cli" ]] || exit 1
  state_lock="$state_dir/.shared.lock"
  [[ -f "$state_lock" && ! -L "$state_lock" ]] || exit 1
  state_call() {
    flock --no-fork --nonblock "$state_lock" node "$state_cli" "$@"
  }
  begin=$(state_call begin "$state_dir" "$root/runtime" "$sha" "$run_id" "$run_attempt" "$digest")
  action=${begin%%$'\t'*}
  case "$action" in
    deploy) ;;
    recovered_success) printf 'deployment already reconciled as exact healthy runtime\n'; exit 0 ;;
    rollback_once)
      previous_sha=${begin#*$'\t'}
      [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
      (cd "$root" && PLANE_GAME_RUNTIME_DIR="$root/runtime" bash deploy/rollback.sh "$previous_sha" "$port")
      state_call rollback-complete "$state_dir" "$root/runtime" "$trigger_id" >/dev/null
      exit 1
      ;;
    *) echo "Deployment reconciliation refused: $action" >&2; exit 1 ;;
  esac
fi

stage_tmp=$(mktemp -d "$incoming/.candidate.$sha.$run_number.$run_attempt.XXXXXX")
docker_config=$(mktemp -d "$incoming/.docker-public.$run_number.$run_attempt.XXXXXX")
cleanup() {
  rm -rf -- "$docker_config"
  [[ ! -d "$stage_tmp" ]] || rm -rf -- "$stage_tmp"
}
trap cleanup EXIT

git archive --format=tar "$sha" compose.yaml deploy ops/jenkins/deployment-state.mjs ops/jenkins/lib "$post_cd_resource_gate" | tar -xf - -C "$stage_tmp"
[[ -f "$stage_tmp/compose.yaml" && -f "$stage_tmp/deploy/promote.sh" &&
   -f "$stage_tmp/$post_cd_resource_gate" && ! -L "$stage_tmp/$post_cd_resource_gate" ]] || exit 1
mv "$stage_tmp" "$stage"

export DOCKER_CONFIG="$docker_config"
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
unset DOCKER_AUTH_CONFIG REGISTRY_AUTH_FILE
umask 077
printf '{}\n' > "$DOCKER_CONFIG/config.json"
bash ops/jenkins/pull-public-images.sh "$sha" "$repository" "$digest" "$gateway_image"

bash ops/jenkins/resource-gate.sh
if [[ "$mode" == poller ]]; then
  second_digest=$(bash ops/jenkins/resolve-public-ghcr-digest.sh "$GITHUB_REPOSITORY" "$sha")
  [[ "$second_digest" == "$digest" ]] || { echo 'GHCR digest changed before deployment' >&2; exit 1; }
  GIT_TERMINAL_PROMPT=0 git fetch --no-tags origin refs/heads/main
  [[ "$(git rev-parse FETCH_HEAD)" == "$sha" ]] || { echo 'SCM main moved after image pull' >&2; exit 1; }
else
  bash ops/jenkins/pre-promote-check.sh "$sha" "$run_id" "$run_attempt" "$digest" "$gateway_image" "$run_number"
fi

export PLANE_POLLER_STATE_DIR="$state_dir"
export PLANE_DEPLOYMENT_STATE_CLI="$state_cli"
export PLANE_LEDGER_LOCK_FILE="${state_lock:-}"
export PLANE_TRIGGER_ID="$trigger_id"
export GITHUB_RUN_ID="$run_id"
export GITHUB_RUN_ATTEMPT="$run_attempt"
cd "$root"
bash "$stage/deploy/promote.sh" "$sha" "$repository" "$digest" "$port" "$run_number" "$run_attempt" "$gateway_image" \
  "$post_cd_resource_gate"
if [[ "$mode" == poller ]]; then
  state_call complete "$state_dir" "$root/runtime" "$trigger_id" >/dev/null
fi
printf 'deployment verified: source=%s trigger=%s sha=%s digest=%s gateway=%s actions_run=%s port=%s health=passed resource_gate=pre_and_post_passed\n' \
  "$mode" "$trigger_id" "$sha" "$digest" "$gateway_image" "$run_number/$run_attempt" "$port"
