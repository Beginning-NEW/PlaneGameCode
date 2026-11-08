#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'actions poller activation refused: %s\n' "$*" >&2
  exit 1
}

usage='usage: manage-actions-poller.sh activate|deactivate|prepare-restart|verify-restart|verify-disabled-restart [APPROVED_DIR]'
[[ $# -ge 1 && $# -le 2 ]] || fail "$usage"
action=$1
case "$action" in
  activate|deactivate|prepare-restart|verify-restart|verify-disabled-restart) ;;
  *) fail "$usage" ;;
esac

state_dir=$HOME/.local/state/plane-game-poller
approved_dir=${2:-"$HOME/.config/plane-game/controller-stage-b"}
selector_file=$approved_dir/cd-trigger-mode
unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
dropin_dir=$unit_dir/plane-game-actions-poller.service.d
proof_file=$state_dir/activation-restart-proof
disabled_proof_file=$state_dir/deactivation-restart-proof
service_name=plane-game-actions-poller.service
timer_name=plane-game-actions-poller.timer
webhook_name=plane-game-webhook-gateway.service
service_source=$profile_dir/systemd-user/$service_name
timer_source=$profile_dir/systemd-user/$timer_name
dropin_source=$profile_dir/systemd-user-activation/$service_name.d/10-trigger-mode.conf
poller_mode_script=$profile_dir/set-poller-mode.groovy
disabled_mode_script=$profile_dir/set-disabled-mode.groovy
jenkins_url=http://127.0.0.1:18080
admin_user=plane-admin

require_regular_owner_mode() {
  local path=$1 expected_mode=$2 label=$3 actual
  [[ -f "$path" && ! -L "$path" ]] || fail "$label must be one regular non-symlink file"
  actual=$(stat -c '%u %a %h' -- "$path") || fail "cannot inspect $label"
  [[ "$actual" == "$PLANE_PREFLIGHT_UID $expected_mode 1" ]] ||
    fail "$label owner/mode/link-count must be $PLANE_PREFLIGHT_UID/$expected_mode/1"
}

require_identity() {
  local repo_root actual
  [[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" && "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] ||
    fail "must run as $PLANE_PREFLIGHT_USER UID $PLANE_PREFLIGHT_UID"
  repo_root=$(cd -- "$profile_dir/../../.." && pwd -P)
  [[ "$repo_root" == "$HOME/plane-game-cd" ]] || fail 'package must be the real $HOME/plane-game-cd checkout'
}

require_approved_directory() {
  [[ -d "$approved_dir" && ! -L "$approved_dir" ]] ||
    fail 'controller approved directory must be a real directory'
  [[ "$(stat -c '%u %a' -- "$approved_dir")" == "$PLANE_PREFLIGHT_UID 750" ]] ||
    fail "controller approved directory owner/mode must be $PLANE_PREFLIGHT_UID/0750"
}

require_selector_value() {
  local expected=$1 actual
  require_regular_owner_mode "$selector_file" 640 trigger-selector
  actual=$(tr -d '\r\n' <"$selector_file")
  [[ "$actual" == "$expected" ]] || fail "persisted trigger selector must be $expected"
}

write_selector_value() {
  local value=$1 temporary
  [[ "$value" == poller || "$value" == disabled ]] || return 1
  require_approved_directory
  temporary=$(mktemp "$approved_dir/.cd-trigger-mode.XXXXXX")
  printf '%s\n' "$value" >"$temporary"
  chmod 0640 "$temporary"
  setfacl --remove-all "$temporary"
  setfacl -m "u:$JENKINS_MAPPED_HOST_UID:r--,m::r--,g::---,o::---" "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$selector_file"
  sync -f "$approved_dir"
  require_selector_value "$value"
}

configure_jenkins_mode() (
  set -euo pipefail
  local mode=$1 script expected runtime_base scratch crumb_json crumb_field crumb_value response
  case "$mode" in
    poller)
      script=$poller_mode_script
      expected=$'selector=poller\njob_disabled=false'
      ;;
    disabled)
      script=$disabled_mode_script
      expected=$'selector=disabled\njob_disabled=true'
      ;;
    *) return 1 ;;
  esac
  [[ -f "$script" && ! -L "$script" ]] || return 1
  runtime_base=${XDG_RUNTIME_DIR:-/run/user/$PLANE_PREFLIGHT_UID}
  [[ -d "$runtime_base" && -w "$runtime_base" && ! -L "$runtime_base" ]] || return 1
  scratch=$(mktemp -d "$runtime_base/plane-game-poller-mode.XXXXXX")
  trap 'find "$scratch" -mindepth 1 -maxdepth 1 -type f -delete; rmdir -- "$scratch"' EXIT
  crumb_json=$(curl --proxy '' --noproxy 127.0.0.1 --proto '=http' --max-redirs 0 \
    --fail --silent --show-error --cookie-jar "$scratch/cookies" --user "$admin_user" \
    "$jenkins_url/crumbIssuer/api/json")
  crumb_field=$(printf '%s' "$crumb_json" | node -e '
    let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
      try { const v=JSON.parse(s); if(typeof v.crumbRequestField!=="string") process.exit(2); process.stdout.write(v.crumbRequestField); }
      catch { process.exit(2); }
    });')
  crumb_value=$(printf '%s' "$crumb_json" | node -e '
    let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
      try { const v=JSON.parse(s); if(typeof v.crumb!=="string") process.exit(2); process.stdout.write(v.crumb); }
      catch { process.exit(2); }
    });')
  printf 'header = "%s: %s"\n' "$crumb_field" "$crumb_value" >"$scratch/crumb.conf"
  chmod 0600 "$scratch/crumb.conf"
  response=$(curl --proxy '' --noproxy 127.0.0.1 --proto '=http' --max-redirs 0 \
    --fail --silent --show-error --cookie "$scratch/cookies" --user "$admin_user" \
    --config "$scratch/crumb.conf" --request POST --data-urlencode "script@$script" \
    "$jenkins_url/scriptText")
  [[ "$response" == "$expected" ]]
)

