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
candidate_started=false
network_created=false
gateway_started_by_run=false

cleanup_failure() {
  local reason="$1"
  if "$first_release" && "$gateway_started_by_run"; then
    docker compose rm -sf gateway >/dev/null 2>&1 || true
  fi
  restore_snapshot_route
  restore_snapshot_gateway_config
  if "$candidate_started"; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  if "$network_created"; then docker network rm plane-game_default >/dev/null 2>&1 || true; fi
  record_snapshot_outcome 'reverted' "$reason"
  die "$reason; candidate and this run's plane-game route/resources were reverted"
}

if docker container inspect "$container" >/dev/null 2>&1; then die 'candidate container name already in use'; fi
if ! docker network inspect plane-game_default >/dev/null 2>&1; then
  docker network create --label com.docker.compose.project=plane-game --label com.docker.compose.network=default plane-game_default >/dev/null
  network_created=true
fi
docker run -d --name "$container" --network plane-game_default --restart unless-stopped \
  --label "com.plane-game.release-sha=$RELEASE_SHA" --label "com.plane-game.image-digest=$IMAGE_DIGEST" \
  "$(image_ref)" >/dev/null
candidate_started=true

wait_healthy "$container" || cleanup_failure 'candidate container did not become healthy'
verify_candidate_version "$container" || cleanup_failure 'candidate version.json does not match approved SHA'

if "$first_release"; then
  write_route "$RELEASE_SHA"
  if [[ -z "$(gateway_container)" ]]; then
    docker compose up -d gateway >/dev/null || cleanup_failure 'gateway failed to start for first release'
    gateway_started_by_run=true
  fi
fi

switch_to "$RELEASE_SHA" || cleanup_failure 'route switch verification failed'
write_release_record "$RELEASE_SHA"
if [[ -n "$old_sha" ]]; then printf '%s\n' "$old_sha" > "$RUNTIME_DIR/previous_healthy_sha"; fi
printf '%s\n' "$RELEASE_SHA" > "$RUNTIME_DIR/active_sha"
record_snapshot_outcome 'deployed' 'candidate healthy and route verified'
printf 'deployment healthy: sha=%s digest=%s config_revision=%s health=healthy port=127.0.0.1:%s time=%s\n' \
  "$RELEASE_SHA" "$IMAGE_DIGEST" "$(config_revision)" "$APP_PORT" "$(now_utc)"
