#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() { printf 'poller token operation refused: %s\n' "$*" >&2; exit 1; }

[[ $# -ge 1 && $# -le 2 ]] ||
  fail 'usage: create-poller-token.sh create|rotate|prune|revoke [TOKEN_FILE]'
operation=$1
token_file=${2:-"$HOME/.local/state/plane-game-poller/jenkins-api-token"}
jenkins_url=http://127.0.0.1:18080
poller_user=plane-actions-poller
admin_user=plane-admin

loopback_curl() {
  curl --proxy '' --noproxy 127.0.0.1 --proto '=http' --max-redirs 0 "$@"
}

[[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" && "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] ||
  fail "must run as $PLANE_PREFLIGHT_USER UID $PLANE_PREFLIGHT_UID"
[[ -f "$token_file" && ! -L "$token_file" ]] ||
  fail 'token target must already exist as a regular non-symlink file'
[[ "$(stat -c '%u %a %h' -- "$token_file")" == "$PLANE_PREFLIGHT_UID 600 1" ]] ||
  fail "token target owner/mode/link-count must be $PLANE_PREFLIGHT_UID/0600/1"
token_dir=$(dirname -- "$token_file")
[[ -d "$token_dir" && ! -L "$token_dir" ]] || fail 'token directory must be a real directory'
[[ "$(stat -c '%u %a' -- "$token_dir")" == "$PLANE_PREFLIGHT_UID 700" ]] ||
  fail "token directory owner/mode must be $PLANE_PREFLIGHT_UID/0700"

lock_file=$token_file.lock
[[ ! -L "$lock_file" ]] || fail 'token lock must not be a symlink'
if [[ -e "$lock_file" ]]; then
  [[ -f "$lock_file" && "$(stat -c '%u %a %h' -- "$lock_file")" == "$PLANE_PREFLIGHT_UID 600 1" ]] ||
    fail 'token lock owner, mode, or link count is invalid'
fi
exec 9>"$lock_file"
chmod 600 "$lock_file"
flock -x 9

runtime_base=${XDG_RUNTIME_DIR:-/run/user/$PLANE_PREFLIGHT_UID}
[[ -d "$runtime_base" && -w "$runtime_base" && ! -L "$runtime_base" ]] ||
  fail 'private runtime directory is unavailable'
scratch=$(mktemp -d "$runtime_base/plane-game-poller-token.XXXXXX")
cleanup() {
  find "$scratch" -mindepth 1 -maxdepth 1 -type f -delete
  rmdir -- "$scratch"
}
trap cleanup EXIT

json_field() {
  local field=$1
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(input);
        let value = parsed;
        for (const part of process.argv[1].split(".")) value = value?.[part];
        if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) process.exit(2);
        process.stdout.write(value);
      } catch { process.exit(2); }
    });
  ' "$field"
}

