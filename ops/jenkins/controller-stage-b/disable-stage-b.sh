#!/usr/bin/env bash
set -euo pipefail

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'stage-b disable refused: %s\n' "$*" >&2
  exit 1
}

approved_dir=${1:?usage: disable-stage-b.sh APPROVED_DIR}
[[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" ]] || fail 'must run as UID 1003'
[[ "${DOCKER_HOST:-}" == "$ROOTLESS_DOCKER_HOST" ]] || fail 'rootless DOCKER_HOST mismatch'
grep -Fxq 'plane-game/main-cd=disabled' "$approved_dir/job-disabled.ack" ||
  fail 'disable job first and record the exact acknowledgement'

printf 'disable-order=job,poller,gateway,controller\n'
"$profile_dir/manage-actions-poller.sh" deactivate
if ! systemctl --user stop plane-game-webhook-gateway.service; then
  load_state=$(systemctl --user show plane-game-webhook-gateway.service --property=LoadState --value) ||
    fail 'cannot inspect gateway unit after stop failed'
  [[ "$load_state" == not-found ]] || fail 'cannot stop installed gateway unit'
fi
if docker container inspect "$JENKINS_CONTAINER" >/dev/null 2>&1; then
  docker stop --time 30 "$JENKINS_CONTAINER" >/dev/null
fi
