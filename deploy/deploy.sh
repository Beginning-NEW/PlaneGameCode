#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
dry_run=false
if [[ "${1:-}" == --dry-run ]]; then dry_run=true; shift; fi
[[ $# -eq 3 ]] || die 'Usage: deploy.sh FULL_SHA IMAGE_REPOSITORY AUDITED_LOOPBACK_PORT'
validate_sha "$1"; validate_repo "$2"; validate_port "$3"
sha="$1"; IMAGE="$2:$sha"; export APP_PORT="$3"
preflight
if "$dry_run"; then echo 'Preflight passed; active release unchanged'; exit 0; fi
mkdir -p runtime/active
old_sha=""; [[ -f runtime/active_sha ]] && old_sha=$(cat runtime/active_sha)
[[ "$sha" != "$old_sha" ]] || die 'SHA is already active'
container="plane-game-$sha"
if docker container inspect "$container" >/dev/null 2>&1; then die 'candidate container name already in use'; fi
docker network inspect plane-game_default >/dev/null 2>&1 || docker network create --label com.docker.compose.project=plane-game --label com.docker.compose.network=default plane-game_default >/dev/null
docker run -d --name "$container" --network plane-game_default --restart unless-stopped "$IMAGE" >/dev/null
if ! wait_healthy "$container"; then docker rm -f "$container" >/dev/null; die 'candidate unhealthy; active route unchanged'; fi
docker exec "$container" wget -q -O - http://127.0.0.1:8080/version.json | grep -Fq "$sha" || { docker rm -f "$container" >/dev/null; die 'candidate build SHA mismatch; active route unchanged'; }
if [[ ! -f runtime/active/upstream.inc ]]; then printf 'set $backend http://plane-game-%s:8080;\n' "$sha" > runtime/active/upstream.inc; fi
if ! docker compose ps -q gateway | grep -q .; then docker compose up -d gateway || die 'gateway failed; existing route unchanged'; fi
switch_to "$sha"
if [[ -n "$old_sha" ]]; then printf '%s\n' "$old_sha" > runtime/previous_healthy_sha; fi
printf '%s\n' "$sha" > runtime/active_sha
printf 'deployment candidate healthy: sha=%s port=127.0.0.1:%s time=%s\n' "$sha" "$APP_PORT" "$(date -u +%FT%TZ)"
