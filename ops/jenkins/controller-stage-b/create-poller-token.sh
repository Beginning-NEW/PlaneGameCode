#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

fail() { printf 'poller token creation refused: %s\n' "$*" >&2; exit 1; }

[[ $# -le 1 ]] || fail 'usage: create-poller-token.sh [TOKEN_FILE]'
token_file=${1:-"$HOME/.local/state/plane-game-poller/jenkins-api-token"}
jenkins_url=http://127.0.0.1:18080
poller_user=plane-actions-poller
admin_user=plane-admin
loopback_curl() {
  curl --proxy '' --noproxy 127.0.0.1 --proto '=http' --max-redirs 0 "$@"
}
[[ "$(id -u)" == 1003 && "$(id -un)" == plane-preflight ]] || fail 'must run as plane-preflight UID 1003'
[[ -f "$token_file" && ! -L "$token_file" && ! -s "$token_file" ]] || fail 'target must be one empty regular file'
[[ "$(stat -c '%u %a' -- "$token_file")" == '1003 600' ]] || fail 'target owner/mode must be 1003/0600'
[[ "$(stat -c '%u %a' -- "$(dirname -- "$token_file")")" == '1003 700' ]] || fail 'directory owner/mode must be 1003/0700'

runtime_base=${XDG_RUNTIME_DIR:-/run/user/1003}
scratch=$(mktemp -d "$runtime_base/plane-game-poller-token.XXXXXX")
cleanup() { find "$scratch" -mindepth 1 -maxdepth 1 -type f -delete; rmdir -- "$scratch"; }
trap cleanup EXIT

json_field() {
  node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{try{const v=JSON.parse(s);const p=process.argv[1].split(".");let x=v;for(const k of p)x=x?.[k];if(typeof x!=="string"||!/^[^\\r\\n]+$/.test(x))process.exit(2);process.stdout.write(x)}catch{process.exit(2)}})' "$1"
}

printf 'Jenkins will prompt twice for the plane-admin bootstrap password; input is not stored.\n' >&2
crumb_json=$(loopback_curl --fail --silent --show-error --cookie-jar "$scratch/cookies" --user "$admin_user" \
  "$jenkins_url/crumbIssuer/api/json")
crumb_field=$(printf '%s' "$crumb_json" | json_field crumbRequestField)
crumb_value=$(printf '%s' "$crumb_json" | json_field crumb)
printf 'header = "%s: %s"\n' "$crumb_field" "$crumb_value" >"$scratch/crumb.conf"
chmod 600 "$scratch/crumb.conf"
response=$(loopback_curl --fail --silent --show-error --cookie "$scratch/cookies" --user "$admin_user" \
  --config "$scratch/crumb.conf" --request POST --data-urlencode 'newTokenName=plane-game-actions-poller-host' \
  "$jenkins_url/user/$poller_user/descriptorByName/jenkins.security.ApiTokenProperty/generateNewToken")
token=$(printf '%s' "$response" | json_field data.tokenValue)
[[ "$token" =~ ^[0-9A-Za-z]{16,256}$ ]] || fail 'Jenkins returned an invalid token'
token_tmp=$(mktemp "$(dirname -- "$token_file")/.jenkins-poller-api-token.XXXXXX")
chmod 600 "$token_tmp"
printf '{"version":1,"username":"%s","token":"%s"}\n' "$poller_user" "$token" >"$token_tmp"
sync -f "$token_tmp"
mv -f -- "$token_tmp" "$token_file"
sync -f "$(dirname -- "$token_file")"
unset token response crumb_value
printf 'poller token created in the existing host-only target\n'
