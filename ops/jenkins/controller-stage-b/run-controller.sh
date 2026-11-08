#!/usr/bin/env bash
set -euo pipefail

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'stage-b controller refused: %s\n' "$*" >&2
  exit 1
}

validate_jenkins_acl() {
  local path=$1 name=$2 owner_access=$3 mapped_access=$4 actual expected
  actual=$(getfacl -n -c -- "$path" 2>/dev/null) || fail "cannot inspect approved ACL: $name"
  expected=$(printf 'user::%s\nuser:%s:%s\ngroup::---\nmask::%s\nother::---\n' \
    "$owner_access" "$JENKINS_MAPPED_HOST_UID" "$mapped_access" "$mapped_access")
  [[ "$actual" == "$expected" ]] || fail "approved ACL grants another principal or lacks Jenkins mapping: $name"
}

validate_secret_file() {
  local path=$1 name=$2 mode owner size
  [[ -f "$path" && ! -L "$path" ]] || fail "approved secret must be one regular non-symlink file: $name"
  owner=$(stat -c '%u' -- "$path")
  mode=$(stat -c '%a' -- "$path")
  size=$(stat -c '%s' -- "$path")
  [[ "$owner" == "$PLANE_PREFLIGHT_UID" ]] || fail "approved secret owner must be UID $PLANE_PREFLIGHT_UID: $name"
  [[ "$mode" =~ ^(440|640)$ ]] || fail "approved secret mode must be 0440/0640 with a narrow Jenkins ACL: $name"
  if [[ "$mode" == 440 ]]; then
    validate_jenkins_acl "$path" "$name" 'r--' 'r--'
  else
    validate_jenkins_acl "$path" "$name" 'rw-' 'r--'
  fi
  (( size > 0 && size <= 16384 )) || fail "approved secret is empty or oversized: $name"
}

validate_single_line() {
  local path=$1 name=$2 value
  value=$(<"$path")
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    fail "approved secret must contain one non-empty line: $name"
}

ensure_trigger_selector() {
  local path=$1 temporary
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    temporary=$(mktemp "$(dirname -- "$path")/.cd-trigger-mode.XXXXXX")
    printf 'disabled\n' >"$temporary"
    chmod 0640 "$temporary"
    setfacl --remove-all "$temporary"
    setfacl -m "u:$JENKINS_MAPPED_HOST_UID:r--,m::r--,g::---,o::---" "$temporary"
    sync -f "$temporary"
    mv -f -- "$temporary" "$path"
    sync -f "$(dirname -- "$path")"
  fi
  validate_secret_file "$path" cd-trigger-mode
  validate_single_line "$path" cd-trigger-mode
  grep -Eq '^(disabled|poller|webhook)$' "$path" || fail 'trigger selector value is invalid'
}

