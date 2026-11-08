#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'actions poller activation refused: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail 'usage: manage-actions-poller.sh activate|prepare-restart|verify-restart'
action=$1
case "$action" in
  activate|prepare-restart|verify-restart) ;;
  *) fail 'usage: manage-actions-poller.sh activate|prepare-restart|verify-restart' ;;
esac

state_dir=$HOME/.local/state/plane-game-poller
unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
dropin_dir=$unit_dir/plane-game-actions-poller.service.d
proof_file=$state_dir/activation-restart-proof
service_name=plane-game-actions-poller.service
timer_name=plane-game-actions-poller.timer
webhook_name=plane-game-webhook-gateway.service
service_source=$profile_dir/systemd-user/$service_name
timer_source=$profile_dir/systemd-user/$timer_name
dropin_source=$profile_dir/systemd-user-activation/$service_name.d/10-trigger-mode.conf

require_regular_owner_mode() {
  local path=$1 expected_mode=$2 label=$3 actual
  [[ -f "$path" && ! -L "$path" ]] || fail "$label must be one regular non-symlink file"
  actual=$(stat -c '%u %a %h' -- "$path") || fail "cannot inspect $label"
  [[ "$actual" == "$PLANE_PREFLIGHT_UID $expected_mode 1" ]] ||
    fail "$label owner/mode/link-count must be $PLANE_PREFLIGHT_UID/$expected_mode/1"
}

require_identity_and_state() {
  local repo_root actual
  [[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" && "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] ||
    fail "must run as $PLANE_PREFLIGHT_USER UID $PLANE_PREFLIGHT_UID"
  repo_root=$(cd -- "$profile_dir/../../.." && pwd -P)
  [[ "$repo_root" == "$HOME/plane-game-cd" ]] || fail 'package must be the real $HOME/plane-game-cd checkout'
  [[ -d "$state_dir" && ! -L "$state_dir" ]] || fail 'state directory must be a real directory'
  actual=$(stat -c '%u %a' -- "$state_dir") || fail 'cannot inspect state directory'
  [[ "$actual" == "$PLANE_PREFLIGHT_UID 700" ]] ||
    fail "state directory owner/mode must be $PLANE_PREFLIGHT_UID/0700"
  require_regular_owner_mode "$state_dir/journal.ndjson" 600 journal
  require_regular_owner_mode "$state_dir/snapshot.json" 600 snapshot
  require_regular_owner_mode "$state_dir/.shared.lock" 600 shared-lock
  require_regular_owner_mode "$state_dir/jenkins-api-token" 600 jenkins-credential
}

require_linger() {
  local linger
  linger=$(loginctl show-user "$PLANE_PREFLIGHT_UID" --property=Linger --value 2>/dev/null) ||
    fail 'cannot prove user-manager linger state'
  [[ "$linger" == yes ]] || fail 'user-manager linger must be enabled before persistent activation'
}

require_webhook_inactive() {
  local state
  if state=$(systemctl --user is-active "$webhook_name" 2>/dev/null); then
    fail 'webhook service is active; simultaneous trigger paths are forbidden'
  fi
  case "$state" in
    inactive|failed) ;;
    *) fail 'cannot prove the webhook service is inactive' ;;
  esac
}

effective_mode() {
  local environment entry count=0 value=''
  environment=$(systemctl --user show "$service_name" --property=Environment --value 2>/dev/null) ||
    fail 'cannot inspect the effective poller environment'
  for entry in $environment; do
    case "$entry" in
      CD_TRIGGER_MODE=*)
        count=$((count + 1))
        value=${entry#CD_TRIGGER_MODE=}
        ;;
    esac
  done
  [[ "$count" == 1 && "$value" == poller ]] ||
    fail 'effective service mode must be exactly one CD_TRIGGER_MODE=poller assignment'
}

require_persistent_active_timer() {
  local enabled active
  enabled=$(systemctl --user is-enabled "$timer_name" 2>/dev/null) || fail 'poller timer is not enabled'
  [[ "$enabled" == enabled ]] || fail 'poller timer must be persistently enabled, not runtime-only or static'
  active=$(systemctl --user is-active "$timer_name" 2>/dev/null) || fail 'poller timer is not active'
  [[ "$active" == active ]] || fail 'poller timer is not active'
  effective_mode
}

