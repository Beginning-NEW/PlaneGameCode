#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'gateway token operation refused: %s\n' "$*" >&2
  exit 1
}

[[ $# -ge 1 && $# -le 2 ]] || fail 'usage: manage-gateway-token.sh create|rotate|prune|revoke [TOKEN_FILE]'
operation=$1
token_file=${2:-"$HOME/.config/plane-game/credentials/jenkins-api-token"}
jenkins_url=http://127.0.0.1:18080
gateway_user=plane-webhook-gateway
admin_user=plane-admin
loopback_curl() {
  curl --proxy '' --noproxy 127.0.0.1 --proto '=http' --max-redirs 0 "$@"
}

[[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" ]] || fail 'must run as UID 1003'
[[ "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] || fail 'must run as plane-preflight'
[[ -f "$token_file" && ! -L "$token_file" ]] || fail 'token target must already exist as a regular non-symlink file'
[[ "$(stat -c '%u' -- "$token_file")" == "$PLANE_PREFLIGHT_UID" ]] || fail 'token target owner must be UID 1003'
[[ "$(stat -c '%a' -- "$token_file")" == 600 ]] || fail 'token target mode must be 0600'
[[ "$(stat -c '%u' -- "$(dirname -- "$token_file")")" == "$PLANE_PREFLIGHT_UID" ]] || fail 'token directory owner must be UID 1003'
[[ "$(stat -c '%a' -- "$(dirname -- "$token_file")")" == 700 ]] || fail 'token directory mode must be 0700'
lock_file=$token_file.lock
[[ ! -L "$lock_file" ]] || fail 'token lock must not be a symlink'
if [[ -e "$lock_file" ]]; then
  [[ -f "$lock_file" && "$(stat -c '%u %a' -- "$lock_file")" == "$PLANE_PREFLIGHT_UID 600" ]] ||
    fail 'token lock owner or mode is invalid'
fi
exec 9>"$lock_file"
chmod 600 "$lock_file"
flock -x 9

runtime_base=${XDG_RUNTIME_DIR:-/run/user/$PLANE_PREFLIGHT_UID}
[[ -d "$runtime_base" && -w "$runtime_base" ]] || fail 'private runtime directory is unavailable'
scratch=$(mktemp -d "$runtime_base/plane-game-gateway-token.XXXXXX")
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
        const value = fieldPath(parsed, process.argv[1].split("."));
        if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) process.exit(2);
        process.stdout.write(value);
      } catch { process.exit(2); }
    });
    function fieldPath(value, parts) {
      for (const part of parts) value = value?.[part];
      return value;
    }
  ' "$field"
}

write_current_token() {
  local token=$1 uuid=$2 token_tmp
  [[ "$uuid" =~ ^[0-9a-fA-F-]{36}$ ]] || fail 'Jenkins returned an invalid token UUID'
  [[ "$token" =~ ^[0-9a-zA-Z]{16,256}$ ]] || fail 'Jenkins returned an invalid token value'
  token_tmp=$(mktemp "$(dirname -- "$token_file")/.jenkins-api-token.XXXXXX")
  chmod 600 "$token_tmp"
  printf '{"version":1,"token":"%s","uuid":"%s"}\n' "$token" "$uuid" >"$token_tmp"
  sync -f "$token_tmp"
  mv -f -- "$token_tmp" "$token_file"
  sync -f "$(dirname -- "$token_file")"
}

write_netrc() {
  local token=$1
  printf 'machine 127.0.0.1 login %s password %s\n' "$gateway_user" "$token" >"$scratch/auth.netrc"
  chmod 600 "$scratch/auth.netrc"
}

gateway_post() {
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
    --request POST --data-urlencode 'newTokenName=plane-game-webhook-gateway-host' \
    "$jenkins_url/user/$gateway_user/descriptorByName/jenkins.security.ApiTokenProperty/generateNewToken")
  token=$(printf '%s' "$response" | json_field data.tokenValue)
  uuid=$(printf '%s' "$response" | json_field data.tokenUuid)
  write_current_token "$token" "$uuid"
  unset token response crumb_value
  printf 'gateway token created in the existing host-only target; remove no other credential files\n'
}

load_current() {
  [[ -s "$token_file" ]] || fail 'current gateway token file is empty'
  node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
    try {
      const value = JSON.parse(s);
      if (value.version !== 1 || Object.keys(value).sort().join(",") !== "token,uuid,version") process.exit(2);
    } catch { process.exit(2); }
  });' <"$token_file" || fail 'current token document is invalid'
  current_token=$(json_field token <"$token_file")
  current_uuid=$(json_field uuid <"$token_file")
  [[ "$current_token" =~ ^[0-9a-zA-Z]{16,256}$ ]] || fail 'current token file format is invalid'
  [[ "$current_uuid" =~ ^[0-9a-fA-F-]{36}$ ]] || fail 'current token UUID metadata is invalid'
  write_netrc "$current_token"
}

rotate_token() {
  load_current
  response=$(gateway_post "/user/$gateway_user/descriptorByName/jenkins.security.ApiTokenProperty/generateNewToken" \
    --data-urlencode 'newTokenName=plane-game-webhook-gateway-host')
  new_token=$(printf '%s' "$response" | json_field data.tokenValue)
  new_uuid=$(printf '%s' "$response" | json_field data.tokenUuid)
  write_current_token "$new_token" "$new_uuid"
  write_netrc "$new_token"
  unset current_token new_token response
  gateway_post "/user/$gateway_user/descriptorByName/jenkins.security.ApiTokenProperty/revokeAllExcept" \
    --data-urlencode "tokenUuid=$new_uuid" >/dev/null ||
    fail 'new token is installed but old tokens remain; run prune after checking controller health'
  printf 'gateway token rotated and all prior tokens revoked\n'
}

prune_tokens() {
  load_current
  gateway_post "/user/$gateway_user/descriptorByName/jenkins.security.ApiTokenProperty/revokeAllExcept" \
    --data-urlencode "tokenUuid=$current_uuid" >/dev/null
  unset current_token
  printf 'all gateway tokens except the host-only current token were revoked\n'
}

revoke_tokens() {
  load_current
  gateway_post "/user/$gateway_user/descriptorByName/jenkins.security.ApiTokenProperty/revokeAll" >/dev/null
  unset current_token
  empty_tmp=$(mktemp "$(dirname -- "$token_file")/.jenkins-api-token.XXXXXX")
  chmod 600 "$empty_tmp"
  sync -f "$empty_tmp"
  mv -f -- "$empty_tmp" "$token_file"
  sync -f "$(dirname -- "$token_file")"
  printf 'all gateway tokens were revoked and the host-only token target was emptied\n'
}

case "$operation" in
  create) create_token ;;
  rotate) rotate_token ;;
  prune) prune_tokens ;;
  revoke) revoke_tokens ;;
  *) fail 'operation must be create, rotate, prune, or revoke' ;;
esac