write_current_token() {
  local token=$1 uuid=$2 token_tmp
  [[ "$uuid" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] ||
    fail 'Jenkins returned an invalid token UUID'
  [[ "$token" =~ ^[0-9A-Za-z]{16,256}$ ]] || fail 'Jenkins returned an invalid token value'
  token_tmp=$(mktemp "$token_dir/.jenkins-poller-api-token.XXXXXX")
  chmod 600 "$token_tmp"
  printf '{"version":1,"username":"%s","token":"%s","uuid":"%s"}\n' \
    "$poller_user" "$token" "$uuid" >"$token_tmp"
  sync -f "$token_tmp"
  mv -f -- "$token_tmp" "$token_file"
  sync -f "$token_dir"
}

write_netrc() {
  local token=$1
  printf 'machine 127.0.0.1 login %s password %s\n' "$poller_user" "$token" >"$scratch/auth.netrc"
  chmod 600 "$scratch/auth.netrc"
}

poller_post() {
  local endpoint=$1
  shift
  loopback_curl --fail --silent --show-error \
    --netrc --netrc-file "$scratch/auth.netrc" \
    --request POST "$jenkins_url$endpoint" "$@"
}

create_token() {
  [[ ! -s "$token_file" ]] || fail 'create requires the existing token target to be empty'
  printf 'Jenkins will prompt twice for the plane-admin bootstrap password; input is not stored.\n' >&2
  crumb_json=$(loopback_curl --fail --silent --show-error \
    --cookie-jar "$scratch/cookies" --user "$admin_user" \
    "$jenkins_url/crumbIssuer/api/json")
  crumb_field=$(printf '%s' "$crumb_json" | json_field crumbRequestField)
  crumb_value=$(printf '%s' "$crumb_json" | json_field crumb)
  printf 'header = "%s: %s"\n' "$crumb_field" "$crumb_value" >"$scratch/crumb.conf"
  chmod 600 "$scratch/crumb.conf"
  response=$(loopback_curl --fail --silent --show-error \
    --cookie "$scratch/cookies" --user "$admin_user" --config "$scratch/crumb.conf" \
    --request POST --data-urlencode 'newTokenName=plane-game-actions-poller-host' \
    "$jenkins_url/user/$poller_user/descriptorByName/jenkins.security.ApiTokenProperty/generateNewToken")
  token=$(printf '%s' "$response" | json_field data.tokenValue)
  uuid=$(printf '%s' "$response" | json_field data.tokenUuid)
  write_current_token "$token" "$uuid"
  unset token response crumb_value
  printf 'poller token created in the existing host-only target\n'
}

load_current() {
  [[ -s "$token_file" ]] || fail 'current poller token file is empty'
  node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
    try {
      const value = JSON.parse(s);
      if (value.version !== 1 || value.username !== "plane-actions-poller" ||
          Object.keys(value).sort().join(",") !== "token,username,uuid,version") process.exit(2);
    } catch { process.exit(2); }
  });' <"$token_file" || fail 'current token document is invalid'
  current_token=$(json_field token <"$token_file")
  current_uuid=$(json_field uuid <"$token_file")
  [[ "$current_token" =~ ^[0-9A-Za-z]{16,256}$ ]] || fail 'current token value is invalid'
  [[ "$current_uuid" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] ||
    fail 'current token UUID metadata is invalid'
  write_netrc "$current_token"
}

rotate_token() {
  load_current
  response=$(poller_post "/user/$poller_user/descriptorByName/jenkins.security.ApiTokenProperty/generateNewToken" \
    --data-urlencode 'newTokenName=plane-game-actions-poller-host')
  new_token=$(printf '%s' "$response" | json_field data.tokenValue)
  new_uuid=$(printf '%s' "$response" | json_field data.tokenUuid)
  write_current_token "$new_token" "$new_uuid"
  write_netrc "$new_token"
  unset current_token new_token response
  poller_post "/user/$poller_user/descriptorByName/jenkins.security.ApiTokenProperty/revokeAllExcept" \
    --data-urlencode "tokenUuid=$new_uuid" >/dev/null ||
    fail 'new token is installed but old tokens remain; run prune after checking controller health'
  printf 'poller token rotated and all prior tokens revoked\n'
}

prune_tokens() {
  load_current
  poller_post "/user/$poller_user/descriptorByName/jenkins.security.ApiTokenProperty/revokeAllExcept" \
    --data-urlencode "tokenUuid=$current_uuid" >/dev/null
  unset current_token
  printf 'all poller tokens except the host-only current token were revoked\n'
}

revoke_tokens() {
  load_current
  poller_post "/user/$poller_user/descriptorByName/jenkins.security.ApiTokenProperty/revokeAll" >/dev/null
  unset current_token
  empty_tmp=$(mktemp "$token_dir/.jenkins-poller-api-token.XXXXXX")
  chmod 600 "$empty_tmp"
  sync -f "$empty_tmp"
  mv -f -- "$empty_tmp" "$token_file"
  sync -f "$token_dir"
  printf 'all poller tokens were revoked and the host-only token target was emptied\n'
}

case "$operation" in
  create) create_token ;;
  rotate) rotate_token ;;
  prune) prune_tokens ;;
  revoke) revoke_tokens ;;
  *) fail 'operation must be create, rotate, prune, or revoke' ;;
esac
