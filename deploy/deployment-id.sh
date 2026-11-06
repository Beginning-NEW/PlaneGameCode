#!/usr/bin/env bash

new_deployment_id() {
  local sha="$1"
  printf '%s-%s-%s\n' "${sha:0:12}" "$(date -u +%Y%m%dT%H%M%SZ)" "$$"
}

valid_deployment_id() {
  [[ "$1" =~ ^[a-f0-9]{12}-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]]
}
