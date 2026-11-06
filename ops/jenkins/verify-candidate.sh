#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 3 ]] || { echo 'Usage: verify-candidate.sh SHA RUN_ID RUN_ATTEMPT' >&2; exit 1; }
sha=$1
run_id=$2
run_attempt=$3
repository=${GITHUB_REPOSITORY:-}
token=${GH_API_TOKEN:-}

[[ "$repository" == Beginning-NEW/PlaneGameCode ]] || { echo 'Unexpected repository identity' >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[1-9][0-9]*$ && "$run_attempt" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ -n "$token" ]] || { echo 'GitHub Actions read credential is required' >&2; exit 1; }
for command in curl jq unzip mktemp; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

api="https://api.github.com/repos/$repository"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
auth=(-H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')

curl -fsS "${auth[@]}" "$api/actions/runs/$run_id" > "$work/run.json"
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

curl -fsS "${auth[@]}" "$api/actions/runs/$run_id/artifacts?per_page=100" > "$work/artifacts.json"
artifact_name="release-candidate-$sha"
artifact_count=$(jq --arg name "$artifact_name" '[.artifacts[] | select(.name == $name and .expired == false)] | length' "$work/artifacts.json")
[[ "$artifact_count" == 1 ]] || { echo 'Expected exactly one unexpired release candidate artifact' >&2; exit 1; }
artifact_id=$(jq -r --arg name "$artifact_name" '.artifacts[] | select(.name == $name and .expired == false) | .id' "$work/artifacts.json")
[[ "$artifact_id" =~ ^[1-9][0-9]*$ ]] || exit 1
curl -fsSL "${auth[@]}" "$api/actions/artifacts/$artifact_id/zip" -o "$work/candidate.zip"
[[ "$(unzip -Z1 "$work/candidate.zip")" == release-candidate.json ]] || { echo 'Unexpected candidate artifact contents' >&2; exit 1; }
unzip -qq "$work/candidate.zip" -d "$work/candidate"

expected_image="ghcr.io/${repository,,}"
jq -e \
  --arg repository "$repository" \
  --arg sha "$sha" \
  --arg run_id "$run_id" \
  --arg run_attempt "$run_attempt" \
  --arg run_number "$api_run_number" \
  --arg image "$expected_image" '
    .schema == 1 and
    .repository == $repository and
    .ref == "refs/heads/main" and
    .sha == $sha and
    .workflow == "Checks" and
    .workflow_path == ".github/workflows/checks.yml" and
    (.run_id | tostring) == $run_id and
    (.run_attempt | tostring) == $run_attempt and
    (.run_number | tostring) == $run_number and
    .image_repository == $image and
    (.image_digest | test("^sha256:[0-9a-f]{64}$")) and
    (.gateway_image | test("^nginxinc/nginx-unprivileged@sha256:[0-9a-f]{64}$"))
  ' "$work/candidate/release-candidate.json" >/dev/null

curl -fsS "${auth[@]}" "$api/git/ref/heads/main" > "$work/main.json"
[[ "$(jq -r .object.sha "$work/main.json")" == "$sha" ]] || { echo 'Protected main moved; stale candidate rejected' >&2; exit 1; }

image_digest=$(jq -r .image_digest "$work/candidate/release-candidate.json")
gateway_image=$(jq -r .gateway_image "$work/candidate/release-candidate.json")
printf '%s\t%s\t%s\t%s\n' "$image_digest" "$gateway_image" "$api_run_number" "$run_attempt"
