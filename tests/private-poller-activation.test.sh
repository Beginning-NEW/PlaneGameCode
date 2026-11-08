#!/usr/bin/env bash
set -euo pipefail

root=$(pwd -P)
scratch=$(mktemp -d)
cleanup() { rm -rf -- "$scratch"; }
trap cleanup EXIT

home=$scratch/home
profile=$home/plane-game-cd/ops/jenkins/controller-stage-b
state_dir=$home/.local/state/plane-game-poller
fake_bin=$scratch/bin
fake_state=$scratch/systemd-state
mkdir -p "$profile/systemd-user" \
  "$profile/systemd-user-activation/plane-game-actions-poller.service.d" "$fake_bin" "$fake_state"
cp "$root/ops/jenkins/controller-stage-b/manage-actions-poller.sh" "$profile/"
cp "$root/ops/jenkins/controller-stage-b/systemd-user/plane-game-actions-poller.service" "$profile/systemd-user/"
cp "$root/ops/jenkins/controller-stage-b/systemd-user/plane-game-actions-poller.timer" "$profile/systemd-user/"
cp "$root/ops/jenkins/controller-stage-b/systemd-user-activation/plane-game-actions-poller.service.d/10-trigger-mode.conf" \
  "$profile/systemd-user-activation/plane-game-actions-poller.service.d/"

current_uid=$(id -u)
current_user=$(id -un)
printf 'PLANE_PREFLIGHT_UID=%s\nPLANE_PREFLIGHT_USER=%s\n' "$current_uid" "$current_user" >"$profile/runtime.env"
install -d -m 0700 "$state_dir"
for name in journal.ndjson snapshot.json .shared.lock jenkins-api-token; do
  install -m 0600 /dev/null "$state_dir/$name"
done

cat >"$fake_bin/loginctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == show-user ]]
cat "$FAKE_SYSTEMD_STATE/linger"
SH

cat >"$fake_bin/cat" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == /proc/sys/kernel/random/boot_id ]]; then
  exec /bin/cat "$FAKE_SYSTEMD_STATE/boot-id"
fi
exec /bin/cat "$@"
SH

cat >"$fake_bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --user ]]
shift
command=$1
shift
unit_dir=$HOME/.config/systemd/user
timer=plane-game-actions-poller.timer
service=plane-game-actions-poller.service
webhook=plane-game-webhook-gateway.service
wants=$unit_dir/timers.target.wants/$timer

property_value() {
  local unit=$1 property=$2 current_boot triggered_boot
  case "$unit:$property" in
    "$service:Environment")
      if grep -Fxq 'Environment=CD_TRIGGER_MODE=poller' \
          "$unit_dir/$service.d/10-trigger-mode.conf" 2>/dev/null; then
        printf 'CD_TRIGGER_MODE=poller\n'
      else
        printf 'CD_TRIGGER_MODE=disabled\n'
      fi
      ;;
    "$timer:LastTriggerUSecMonotonic")
      current_boot=$(/bin/cat "$FAKE_SYSTEMD_STATE/boot-id")
      triggered_boot=$(/bin/cat "$FAKE_SYSTEMD_STATE/triggered-boot" 2>/dev/null || true)
      [[ "$current_boot" == "$triggered_boot" ]] && printf '300000000\n' || printf '0\n'
      ;;
    "$service:Result") printf 'success\n' ;;
    "$service:ExecMainStatus") printf '0\n' ;;
    *) exit 2 ;;
  esac
}

