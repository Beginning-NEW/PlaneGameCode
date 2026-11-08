#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Public GHCR resolution failed: $*" >&2
  exit 1
}

[[ $# -eq 2 ]] || fail 'usage: resolve-public-ghcr-digest.sh REPOSITORY FULL_SHA_TAG'
repository=$1
tag=$2
[[ "$repository" == Beginning-NEW/PlaneGameCode ]] || fail 'unexpected repository identity'
[[ "$tag" =~ ^[0-9a-f]{40}$ ]] || fail 'tag must be one full candidate SHA'

for command in curl jq mktemp awk grep; do
  command -v "$command" >/dev/null || fail "$command is required"
done

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
umask 077

request() {
  local body=$1 headers=$2
  shift 2
  local status
  status=$(curl --silent --show-error --retry 0 --connect-timeout 10 --max-time 30 \
    --dump-header "$headers" --output "$body" --write-out '%{http_code}' "$@") ||
    fail 'registry request was unavailable or timed out'
  [[ "$status" =~ ^2[0-9][0-9]$ ]] || fail "registry returned HTTP $status"
  if grep -Eiq '^(x-)?ratelimit-remaining:[[:space:]]*0([;[:space:]]|$)' "$headers"; then
    fail 'registry rate limit is exhausted'
  fi
}

scope='repository:beginning-new/planegamecode:pull'
request "$work/token.json" "$work/token.headers" \
  "https://ghcr.io/token?scope=$scope"
token=$(jq -er '.token | select(type == "string" and length >= 16 and length <= 8192 and test("^[A-Za-z0-9._~+/-]+={0,2}$"))' "$work/token.json") ||
  fail 'registry token response is malformed'

printf 'header = "Authorization: Bearer %s"\n' "$token" > "$work/auth.config"
request "$work/manifest.json" "$work/manifest.headers" \
  --config "$work/auth.config" \
  --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/beginning-new/planegamecode/manifests/$tag"

jq -e '.schemaVersion == 2' "$work/manifest.json" >/dev/null || fail 'registry manifest is malformed'
mapfile -t digests < <(awk 'tolower($1) == "docker-content-digest:" {
  gsub("\r", "", $2); print $2
}' "$work/manifest.headers")
[[ ${#digests[@]} -eq 1 && "${digests[0]}" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail 'registry did not return one canonical sha256 digest'
printf '%s\n' "${digests[0]}"
