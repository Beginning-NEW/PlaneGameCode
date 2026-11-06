#!/usr/bin/env bash
# Run from a checksum-verified git archive in the dedicated deploy user's home.
set -euo pipefail
[[ $# -eq 7 ]] || { echo 'Usage: promote.sh SHA REPOSITORY DIGEST PORT RUN_NUMBER RUN_ATTEMPT GATEWAY_IMAGE' >&2; exit 1; }
sha="$1"; repo="$2"; digest="$3"; port="$4"; run="$5"; attempt="$6"; gateway_image="$7"
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$repo" =~ ^[a-zA-Z0-9][a-zA-Z0-9./_-]*$ && "$port" =~ ^[0-9]{4,5}$ ]] || exit 1
[[ "$run" =~ ^[1-9][0-9]*$ && ${#run} -le 15 ]] || exit 1
[[ "$attempt" =~ ^[1-9][0-9]*$ && ${#attempt} -le 10 ]] || exit 1
[[ "$gateway_image" =~ ^nginxinc/nginx-unprivileged@sha256:[a-f0-9]{64}$ ]] || exit 1
[[ $(id -un) == plane-preflight && $(id -u) -ne 0 ]] || { echo 'Refusing deployment outside plane-preflight' >&2; exit 1; }
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
docker info --format '{{json .SecurityOptions}}' | grep -q rootless || { echo 'Rootless Docker is required' >&2; exit 1; }
root="$HOME/plane-game"
stage="$root/incoming/$sha-$run-$attempt"
[[ "$PWD" == "$root" && -f "$stage/compose.yaml" && -f "$stage/deploy/deploy.sh" ]] || exit 1
[[ -z "$(find "$stage" -type l -print -quit)" ]] || { echo 'Source archive contains a symlink' >&2; exit 1; }
"$stage/deploy/plane-preflight"
export PLANE_GAME_RUNTIME_DIR="$root/runtime"
mkdir -p "$PLANE_GAME_RUNTIME_DIR" "$root/deploy"
exec 8>"$PLANE_GAME_RUNTIME_DIR/.release.lock"
flock 8
bash "$stage/deploy/check-release-order.sh" "$run" "$attempt"
old_sha=''
[[ ! -f "$PLANE_GAME_RUNTIME_DIR/active_sha" ]] || old_sha=$(<"$PLANE_GAME_RUNTIME_DIR/active_sha")
backup="$PLANE_GAME_RUNTIME_DIR/source-backups/$run-$attempt"
mkdir -p "$backup"
if [[ -f "$root/compose.yaml" ]]; then
  cp "$root/compose.yaml" "$backup/compose.yaml"
  cp -a "$root/deploy" "$backup/deploy"
elif [[ -n "$old_sha" ]]; then
  echo 'Active release has no matching deployed source' >&2
  exit 1
fi
restore_source() {
  if [[ -f "$backup/compose.yaml" ]]; then
    cp "$backup/compose.yaml" "$root/compose.yaml"
    cp -a "$backup/deploy/." "$root/deploy/"
  else
    rm -f "$root/compose.yaml"
    # First-release code is retained for diagnosis; no service is exposed.
  fi
}
old_attempt_present=false
old_attempt=''
if [[ -f "$PLANE_GAME_RUNTIME_DIR/last_run_attempt" ]]; then
  old_attempt_present=true
  old_attempt=$(<"$PLANE_GAME_RUNTIME_DIR/last_run_attempt")
fi
order_attempt_updated=false
restore_attempt_marker() {
  "$order_attempt_updated" || return 0
  if "$old_attempt_present"; then
    printf '%s\n' "$old_attempt" > "$PLANE_GAME_RUNTIME_DIR/last_run_attempt"
  else
    rm -f "$PLANE_GAME_RUNTIME_DIR/last_run_attempt"
  fi
}
deactivate_first_release() {
  local gateway
  [[ -f "$PLANE_GAME_RUNTIME_DIR/active_sha" ]] || return 0
  [[ "$(<"$PLANE_GAME_RUNTIME_DIR/active_sha")" == "$sha" ]] || return 1
  gateway=$(docker compose -p plane-game ps -q gateway 2>/dev/null || true)
  [[ -n "$gateway" ]] || return 1
  docker rm -f "$gateway" >/dev/null 2>&1 || return 1
  rm -f "$PLANE_GAME_RUNTIME_DIR/active/upstream.inc" "$PLANE_GAME_RUNTIME_DIR/active_sha"
  [[ ! -f "$PLANE_GAME_RUNTIME_DIR/active_sha" && ! -f "$PLANE_GAME_RUNTIME_DIR/active/upstream.inc" ]]
}
failed() {
  code="$?"
  trap - EXIT
  if [[ "$code" -eq 0 ]]; then return; fi
  recovery=restored
  if [[ -z "$old_sha" ]]; then
    recovery=first_reverted
    deactivate_first_release ||
      { echo 'ALERT: first release could not be safely deactivated' >&2; recovery=incomplete; }
  fi
  restore_source || { echo 'ALERT: source restoration incomplete' >&2; recovery=incomplete; }
  restore_attempt_marker || { echo 'ALERT: release attempt marker restoration incomplete' >&2; recovery=incomplete; }
  if [[ -n "$old_sha" ]]; then
    gateway=$(docker compose -p plane-game ps -q gateway 2>/dev/null || true)
    if [[ -z "$gateway" ]] || ! docker exec "$gateway" nginx -t >/dev/null 2>&1 ||
       ! docker exec "$gateway" nginx -s reload >/dev/null 2>&1; then
      echo 'ALERT: previous gateway configuration could not be restored' >&2
      recovery=incomplete
    fi
    if [[ -f "$PLANE_GAME_RUNTIME_DIR/active_sha" && $(<"$PLANE_GAME_RUNTIME_DIR/active_sha") != "$old_sha" ]]; then
      # A post-check failure must recover the recorded previous release.
      PLANE_GAME_RUNTIME_DIR="$PLANE_GAME_RUNTIME_DIR" bash "$root/deploy/rollback.sh" "$old_sha" "$port" ||
        { echo 'ALERT: automatic rollback incomplete' >&2; recovery=incomplete; }
    fi
    if ! curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null ||
       [[ "$(curl -fsS "http://127.0.0.1:$port/version.json" 2>/dev/null)" != "{\"sha\":\"$old_sha\"}" ]]; then
      echo 'ALERT: prior healthy route not restored; investigate immediately' >&2
      recovery=incomplete
    fi
  else
    if [[ -f "$PLANE_GAME_RUNTIME_DIR/active_sha" ]]; then
      echo 'ALERT: first release left an active route; investigate immediately' >&2
      recovery=incomplete
    fi
  fi
  for record in "$PLANE_GAME_RUNTIME_DIR"/deployment-snapshots/*-"$sha"/state.env; do
    [[ -f "$record" ]] || continue
    if grep -q '^outcome=revert_incomplete$' "$record"; then
      echo 'ALERT: run-scoped resource cleanup is incomplete' >&2
      recovery=incomplete
    fi
  done
  printf 'sha=%s digest=%s gateway=%s time=%s health=failed recovery=%s\n' "$sha" "$digest" "$gateway_image" "$(date -u +%FT%TZ)" "$recovery" >&2
}
trap failed EXIT
cp "$stage/compose.yaml" "$root/compose.yaml"
cp -a "$stage/deploy/." "$root/deploy/"
cmp "$stage/compose.yaml" "$root/compose.yaml"
while IFS= read -r -d '' source; do
  cmp "$source" "$root/deploy/${source#"$stage/deploy/"}"
done < <(find "$stage/deploy" -type f -print0)
bash "$root/deploy/deploy.sh" "$sha" "$repo" "$digest" "$port" "$gateway_image"
curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz" >/dev/null
expected_version=$(printf '{"sha":"%s"}' "$sha")
[[ "$(curl -fsS --max-time 5 "http://127.0.0.1:$port/version.json")" == "$expected_version" ]]
order_attempt_updated=true
printf '%s\n' "$attempt" > "$PLANE_GAME_RUNTIME_DIR/last_run_attempt"
printf '%s\n' "$run" > "$PLANE_GAME_RUNTIME_DIR/last_run_number"
order_attempt_updated=false
trap - EXIT
printf 'sha=%s digest=%s gateway=%s time=%s health=healthy recovery=not_required run=%s attempt=%s\n' \
  "$sha" "$digest" "$gateway_image" "$(date -u +%FT%TZ)" "$run" "$attempt"
