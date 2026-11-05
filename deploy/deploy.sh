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

candidate_owned_by_run() {
  local id="$1" actual
  [[ -n "$id" ]] || return 1
  actual=$(docker container inspect --format '{{.Id}} {{ index .Config.Labels "com.plane-game.deployment-id" }} {{ index .Config.Labels "com.plane-game.release-sha" }} {{ index .Config.Labels "com.plane-game.image-digest" }}' "$id" 2>/dev/null || true)
  [[ "$actual" == "$id $deployment_id $RELEASE_SHA $IMAGE_DIGEST" ]]
}

network_owned_by_run() {
  local id="$1" actual
  [[ -n "$id" ]] || return 1
  actual=$(docker network inspect --format '{{.Id}} {{ index .Labels "com.plane-game.deployment-id" }} {{ index .Labels "com.docker.compose.project" }} {{ index .Labels "com.docker.compose.network" }}' "$id" 2>/dev/null || true)
  [[ "$actual" == "$id $deployment_id plane-game default" ]]
}

gateway_owned_by_run() {
  local id="$1" actual
  [[ -n "$id" ]] || return 1
  actual=$(docker container inspect --format '{{.Id}} {{ index .Config.Labels "com.plane-game.deployment-id" }} {{ index .Config.Labels "com.docker.compose.project" }} {{ index .Config.Labels "com.docker.compose.service" }}' "$id" 2>/dev/null || true)
  [[ "$actual" == "$id $deployment_id plane-game gateway" ]]
}

gateway_container_for_run() {
  local ids id found=''
  ids=$(docker ps -aq \
    --filter 'label=com.docker.compose.project=plane-game' \
    --filter 'label=com.docker.compose.service=gateway' \
    --filter "label=com.plane-game.deployment-id=$deployment_id") || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    gateway_owned_by_run "$id" || continue
    [[ -z "$found" || "$found" == "$id" ]] || { log 'multiple gateway containers match this deployment id; preserving them'; return 1; }
    found="$id"
  done <<<"$ids"
  printf '%s\n' "$found"
}

candidate_container_for_run() {
  local ids id found='' actual actual_id actual_deployment actual_sha actual_digest
  ids=$(docker ps -aq \
    --filter "label=com.plane-game.deployment-id=$deployment_id" \
    --filter "label=com.plane-game.release-sha=$RELEASE_SHA") || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    actual=$(docker container inspect --format '{{.Id}} {{ index .Config.Labels "com.plane-game.deployment-id" }} {{ index .Config.Labels "com.plane-game.release-sha" }} {{ index .Config.Labels "com.plane-game.image-digest" }}' "$id" 2>/dev/null || true)
    read -r actual_id actual_deployment actual_sha actual_digest <<<"$actual"
    [[ "$actual_id" == "$id" ]] || continue
    [[ "$actual_deployment" == "$deployment_id" && "$actual_sha" == "$RELEASE_SHA" ]] || continue
    if [[ "$actual_digest" != "$IMAGE_DIGEST" ]]; then
      log 'candidate container digest label mismatch; preserving this run-scoped resource'
      return 1
    fi
    candidate_owned_by_run "$id" || continue
    [[ -z "$found" || "$found" == "$id" ]] || { log 'multiple candidate containers match this deployment id; preserving them'; return 1; }
    found="$id"
  done <<<"$ids"
  printf '%s\n' "$found"
}

network_for_run() {
  local ids id found=''
  ids=$(docker network ls -q --filter "label=com.plane-game.deployment-id=$deployment_id") || return 1
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    network_owned_by_run "$id" || continue
    [[ -z "$found" || "$found" == "$id" ]] || { log 'multiple plane-game networks match this deployment id; preserving them'; return 1; }
    found="$id"
  done <<<"$ids"
  printf '%s\n' "$found"
}

reconcile_candidate_id() {
  candidate_owned_by_run "$candidate_id" && return 0
  candidate_id=$(candidate_container_for_run)
}

reconcile_gateway_id() {
  gateway_owned_by_run "$gateway_id" && return 0
  gateway_id=$(gateway_container_for_run)
}

reconcile_network_id() {
  network_owned_by_run "$network_id" && return 0
  network_id=$(network_for_run)
}

