#!/usr/bin/env bash
set -euo pipefail

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'stage-b controller refused: %s\n' "$*" >&2
  exit 1
}

image_id_file=${1:?usage: run-controller.sh IMAGE_ID_FILE APPROVED_DIR}
approved_dir=${2:?usage: run-controller.sh IMAGE_ID_FILE APPROVED_DIR}
[[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" ]] || fail 'must run as UID 1003'
[[ "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] || fail 'must run as plane-preflight'
[[ "${DOCKER_HOST:-}" == "$ROOTLESS_DOCKER_HOST" ]] || fail 'rootless DOCKER_HOST mismatch'

for name in agent-host agent-host-key agent-private-key; do
  [[ -s "$approved_dir/$name" ]] || fail "missing approved file: $name"
done
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^[:space:]]+)?$' "$approved_dir/agent-host-key" ||
  fail 'approved host key must be fixed Ed25519'
image_id=$(tr -d '\r\n' <"$image_id_file")
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'image ID must be immutable sha256'

home_volume=$JENKINS_HOME_VOLUME
if [[ -s "$approved_dir/active-home-volume" ]]; then
  home_volume=$(tr -d '\r\n' <"$approved_dir/active-home-volume")
fi
[[ "$home_volume" =~ ^plane-game-jenkins-stage-b-home(-restore-[0-9]{8}T[0-9]{6}Z)?$ ]] ||
  fail 'home volume is outside the Stage B namespace'
! docker container inspect "$JENKINS_CONTAINER" >/dev/null 2>&1 ||
  fail 'controller container already exists'
docker volume inspect "$home_volume" >/dev/null 2>&1 ||
  docker volume create --label io.paperclip.plane-game.stage=controller-b "$home_volume" >/dev/null

docker run --detach   --name "$JENKINS_CONTAINER"   --label io.paperclip.plane-game.stage=controller-b   --publish "$JENKINS_HOST_IP:$JENKINS_HOST_PORT:$JENKINS_CONTAINER_PORT"   --read-only   --security-opt no-new-privileges:true   --cap-drop ALL   --restart no   --memory "$JENKINS_MEMORY"   --memory-reservation "$JENKINS_MEMORY_RESERVATION"   --memory-swap "$JENKINS_MEMORY_SWAP"   --cpus "$JENKINS_CPU_CORES"   --pids-limit "$JENKINS_PIDS_LIMIT"   --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m   --volume "$home_volume:/var/jenkins_home"   --mount "type=bind,src=$approved_dir/agent-host,dst=/run/secrets/PLANE_AGENT_HOST,readonly"   --mount "type=bind,src=$approved_dir/agent-host-key,dst=/run/secrets/PLANE_AGENT_ED25519_HOST_KEY,readonly"   --mount "type=bind,src=$approved_dir/agent-private-key,dst=/run/secrets/PLANE_AGENT_PRIVATE_KEY,readonly"   "$image_id"
