#!/usr/bin/env bash
set -euo pipefail

profile_dir=${1:-/opt/plane-game-controller}
plugin_dir=${2:-/usr/share/jenkins/ref/plugins}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

sed -n 's/^[^#][^:]*:\([^:]*\):.*/\1/p' "$profile_dir/plugins.lock" >/dev/null
sed -n 's/^\([^#][^:]*\):.*/\1/p' "$profile_dir/plugins.lock" | sort >"$work/expected"
find "$plugin_dir" -maxdepth 1 -type f \( -name '*.jpi' -o -name '*.hpi' \) \
  -printf '%f\n' | sed -E 's/[.](jpi|hpi)$//' | sort >"$work/actual"
diff -u "$work/expected" "$work/actual"
(
  cd /usr/share/jenkins/ref
  sha256sum -c "$profile_dir/plugins.sha256"
)
