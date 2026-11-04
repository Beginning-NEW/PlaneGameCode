#!/usr/bin/env bash
set -euo pipefail
cd "${BASH_SOURCE[0]%/*}/.."
export COMPOSE_PROJECT_NAME=plane-game
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
validate_sha() { [[ "$1" =~ ^[a-fA-F0-9]{40}$ ]] || die 'SHA must be a full 40-character git commit hash'; }
validate_port() { [[ "$1" =~ ^[0-9]{2,5}$ ]] && (( 10#$1 >= 1024 && 10#$1 <= 65535 )) || die 'port must be 1024-65535'; }
validate_repo() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9./_-]*$ ]] || die 'image repository contains invalid characters'; }
preflight() {
  command -v docker >/dev/null || die 'docker required'
  command -v curl >/dev/null || die 'curl required'
  docker info >/dev/null || die 'docker daemon unavailable'
  docker compose config -q || die 'compose syntax invalid'
  docker image inspect "$IMAGE" >/dev/null || die "image unavailable: $IMAGE"
  docker run --rm --entrypoint nginx "$IMAGE" -t >/dev/null || die 'application nginx config invalid'
  docker run --rm -v "$PWD/deploy/gateway.conf:/etc/nginx/conf.d/default.conf:ro" -v "$PWD/deploy/preflight:/etc/nginx/active:ro" --entrypoint nginx nginxinc/nginx-unprivileged:1.29-alpine -t >/dev/null || die 'gateway nginx config invalid'
  if ! docker compose ps -q gateway | grep -q .; then
    if (echo >/dev/tcp/127.0.0.1/"$APP_PORT") 2>/dev/null; then die 'host port occupied'; fi
  else
    curl -fsS --max-time 3 "http://127.0.0.1:$APP_PORT/healthz" >/dev/null || die 'current healthy version failed preflight'
  fi
}
wait_healthy() {
  local container="$1" status
  for _ in {1..30}; do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container" 2>/dev/null || true)
    [[ "$status" == healthy ]] && return 0
    [[ "$status" == unhealthy || "$status" == missing ]] && return 1
    sleep 1
  done
  return 1
}
switch_to() {
  local sha="$1" old="" temp
  [[ -f runtime/active/upstream.inc ]] && old=$(cat runtime/active/upstream.inc)
  temp=$(mktemp runtime/active/.upstream.XXXXXX)
  printf 'set $backend http://plane-game-%s:8080;\n' "$sha" > "$temp"
  mv -f "$temp" runtime/active/upstream.inc
  if ! docker exec plane-game-gateway-1 nginx -t || ! docker exec plane-game-gateway-1 nginx -s reload || ! curl -fsS --retry 6 --retry-delay 1 --max-time 3 "http://127.0.0.1:$APP_PORT/healthz" >/dev/null || ! curl -fsS --retry 6 --retry-delay 1 --max-time 3 "http://127.0.0.1:$APP_PORT/version.json" | grep -Fq "$sha"; then
    printf '%s\n' "$old" > runtime/active/upstream.inc
    docker exec plane-game-gateway-1 nginx -s reload || true
    die 'switch failed; restored previous route'
  fi
}