cleanup_failure() {
  local reason="$1" cleanup_incomplete=false candidate_removed=true
  if ! reconcile_gateway_id; then
    log "cleanup could not enumerate this run's gateway container"
    cleanup_incomplete=true
  fi
  if ! reconcile_candidate_id; then
    log "cleanup could not enumerate this run's candidate container"
    cleanup_incomplete=true
    candidate_removed=false
  fi
  if ! reconcile_network_id; then
    log "cleanup could not enumerate this run's network"
    cleanup_incomplete=true
  fi

  if "$first_release" && [[ -n "$gateway_id" ]]; then
    if ! gateway_owned_by_run "$gateway_id" || ! docker rm -f "$gateway_id" >/dev/null 2>&1; then
      log "cleanup could not remove this run's gateway container"
      cleanup_incomplete=true
    fi
  fi
  if [[ -n "$candidate_id" ]]; then
    if ! candidate_owned_by_run "$candidate_id" || ! docker rm -f "$candidate_id" >/dev/null 2>&1; then
      log "cleanup could not remove this run's candidate container"
      cleanup_incomplete=true
      candidate_removed=false
    fi
  fi
  if [[ -n "$network_id" ]]; then
    if ! "$candidate_removed"; then
      log "cleanup will not remove this run's network while its candidate container remains"
      cleanup_incomplete=true
    elif ! network_owned_by_run "$network_id" || ! docker network rm "$network_id" >/dev/null 2>&1; then
      log "cleanup could not remove this run's network"
      cleanup_incomplete=true
    fi
  fi
  if ! restore_snapshot_route; then
    log 'cleanup could not restore the route snapshot'
    cleanup_incomplete=true
  fi
  if ! restore_snapshot_gateway_config; then
    log 'cleanup could not restore the gateway configuration snapshot'
    cleanup_incomplete=true
  fi
  if [[ -n "$old_sha" ]]; then
    local gateway
    gateway=$(gateway_container)
    if [[ -z "$gateway" ]] || ! docker exec "$gateway" nginx -t >/dev/null 2>&1 ||
      ! docker exec "$gateway" nginx -s reload >/dev/null 2>&1 ||
      ! verify_gateway_route "$old_sha"; then
      log 'ALERT: previous healthy route could not be verified after recovery'
      cleanup_incomplete=true
    fi
  elif [[ -f "$ACTIVE_UPSTREAM" ]]; then
    log 'ALERT: first release left an active route'
    cleanup_incomplete=true
  fi
  if "$cleanup_incomplete"; then
    record_snapshot_outcome 'revert_incomplete' "$reason" || true
    die "$reason; cleanup is incomplete for deployment-id=$deployment_id; inspect only this run's plane-game resources"
  fi
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
candidate_owned_by_run "$candidate_id" || cleanup_failure 'candidate container ownership verification failed'

wait_healthy "$container" || cleanup_failure 'candidate container did not become healthy'
verify_candidate_version "$container" || cleanup_failure 'candidate version.json does not match approved SHA'

if "$first_release"; then
  write_route "$RELEASE_SHA"
  if [[ -n "$(gateway_container_any_state)" ]]; then
    cleanup_failure 'gateway container already exists; refusing to adopt or remove it during first deployment'
  fi
  if ! docker compose up -d gateway >/dev/null; then
    cleanup_failure 'gateway failed to start for first release'
  fi
  gateway_id=$(gateway_container_for_run)
  gateway_owned_by_run "$gateway_id" || cleanup_failure 'gateway ownership verification failed'
fi

switch_to "$RELEASE_SHA" || cleanup_failure 'route switch verification failed'
write_release_record "$RELEASE_SHA"
if [[ -n "$old_sha" ]]; then printf '%s\n' "$old_sha" > "$RUNTIME_DIR/previous_healthy_sha"; fi
printf '%s\n' "$RELEASE_SHA" > "$RUNTIME_DIR/active_sha"
record_snapshot_outcome 'deployed' 'candidate healthy and route verified'
printf 'deployment healthy: sha=%s digest=%s config_revision=%s health=healthy port=127.0.0.1:%s time=%s\n' \
  "$RELEASE_SHA" "$IMAGE_DIGEST" "$(config_revision)" "$APP_PORT" "$(now_utc)"
