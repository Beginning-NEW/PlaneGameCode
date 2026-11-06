#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 6 ]] || { echo 'Usage: deploy-local.sh SHA REPOSITORY DIGEST PORT ACTIONS_RUN_ID GATEWAY_IMAGE' >&2; exit 1; }
sha=$1
repository=$2
digest=$3
port=$4
run_id=$5
gateway_image=$6

[[ "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$repository" == ghcr.io/beginning-new/planegamecode ]] || { echo 'Unexpected GHCR repository' >&2; exit 1; }
[[ "$port" =~ ^[0-9]{4,5}$ ]] && (( 10#$port >= 1024 && 10#$port <= 65535 )) || exit 1
[[ "$run_id" =~ ^[1-9][0-9]*$ && ${#run_id} -le 15 ]] || exit 1
[[ "$gateway_image" =~ ^nginxinc/nginx-unprivileged@sha256:[0-9a-f]{64}$ ]] || exit 1
[[ -n "${GHCR_USER:-}" && -n "${GHCR_TOKEN:-}" ]] || { echo 'Sustainable GHCR pull credential is required' >&2; exit 1; }
[[ "$(id -un)" == plane-preflight && "$(id -u)" -ne 0 ]] || exit 1
[[ "$(git rev-parse HEAD)" == "$sha" ]] || { echo 'Trusted checkout changed before deployment' >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo 'Jenkins checkout is dirty' >&2; exit 1; }

root="$HOME/plane-game"
incoming="$root/incoming"
stage="$incoming/$sha-$run_id"
mkdir -p "$incoming"
[[ ! -e "$stage" ]] || { echo 'Run-specific deployment source already exists' >&2; exit 1; }
stage_tmp=$(mktemp -d "$incoming/.candidate.$sha.$run_id.XXXXXX")
docker_config=$(mktemp -d "$incoming/.docker-auth.$run_id.XXXXXX")
cleanup() {
  rm -rf -- "$docker_config"
  [[ ! -d "$stage_tmp" ]] || rm -rf -- "$stage_tmp"
}
trap cleanup EXIT

git archive --format=tar "$sha" compose.yaml deploy | tar -xf - -C "$stage_tmp"
[[ -f "$stage_tmp/compose.yaml" && -f "$stage_tmp/deploy/promote.sh" ]] || exit 1
mv "$stage_tmp" "$stage"

export DOCKER_CONFIG="$docker_config"
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
docker pull "$repository@$digest" >/dev/null
docker pull "$gateway_image" >/dev/null

cd "$root"
bash "$stage/deploy/promote.sh" "$sha" "$repository" "$digest" "$port" "$run_id" "$gateway_image"
curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz" >/dev/null
expected_version=$(printf '{"sha":"%s"}' "$sha")
[[ "$(curl -fsS --max-time 5 "http://127.0.0.1:$port/version.json")" == "$expected_version" ]]
printf 'deployment verified: sha=%s digest=%s gateway=%s actions_run=%s port=%s health=passed\n' \
  "$sha" "$digest" "$gateway_image" "$run_id" "$port"