case "$command" in
  daemon-reload) exit 0 ;;
  enable)
    [[ "$1" == --now && "$2" == "$timer" ]]
    grep -Fxq 'WantedBy=timers.target' "$unit_dir/$timer"
    mkdir -p "$unit_dir/timers.target.wants"
    ln -sfn "../$timer" "$wants"
    touch "$FAKE_SYSTEMD_STATE/timer-active"
    ;;
  disable)
    for unit in "$@"; do
      case "$unit" in
        --now) ;;
        "$timer")
          rm -f "$wants" "$FAKE_SYSTEMD_STATE/timer-active"
          ;;
        "$service") rm -f "$FAKE_SYSTEMD_STATE/service-active" ;;
        *) exit 2 ;;
      esac
    done
    ;;
  stop)
    for unit in "$@"; do
      case "$unit" in
        "$timer") rm -f "$FAKE_SYSTEMD_STATE/timer-active" ;;
        "$service") rm -f "$FAKE_SYSTEMD_STATE/service-active" ;;
        *) exit 2 ;;
      esac
    done
    ;;
  is-enabled)
    case "$1" in
      "$timer")
        if [[ -L "$wants" ]]; then
          printf 'enabled\n'
        else
          printf 'disabled\n'
          exit 1
        fi
        ;;
      "$service") printf 'static\n' ;;
      *) exit 2 ;;
    esac
    ;;
  is-active)
    quiet=false
    if [[ "$1" == --quiet ]]; then quiet=true; shift; fi
    if [[ "$1" == "$webhook" ]]; then
      [[ ! -e "$FAKE_SYSTEMD_STATE/webhook-query-error" ]] || exit 1
      if [[ -e "$FAKE_SYSTEMD_STATE/webhook-active" ]]; then
        $quiet || printf 'active\n'
      else
        $quiet || printf 'inactive\n'
        exit 3
      fi
    elif [[ "$1" == "$timer" ]]; then
      if [[ -e "$FAKE_SYSTEMD_STATE/timer-active" ]]; then
        $quiet || printf 'active\n'
      else
        $quiet || printf 'inactive\n'
        exit 3
      fi
    elif [[ "$1" == "$service" ]]; then
      if [[ -e "$FAKE_SYSTEMD_STATE/service-active" ]]; then
        $quiet || printf 'active\n'
      else
        $quiet || printf 'inactive\n'
        exit 3
      fi
    else
      exit 2
    fi
    ;;
  show)
    unit=$1
    shift
    property=''
    while (($#)); do
      case "$1" in
        --property=*) property=${1#--property=} ;;
        -p) shift; property=$1 ;;
      esac
      shift
    done
    property_value "$unit" "$property"
    ;;
  *) exit 2 ;;
esac
SH
chmod 0700 "$fake_bin/loginctl" "$fake_bin/cat" "$fake_bin/systemctl"

boot_one=11111111-1111-4111-8111-111111111111
boot_two=22222222-2222-4222-8222-222222222222
printf 'no\n' >"$fake_state/linger"
printf '%s\n' "$boot_one" >"$fake_state/boot-id"

run_manager() {
  env HOME="$home" XDG_CONFIG_HOME="$home/.config" \
    FAKE_SYSTEMD_STATE="$fake_state" PATH="$fake_bin:/usr/bin:/bin" \
    bash "$profile/manage-actions-poller.sh" "$@"
}

if run_manager activate >/dev/null 2>&1; then
  printf 'activation unexpectedly ignored missing linger\n' >&2
  exit 1
fi
[[ ! -e "$home/.config/systemd/user/timers.target.wants/plane-game-actions-poller.timer" ]]

printf 'yes\n' >"$fake_state/linger"
touch "$fake_state/webhook-query-error"
if run_manager activate >/dev/null 2>&1; then
  printf 'activation unexpectedly ignored an unverifiable webhook state\n' >&2
  exit 1
fi
rm "$fake_state/webhook-query-error"
touch "$fake_state/webhook-active"
if run_manager activate >/dev/null 2>&1; then
  printf 'activation unexpectedly allowed simultaneous webhook mode\n' >&2
  exit 1
fi
rm "$fake_state/webhook-active"

run_manager activate >/dev/null
test -L "$home/.config/systemd/user/timers.target.wants/plane-game-actions-poller.timer"
grep -Fxq 'Environment=CD_TRIGGER_MODE=disabled' \
  "$home/.config/systemd/user/plane-game-actions-poller.service"
grep -Fxq 'Environment=CD_TRIGGER_MODE=poller' \
  "$home/.config/systemd/user/plane-game-actions-poller.service.d/10-trigger-mode.conf"

