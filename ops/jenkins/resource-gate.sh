#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'resource-gate: %s\n' "$*" >&2; exit 1; }

[[ "$(id -un)" == plane-preflight && "$(id -u)" -ne 0 ]] || fail 'executor must run as the dedicated plane-preflight user'
for command in awk df docker curl jq python3 tar unzip; do
  command -v "$command" >/dev/null || fail "$command is required"
done

# YOU-43 admission floor: the 24-hour p5 must also meet this value before the job is enabled.
minimum_mem_kib=3670016
available_mem_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
[[ "$available_mem_kib" =~ ^[0-9]+$ && "$available_mem_kib" -ge "$minimum_mem_kib" ]] ||
  fail "MemAvailable ${available_mem_kib:-unknown} KiB is below the 3.5 GiB admission floor"

minimum_disk_kib=36700160
available_disk_kib=$(df -Pk "$HOME" | awk 'NR == 2 {print $4}')
[[ "$available_disk_kib" =~ ^[0-9]+$ && "$available_disk_kib" -ge "$minimum_disk_kib" ]] ||
  fail "free disk ${available_disk_kib:-unknown} KiB is below the 35 GiB admission floor"

cgroup_path=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
[[ "$cgroup_path" == /* && "$cgroup_path" != *..* ]] || fail 'unable to resolve the executor cgroup'
cgroup_root=/sys/fs/cgroup
memory_max=$(<"$cgroup_root$cgroup_path/memory.max")
[[ "$memory_max" =~ ^[0-9]+$ && "$memory_max" -le 402653184 ]] ||
  fail 'executor MemoryMax must be finite and no greater than 384 MiB'
read -r cpu_quota cpu_period < "$cgroup_root$cgroup_path/cpu.max"
[[ "$cpu_quota" =~ ^[0-9]+$ && "$cpu_period" =~ ^[1-9][0-9]*$ ]] ||
  fail 'executor CPUQuota must be finite'
(( cpu_quota * 100 <= cpu_period * 25 )) || fail 'executor CPUQuota must be no greater than 25%'

bash deploy/plane-preflight >/dev/null
printf 'resource-gate: passed mem_available_kib=%s disk_available_kib=%s memory_max=%s cpu_max=%s/%s\n' \
  "$available_mem_kib" "$available_disk_kib" "$memory_max" "$cpu_quota" "$cpu_period"
