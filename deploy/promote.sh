#!/usr/bin/env bash
# Run from a checksum-verified git archive in the dedicated deploy user's home.
set -euo pipefail
[[ $# -eq 5 ]] || { echo 'Usage: promote.sh SHA REPOSITORY DIGEST PORT RUN_NUMBER' >&2; exit 1; }
sha="$1"; repo="$2"; digest="$3"; port="$4"; run="$5"
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$repo" =~ ^[a-zA-Z0-9][a-zA-Z0-9./_-]*$ && "$port" =~ ^[0-9]{4,5}$ ]] || exit 1
[[ "$run" =~ ^[1-9][0-9]*$ && ${#run} -le 15 ]] || exit 1
[[ $(id -u) -ne 0 ]] || { echo 'Refusing root deployment' >&2; exit 1; }
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
docker info --format '{{json .SecurityOptions}}' | grep -q rootless || { echo 'Rootless Docker is required' >&2; exit 1; }
root="$HOME/plane-game"
stage="$root/incoming/$sha"
[[ "$PWD" == "$root" && -f "$stage/compose.yaml" && -f "$stage/deploy/deploy.sh" ]] || exit 1
[[ -z "$(find "$stage" -type l -print -quit)" ]] || { echo 'Source archive contains a symlink' >&2; exit 1; }
export PLANE_GAME_RUNTIME_DIR="$root/runtime"
mkdir -p "$PLANE_GAME_RUNTIME_DIR" "$root/deploy"
exec 8>"$PLANE_GAME_RUNTIME_DIR/.release.lock"
flock 8
last=0
[[ ! -f "$PLANE_GAME_RUNTIME_DIR/last_run_number" ]] || last=$(<"$PLANE_GAME_RUNTIME_DIR/last_run_number")
[[ "$last" =~ ^[0-9]{1,15}$ ]] || { echo 'Invalid release order marker' >&2; exit 1; }
(( 10#$run > 10#$last )) || { echo "Stale run $run cannot supersede run $last" >&2; exit 1; }
old_sha=''
[[ ! -f "$PLANE_GAME_RUNTIME_DIR/active_sha" ]] || old_sha=$(<"$PLANE_GAME_RUNTIME_DIR/active_sha")
backup="$PLANE_GAME_RUNTIME_DIR/source-backups/$run"
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
failed() {
  code="$?"
  trap - EXIT
  if [[ "$code" -eq 0 ]]; then return; fi
  recovery=restored
  restore_source || { echo 'ALERT: source restoration incomplete' >&2; recovery=incomplete; }
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
    recovery=first_reverted
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
  printf 'sha=%s digest=%s time=%s health=failed recovery=%s\n' "$sha" "$digest" "$(date -u +%FT%TZ)" "$recovery" >&2
}
trap failed EXIT
cp "$stage/compose.yaml" "$root/compose.yaml"
cp -a "$stage/deploy/." "$root/deploy/"
cmp "$stage/compose.yaml" "$root/compose.yaml"
for source in "$stage"/deploy/*; do cmp "$source" "$root/deploy/${source##*/}"; done
printf '%s\n' "$run" > "$PLANE_GAME_RUNTIME_DIR/last_run_number"
bash "$root/deploy/deploy.sh" "$sha" "$repo" "$digest" "$port"
trap - EXIT
printf 'sha=%s digest=%s time=%s health=healthy recovery=not_required run=%s\n' "$sha" "$digest" "$(date -u +%FT%TZ)" "$run"
