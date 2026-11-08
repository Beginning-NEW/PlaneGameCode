#!/usr/bin/env bash

new_deployment_id() {
  local sha="$1"
  printf '%s-%s-%s\n' "${sha:0:12}" "$(date -u +%Y%m%dT%H%M%SZ)" "$$"
}

valid_deployment_id() {
  local deployment_id="${1:-}" expected_sha="${2:-}"
  local prefix timestamp pid normalized_timestamp

  [[ "$expected_sha" =~ ^[a-f0-9]{40}$ ]] || return 1
  [[ "$deployment_id" =~ ^([a-f0-9]{12})-([0-9]{8}T[0-9]{6}Z)-([1-9][0-9]*)$ ]] || return 1
  prefix="${BASH_REMATCH[1]}"
  timestamp="${BASH_REMATCH[2]}"
  pid="${BASH_REMATCH[3]}"

  [[ "$prefix" == "${expected_sha:0:12}" ]] || return 1
  normalized_timestamp=$(date -u -d \
    "${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2} UTC" \
    +%Y%m%dT%H%M%SZ 2>/dev/null) || return 1
  [[ "$normalized_timestamp" == "$timestamp" ]] || return 1
  [[ ${#pid} -le 7 ]] || return 1
  (( 10#$pid <= 4194304 ))
}
