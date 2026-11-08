#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 3 ]] || { echo 'Usage: verify-candidate.sh SHA RUN_ID RUN_ATTEMPT' >&2; exit 1; }
sha=$1
run_id=$2
run_attempt=$3
repository=${GITHUB_REPOSITORY:-}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

[[ "$repository" == Beginning-NEW/PlaneGameCode ]] || { echo 'Unexpected repository identity' >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[1-9][0-9]*$ && "$run_attempt" =~ ^[1-9][0-9]*$ ]] || exit 1
for command in curl jq mktemp grep; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

api="https://api.github.com/repos/$repository"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
public_get() {
  local url=$1 body=$2 headers=$3 status
  status=$(curl --silent --show-error --retry 0 --connect-timeout 10 --max-time 30 \
    --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$url") || {
    echo 'Public GitHub API unavailable or timed out' >&2
    return 1
  }
  [[ "$status" =~ ^2[0-9][0-9]$ ]] || {
    echo "Public GitHub API returned HTTP $status" >&2
    return 1
  }
  if grep -Eiq '^(x-)?ratelimit-remaining:[[:space:]]*0([;[:space:]]|$)' "$headers"; then
    echo 'Public GitHub API rate limit exhausted' >&2
    return 1
  fi
}

public_get "$api/actions/runs/$run_id/attempts/$run_attempt" "$work/run.json" "$work/run.headers"
jq -e \
  --arg repository "$repository" \
  --arg sha "$sha" \
  --arg run_id "$run_id" \
  --arg run_attempt "$run_attempt" '
    (.id | tostring) == $run_id and
    (.run_attempt | tostring) == $run_attempt and
    (.run_number | type == "number" and . > 0) and
    .name == "Checks" and
    .path == ".github/workflows/checks.yml" and
    .event == "push" and
    .head_branch == "main" and
    .head_sha == $sha and
    .status == "completed" and
    .conclusion == "success" and
    .repository.full_name == $repository and
    .head_repository.full_name == $repository
  ' "$work/run.json" >/dev/null
api_run_number=$(jq -r '.run_number' "$work/run.json")
[[ "$api_run_number" =~ ^[1-9][0-9]*$ && ${#api_run_number} -le 15 ]] || exit 1

public_get "$api/git/ref/heads/main" "$work/main.json" "$work/main.headers"
[[ "$(jq -r .object.sha "$work/main.json")" == "$sha" ]] || { echo 'Protected main moved; stale candidate rejected' >&2; exit 1; }

image_digest=$(bash "$script_dir/resolve-public-ghcr-digest.sh" "$repository" "$sha")
# shellcheck disable=SC1091
source "$script_dir/public-source-images.env"
gateway_image=${GATEWAY_IMAGE:-}
[[ "$gateway_image" =~ ^nginxinc/nginx-unprivileged@sha256:[0-9a-f]{64}$ ]] || {
  echo 'Reviewed gateway digest is invalid' >&2
  exit 1
}
printf '%s\t%s\t%s\t%s\n' "$image_digest" "$gateway_image" "$api_run_number" "$run_attempt"
