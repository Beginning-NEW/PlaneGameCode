# Jenkins CD operator notes

This directory implements the repository side of the main-only, same-host CD contract. See `RUNBOOK.md` for resource admission, credential ownership, setup, rollback, and evidence requirements.

## Webhook admission

GitHub must send only `workflow_run` events to the reviewed reverse-proxy route for `webhook-gateway.mjs`; it must not target Jenkins or Generic Webhook Trigger. The gateway verifies the raw-body HMAC before validating the UUID-shaped `X-GitHub-Delivery`, filters the exact completed/successful `Checks` push on `main`, and atomically reserves both delivery and `(run_id, run_attempt)` in a private SQLite database before reading the scoped Jenkins API token or calling a queue API.

Import `config/plane-game-job.groovy` only after review. Install `config/plane-game-webhook-gateway.service` as a template through the controller host's configuration process; do not install it directly from a checkout. Keep one gateway process under the included `flock`, keep `/var/lib/plane-game-webhook` mode `0700`, and provide the webhook secret and minimal Jenkins API token through systemd credentials. The `plane-webhook-gateway` Jenkins principal needs only Overall Read plus Item Read/Build for `plane-game/main-cd` and queue/build read needed for reconciliation. It must have no Configure/Administer, credential, agent, GHCR, Docker, or deployment-host access.

The repository's canonical controller endpoint is declared in `config/jenkins-loopback-contract.env`. The reviewed controller drop-in is `config/jenkins.service.d/plane-game-limits.conf`; install it as `/etc/systemd/system/jenkins.service.d/plane-game-limits.conf` only through the approved Operations change. Run `node ops/jenkins/check-loopback-contract.mjs` before staging either template. It must report `endpoint=http://127.0.0.1:18080`, `gateway=match`, `controller=match`, and `legacy_8080=absent`.

## Pre-enable loopback verification

After both reviewed templates have been staged and the loopback controller smoke is running, but before enabling the gateway, webhook, or CD job, Operations must run this exact read-only check on the controller host:

```bash
set -eu
env_value() {
  systemctl show "$1" --property=Environment --value |
    tr ' ' '\n' |
    sed -n "s/^$2=//p"
}

jenkins_host=$(env_value jenkins.service JENKINS_LISTEN_ADDRESS)
jenkins_port=$(env_value jenkins.service JENKINS_PORT)
gateway_url=$(env_value plane-game-webhook-gateway.service JENKINS_URL)
controller_url="http://${jenkins_host}:${jenkins_port}"

printf 'effective controller=%s\n' "$controller_url"
printf 'effective gateway=%s\n' "$gateway_url"
test "$controller_url" = 'http://127.0.0.1:18080'
test "$gateway_url" = "$controller_url"

listener_18080=$(ss -H -ltn 'sport = :18080')
listener_8080=$(ss -H -ltn 'sport = :8080')
printf 'listener 18080:\n%s\n' "$listener_18080"
printf 'listener 8080:\n%s\n' "$listener_8080"
test "$(printf '%s\n' "$listener_18080" | sed '/^$/d' | wc -l)" -eq 1
printf '%s\n' "$listener_18080" | awk '{print $4}' | grep -Fx '127.0.0.1:18080'
test -z "$listener_8080"
```

Expected evidence is two identical effective URLs, each exactly `http://127.0.0.1:18080`; one `LISTEN` row whose local address is exactly `127.0.0.1:18080`; and an empty `listener 8080` section. A missing/multiple `18080` listener, any `8080` listener, a non-loopback address, or any environment mismatch is an immediate STOP/NO-GO: keep the gateway and CD job disabled and use the approved controller rollback procedure. These commands do not enable, restart, or otherwise mutate either service.

A first valid delivery is reserved as `dispatching`, then durably moved to non-retryable `submitted` before the only permitted Jenkins POST. A valid same-origin numeric `201 Location` persists the queue item identity as `queued`; later signed replays only reconcile that identity through `running` and `completed`. An empty queue/build lookup is `submitted_unknown` or `queue_state_unknown`, never permission for another POST. Startup retries only a pre-submit `dispatching` row; legacy ambiguous rows migrate to `submitted`. Resolve a persistently unknown submission through operator investigation rather than deleting/resetting its row. A different delivery for the same `(run_id, run_attempt)` is acknowledged without a second queue call. Back up the SQLite database with the host state and retain the corresponding Jenkins queue/build history.

- `verify-candidate.sh` treats webhook parameters as untrusted and verifies the successful GitHub Actions `Checks` push run, repository/ref/SHA/run attempt, API/artifact-matching run number, unique candidate artifact, immutable digests, and current protected-main head.
- `webhook-admission.mjs` owns HMAC validation, exact event filtering, and the persistent `dispatching`/`submitted`/`queued`/`running`/`completed` state machine. `webhook-gateway.mjs` validates `Location`, owns queue/build reconciliation, and is the only component allowed to call `buildWithParameters`.
- `Jenkinsfile` accepts only the core Jenkins identity `JOB_NAME=plane-game/main-cd`; a plain `pipelineJob` does not provide Multibranch's `BRANCH_NAME`. The versioned pipeline fixes `DEPLOY_PORT=18081`, exposes no port parameter, and both deployment entrypoints reject every other value.
- `resource-gate.sh` enforces the restricted `plane-preflight` executor, rootless Docker, 3.5 GiB current memory admission, 35 GiB disk admission, and the 384 MiB/25% agent cgroup caps.
- `deploy-local.sh` creates source from the verified Git object, uses the separately rotated `plane-ghcr-pull` credential in a temporary Docker config, pulls only immutable digests, then runs `pre-promote-check.sh` so API/artifact and SCM main are checked after the pull and immediately before promotion. It also passes the candidate-owned `resource-gate.sh` into the promoter; the post-CD resource check runs before the rollback trap is released, so a failure restores the prior healthy release and ordering markers. On a first release, the promoter removes the gateway, candidate, and newly created network only after matching the recorded deployment IDs and ownership labels; missing or ambiguous ownership is preserved for investigation and reported as `ALERT` with `recovery=revert_incomplete`.
- `config/plane-game-job.groovy` deliberately has no webhook trigger. Direct GitHub-to-Jenkins webhook configuration is a rollback condition.
- `webhook-contract-dry-run.mjs` performs an offline HMAC, admission, persistence, and duplicate-delivery contract check without printing the payload or key. Run `node ops/jenkins/webhook-contract-dry-run.mjs`.

The Jenkins controller must have zero executors and no Docker or deployment credential access. The job must use `disableConcurrentBuilds`, the explicit `plane-game-production-cd` lock, and the host `flock`. Do not add build, test, Playwright, image push, SSH, ACR, DNS, Nginx, or certificate operations here.