image_id_file=${1:?usage: run-controller.sh IMAGE_ID_FILE APPROVED_DIR}
approved_dir_input=${2:?usage: run-controller.sh IMAGE_ID_FILE APPROVED_DIR}
[[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" ]] || fail 'must run as UID 1003'
[[ "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] || fail 'must run as plane-preflight'
[[ "${DOCKER_HOST:-}" == "$ROOTLESS_DOCKER_HOST" ]] || fail 'rootless DOCKER_HOST mismatch'
mapfile -t daemon_pids < <(pgrep -u "$PLANE_PREFLIGHT_UID" -x dockerd || true)
[[ "${#daemon_pids[@]}" == 1 ]] || fail 'exactly one UID-1003 rootless Docker daemon is required'
mapped_uid=$(awk -v target=1000 '$1 <= target && target < $1 + $3 { print $2 + target - $1 }' \
  "/proc/${daemon_pids[0]}/uid_map")
[[ "$mapped_uid" == "$JENKINS_MAPPED_HOST_UID" ]] || fail 'rootless Jenkins host UID mapping changed'
[[ -d "$approved_dir_input" && ! -L "$approved_dir_input" ]] || fail 'approved directory must be a real directory'
approved_dir=$(cd -- "$approved_dir_input" && pwd -P)
[[ "$(stat -c '%u' -- "$approved_dir")" == "$PLANE_PREFLIGHT_UID" ]] || fail 'approved directory owner must be UID 1003'
[[ "$(stat -c '%a' -- "$approved_dir")" == 750 ]] || fail 'approved directory mode must be 0750 with a narrow Jenkins ACL'
validate_jenkins_acl "$approved_dir" approved-directory 'rwx' 'r-x'
ensure_trigger_selector "$approved_dir/cd-trigger-mode"

secret_names=(
  agent-host
  agent-host-key
  agent-private-key
  cd-trigger-mode
)
secret_destinations=(
  /run/secrets/PLANE_AGENT_HOST
  /run/secrets/PLANE_AGENT_ED25519_HOST_KEY
  /run/secrets/PLANE_AGENT_PRIVATE_KEY
  /run/secrets/PLANE_CD_TRIGGER_MODE
)
mount_args=()
for index in "${!secret_names[@]}"; do
  name=${secret_names[$index]}
  source_path=$approved_dir/$name
  destination=${secret_destinations[$index]}
  validate_secret_file "$source_path" "$name"
  mount_args+=(--mount "type=bind,src=$source_path,dst=$destination,readonly")
done
for single_line_name in agent-host agent-host-key; do
  validate_single_line "$approved_dir/$single_line_name" "$single_line_name"
done

bootstrap_source=$approved_dir/admin-bootstrap-bcrypt
if [[ -e "$bootstrap_source" || -L "$bootstrap_source" ]]; then
  validate_secret_file "$bootstrap_source" admin-bootstrap-bcrypt
  validate_single_line "$bootstrap_source" admin-bootstrap-bcrypt
  grep -Eq '^#jbcrypt:\$2a\$(0[4-9]|1[0-8])\$[./A-Za-z0-9]{53}$' "$bootstrap_source" ||
    fail 'admin bootstrap must be one Jenkins #jbcrypt hash'
  secret_destinations+=(/run/secrets/PLANE_ADMIN_BOOTSTRAP_BCRYPT)
  mount_args+=(--mount "type=bind,src=$bootstrap_source,dst=/run/secrets/PLANE_ADMIN_BOOTSTRAP_BCRYPT,readonly")
fi

grep -Eq '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^[:space:]]+)?$' "$approved_dir/agent-host-key" ||
  fail 'approved host key must be fixed Ed25519'
image_id=$(tr -d '\r\n' <"$image_id_file")
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'image ID must be immutable sha256'

home_volume=$JENKINS_HOME_VOLUME
if [[ -s "$approved_dir/active-home-volume" ]]; then
  home_volume=$(tr -d '\r\n' <"$approved_dir/active-home-volume")
fi
[[ "$home_volume" =~ ^plane-game-jenkins-stage-b-home(-restore-[0-9]{8}T[0-9]{6}Z)?$ ]] ||
  fail 'home volume is outside the Stage B namespace'
if docker container inspect "$JENKINS_CONTAINER" >/dev/null 2>&1; then
  [[ "$(docker inspect --format '{{.State.Running}}' "$JENKINS_CONTAINER")" == false ]] ||
    fail 'controller container is already running'
  [[ "$(docker inspect --format '{{ index .Config.Labels "io.paperclip.plane-game.stage" }}' "$JENKINS_CONTAINER")" == controller-b ]] ||
    fail 'existing stopped container is outside the Stage B label boundary'
  docker rm "$JENKINS_CONTAINER" >/dev/null
fi
docker volume inspect "$home_volume" >/dev/null 2>&1 ||
  docker volume create --label io.paperclip.plane-game.stage=controller-b "$home_volume" >/dev/null

# Prove that the exact image user can read every bind-mounted file. Do not chmod,
# copy, echo, or otherwise weaken/expose the host files when this preflight fails.
docker run --rm \
  --network none \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --entrypoint /bin/sh \
  "${mount_args[@]}" \
  "$image_id" -eu -c 'for secret in "$@"; do test -r "$secret" && test -s "$secret"; done' \
  stage-b-secret-preflight "${secret_destinations[@]}" >/dev/null ||
  fail 'rootless Jenkins image user cannot read every approved secret; fix the specific host ACL mapping'

docker run --detach \
  --name "$JENKINS_CONTAINER" \
  --label io.paperclip.plane-game.stage=controller-b \
  --publish "$JENKINS_HOST_IP:$JENKINS_HOST_PORT:$JENKINS_CONTAINER_PORT" \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --restart no \
  --memory "$JENKINS_MEMORY" \
  --memory-reservation "$JENKINS_MEMORY_RESERVATION" \
  --memory-swap "$JENKINS_MEMORY_SWAP" \
  --cpus "$JENKINS_CPU_CORES" \
  --pids-limit "$JENKINS_PIDS_LIMIT" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --volume "$home_volume:/var/jenkins_home" \
  "${mount_args[@]}" \
  "$image_id"
