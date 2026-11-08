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

for command in curl jq mktemp awk grep wc; do
  command -v "$command" >/dev/null || fail "$command is required"
done

readonly HEADER_MAX_BYTES=1048576
readonly TOKEN_BODY_MAX_BYTES=65536
readonly MANIFEST_BODY_MAX_BYTES=1048576
# Bash expresses RLIMIT_FSIZE in KiB. This limits each regular file curl can
# write, including --dump-header, while the request is still in progress.
readonly CURL_FILE_LIMIT_KIB=1024

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
umask 077

request() {
  local body=$1 headers=$2 body_max_bytes=$3
  shift 3
  local status header_bytes body_bytes
  status=$(
    ulimit -f "$CURL_FILE_LIMIT_KIB" || exit 125
    exec curl --silent --show-error --retry 0 --connect-timeout 10 --max-time 30 \
      --max-filesize "$body_max_bytes" \
      --dump-header "$headers" --output "$body" --write-out '%{http_code}' "$@"
  ) || fail 'registry response exceeded a size limit or was unavailable or timed out'
  [[ -f "$headers" && ! -L "$headers" && -f "$body" && ! -L "$body" ]] ||
    fail 'registry response files are unsafe'
  header_bytes=$(wc -c < "$headers") || fail 'registry response headers could not be measured'
  body_bytes=$(wc -c < "$body") || fail 'registry response body could not be measured'
  ((header_bytes < HEADER_MAX_BYTES)) || fail 'registry response headers reached the size limit'
  ((body_bytes < body_max_bytes)) || fail 'registry response body reached the size limit'
  [[ "$status" =~ ^2[0-9][0-9]$ ]] || fail "registry returned HTTP $status"
  if grep -Eiq '^(x-)?ratelimit-remaining:[[:space:]]*0([;[:space:]]|$)' "$headers"; then
    fail 'registry rate limit is exhausted'
  fi
}

scope='repository:beginning-new/planegamecode:pull'
request "$work/token.json" "$work/token.headers" "$TOKEN_BODY_MAX_BYTES" \
  "https://ghcr.io/token?scope=$scope"
token=$(jq -er '.token | select(type == "string" and length >= 16 and length <= 8192 and test("^[A-Za-z0-9._~+/-]+={0,2}$"))' "$work/token.json") ||
  fail 'registry token response is malformed'

printf 'header = "Authorization: Bearer %s"\n' "$token" > "$work/auth.config"
request "$work/manifest.json" "$work/manifest.headers" "$MANIFEST_BODY_MAX_BYTES" \
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
