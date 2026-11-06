#!/usr/bin/env bash
set -euo pipefail

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'stage-b restore refused: %s\n' "$*" >&2
  exit 1
}

image_id_file=${1:?usage: restore-home.sh IMAGE_ID_FILE BACKUP_DIR RESTORE_ID}
backup_dir=${2:?usage: restore-home.sh IMAGE_ID_FILE BACKUP_DIR RESTORE_ID}
restore_id=${3:?usage: restore-home.sh IMAGE_ID_FILE BACKUP_DIR RESTORE_ID}
[[ "${DOCKER_HOST:-}" == "$ROOTLESS_DOCKER_HOST" ]] || fail 'rootless DOCKER_HOST mismatch'
[[ "$restore_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail 'restore ID must be UTC YYYYMMDDTHHMMSSZ'
! docker container inspect "$JENKINS_CONTAINER" >/dev/null 2>&1 ||
  fail 'restore requires the Stage B controller to be absent'
(
  cd "$backup_dir"
  sha256sum -c jenkins-home.tgz.sha256
)
image_id=$(tr -d '\r\n' <"$image_id_file")
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'image ID must be immutable sha256'
target="${JENKINS_HOME_VOLUME}-restore-$restore_id"
! docker volume inspect "$target" >/dev/null 2>&1 || fail 'restore target already exists'
docker volume create --label io.paperclip.plane-game.stage=controller-b "$target" >/dev/null
cleanup() {
  if [[ "${restored:-false}" != true ]]; then
    docker volume rm "$target" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
docker run --rm   --read-only   --security-opt no-new-privileges:true   --cap-drop ALL   --mount "type=volume,src=$target,dst=/restore"   --mount "type=bind,src=$backup_dir,dst=/backup,readonly"   "$image_id"   sh -ceu 'cd /restore && tar --numeric-owner -xzf /backup/jenkins-home.tgz'
restored=true
printf '%s\n' "$target"
