#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'public image pull refused: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 4 ]] || fail 'usage: pull-public-images.sh SHA REPOSITORY DIGEST GATEWAY_IMAGE'
sha=$1
repository=$2
digest=$3
gateway_image=$4
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'candidate SHA must be lowercase 40-hex'
[[ "$repository" == ghcr.io/beginning-new/planegamecode ]] || fail 'unexpected GHCR repository'
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'application digest must be canonical sha256'
[[ "$gateway_image" =~ ^nginxinc/nginx-unprivileged@sha256:[0-9a-f]{64}$ ]] ||
  fail 'gateway image must be pinned by canonical sha256 digest'
[[ -n "${DOCKER_CONFIG:-}" && -d "$DOCKER_CONFIG" && ! -L "$DOCKER_CONFIG" ]] ||
  fail 'DOCKER_CONFIG must be one real temporary directory'
[[ -f "$DOCKER_CONFIG/config.json" && ! -L "$DOCKER_CONFIG/config.json" ]] ||
  fail 'empty Docker config file is missing'
[[ "$(tr -d '[:space:]' < "$DOCKER_CONFIG/config.json")" == '{}' ]] ||
  fail 'Docker config must be empty'
[[ -z "${DOCKER_AUTH_CONFIG+x}" && -z "${REGISTRY_AUTH_FILE+x}" ]] ||
  fail 'ambient registry authentication is forbidden'
command -v docker >/dev/null || fail 'docker is required'

resolved_digest=$(bash "$script_dir/resolve-public-ghcr-digest.sh" Beginning-NEW/PlaneGameCode "$sha")
[[ "$resolved_digest" == "$digest" ]] || fail 'public GHCR full-SHA tag digest changed before pull'
docker pull "$repository@$digest" >/dev/null || fail 'public application pull failed'
docker pull "$gateway_image" >/dev/null || fail 'public gateway pull failed'