require_activation_state() {
  local actual
  [[ -d "$state_dir" && ! -L "$state_dir" ]] || fail 'state directory must be a real directory'
  actual=$(stat -c '%u %a' -- "$state_dir") || fail 'cannot inspect state directory'
  [[ "$actual" == "$PLANE_PREFLIGHT_UID 700" ]] ||
    fail "state directory owner/mode must be $PLANE_PREFLIGHT_UID/0700"
  require_regular_owner_mode "$state_dir/journal.ndjson" 600 journal
  require_regular_owner_mode "$state_dir/snapshot.json" 600 snapshot
  require_regular_owner_mode "$state_dir/.shared.lock" 600 shared-lock
  require_regular_owner_mode "$state_dir/jenkins-api-token" 600 jenkins-credential
}

ensure_state_directory() {
  local parent mode
  for parent in "$HOME/.local" "$HOME/.local/state" "$state_dir"; do
    [[ ! -L "$parent" ]] || fail "state path must not be a symlink: $parent"
    mkdir -p -- "$parent"
    [[ -d "$parent" && ! -L "$parent" ]] || fail "state path is not a real directory: $parent"
    [[ "$(stat -c '%u' -- "$parent")" == "$PLANE_PREFLIGHT_UID" ]] ||
      fail "state path is not owned by UID $PLANE_PREFLIGHT_UID: $parent"
    mode=$(stat -c '%a' -- "$parent") || fail "cannot inspect state directory mode: $parent"
    (( (8#$mode & 8#022) == 0 )) || fail "state path is group/world writable: $parent"
  done
  chmod 0700 "$state_dir"
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

effective_disabled_mode() {
  local environment entry count=0 value=''
  environment=$(systemctl --user show "$service_name" --property=Environment --value 2>/dev/null) ||
    fail 'cannot inspect the effective poller environment while disabling'
  for entry in $environment; do
    case "$entry" in
      CD_TRIGGER_MODE=*)
        count=$((count + 1))
        value=${entry#CD_TRIGGER_MODE=}
        ;;
    esac
  done
  [[ "$count" == 1 && "$value" == disabled ]] ||
    fail 'effective service mode must be exactly one CD_TRIGGER_MODE=disabled assignment'
}

require_persistent_active_timer() {
  local enabled active
  enabled=$(systemctl --user is-enabled "$timer_name" 2>/dev/null) || fail 'poller timer is not enabled'
  [[ "$enabled" == enabled ]] || fail 'poller timer must be persistently enabled, not runtime-only or static'
  active=$(systemctl --user is-active "$timer_name" 2>/dev/null) || fail 'poller timer is not active'
  [[ "$active" == active ]] || fail 'poller timer is not active'
  effective_mode
  require_selector_value poller
}

require_persistent_disabled_poller() {
  local timer_enabled timer_enabled_status service_enabled service_enabled_status
  local timer_active timer_active_status service_active service_active_status
  set +e
  timer_enabled=$(systemctl --user is-enabled "$timer_name" 2>/dev/null)
  timer_enabled_status=$?
  service_enabled=$(systemctl --user is-enabled "$service_name" 2>/dev/null)
  service_enabled_status=$?
  timer_active=$(systemctl --user is-active "$timer_name" 2>/dev/null)
  timer_active_status=$?
  service_active=$(systemctl --user is-active "$service_name" 2>/dev/null)
  service_active_status=$?
  set -e
  [[ "$timer_enabled_status" -ne 0 && "$timer_enabled" == disabled ]] ||
    fail 'poller timer must be persistently disabled'
  [[ "$service_enabled_status" -eq 0 && "$service_enabled" == static ]] ||
    fail 'poller service must remain static and not independently enableable'
  [[ "$timer_active_status" -ne 0 && "$timer_active" == inactive ]] ||
    fail 'poller timer must be inactive'
  [[ "$service_active_status" -ne 0 && "$service_active" == inactive ]] ||
    fail 'poller service must be inactive'
  [[ ! -e "$dropin_dir/10-trigger-mode.conf" && ! -L "$dropin_dir/10-trigger-mode.conf" ]] ||
    fail 'poller mode drop-in remains installed'
  effective_disabled_mode
  require_selector_value disabled
}

ensure_unit_directory() {
  local create_dropin=${1:-false} parent mode
  local -a parents=(
    "${XDG_CONFIG_HOME:-"$HOME/.config"}"
    "${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd"
    "$unit_dir"
  )
  case "$create_dropin" in
    true) parents+=("$dropin_dir") ;;
    false) ;;
    *) fail 'internal unit-directory mode is invalid' ;;
  esac
  for parent in "${parents[@]}"; do
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

atomic_remove() {
  local destination=$1 parent
  [[ ! -d "$destination" ]] || fail "refusing to remove a directory where a unit file is expected: $destination"
  if [[ -e "$destination" || -L "$destination" ]]; then
    parent=$(dirname -- "$destination")
    [[ -d "$parent" && ! -L "$parent" ]] ||
      fail "unit-file parent must be a real directory before removal: $parent"
    rm -f -- "$destination"
    sync -f "$parent"
  fi
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
  printf 'service_result=%s\nservice_status=%s\nselector=poller\njob_disabled=false\n' \
    "$result" "$status" >>"$temporary"
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$proof_file"
  sync -f "$state_dir"
}

write_disabled_pre_restart_proof() {
  local boot_id=$1 temporary now
  now=$(date -u +%s)
  temporary=$(mktemp "$state_dir/.deactivation-restart-proof.XXXXXX")
  printf 'version=1\nbefore_boot_id=%s\ndeactivated_at_epoch=%s\n' "$boot_id" "$now" >"$temporary"
  printf 'timer_enabled=disabled\ntimer_active=inactive\nservice_enabled=static\nservice_active=inactive\nselector=disabled\njob_disabled=true\n' >>"$temporary"
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$disabled_proof_file"
  sync -f "$state_dir"
}

read_disabled_before_boot_id() {
  local before count
  require_regular_owner_mode "$disabled_proof_file" 600 disabled-restart-proof
  count=$(awk -F= '$1 == "before_boot_id" { count += 1 } END { print count + 0 }' "$disabled_proof_file")
  [[ "$count" == 1 ]] || fail 'disabled restart proof must contain exactly one before_boot_id'
  before=$(awk -F= '$1 == "before_boot_id" { print $2 }' "$disabled_proof_file")
  [[ "$before" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    fail 'stored disabled boot ID is malformed'
  printf '%s' "$before"
}

write_disabled_verified_proof() {
  local before=$1 after=$2 temporary now
  now=$(date -u +%s)
  temporary=$(mktemp "$state_dir/.deactivation-restart-proof.XXXXXX")
  printf 'version=1\nbefore_boot_id=%s\nafter_boot_id=%s\nverified_at_epoch=%s\n' \
    "$before" "$after" "$now" >"$temporary"
  printf 'timer_enabled=disabled\ntimer_active=inactive\nservice_enabled=static\nservice_active=inactive\nselector=disabled\njob_disabled=true\n' >>"$temporary"
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$disabled_proof_file"
  sync -f "$state_dir"
}

activation_pending=false
rollback_partial_activation() {
  set +e
  systemctl --user stop "$timer_name" "$service_name" >/dev/null 2>&1
  systemctl --user disable "$timer_name" "$service_name" >/dev/null 2>&1
  if [[ -e "$dropin_dir/10-trigger-mode.conf" || -L "$dropin_dir/10-trigger-mode.conf" ]]; then
    rm -f -- "$dropin_dir/10-trigger-mode.conf"
    sync -f "$dropin_dir"
  fi
  systemctl --user daemon-reload >/dev/null 2>&1
  write_selector_value disabled >/dev/null 2>&1
  configure_jenkins_mode disabled >/dev/null 2>&1
  set -e
}

require_identity

case "$action" in
  activate)
    require_activation_state
    require_linger
    require_webhook_inactive
    require_approved_directory
    ensure_unit_directory true
    for source in "$poller_mode_script" "$disabled_mode_script"; do
      [[ -f "$source" && ! -L "$source" ]] || fail "Jenkins mode source is unsafe: $source"
    done
    activation_pending=true
    trap 'if [[ "$activation_pending" == true ]]; then rollback_partial_activation; fi' ERR
    write_selector_value poller
    configure_jenkins_mode poller
    atomic_install "$service_source" "$unit_dir/$service_name"
    atomic_install "$timer_source" "$unit_dir/$timer_name"
    atomic_install "$dropin_source" "$dropin_dir/10-trigger-mode.conf"
    systemctl --user daemon-reload
    effective_mode
    systemctl --user enable --now "$timer_name"
    require_persistent_active_timer
    activation_pending=false
    trap - ERR
    printf 'Jenkins selector/job and actions poller timer enabled as one tuple; restart proof is still required before GO\n'
    ;;
  deactivate)
    ensure_state_directory
    require_approved_directory
    ensure_unit_directory false
    atomic_install "$service_source" "$unit_dir/$service_name"
    atomic_install "$timer_source" "$unit_dir/$timer_name"
    systemctl --user stop "$timer_name" "$service_name" >/dev/null 2>&1 || true
    systemctl --user disable "$timer_name" "$service_name" >/dev/null 2>&1 || true
    atomic_remove "$dropin_dir/10-trigger-mode.conf"
    systemctl --user daemon-reload
    systemctl --user stop "$timer_name" "$service_name" >/dev/null 2>&1 || true
    systemctl --user disable "$timer_name" "$service_name" >/dev/null 2>&1 || true
    write_selector_value disabled
    configure_jenkins_mode disabled || fail 'cannot prove Jenkins selector disabled and job disabled'
    require_persistent_disabled_poller
    write_disabled_pre_restart_proof "$(read_boot_id)"
    printf 'actions poller persistently disabled and inactive; reboot, then run verify-disabled-restart\n'
    ;;
  prepare-restart)
    require_activation_state
    require_linger
    require_webhook_inactive
    require_persistent_active_timer
    write_pre_restart_proof "$(read_boot_id)"
    printf 'pre-restart boot ID recorded; reboot, wait for the five-minute timer, then run verify-restart\n'
    ;;
  verify-restart)
    require_activation_state
    require_linger
    require_webhook_inactive
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
    configure_jenkins_mode poller || fail 'cannot prove post-restart Jenkins selector poller and job enabled'
    write_verified_proof "$before_boot_id" "$after_boot_id" "$last_trigger" "$service_result" "$service_status"
    printf 'actions poller persistent activation verified after host restart\n'
    ;;
  verify-disabled-restart)
    ensure_state_directory
    before_boot_id=$(read_disabled_before_boot_id)
    after_boot_id=$(read_boot_id)
    [[ "$after_boot_id" != "$before_boot_id" ]] || fail 'host boot ID did not change; a disabled restart is not proven'
    configure_jenkins_mode disabled || fail 'cannot prove post-restart Jenkins selector and job remain disabled'
    require_persistent_disabled_poller
    write_disabled_verified_proof "$before_boot_id" "$after_boot_id"
    printf 'actions poller persistent deactivation verified after host restart\n'
    ;;
esac
