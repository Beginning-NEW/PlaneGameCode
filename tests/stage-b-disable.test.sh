#!/usr/bin/env bash
set -euo pipefail

root=$(pwd -P)
scratch=$(mktemp -d)
cleanup() { rm -rf -- "$scratch"; }
trap cleanup EXIT

profile=$scratch/controller-stage-b
approved=$scratch/approved
fake_bin=$scratch/bin
events=$scratch/events.log
mkdir -p "$profile" "$approved" "$fake_bin"
cp "$root/ops/jenkins/controller-stage-b/disable-stage-b.sh" "$profile/"
printf 'PLANE_PREFLIGHT_UID=%s\nROOTLESS_DOCKER_HOST=unix:///run/user/%s/docker.sock\nJENKINS_CONTAINER=plane-game-jenkins-stage-b\n' \
  "$(id -u)" "$(id -u)" >"$profile/runtime.env"
printf 'plane-game/main-cd=disabled\n' >"$approved/job-disabled.ack"

cat >"$profile/manage-actions-poller.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 1 && "$1" == deactivate ]]
printf 'poller:deactivate\n' >>"$STAGE_B_DISABLE_EVENTS"
SH

cat >"$fake_bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --user && "$2" == stop && "$3" == plane-game-webhook-gateway.service ]]
printf 'gateway:stop\n' >>"$STAGE_B_DISABLE_EVENTS"
SH

cat >"$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == container && "$2" == inspect && "$3" == plane-game-jenkins-stage-b ]]; then
  exit 0
fi
[[ "$1" == stop && "$2" == --time && "$3" == 30 && "$4" == plane-game-jenkins-stage-b ]]
printf 'controller:stop\n' >>"$STAGE_B_DISABLE_EVENTS"
SH
chmod 0700 "$profile/manage-actions-poller.sh" "$fake_bin/systemctl" "$fake_bin/docker"

env DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock" \
  STAGE_B_DISABLE_EVENTS="$events" PATH="$fake_bin:/usr/bin:/bin" \
  bash "$profile/disable-stage-b.sh" "$approved" >"$scratch/stdout"

grep -Fxq 'disable-order=job,poller,gateway,controller' "$scratch/stdout"
expected=$'poller:deactivate\ngateway:stop\ncontroller:stop'
[[ "$(cat "$events")" == "$expected" ]]
printf 'stage B disable order test: PASS\n'
