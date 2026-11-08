#!/usr/bin/env bash
set -euo pipefail

[[ -r /var/jenkins_home/.stage-b-ready ]]
grep -qx 'stage-b-ready-v2' /var/jenkins_home/.stage-b-ready
login_code=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/login)
api_code=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/api/json)
[[ "$login_code" == 200 && "$api_code" == 403 ]]
