#!/usr/bin/env bash
# Run from a checksum-verified git archive in the dedicated deploy user's home.
set -euo pipefail
[[ $# -eq 8 ]] || { echo 'Usage: promote.sh SHA REPOSITORY DIGEST PORT RUN_NUMBER RUN_ATTEMPT GATEWAY_IMAGE POST_CD_RESOURCE_GATE' >&2; exit 1; }
sha="$1"; repo="$2"; digest="$3"; port="$4"; run="$5"; attempt="$6"; gateway_image="$7"; post_cd_resource_gate_ref="$8"
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$repo" =~ ^[a-zA-Z0-9][a-zA-Z0-9./_-]*$ ]] || exit 1
[[ "$port" == 18081 ]] || { echo 'DEPLOY_PORT must be the versioned value 18081' >&2; exit 1; }
[[ "$run" =~ ^[1-9][0-9]*$ && ${#run} -le 15 ]] || exit 1
[[ "$attempt" =~ ^[1-9][0-9]*$ && ${#attempt} -le 10 ]] || exit 1
[[ "$gateway_image" =~ ^nginxinc/nginx-unprivileged@sha256:[a-f0-9]{64}$ ]] || exit 1
[[ $(id -un) == plane-preflight && $(id -u) -ne 0 ]] || { echo 'Refusing deployment outside plane-preflight' >&2; exit 1; }
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
docker info --format '{{json .SecurityOptions}}' | grep -q rootless || { echo 'Rootless Docker is required' >&2; exit 1; }
root="$HOME/plane-game"
poller_mode=false
if [[ "${CD_TRIGGER_MODE:-}" == poller ]]; then
  [[ "${PLANE_POLLER_STATE_DIR:-}" == "$HOME/.local/state/plane-game-poller" ]] || exit 1
  [[ "${PLANE_DEPLOYMENT_STATE_CLI:-}" == */ops/jenkins/deployment-state.mjs &&
     -f "$PLANE_DEPLOYMENT_STATE_CLI" && ! -L "$PLANE_DEPLOYMENT_STATE_CLI" ]] || exit 1
  [[ "${PLANE_LEDGER_LOCK_FILE:-}" == "$PLANE_POLLER_STATE_DIR/.shared.lock" &&
     -f "$PLANE_LEDGER_LOCK_FILE" && ! -L "$PLANE_LEDGER_LOCK_FILE" ]] || exit 1
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ && "${GITHUB_RUN_ATTEMPT:-}" == "$attempt" ]] || exit 1
  [[ "${PLANE_TRIGGER_ID:-}" == "$sha:$GITHUB_RUN_ID:$attempt" ]] || exit 1
  poller_mode=true
  state_call() { flock --no-fork --nonblock "$PLANE_LEDGER_LOCK_FILE" node "$PLANE_DEPLOYMENT_STATE_CLI" "$@"; }
fi

stage="$root/incoming/$sha-$run-$attempt"
[[ "$PWD" == "$root" && -f "$stage/compose.yaml" && -f "$stage/deploy/deploy.sh" && -f "$stage/deploy/deployment-id.sh" ]] || exit 1
[[ -z "$(find "$stage" -type l -print -quit)" ]] || { echo 'Source archive contains a symlink' >&2; exit 1; }
source "$stage/deploy/deployment-id.sh"
[[ "$post_cd_resource_gate_ref" == ops/jenkins/resource-gate.sh ]] || {
  echo 'Post-CD resource gate is not the candidate-owned reviewed script' >&2
  exit 1
}
post_cd_resource_gate="$stage/$post_cd_resource_gate_ref"
[[ -f "$post_cd_resource_gate" && ! -L "$post_cd_resource_gate" ]] || exit 1
"$stage/deploy/plane-preflight"
export PLANE_GAME_RUNTIME_DIR="$root/runtime"
export PLANE_GAME_PROMOTION_CONTEXT="$PLANE_GAME_RUNTIME_DIR/promotion-context/$run-$attempt-$sha.env"
mkdir -p "$PLANE_GAME_RUNTIME_DIR" "$root/deploy"
exec 8>"$PLANE_GAME_RUNTIME_DIR/.release.lock"
flock 8
rm -f "$PLANE_GAME_PROMOTION_CONTEXT"
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
  local deployment_id candidate_id gateway_id network_id network_created
  local actual candidate_removed=true cleanup_incomplete=false
  if [[ -f "$PLANE_GAME_RUNTIME_DIR/active_sha" ]]; then
    [[ "$(<"$PLANE_GAME_RUNTIME_DIR/active_sha")" == "$sha" ]] || return 1
  elif [[ ! -f "$PLANE_GAME_RUNTIME_DIR/active/upstream.inc" && ! -f "$PLANE_GAME_PROMOTION_CONTEXT" ]]; then
    return 0
  fi

  if [[ ! -f "$PLANE_GAME_PROMOTION_CONTEXT" || -L "$PLANE_GAME_PROMOTION_CONTEXT" ]]; then
    cleanup_incomplete=true
  else
    promotion_value() {
      local key="$1"
      sed -n "s/^${key}=//p" "$PLANE_GAME_PROMOTION_CONTEXT"
    }
    deployment_id=$(promotion_value deployment_id)
    candidate_id=$(promotion_value candidate_id)
    gateway_id=$(promotion_value gateway_id)
    network_id=$(promotion_value network_id)
    network_created=$(promotion_value network_created)
    if [[ "$(promotion_value release_sha)" != "$sha" || "$(promotion_value image_digest)" != "$digest" ||
          ! "$candidate_id" =~ ^[a-f0-9]{64}$ || ! "$gateway_id" =~ ^[a-f0-9]{64}$ ||
          ( "$network_created" != true && "$network_created" != false ) ||
          ( "$network_created" == true && ! "$network_id" =~ ^[a-f0-9]{64}$ ) ||
          ( "$network_created" == false && -n "$network_id" ) ]] ||
       ! valid_deployment_id "$deployment_id" "$sha"; then
      cleanup_incomplete=true
    else
      if docker container inspect "$gateway_id" >/dev/null 2>&1; then
        actual=$(docker container inspect --format '{{.Id}} {{ index .Config.Labels "com.plane-game.deployment-id" }} {{ index .Config.Labels "com.docker.compose.project" }} {{ index .Config.Labels "com.docker.compose.service" }}' "$gateway_id" 2>/dev/null || true)
        if [[ "$actual" != "$gateway_id $deployment_id plane-game gateway" ]] ||
           ! docker rm -f "$gateway_id" >/dev/null 2>&1 ||
           docker container inspect "$gateway_id" >/dev/null 2>&1; then
          cleanup_incomplete=true
        fi
      fi
      if docker container inspect "$candidate_id" >/dev/null 2>&1; then
        actual=$(docker container inspect --format '{{.Id}} {{ index .Config.Labels "com.plane-game.deployment-id" }} {{ index .Config.Labels "com.plane-game.release-sha" }} {{ index .Config.Labels "com.plane-game.image-digest" }}' "$candidate_id" 2>/dev/null || true)
        if [[ "$actual" != "$candidate_id $deployment_id $sha $digest" ]] ||
           ! docker rm -f "$candidate_id" >/dev/null 2>&1 ||
           docker container inspect "$candidate_id" >/dev/null 2>&1; then
          cleanup_incomplete=true
          candidate_removed=false
        fi
      fi
      if [[ "$network_created" == true ]] && docker network inspect "$network_id" >/dev/null 2>&1; then
        actual=$(docker network inspect --format '{{.Id}} {{ index .Labels "com.plane-game.deployment-id" }} {{ index .Labels "com.docker.compose.project" }} {{ index .Labels "com.docker.compose.network" }}' "$network_id" 2>/dev/null || true)
        if ! "$candidate_removed" || [[ "$actual" != "$network_id $deployment_id plane-game default" ]] ||
           ! docker network rm "$network_id" >/dev/null 2>&1 ||
           docker network inspect "$network_id" >/dev/null 2>&1; then
          cleanup_incomplete=true
        fi
      fi
    fi
  fi
  rm -f "$PLANE_GAME_RUNTIME_DIR/active/upstream.inc" "$PLANE_GAME_RUNTIME_DIR/active_sha"
  if [[ -f "$PLANE_GAME_RUNTIME_DIR/active_sha" || -f "$PLANE_GAME_RUNTIME_DIR/active/upstream.inc" ]]; then
    cleanup_incomplete=true
  fi
  if "$cleanup_incomplete"; then
    return 1
  fi
  rm -f "$PLANE_GAME_PROMOTION_CONTEXT"
}
set_recovery_incomplete() {
  if [[ -z "$old_sha" ]]; then recovery=revert_incomplete; else recovery=incomplete; fi
}
failed() {
  code="$?"
  trap - EXIT
  if [[ "$code" -eq 0 ]]; then return; fi
  if "$poller_mode"; then
    if ! state_call rollback-intent "$PLANE_POLLER_STATE_DIR" \
      "$PLANE_GAME_RUNTIME_DIR" "$PLANE_TRIGGER_ID" "promotion_failed" >/dev/null; then
      echo 'ALERT: durable rollback intent could not be recorded; automatic rollback refused' >&2
      return
    fi
  fi

  recovery=restored
  if [[ -z "$old_sha" ]]; then
    recovery=first_reverted
    deactivate_first_release ||
      { echo 'ALERT: first release could not be safely deactivated' >&2; recovery=revert_incomplete; }
  fi
  restore_source || { echo 'ALERT: source restoration incomplete' >&2; set_recovery_incomplete; }
  restore_attempt_marker || { echo 'ALERT: release attempt marker restoration incomplete' >&2; set_recovery_incomplete; }
  if [[ -n "$old_sha" ]]; then
    gateway=$(docker compose -p plane-game ps -q gateway 2>/dev/null || true)
    if [[ -z "$gateway" ]] || ! docker exec "$gateway" nginx -t >/dev/null 2>&1 ||
       ! docker exec "$gateway" nginx -s reload >/dev/null 2>&1; then
      echo 'ALERT: previous gateway configuration could not be restored' >&2
      set_recovery_incomplete
    fi
    if [[ -f "$PLANE_GAME_RUNTIME_DIR/active_sha" && $(<"$PLANE_GAME_RUNTIME_DIR/active_sha") != "$old_sha" ]]; then
      # A post-check failure must recover the recorded previous release.
      PLANE_GAME_RUNTIME_DIR="$PLANE_GAME_RUNTIME_DIR" bash "$root/deploy/rollback.sh" "$old_sha" "$port" ||
        { echo 'ALERT: automatic rollback incomplete' >&2; recovery=incomplete; }
    fi
    if ! curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null ||
       [[ "$(curl -fsS "http://127.0.0.1:$port/version.json" 2>/dev/null)" != "{\"sha\":\"$old_sha\"}" ]]; then
      echo 'ALERT: prior healthy route not restored; investigate immediately' >&2
      set_recovery_incomplete
    fi
  else
    if [[ -f "$PLANE_GAME_RUNTIME_DIR/active_sha" ]]; then
      echo 'ALERT: first release left an active route; investigate immediately' >&2
      set_recovery_incomplete
    fi
  fi
  for record in "$PLANE_GAME_RUNTIME_DIR"/deployment-snapshots/*-"$sha"/state.env; do
    [[ -f "$record" ]] || continue
    if grep -q '^outcome=revert_incomplete$' "$record"; then
      echo 'ALERT: run-scoped resource cleanup is incomplete' >&2
      set_recovery_incomplete
    fi
  done
  [[ -z "$old_sha" ]] || rm -f "$PLANE_GAME_PROMOTION_CONTEXT"
  printf 'sha=%s digest=%s gateway=%s time=%s health=failed recovery=%s\n' "$sha" "$digest" "$gateway_image" "$(date -u +%FT%TZ)" "$recovery" >&2
  if "$poller_mode"; then
    if ! state_call rollback-complete "$PLANE_POLLER_STATE_DIR" \
      "$PLANE_GAME_RUNTIME_DIR" "$PLANE_TRIGGER_ID" >/dev/null; then
      echo 'ALERT: rollback result is not authoritative; tuple quarantined' >&2
      set_recovery_incomplete
    fi
  fi
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
bash "$post_cd_resource_gate"
order_attempt_updated=true
printf '%s\n' "$attempt" > "$PLANE_GAME_RUNTIME_DIR/last_run_attempt"
printf '%s\n' "$run" > "$PLANE_GAME_RUNTIME_DIR/last_run_number"
order_attempt_updated=false
rm -f "$PLANE_GAME_PROMOTION_CONTEXT"
trap - EXIT
printf 'sha=%s digest=%s gateway=%s time=%s health=healthy recovery=not_required run=%s attempt=%s\n' \
  "$sha" "$digest" "$gateway_image" "$(date -u +%FT%TZ)" "$run" "$attempt"
