#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || { echo 'Usage: check-release-order.sh RUN_NUMBER RUN_ATTEMPT' >&2; exit 1; }
run_number=$1
run_attempt=$2
runtime_dir=${PLANE_GAME_RUNTIME_DIR:?PLANE_GAME_RUNTIME_DIR is required}
[[ "$run_number" =~ ^[1-9][0-9]*$ && ${#run_number} -le 15 ]] || exit 1
[[ "$run_attempt" =~ ^[1-9][0-9]*$ && ${#run_attempt} -le 10 ]] || exit 1

last_number=0
last_attempt=0
[[ ! -f "$runtime_dir/last_run_number" ]] || last_number=$(<"$runtime_dir/last_run_number")
[[ ! -f "$runtime_dir/last_run_attempt" ]] || last_attempt=$(<"$runtime_dir/last_run_attempt")
[[ "$last_number" =~ ^[0-9]{1,15}$ && "$last_attempt" =~ ^[0-9]{1,10}$ ]] || {
  echo 'Invalid release order marker' >&2
  exit 1
}

if (( 10#$run_number < 10#$last_number )); then
  echo "Stale run number $run_number cannot supersede $last_number" >&2
  exit 1
fi
if (( 10#$run_number == 10#$last_number )); then
  echo "Run number $run_number is already deployed (recorded attempt $last_attempt); rerun attempt $run_attempt cannot supersede it" >&2
  exit 1
fi
