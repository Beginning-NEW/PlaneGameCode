#!/usr/bin/env bash
set -euo pipefail

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mode=${1:?usage: rollback-stage-b.sh first-release|last-healthy APPROVED_DIR}
approved_dir=${2:?usage: rollback-stage-b.sh first-release|last-healthy APPROVED_DIR}

"$profile_dir/disable-stage-b.sh" "$approved_dir"
case "$mode" in
  first-release)
    grep -Fxq 'plane-game=absent' "$approved_dir/no-app.ack" ||
      { printf 'first-release rollback requires the no-app acknowledgement\n' >&2; exit 1; }
    printf 'rollback=first-release state=no-jenkins,no-app home=preserved\n'
    ;;
  last-healthy)
    volume=$(tr -d '\r\n' <"$approved_dir/last-healthy-home-volume")
    [[ "$volume" =~ ^plane-game-jenkins-stage-b-home(-restore-[0-9]{8}T[0-9]{6}Z)?$ ]] ||
      { printf 'last-healthy volume is outside the Stage B namespace\n' >&2; exit 1; }
    install -m 0600 "$approved_dir/last-healthy-home-volume" "$approved_dir/active-home-volume"
    printf 'rollback=last-healthy selected-volume=%s state=disabled\n' "$volume"
    ;;
  *)
    printf 'unknown rollback mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac
