#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export COMPOSE_PROJECT_NAME=plane-game

RUNTIME_DIR="${PLANE_GAME_RUNTIME_DIR:-$PWD/runtime}"
ACTIVE_DIR="$RUNTIME_DIR/active"
ACTIVE_UPSTREAM="$ACTIVE_DIR/upstream.inc"
RELEASES_DIR="$RUNTIME_DIR/releases"
SNAPSHOTS_DIR="$RUNTIME_DIR/deployment-snapshots"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }
now_utc() { date -u +%FT%TZ; }

validate_sha() { [[ "$1" =~ ^[a-fA-F0-9]{40}$ ]] || die 'SHA must be a full 40-character git commit hash'; }
validate_digest() { [[ "$1" =~ ^sha256:[a-fA-F0-9]{64}$ ]] || die 'digest must be a sha256: digest'; }
validate_port() { [[ "$1" =~ ^[0-9]{2,5}$ ]] && (( 10#$1 >= 1024 && 10#$1 <= 65535 )) || die 'port must be 1024-65535'; }
validate_repo() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9./_-]*$ ]] || die 'image repository contains invalid characters'; }

config_revision() {
  sha256sum compose.yaml deploy/gateway.conf deploy/app.conf | sha256sum | awk '{print $1}'
}

gateway_config_digest() {
  sha256sum deploy/gateway.conf | awk '{print $1}'
}

gateway_container() {
  docker compose ps -q gateway | head -n 1
}

gateway_container_any_state() {
  docker compose ps -aq gateway | head -n 1
}

port_is_available() {
  ! (echo >/dev/tcp/127.0.0.1/"$APP_PORT") 2>/dev/null
}

image_ref() {
  printf '%s@%s\n' "$IMAGE_REPOSITORY" "$IMAGE_DIGEST"
}

verify_image_binding() {
  local ref revision digests
  ref=$(image_ref)
  docker image inspect "$ref" >/dev/null || die "approved image unavailable locally: $ref"
  revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ref")
  [[ "$revision" == "$RELEASE_SHA" ]] || die "image revision label does not match approved SHA: expected $RELEASE_SHA"
  digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref")
  grep -Fxq "$ref" <<<"$digests" || die "approved digest is not recorded for repository: $ref"
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

verify_candidate_version() {
  local container="$1"
  docker exec "$container" wget -q -O - http://127.0.0.1:8080/version.json | grep -Fq "$RELEASE_SHA"
}

verify_gateway_route() {
  local url="http://127.0.0.1:$APP_PORT"
  curl -fsS --retry 6 --retry-delay 1 --max-time 3 "$url/healthz" >/dev/null &&
    curl -fsS --retry 6 --retry-delay 1 --max-time 3 "$url/" | grep -qi '<html' &&
    [[ "$(curl -fsS --retry 6 --retry-delay 1 --max-time 3 "$url/version.json")" == "{\"sha\":\"$1\"}" ]]
}

read_route_sha() {
  local route
  [[ -f "$ACTIVE_UPSTREAM" ]] || return 1
  route=$(<"$ACTIVE_UPSTREAM")
  [[ "$route" =~ ^set\ \$backend\ http://plane-game-([a-fA-F0-9]{40}):8080\;$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

write_route() {
  local sha="$1" temp
  mkdir -p "$ACTIVE_DIR"
  temp=$(mktemp "$ACTIVE_DIR/.upstream.XXXXXX")
  printf 'set $backend http://plane-game-%s:8080;\n' "$sha" > "$temp"
  mv -f "$temp" "$ACTIVE_UPSTREAM"
}

snapshot_deployment_state() {
  local sha="$1" route_sha='none'
  SNAPSHOT_DIR="$SNAPSHOTS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$sha"
  mkdir -p "$SNAPSHOT_DIR"
  if [[ -f "$ACTIVE_UPSTREAM" ]]; then
    cp "$ACTIVE_UPSTREAM" "$SNAPSHOT_DIR/upstream.inc"
    route_sha=$(read_route_sha || printf 'unparseable')
    printf 'route_present=true\n' > "$SNAPSHOT_DIR/state.env"
  else
    printf 'route_present=false\n' > "$SNAPSHOT_DIR/state.env"
  fi
  cp deploy/gateway.conf "$SNAPSHOT_DIR/gateway.conf"
  printf 'snapshot_at=%s\nroute_sha=%s\nconfig_revision=%s\n' "$(now_utc)" "$route_sha" "$(config_revision)" >> "$SNAPSHOT_DIR/state.env"
}

snapshot_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$SNAPSHOT_DIR/state.env" | head -n 1
}

restore_snapshot_route() {
  [[ -n "${SNAPSHOT_DIR:-}" ]] || return 0
  if [[ "$(snapshot_value route_present)" == true ]]; then
    mkdir -p "$ACTIVE_DIR"
    cp "$SNAPSHOT_DIR/upstream.inc" "$ACTIVE_UPSTREAM"
  else
    rm -f "$ACTIVE_UPSTREAM"
  fi
}

restore_snapshot_gateway_config() {
  [[ -n "${SNAPSHOT_DIR:-}" && -f "$SNAPSHOT_DIR/gateway.conf" ]] || return 0
  cp "$SNAPSHOT_DIR/gateway.conf" deploy/gateway.conf
}

record_snapshot_outcome() {
  local outcome="$1" detail="$2"
  [[ -n "${SNAPSHOT_DIR:-}" ]] || return 0
  printf 'outcome=%s\ncompleted_at=%s\ndetail=%s\n' "$outcome" "$(now_utc)" "$detail" >> "$SNAPSHOT_DIR/state.env"
}

release_dir() { printf '%s/%s\n' "$RELEASES_DIR" "$1"; }

record_value() {
  local record="$1" key="$2"
  sed -n "s/^${key}=//p" "$record" | head -n 1
}

write_release_record() {
  local sha="$1" release_dir_path temp
  release_dir_path=$(release_dir "$sha")
  mkdir -p "$release_dir_path"
  cp deploy/gateway.conf "$release_dir_path/gateway.conf"
  temp=$(mktemp "$release_dir_path/.release.XXXXXX")
  {
    printf 'RELEASE_SHA=%s\n' "$sha"
    printf 'IMAGE_REPOSITORY=%s\n' "$IMAGE_REPOSITORY"
    printf 'IMAGE_DIGEST=%s\n' "$IMAGE_DIGEST"
    printf 'CONFIG_REVISION=%s\n' "$(config_revision)"
    printf 'GATEWAY_CONFIG_DIGEST=%s\n' "$(gateway_config_digest)"
    printf 'HEALTH_STATUS=healthy\n'
    printf 'RECORDED_AT=%s\n' "$(now_utc)"
  } > "$temp"
  mv -f "$temp" "$release_dir_path/release.env"
}

verify_recorded_release() {
  local sha="$1" release_dir_path record repo digest stored_sha health stored_config_digest
  release_dir_path=$(release_dir "$sha")
  record="$release_dir_path/release.env"
  [[ -f "$record" && -f "$release_dir_path/gateway.conf" ]] || die "release record or gateway configuration missing for $sha"
  stored_sha=$(record_value "$record" RELEASE_SHA)
  repo=$(record_value "$record" IMAGE_REPOSITORY)
  digest=$(record_value "$record" IMAGE_DIGEST)
  health=$(record_value "$record" HEALTH_STATUS)
  stored_config_digest=$(record_value "$record" GATEWAY_CONFIG_DIGEST)
  [[ "$stored_sha" == "$sha" && "$health" == healthy ]] || die "release record is not a verified healthy release: $sha"
  validate_repo "$repo"; validate_digest "$digest"
  [[ "$(sha256sum "$release_dir_path/gateway.conf" | awk '{print $1}')" == "$stored_config_digest" ]] || die "recorded gateway configuration digest mismatch for $sha"
  RELEASE_SHA="$sha"
  IMAGE_REPOSITORY="$repo"
  IMAGE_DIGEST="$digest"
  RECORDED_CONFIG_REVISION=$(record_value "$record" CONFIG_REVISION)
  verify_image_binding
}

restore_release_gateway_config() {
  local sha="$1" release_dir_path gateway
  release_dir_path=$(release_dir "$sha")
  cp "$release_dir_path/gateway.conf" deploy/gateway.conf
  gateway=$(gateway_container)
  [[ -n "$gateway" ]] || { log 'gateway container missing; cannot apply recorded configuration'; return 1; }
  docker exec "$gateway" nginx -t >/dev/null || { log 'recorded gateway configuration failed nginx validation'; return 1; }
  docker exec "$gateway" nginx -s reload >/dev/null || { log 'recorded gateway configuration reload failed'; return 1; }
}

switch_to() {
  local sha="$1" gateway
  gateway=$(gateway_container)
  [[ -n "$gateway" ]] || return 1
  write_route "$sha"
  if ! docker exec "$gateway" nginx -t >/dev/null || \
    ! docker exec "$gateway" nginx -s reload >/dev/null || \
    ! verify_gateway_route "$sha"; then
    restore_snapshot_route
    if [[ "$(snapshot_value route_present)" == true ]]; then
      docker exec "$gateway" nginx -t >/dev/null && docker exec "$gateway" nginx -s reload >/dev/null || true
    fi
    return 1
  fi
}

preflight_readonly() {
  local gateway health
  command -v docker >/dev/null || die 'docker required'
  command -v curl >/dev/null || die 'curl required'
  command -v sha256sum >/dev/null || die 'sha256sum required'
  docker info >/dev/null || die 'docker daemon unavailable'
  docker compose config -q || die 'compose syntax invalid'
  verify_image_binding
  gateway=$(gateway_container)
  if [[ -n "$gateway" ]]; then
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$gateway")
    [[ "$health" == healthy ]] || die 'current gateway is not healthy; use rollback or diagnose before an update'
    curl -fsS --max-time 3 "http://127.0.0.1:$APP_PORT/healthz" >/dev/null || die 'current route health check failed preflight'
  else
    [[ -z "$(gateway_container_any_state)" ]] || die 'gateway container exists but is stopped; diagnose it before a first deployment'
    port_is_available || die 'audited host port is occupied'
  fi
}

print_preflight_boundary() {
  log 'dry-run boundary: validates local Docker/Compose metadata, immutable image digest+revision label, and read-only local health GETs.'
  log 'dry-run does not pull, run, start, stop, remove, reload, rename, create a network, or write runtime/deploy configuration.'
}
