#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 6 ]] || {
  echo 'Usage: pre-promote-check.sh SHA RUN_ID RUN_ATTEMPT DIGEST GATEWAY_IMAGE RUN_NUMBER' >&2
  exit 1
}
sha=$1
run_id=$2
run_attempt=$3
digest=$4
gateway_image=$5
run_number=$6
script_dir=$(cd "$(dirname "$0")" && pwd)

[[ "$sha" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ "$run_attempt" =~ ^[1-9][0-9]*$ && "$run_number" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$gateway_image" =~ ^nginxinc/nginx-unprivileged@sha256:[0-9a-f]{64}$ ]] || exit 1

verified=$(bash "$script_dir/verify-candidate.sh" "$sha" "$run_id" "$run_attempt")
expected=$(printf '%s\t%s\t%s\t%s' "$digest" "$gateway_image" "$run_number" "$run_attempt")
[[ "$verified" == "$expected" ]] || {
  echo 'Trusted Actions handoff changed after image pull' >&2
  exit 1
}
git fetch --no-tags origin refs/heads/main
[[ "$(git rev-parse FETCH_HEAD)" == "$sha" ]] || {
  echo 'SCM main moved after image pull; stale candidate rejected' >&2
  exit 1
}
printf 'pre-promote trust revalidation passed: sha=%s run=%s attempt=%s\n' "$sha" "$run_number" "$run_attempt"
