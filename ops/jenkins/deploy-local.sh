#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 9 ]] || { echo 'Usage: deploy-local.sh SHA REPOSITORY DIGEST PORT ACTIONS_RUN_ID RUN_NUMBER RUN_ATTEMPT GATEWAY_IMAGE POST_CD_RESOURCE_GATE' >&2; exit 1; }
sha=$1
repository=$2
digest=$3
port=$4
run_id=$5
run_number=$6
run_attempt=$7
gateway_image=$8
post_cd_resource_gate=$9

[[ "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$repository" == ghcr.io/beginning-new/planegamecode ]] || { echo 'Unexpected GHCR repository' >&2; exit 1; }
[[ "$port" == 18081 ]] || { echo 'DEPLOY_PORT must be the versioned value 18081' >&2; exit 1; }
[[ "$run_id" =~ ^[1-9][0-9]*$ && ${#run_id} -le 20 ]] || exit 1
[[ "$run_number" =~ ^[1-9][0-9]*$ && ${#run_number} -le 15 ]] || exit 1
[[ "$run_attempt" =~ ^[1-9][0-9]*$ && ${#run_attempt} -le 10 ]] || exit 1
[[ "$gateway_image" =~ ^nginxinc/nginx-unprivileged@sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$post_cd_resource_gate" == ops/jenkins/resource-gate.sh ]] || { echo 'Unexpected post-CD resource gate' >&2; exit 1; }
[[ -n "${GHCR_USER:-}" && -n "${GHCR_TOKEN:-}" ]] || { echo 'Sustainable GHCR pull credential is required' >&2; exit 1; }
[[ -n "${GH_API_TOKEN:-}" ]] || { echo 'GitHub Actions read credential is required' >&2; exit 1; }
[[ "$(id -un)" == plane-preflight && "$(id -u)" -ne 0 ]] || exit 1
[[ "$(git rev-parse HEAD)" == "$sha" ]] || { echo 'Trusted checkout changed before deployment' >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo 'Jenkins checkout is dirty' >&2; exit 1; }

root="$HOME/plane-game"
incoming="$root/incoming"
stage="$incoming/$sha-$run_number-$run_attempt"
mkdir -p "$incoming"
[[ ! -e "$stage" ]] || { echo 'Run-specific deployment source already exists' >&2; exit 1; }
stage_tmp=$(mktemp -d "$incoming/.candidate.$sha.$run_number.$run_attempt.XXXXXX")
docker_config=$(mktemp -d "$incoming/.docker-auth.$run_number.$run_attempt.XXXXXX")
cleanup() {
  rm -rf -- "$docker_config"
  [[ ! -d "$stage_tmp" ]] || rm -rf -- "$stage_tmp"
}
trap cleanup EXIT

git archive --format=tar "$sha" compose.yaml deploy "$post_cd_resource_gate" | tar -xf - -C "$stage_tmp"
[[ -f "$stage_tmp/compose.yaml" && -f "$stage_tmp/deploy/promote.sh" &&
   -f "$stage_tmp/$post_cd_resource_gate" && ! -L "$stage_tmp/$post_cd_resource_gate" ]] || exit 1
mv "$stage_tmp" "$stage"

export DOCKER_CONFIG="$docker_config"
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
docker pull "$repository@$digest" >/dev/null
docker pull "$gateway_image" >/dev/null

bash ops/jenkins/resource-gate.sh
bash ops/jenkins/pre-promote-check.sh \
  "$sha" "$run_id" "$run_attempt" "$digest" "$gateway_image" "$run_number"

cd "$root"
bash "$stage/deploy/promote.sh" "$sha" "$repository" "$digest" "$port" "$run_number" "$run_attempt" "$gateway_image" \
  "$post_cd_resource_gate"
printf 'deployment verified: sha=%s digest=%s gateway=%s actions_run=%s port=%s health=passed resource_gate=pre_and_post_passed\n' \
  "$sha" "$digest" "$gateway_image" "$run_number/$run_attempt" "$port"
