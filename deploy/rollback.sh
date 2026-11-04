#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
dry_run=false
if [[ "${1:-}" == --dry-run ]]; then dry_run=true; shift; fi
[[ $# -eq 2 ]] || die 'Usage: rollback.sh previous_healthy_sha AUDITED_LOOPBACK_PORT'
validate_sha "$1"; validate_port "$2"
sha="$1"; export APP_PORT="$2"
[[ -f runtime/previous_healthy_sha && "$(cat runtime/previous_healthy_sha)" == "$sha" ]] || die 'explicit previous_healthy_sha does not match recorded healthy release'
[[ -f runtime/active_sha ]] || die 'no active release recorded'
command -v docker >/dev/null && command -v curl >/dev/null || die 'docker and curl required'
docker compose config -q || die 'compose syntax invalid'
curl -fsS --max-time 3 "http://127.0.0.1:$APP_PORT/healthz" >/dev/null || die 'current version unhealthy; manual diagnosis required'
wait_healthy "plane-game-$sha" || die 'previous_healthy_sha container unhealthy or missing; active route unchanged'
if "$dry_run"; then echo 'Rollback preflight passed; active release unchanged'; exit 0; fi
current=$(cat runtime/active_sha)
switch_to "$sha"
printf '%s\n' "$current" > runtime/previous_healthy_sha
printf '%s\n' "$sha" > runtime/active_sha
printf 'rollback healthy: sha=%s port=127.0.0.1:%s time=%s\n' "$sha" "$APP_PORT" "$(date -u +%FT%TZ)"
