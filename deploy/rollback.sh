#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

dry_run=false
if [[ "${1:-}" == --dry-run ]]; then dry_run=true; shift; fi
[[ $# -eq 2 ]] || die 'Usage: rollback.sh [--dry-run] PREVIOUS_HEALTHY_SHA AUDITED_LOOPBACK_PORT'
validate_sha "$1"; validate_port "$2"

previous_sha="$1"
export APP_PORT="$2"
[[ -f "$RUNTIME_DIR/previous_healthy_sha" && "$(<"$RUNTIME_DIR/previous_healthy_sha")" == "$previous_sha" ]] || die 'explicit previous_healthy_sha does not match recorded healthy release'
[[ -f "$RUNTIME_DIR/active_sha" ]] || die 'no active release recorded'
current_sha=$(<"$RUNTIME_DIR/active_sha")
validate_sha "$current_sha"
[[ "$current_sha" != "$previous_sha" ]] || die 'previous release equals active release'

command -v docker >/dev/null && command -v curl >/dev/null && command -v sha256sum >/dev/null || die 'docker, curl, and sha256sum required'
docker info >/dev/null || die 'docker daemon unavailable'
# A broken current application is the reason to roll back. Only the recorded previous release must be healthy.
verify_recorded_release "$previous_sha"
docker compose config -q || die 'compose syntax invalid'
verify_gateway_binding
gateway=$(gateway_container)
[[ -n "$gateway" ]] || die 'gateway container missing; active route unchanged'
wait_healthy "plane-game-$previous_sha" || die 'previous_healthy_sha container unhealthy or missing; active route unchanged'
RELEASE_SHA="$previous_sha"
verify_candidate_version "plane-game-$previous_sha" || die 'previous release version.json does not match its recorded SHA'

if "$dry_run"; then
  printf 'rollback preflight passed: from=%s to=%s digest=%s gateway=%s config_revision=%s previous_health=healthy\n' \
    "$current_sha" "$previous_sha" "$IMAGE_DIGEST" "$GATEWAY_IMAGE" "$RECORDED_CONFIG_REVISION"
  print_preflight_boundary
  exit 0
fi

started_at=$SECONDS
snapshot_deployment_state "$previous_sha"
if ! restore_release_gateway_config "$previous_sha" || ! switch_to "$previous_sha"; then
  restore_snapshot_gateway_config
  docker exec "$gateway" nginx -t >/dev/null && docker exec "$gateway" nginx -s reload >/dev/null || true
  restore_snapshot_route
  if [[ "$(snapshot_value route_present)" == true ]]; then
    docker exec "$gateway" nginx -t >/dev/null && docker exec "$gateway" nginx -s reload >/dev/null || true
  fi
  record_snapshot_outcome 'rollback_failed_restored' 'previous route or recorded gateway config failed verification'
  die 'rollback failed; previous route and gateway configuration snapshot restored'
fi

printf '%s\n' "$current_sha" > "$RUNTIME_DIR/previous_healthy_sha"
printf '%s\n' "$previous_sha" > "$RUNTIME_DIR/active_sha"
duration=$((SECONDS - started_at))
record_snapshot_outcome 'rolled_back' "from=$current_sha to=$previous_sha duration_seconds=$duration"
printf 'rollback healthy: from=%s to=%s digest=%s gateway=%s config_revision=%s health=healthy duration_seconds=%s port=127.0.0.1:%s time=%s\n' \
  "$current_sha" "$previous_sha" "$IMAGE_DIGEST" "$GATEWAY_IMAGE" "$RECORDED_CONFIG_REVISION" "$duration" "$APP_PORT" "$(now_utc)"