run_manager prepare-restart >/dev/null
grep -Fxq "before_boot_id=$boot_one" "$state_dir/activation-restart-proof"
if run_manager verify-restart >/dev/null 2>&1; then
  printf 'restart verification unexpectedly accepted the same boot ID\n' >&2
  exit 1
fi

printf '%s\n' "$boot_two" >"$fake_state/boot-id"
if run_manager verify-restart >/dev/null 2>&1; then
  printf 'restart verification unexpectedly accepted a timer that had not fired\n' >&2
  exit 1
fi
printf '%s\n' "$boot_two" >"$fake_state/triggered-boot"
run_manager verify-restart >/dev/null
grep -Fxq "after_boot_id=$boot_two" "$state_dir/activation-restart-proof"
grep -Fxq 'timer_enabled=enabled' "$state_dir/activation-restart-proof"
grep -Fxq 'service_result=success' "$state_dir/activation-restart-proof"

# A normal deactivation stops an in-flight service, removes the poller selector,
# disables the persistent timer, and is safe to repeat.
touch "$fake_state/service-active"
run_manager deactivate >/dev/null
test ! -e "$home/.config/systemd/user/timers.target.wants/plane-game-actions-poller.timer"
test ! -e "$home/.config/systemd/user/plane-game-actions-poller.service.d/10-trigger-mode.conf"
test ! -e "$fake_state/timer-active"
test ! -e "$fake_state/service-active"
grep -Fxq "before_boot_id=$boot_two" "$state_dir/deactivation-restart-proof"
grep -Fxq 'selector=disabled' "$state_dir/deactivation-restart-proof"
run_manager deactivate >/dev/null
if run_manager verify-disabled-restart >/dev/null 2>&1; then
  printf 'disabled restart verification unexpectedly accepted the same boot ID\n' >&2
  exit 1
fi

boot_three=33333333-3333-4333-8333-333333333333
printf '%s\n' "$boot_three" >"$fake_state/boot-id"
run_manager verify-disabled-restart >/dev/null
grep -Fxq "after_boot_id=$boot_three" "$state_dir/deactivation-restart-proof"
grep -Fxq 'timer_enabled=disabled' "$state_dir/deactivation-restart-proof"
grep -Fxq 'service_active=inactive' "$state_dir/deactivation-restart-proof"

# A partial activation may leave only a mode drop-in, dangling timer enablement,
# and active-state evidence. Deactivation restores the reviewed disabled units
# without depending on the activation ledger or credential files.
rm -rf "$state_dir"
rm -f "$home/.config/systemd/user/plane-game-actions-poller.service" \
  "$home/.config/systemd/user/plane-game-actions-poller.timer"
mkdir -p "$home/.config/systemd/user/plane-game-actions-poller.service.d" \
  "$home/.config/systemd/user/timers.target.wants"
cp "$profile/systemd-user-activation/plane-game-actions-poller.service.d/10-trigger-mode.conf" \
  "$home/.config/systemd/user/plane-game-actions-poller.service.d/10-trigger-mode.conf"
ln -sfn ../plane-game-actions-poller.timer \
  "$home/.config/systemd/user/timers.target.wants/plane-game-actions-poller.timer"
touch "$fake_state/timer-active" "$fake_state/service-active"
run_manager deactivate >/dev/null
grep -Fxq 'Environment=CD_TRIGGER_MODE=disabled' \
  "$home/.config/systemd/user/plane-game-actions-poller.service"
test ! -e "$home/.config/systemd/user/plane-game-actions-poller.service.d/10-trigger-mode.conf"
test ! -e "$home/.config/systemd/user/timers.target.wants/plane-game-actions-poller.timer"

boot_four=44444444-4444-4444-8444-444444444444
printf '%s\n' "$boot_four" >"$fake_state/boot-id"
run_manager verify-disabled-restart >/dev/null
grep -Fxq "after_boot_id=$boot_four" "$state_dir/deactivation-restart-proof"

printf 'private poller persistent activation and deactivation test: PASS\n'
