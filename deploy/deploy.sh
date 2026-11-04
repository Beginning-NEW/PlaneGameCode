#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

dry_run=false
if [[ "${1:-}" == --dry-run ]]; then dry_run=true; shift; fi
[[ $# -eq 4 ]] || die 'Usage: deploy.sh [--dry-run] FULL_SHA IMAGE_REPOSITORY APPROVED_IMAGE_DIGEST AUDITED_LOOPBACK_PORT'
validate_sha "$1"; validate_repo "$2"; validate_digest "$3"; validate_port "$4"

RELEASE_SHA="$1"
IMAGE_REPOSITORY="$2"
IMAGE_DIGEST="$3"
export APP_PORT="$4"

preflight_readonly
if "$dry_run"; then
  printf 'readonly preflight passed: sha=%s digest=%s config_revision=%s\n' "$RELEASE_SHA" "$IMAGE_DIGEST" "$(config_revision)"
  print_preflight_boundary
  exit 0
fi

mkdir -p "$ACTIVE_DIR" "$RELEASES_DIR" "$SNAPSHOTS_DIR"
command -v flock >/dev/null || die 'flock is required to serialize deployments'
exec 9>"$RUNTIME_DIR/.deploy.lock"
flock -n 9 || die 'another PlaneGame deployment is already running'
old_sha=''
[[ -f "$RUNTIME_DIR/active_sha" ]] && old_sha=$(<"$RUNTIME_DIR/active_sha")
if [[ -n "$old_sha" ]]; then
  validate_sha "$old_sha"
  [[ "$RELEASE_SHA" != "$old_sha" ]] || die 'SHA is already active'
else
  [[ ! -f "$ACTIVE_UPSTREAM" ]] || die 'untracked active route exists; import or diagnose it before first deployment'
fi

first_release=false
[[ -z "$old_sha" ]] && first_release=true
snapshot_deployment_state "$RELEASE_SHA"

container="plane-game-$RELEASE_SHA"
deployment_id="${RELEASE_SHA:0:12}-$(date -u +%Y%m%dT%H%M%S)-$$"
export PLANE_GAME_DEPLOYMENT_ID="$deployment_id"
network_id=''
candidate_id=''
gateway_id=''
gateway_started_by_run=false

container_owned_by_run() {
  local id="$1" actual
  [[ -n "$id" ]] || return 1
  actual=$(docker container inspect --format '{{.Id}} {{ index .Config.Labels "com.plane-game.deployment-id" }}' "$id" 2>/dev/null || true)
  [[ "$actual" == "$id $deployment_id" ]]
}

network_owned_by_run() {
  local id="$1" actual
  [[ -n "$id" ]] || return 1
  actual=$(docker network inspect --format '{{.Id}} {{ index .Labels "com.plane-game.deployment-id" }}' "$id" 2>/dev/null || true)
  [[ "$actual" == "$id $deployment_id" ]]
}

gateway_container_for_run() {
  docker ps -aq \
    --filter 'label=com.docker.compose.project=plane-game' \
    --filter 'label=com.docker.compose.service=gateway' \
    --filter "label=com.plane-game.deployment-id=$deployment_id" | head -n 1
}

cleanup_failure() {
  local reason="$1"
  if "$first_release" && "$gateway_started_by_run" && container_owned_by_run "$gateway_id"; then
    docker rm -f "$gateway_id" >/dev/null 2>&1 || true
  fi
  restore_snapshot_route
  restore_snapshot_gateway_config
  if container_owned_by_run "$candidate_id"; then docker rm -f "$candidate_id" >/dev/null 2>&1 || true; fi
  if network_owned_by_run "$network_id"; then docker network rm "$network_id" >/dev/null 2>&1 || true; fi
  record_snapshot_outcome 'reverted' "$reason"
  die "$reason; candidate and this run's plane-game route/resources were reverted"
}

if docker container inspect "$container" >/dev/null 2>&1; then die 'candidate container name already in use'; fi
if ! docker network inspect plane-game_default >/dev/null 2>&1; then
  if ! network_id=$(docker network create \
    --label com.docker.compose.project=plane-game \
    --label com.docker.compose.network=default \
    --label "com.plane-game.deployment-id=$deployment_id" \
    plane-game_default); then
    cleanup_failure 'plane-game network failed to start'
  fi
  network_owned_by_run "$network_id" || cleanup_failure 'created plane-game network ownership verification failed'
fi
if ! candidate_id=$(docker run -d --name "$container" --network plane-game_default --restart unless-stopped \
  --label "com.plane-game.release-sha=$RELEASE_SHA" --label "com.plane-game.image-digest=$IMAGE_DIGEST" \
  --label "com.plane-game.deployment-id=$deployment_id" \
  "$(image_ref)"); then
  cleanup_failure 'candidate container failed to start'
fi
container_owned_by_run "$candidate_id" || cleanup_failure 'candidate container ownership verification failed'

wait_healthy "$container" || cleanup_failure 'candidate container did not become healthy'
verify_candidate_version "$container" || cleanup_failure 'candidate version.json does not match approved SHA'

if "$first_release"; then
  write_route "$RELEASE_SHA"
  if [[ -n "$(gateway_container_any_state)" ]]; then
    cleanup_failure 'gateway container already exists; refusing to adopt or remove it during first deployment'
  fi
  if ! docker compose up -d gateway >/dev/null; then
    gateway_id=$(gateway_container_for_run || true)
    if container_owned_by_run "$gateway_id"; then gateway_started_by_run=true; fi
    cleanup_failure 'gateway failed to start for first release'
  fi
  gateway_id=$(gateway_container_for_run || true)
  container_owned_by_run "$gateway_id" || cleanup_failure 'gateway ownership verification failed'
  gateway_started_by_run=true
fi

switch_to "$RELEASE_SHA" || cleanup_failure 'route switch verification failed'
write_release_record "$RELEASE_SHA"
if [[ -n "$old_sha" ]]; then printf '%s\n' "$old_sha" > "$RUNTIME_DIR/previous_healthy_sha"; fi
printf '%s\n' "$RELEASE_SHA" > "$RUNTIME_DIR/active_sha"
record_snapshot_outcome 'deployed' 'candidate healthy and route verified'
printf 'deployment healthy: sha=%s digest=%s config_revision=%s health=healthy port=127.0.0.1:%s time=%s\n' \
  "$RELEASE_SHA" "$IMAGE_DIGEST" "$(config_revision)" "$APP_PORT" "$(now_utc)"
