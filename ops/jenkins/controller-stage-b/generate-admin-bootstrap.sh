#!/usr/bin/env bash
set -euo pipefail

profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$profile_dir/runtime.env"

fail() {
  printf 'stage-b bootstrap generation refused: %s\n' "$*" >&2
  exit 1
}

image_id_file=${1:?usage: generate-admin-bootstrap.sh IMAGE_ID_FILE APPROVED_DIR}
approved_dir_input=${2:?usage: generate-admin-bootstrap.sh IMAGE_ID_FILE APPROVED_DIR}
[[ -t 0 && -t 1 ]] || fail 'an interactive terminal is required'
[[ "$(id -u)" == "$PLANE_PREFLIGHT_UID" ]] || fail 'must run as UID 1003'
[[ "$(id -un)" == "$PLANE_PREFLIGHT_USER" ]] || fail 'must run as plane-preflight'
[[ "${DOCKER_HOST:-}" == "$ROOTLESS_DOCKER_HOST" ]] || fail 'rootless DOCKER_HOST mismatch'
[[ -f "$image_id_file" && ! -L "$image_id_file" ]] || fail 'image ID file must be a regular non-symlink file'
[[ -d "$approved_dir_input" && ! -L "$approved_dir_input" ]] || fail 'approved directory must be a real directory'
approved_dir=$(cd -- "$approved_dir_input" && pwd -P)
[[ "$(stat -c '%u' -- "$approved_dir")" == "$PLANE_PREFLIGHT_UID" ]] || fail 'approved directory owner must be UID 1003'
[[ "$(stat -c '%a' -- "$approved_dir")" =~ ^(700|750)$ ]] || fail 'approved directory mode must be 0700 or 0750'

target=$approved_dir/admin-bootstrap-bcrypt
[[ ! -e "$target" && ! -L "$target" ]] || fail 'remove the previously applied bootstrap file before generating a new hash'
image_id=$(tr -d '\r\n' < "$image_id_file")
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'image ID must be immutable sha256'
[[ "$(docker image inspect --format '{{ index .Config.Labels "io.paperclip.plane-game.profile" }}' "$image_id")" == jenkins-controller-stage-b ]] ||
  fail 'image ID is not the approved Stage B controller image'

docker run --rm --interactive --tty \
  --network none \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --mount "type=bind,src=$profile_dir/GenerateAdminBootstrap.java,dst=/tool/GenerateAdminBootstrap.java,readonly" \
  --mount "type=bind,src=$approved_dir,dst=/output" \
  --entrypoint /bin/sh \
  "$image_id" -eu -c '
    cd /tmp
    jar tf /usr/share/jenkins/jenkins.war |
      grep -E "^WEB-INF/lib/(jbcrypt|spring-security-crypto)-[^/]+[.]jar$" > bcrypt-jars
    test -s bcrypt-jars
    while IFS= read -r dependency; do jar xf /usr/share/jenkins/jenkins.war "$dependency"; done < bcrypt-jars
    classpath=$(find WEB-INF/lib -type f -name "*.jar" -print | paste -sd: -)
    test -n "$classpath"
    exec java --class-path "$classpath" /tool/GenerateAdminBootstrap.java /output/admin-bootstrap-bcrypt
  '

[[ -f "$target" && ! -L "$target" ]] || fail 'bootstrap generator did not create the expected regular file'
[[ "$(stat -c '%u' -- "$target")" == "$PLANE_PREFLIGHT_UID" ]] || fail 'generated bootstrap owner mismatch'
[[ "$(stat -c '%a' -- "$target")" == 600 ]] || fail 'generated bootstrap mode must be 0600'
grep -Eq '^#jbcrypt:\$2a\$(0[4-9]|1[0-8])\$[./A-Za-z0-9]{53}$' "$target" ||
  fail 'generated bootstrap is not one Jenkins-compatible bcrypt hash'
printf 'Stage B admin bootstrap hash created at %s (secret value not displayed).\n' "$target"
