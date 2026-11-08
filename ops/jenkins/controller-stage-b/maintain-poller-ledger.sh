#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"
state_dir=${PLANE_POLLER_STATE_DIR:-"$HOME/.local/state/plane-game-poller"}

[[ $# -eq 0 ]] || { printf 'usage: maintain-poller-ledger.sh\n' >&2; exit 1; }
[[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" && "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] || {
  printf 'ledger maintenance must run as %s UID %s\n' "$PLANE_PREFLIGHT_USER" "$PLANE_PREFLIGHT_UID" >&2
  exit 1
}
[[ "$state_dir" == /* && -d "$state_dir" && ! -L "$state_dir" ]] || {
  printf 'ledger maintenance state directory is invalid\n' >&2
  exit 1
}
[[ "$(stat -c '%u %a' -- "$state_dir")" == "$PLANE_PREFLIGHT_UID 700" ]] || {
  printf 'ledger maintenance state directory owner/mode is invalid\n' >&2
  exit 1
}

export PLANE_POLLER_STATE_DIR=$state_dir
exec /usr/bin/flock --no-fork --nonblock "$state_dir/.shared.lock" \
  /usr/bin/node "$HOME/plane-game-cd/ops/jenkins/maintain-poller-ledger.mjs"
