#!/usr/bin/env bash
set -euo pipefail

root=$(pwd -P)
scratch=$(mktemp -d)
cleanup() { rm -rf -- "$scratch"; }
trap cleanup EXIT

profile=$scratch/profile
state=$scratch/state
runtime=$scratch/runtime
fake_bin=$scratch/bin
fake_state=$scratch/fake-state
mkdir -p "$profile" "$state" "$runtime" "$fake_bin" "$fake_state"
chmod 0700 "$state" "$runtime"
cp "$root/ops/jenkins/controller-stage-b/create-poller-token.sh" "$profile/"
current_uid=$(id -u)
current_user=$(id -un)
printf 'PLANE_PREFLIGHT_UID=%s\nPLANE_PREFLIGHT_USER=%s\n' "$current_uid" "$current_user" >"$profile/runtime.env"
token_file=$state/jenkins-api-token
install -m 0600 /dev/null "$token_file"

cat >"$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >>"$FAKE_TOKEN_STATE/curl-argv"
args=$(printf '%s\n' "$@")
if grep -Fq '/crumbIssuer/api/json' <<<"$args"; then
  printf '{"crumbRequestField":"Jenkins-Crumb","crumb":"test-crumb"}\n'
elif grep -Fq '/generateNewToken' <<<"$args"; then
  if [[ -e "$FAKE_TOKEN_STATE/invalid-token" ]]; then
    printf '{"data":{"tokenValue":"short","tokenUuid":"bad"}}\n'
    exit 0
  fi
  count=0
  [[ ! -s "$FAKE_TOKEN_STATE/count" ]] || count=$(<"$FAKE_TOKEN_STATE/count")
  count=$((count + 1))
  printf '%s\n' "$count" >"$FAKE_TOKEN_STATE/count"
  if [[ "$count" == 1 ]]; then
    printf '{"data":{"tokenValue":"FIRSTTOKENVALUE1234","tokenUuid":"11111111-1111-4111-8111-111111111111"}}\n'
  else
    printf '{"data":{"tokenValue":"SECONDTOKENVALUE123","tokenUuid":"22222222-2222-4222-8222-222222222222"}}\n'
  fi
elif grep -Fq '/revokeAllExcept' <<<"$args" || grep -Fq '/revokeAll' <<<"$args"; then
  printf '{}\n'
else
  exit 2
fi
SH
chmod 0700 "$fake_bin/curl"

run_helper() {
  env HOME="$scratch/home" XDG_RUNTIME_DIR="$runtime" FAKE_TOKEN_STATE="$fake_state" \
    PATH="$fake_bin:/usr/bin:/bin" bash "$profile/create-poller-token.sh" "$1" "$token_file"
}

run_helper create >/dev/null
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.version !== 1 || value.username !== "plane-actions-poller" ||
      value.token !== "FIRSTTOKENVALUE1234" || value.uuid !== "11111111-1111-4111-8111-111111111111") process.exit(2);
' "$token_file"
if run_helper create >/dev/null 2>&1; then
  printf 'create unexpectedly replaced an existing token\n' >&2
  exit 1
fi

run_helper rotate >/dev/null
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.token !== "SECONDTOKENVALUE123" || value.uuid !== "22222222-2222-4222-8222-222222222222") process.exit(2);
' "$token_file"
run_helper prune >/dev/null
grep -Fq 'tokenUuid=22222222-2222-4222-8222-222222222222' "$fake_state/curl-argv"
if grep -Eq 'FIRSTTOKENVALUE1234|SECONDTOKENVALUE123' "$fake_state/curl-argv"; then
  printf 'token value leaked into curl argv\n' >&2
  exit 1
fi

run_helper revoke >/dev/null
test ! -s "$token_file"
touch "$fake_state/invalid-token"
if run_helper create >/dev/null 2>&1; then
  printf 'create unexpectedly accepted malformed Jenkins token metadata\n' >&2
  exit 1
fi
test ! -s "$token_file"

printf 'poller token lifecycle test: PASS\n'