ensure_unit_directory() {
  local parent mode
  for parent in "${XDG_CONFIG_HOME:-"$HOME/.config"}" \
      "${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd" "$unit_dir" "$dropin_dir"; do
    [[ ! -L "$parent" ]] || fail "systemd configuration path must not be a symlink: $parent"
    mkdir -p -- "$parent"
    [[ -d "$parent" && ! -L "$parent" ]] || fail "systemd configuration path is not a real directory: $parent"
    [[ "$(stat -c '%u' -- "$parent")" == "$PLANE_PREFLIGHT_UID" ]] ||
      fail "systemd configuration path is not owned by UID $PLANE_PREFLIGHT_UID: $parent"
    mode=$(stat -c '%a' -- "$parent") || fail "cannot inspect systemd configuration mode: $parent"
    (( (8#$mode & 8#022) == 0 )) || fail "systemd configuration path is group/world writable: $parent"
  done
  for source in "$service_source" "$timer_source" "$dropin_source"; do
    [[ -f "$source" && ! -L "$source" ]] || fail "activation source must be a regular non-symlink file: $source"
  done
}

atomic_install() {
  local source=$1 destination=$2 temporary
  temporary=$(mktemp "$(dirname -- "$destination")/.${destination##*/}.XXXXXX")
  install -m 0600 -- "$source" "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$destination"
  sync -f "$(dirname -- "$destination")"
}

read_boot_id() {
  local boot_id
  boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || fail 'cannot read kernel boot ID'
  [[ "$boot_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    fail 'kernel boot ID is malformed'
  printf '%s' "$boot_id"
}

write_pre_restart_proof() {
  local boot_id=$1 temporary now
  now=$(date -u +%s)
  temporary=$(mktemp "$state_dir/.activation-restart-proof.XXXXXX")
  printf 'version=1\nbefore_boot_id=%s\nprepared_at_epoch=%s\n' "$boot_id" "$now" >"$temporary"
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$proof_file"
  sync -f "$state_dir"
}

read_before_boot_id() {
  local before count
  require_regular_owner_mode "$proof_file" 600 restart-proof
  count=$(awk -F= '$1 == "before_boot_id" { count += 1 } END { print count + 0 }' "$proof_file")
  [[ "$count" == 1 ]] || fail 'restart proof must contain exactly one before_boot_id'
  before=$(awk -F= '$1 == "before_boot_id" { print $2 }' "$proof_file")
  [[ "$before" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    fail 'stored boot ID is malformed'
  printf '%s' "$before"
}

write_verified_proof() {
  local before=$1 after=$2 last_trigger=$3 result=$4 status=$5 temporary now
  now=$(date -u +%s)
  temporary=$(mktemp "$state_dir/.activation-restart-proof.XXXXXX")
  printf 'version=1\nbefore_boot_id=%s\nafter_boot_id=%s\nverified_at_epoch=%s\n' \
    "$before" "$after" "$now" >"$temporary"
  printf 'timer_enabled=enabled\ntimer_active=active\nlast_trigger_monotonic_usec=%s\n' "$last_trigger" >>"$temporary"
  printf 'service_result=%s\nservice_status=%s\n' "$result" "$status" >>"$temporary"
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$proof_file"
  sync -f "$state_dir"
}

require_identity_and_state
require_linger
require_webhook_inactive

case "$action" in
  activate)
    ensure_unit_directory
    atomic_install "$service_source" "$unit_dir/$service_name"
    atomic_install "$timer_source" "$unit_dir/$timer_name"
    atomic_install "$dropin_source" "$dropin_dir/10-trigger-mode.conf"
    systemctl --user daemon-reload
    effective_mode
    systemctl --user enable --now "$timer_name"
    require_persistent_active_timer
    printf 'actions poller timer persistently enabled; restart proof is still required before GO\n'
    ;;
  prepare-restart)
    require_persistent_active_timer
    write_pre_restart_proof "$(read_boot_id)"
    printf 'pre-restart boot ID recorded; reboot, wait for the five-minute timer, then run verify-restart\n'
    ;;
  verify-restart)
    before_boot_id=$(read_before_boot_id)
    after_boot_id=$(read_boot_id)
    [[ "$after_boot_id" != "$before_boot_id" ]] || fail 'host boot ID did not change; a restart is not proven'
    require_persistent_active_timer
    last_trigger=$(systemctl --user show "$timer_name" --property=LastTriggerUSecMonotonic --value 2>/dev/null) ||
      fail 'cannot inspect timer trigger evidence'
    [[ "$last_trigger" =~ ^[1-9][0-9]*$ ]] || fail 'timer has not fired in the current boot'
    service_result=$(systemctl --user show "$service_name" --property=Result --value 2>/dev/null) ||
      fail 'cannot inspect poller service result'
    service_status=$(systemctl --user show "$service_name" --property=ExecMainStatus --value 2>/dev/null) ||
      fail 'cannot inspect poller service exit status'
    [[ "$service_result" == success && "$service_status" == 0 ]] ||
      fail 'post-restart timer invocation did not complete successfully'
    write_verified_proof "$before_boot_id" "$after_boot_id" "$last_trigger" "$service_result" "$service_status"
    printf 'actions poller persistent activation verified after host restart\n'
    ;;
esac
