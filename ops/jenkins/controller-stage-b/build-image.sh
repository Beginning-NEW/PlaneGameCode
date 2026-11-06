#!/usr/bin/env bash
set -euo pipefail

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$profile_dir/../../.." && pwd)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'stage-b build refused: %s\n' "$*" >&2
  exit 1
}

candidate_sha=${1:?usage: build-image.sh CANDIDATE_SHA IMAGE_ID_FILE}
image_id_file=${2:?usage: build-image.sh CANDIDATE_SHA IMAGE_ID_FILE}
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'candidate SHA must be lowercase 40-hex'
[[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" ]] || fail 'must run as UID 1003'
[[ "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] || fail 'must run as plane-preflight'
[[ "${DOCKER_HOST:-}" == "$ROOTLESS_DOCKER_HOST" ]] || fail 'rootless DOCKER_HOST mismatch'

docker image inspect "$JENKINS_BASE_IMAGE" >/dev/null ||
  fail 'digest-pinned base image is not present; acquisition is a separate approved step'
docker build   --pull=false   --file "$profile_dir/Dockerfile"   --build-arg "JENKINS_BASE=$JENKINS_BASE_IMAGE"   --build-arg "CANDIDATE_SHA=$candidate_sha"   --iidfile "$image_id_file"   "$repo_root"
