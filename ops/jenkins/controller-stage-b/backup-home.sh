#!/usr/bin/env bash
set -euo pipefail

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'stage-b backup refused: %s\n' "$*" >&2
  exit 1
}

image_id_file=${1:?usage: backup-home.sh IMAGE_ID_FILE BACKUP_DIR HOME_VOLUME}
backup_dir=${2:?usage: backup-home.sh IMAGE_ID_FILE BACKUP_DIR HOME_VOLUME}
home_volume=${3:?usage: backup-home.sh IMAGE_ID_FILE BACKUP_DIR HOME_VOLUME}
[[ "${DOCKER_HOST:-}" == "$ROOTLESS_DOCKER_HOST" ]] || fail 'rootless DOCKER_HOST mismatch'
[[ "$home_volume" =~ ^plane-game-jenkins-stage-b-home(-restore-[0-9]{8}T[0-9]{6}Z)?$ ]] ||
  fail 'home volume is outside the Stage B namespace'
if docker container inspect "$JENKINS_CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -Fxq true; then
  fail 'cold backup requires the controller to be stopped'
fi
image_id=$(tr -d '\r\n' <"$image_id_file")
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'image ID must be immutable sha256'
install -d -m 0700 "$backup_dir"
docker run --rm   --read-only   --security-opt no-new-privileges:true   --cap-drop ALL   --mount "type=volume,src=$home_volume,dst=/source,readonly"   --mount "type=bind,src=$backup_dir,dst=/backup"   "$image_id"   sh -ceu 'cd /source && tar --numeric-owner -czf /backup/jenkins-home.tgz .'
(
  cd "$backup_dir"
  sha256sum jenkins-home.tgz >jenkins-home.tgz.sha256
)
