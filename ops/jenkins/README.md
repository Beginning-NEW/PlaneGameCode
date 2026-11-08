# Jenkins CD operator notes

Every request to the fixed Jenkins and application loopback origins must use the repository direct transport boundary. Node clients use direct HTTP sockets; shell clients disable proxying and redirects explicitly; service units remove inherited proxy and Node proxy-enablement variables before launch.

This directory implements the repository side of the main-only, same-host CD contract. See `RUNBOOK.md` for resource admission, credential ownership, setup, rollback, and evidence requirements.

## Webhook admission

GitHub must send only `workflow_run` events to the reviewed reverse-proxy route for `webhook-gateway.mjs`; it must not target Jenkins or Generic Webhook Trigger. The gateway verifies the raw-body HMAC before validating the UUID-shaped `X-GitHub-Delivery`, filters the exact completed/successful `Checks` push on `main`, and atomically reserves both delivery and `(run_id, run_attempt)` in a private SQLite database before reading the scoped Jenkins API token or calling a queue API.

The plane-demo TLS virtual host exposes only the exact `POST /github/workflow-run` route to the loopback gateway at `127.0.0.1:9080`. Nginx explicitly preserves `X-GitHub-Delivery`, `X-GitHub-Event`, and `X-Hub-Signature-256`; sibling paths continue to the application at `127.0.0.1:18081`. Jenkins remains distinct at `127.0.0.1:18080`: Nginx must never listen on or proxy to that controller port. Run `node ops/nginx/check-plane-demo-contract.mjs` before staging the template. This source contract does not enable the gateway, webhook, Jenkins job, or controller.

Import `config/plane-game-job.groovy` only after review. Install `config/plane-game-webhook-gateway.service` as a template through the controller host's configuration process; do not install it directly from a checkout. Keep one gateway process under the included `flock`, keep `/var/lib/plane-game-webhook` mode `0700`, and provide the webhook secret and minimal Jenkins API token through systemd credentials. The `plane-webhook-gateway` Jenkins principal needs only Overall Read plus Item Read/Build for `plane-game/main-cd` and queue/build read needed for reconciliation. It must have no Configure/Administer, credential, agent, GHCR, Docker, or deployment-host access.

The repository's canonical controller endpoint is declared in `config/jenkins-loopback-contract.env`. The current controller path is the Operations-owned rootless Docker container; this repository does not install or configure that container. Its JVM, memory, CPU, PIDs, image, and rollback settings come from the separately approved fresh resource baseline, not from a host `jenkins.service` drop-in.

`config/jenkins.service.d/plane-game-loopback.conf` is an endpoint-only reference for a possible future host-systemd controller. It is **not used or staged for the current rootless-container CD path** and deliberately contains no JVM or resource policy. Do not restore or propagate the retired `plane-game-limits.conf` values (`-Xmx256m`, `MemoryHigh=448M`, or `MemoryMax=512M`) through this port fix. A future move to host systemd requires its own approved resource configuration and runtime verification.

Run `node ops/jenkins/check-loopback-contract.mjs` before staging the gateway template. It must report `endpoint=http://127.0.0.1:18080`, `gateway=match`, `controller=match`, and `legacy_8080=absent`. The contract also fails if the endpoint-only reference acquires JVM or resource limits.

## Pre-enable loopback verification

After the approved rootless controller smoke is running and the gateway template has been staged, but before enabling the gateway, webhook, or CD job, Operations must run this exact read-only check on the controller host. Set `JENKINS_CONTAINER` to the approved rootless controller container name from the Operations change record; the guard rejects an empty value.

```bash
set -eu
: "${JENKINS_CONTAINER:?set this to the approved rootless Jenkins container name}"
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
env_value() {
  systemctl show "$1" --property=Environment --value |
    tr ' ' '\n' |
    sed -n "s/^$2=//p"
}

gateway_url=$(env_value plane-game-webhook-gateway.service JENKINS_URL)
controller_binding=$(
  docker inspect --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{if eq $port "8080/tcp"}}{{range $bindings}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}' \
    "$JENKINS_CONTAINER"
)
controller_url="http://${controller_binding}"

printf 'effective controller=%s\n' "$controller_url"
printf 'effective gateway=%s\n' "$gateway_url"
test "$controller_binding" = '127.0.0.1:18080'
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

Expected evidence is the rootless container's effective host binding `127.0.0.1:18080`, a matching gateway URL exactly `http://127.0.0.1:18080`, one `LISTEN` row whose local address is exactly `127.0.0.1:18080`, and an empty host `listener 8080` section. Container port `8080/tcp` is internal; it must be published only to host `127.0.0.1:18080`. A missing/multiple `18080` listener, any host `8080` listener, a non-loopback binding, or any environment mismatch is an immediate STOP/NO-GO: keep the gateway and CD job disabled and use the approved controller rollback procedure. These commands do not enable, restart, or otherwise mutate the container or gateway service.

A first valid delivery is reserved as `dispatching`, then durably moved to non-retryable `submitted` with redacted `enqueue_outcome_pending` evidence before the only permitted Jenkins POST. A valid same-origin numeric `201 Location` persists a write-once queue identity as `queued`; later signed replays require `TRIGGER_SOURCE=webhook` plus the complete `GITHUB_SHA`/`GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`/`TRIGGER_ID`/`WEBHOOK_DELIVERY_UUID` tuple and exactly one fallback match before following that identity through `running` and `completed`. Queue/build identity conflicts and multiple matches fail closed and persist a fixed redacted error code. Every empty or failed reconciliation increments `reconcile_count`, updates `last_reconciled_at`, and stores `submitted_unknown`, `queue_state_unknown`, or the fixed failure code; an empty lookup is never permission for another POST. If the primary SQLite connection rejects the post-accept audit write, the store reopens the same WAL database and replaces the failed connection only after that audit commits; failure of both paths is surfaced as `audit_persistence_failed` rather than suppressed. Startup retries only a pre-submit `dispatching` row; legacy ambiguous rows migrate to `submitted`. Resolve persistently unknown or mismatched submissions through operator investigation rather than deleting/resetting rows. A different delivery for the same `(run_id, run_attempt)` is acknowledged without a second queue call. Back up the SQLite database with the host state and retain the corresponding Jenkins queue/build history.

- `verify-candidate.sh` treats webhook parameters as untrusted and calls the public exact-attempt and main-ref APIs without authentication. It validates repository/head repository, workflow name/path, push/main, exact SHA, run id/attempt/number, completed/success, and protected-main immobility before deriving the application digest from the public GHCR full-SHA tag.
- `webhook-admission.mjs` owns HMAC validation, exact event filtering, and the persistent `dispatching`/`submitted`/`queued`/`running`/`completed` state machine. `webhook-gateway.mjs` validates `Location`, owns queue/build reconciliation, and is the only component allowed to call `buildWithParameters`.
- `Jenkinsfile` accepts only the core Jenkins identity `JOB_NAME=plane-game/main-cd`; a plain `pipelineJob` does not provide Multibranch's `BRANCH_NAME`. It also requires the global `CD_TRIGGER_MODE` to equal exactly one mutually exclusive `TRIGGER_SOURCE`. Poller mode requires an empty webhook UUID and deterministic `TRIGGER_ID=SHA:run_id:run_attempt`; webhook mode requires `TRIGGER_ID=webhook:UUID`. The versioned pipeline fixes `DEPLOY_PORT=18081`, exposes no port parameter, and both deployment entrypoints reject every other value.
- `resource-gate.sh` enforces the restricted `plane-preflight` executor, rootless Docker, 3.5 GiB current memory admission, 35 GiB disk admission, and the 384 MiB/25% agent cgroup caps. Its sole sudo exception is the existing test-server contract `(root) NOPASSWD: /usr/local/sbin/plane-game-preflight-report ""`. `deploy/plane-preflight` invokes the policy with `/usr/bin/python3 -I`; `deploy/preflight_sudo_policy.py` uses `/usr/bin/sudo` directly, accepts only that one normalized effective command plus the reviewed non-widening Defaults (`env_reset`, `mail_badpass`, the exact target `secure_path=/usr/local/sbin\:/usr/local/bin\:/usr/sbin\:/usr/bin\:/sbin\:/bin\:/snap/bin`, and optional `use_pty`), and verifies the canonical root-owned, non-writable, regular non-symlink mode-0755 report against the reviewed SHA-256. This is not a general sudo allowance: inherited Python paths, a changed/missing/reordered/additional secure-path entry, environment-widening or unknown Defaults, any other run-as identity, argument, command, alias expansion, wildcard, `ALL`, `SETENV`, extra entry, changed file, or unparseable output are stop conditions.
- `deploy-local.sh` durably records poller `deploy_intent` before pull, creates source from the verified Git object, creates an empty temporary Docker config, unsets inherited auth configuration, resolves the public full-SHA tag again, and anonymously pulls the application and reviewed gateway only by digest. `pre-promote-check.sh` repeats the public API, tag digest, and SCM main checks immediately before promotion. The promoter records rollback intent before recovery and runs the candidate-owned `resource-gate.sh` before releasing the rollback trap, so a failure restores the prior healthy release and ordering markers. Exact runtime labels and release records carry the full tuple and digest. On a first release, cleanup occurs only after deployment IDs and ownership labels match; missing or ambiguous ownership is preserved for investigation and quarantine, with incomplete recovery reported as `ALERT` and `recovery=revert_incomplete`.
- `config/plane-game-job.groovy` deliberately has no webhook trigger. Direct GitHub-to-Jenkins webhook configuration is a rollback condition.
- `webhook-contract-dry-run.mjs` performs an offline HMAC, admission, persistence, and duplicate-delivery contract check without printing the payload or key. Run `node ops/jenkins/webhook-contract-dry-run.mjs`.

The bounded private poller request graph, state machines, test-only approval exception, credential format, initialization boundary, and same-service-UID replay residual are documented in [`PRIVATE-POLLER.md`](PRIVATE-POLLER.md).

The Jenkins controller must have zero executors and no Docker or deployment credential access. The job must use `disableConcurrentBuilds`, the explicit `plane-game-production-cd` lock, and the host `flock`. Do not add build, test, Playwright, image push, SSH, ACR, DNS, Nginx, or certificate operations here.

## Operations rerun evidence for the fixed report exception

After Security, QA, and CTO approve one exact candidate SHA, Operations may rerun the same transient user-scope admission invocation below from that exact checkout. It is read-only apart from its run-owned evidence directory and the transient scope. It does not edit sudoers, the report, SSH, Jenkins, Docker, systemd configuration, or any host service. A repository test pass is not target approval.

```bash
set -u
test "$(id -un)" = plane-preflight
test -z "$(git status --porcelain --untracked-files=no)"
evidence_dir=$(mktemp -d "${TMPDIR:-/tmp}/plane-stage-b-gate.XXXXXX")
started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
candidate_sha=$(git rev-parse --verify HEAD)
candidate_tree=$(git rev-parse --verify HEAD^{tree})
{
  printf 'started_utc=%s\n' "$started_utc"
  printf 'candidate_sha=%s\n' "$candidate_sha"
  printf 'candidate_tree=%s\n' "$candidate_tree"
  sha256sum deploy/plane-preflight deploy/preflight_sudo_policy.py \
    ops/jenkins/resource-gate.sh ops/jenkins/public-source-images.env \
    ops/jenkins/config/jenkins-loopback-contract.env
  readlink -e /usr/local/sbin/plane-game-preflight-report
  stat -c 'report=%F uid=%u gid=%g mode=%a size=%s mtime=%y device=%d inode=%i' \
    /usr/local/sbin/plane-game-preflight-report
  sha256sum /usr/local/sbin/plane-game-preflight-report
} >"$evidence_dir/identity.txt"
set +e
systemd-run --user --scope --quiet -p MemoryMax=384M -p CPUQuota=25% bash -s \
  >"$evidence_dir/stdout.txt" 2>"$evidence_dir/stderr.txt" <<'STAGE_B_GATE'
set -euo pipefail
bash ops/jenkins/resource-gate.sh
STAGE_B_GATE
gate_exit=$?
set -e
finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  printf 'finished_utc=%s\n' "$finished_utc"
  printf 'exit_code=%s\n' "$gate_exit"
  printf 'host_mutation=none; transient_scope_and_evidence_files_only\n'
  printf '%s  %s\n' "$(sha256sum "$evidence_dir/stdout.txt" | awk '{print $1}')" stdout.txt
  printf '%s  %s\n' "$(sha256sum "$evidence_dir/stderr.txt" | awk '{print $1}')" stderr.txt
} >"$evidence_dir/result.txt"
cat "$evidence_dir/identity.txt"
printf '%s\n' '--- stdout ---'
cat "$evidence_dir/stdout.txt"
printf '%s\n' '--- stderr ---' >&2
cat "$evidence_dir/stderr.txt" >&2
cat "$evidence_dir/result.txt"
test "$gate_exit" -eq 0
grep -E '^resource-gate: passed .*memory_max=402653184 cpu_max=25000/100000$' \
  "$evidence_dir/stdout.txt"
```

Retain `identity.txt`, `stdout.txt`, `stderr.txt`, and `result.txt` together with the UTC window and exact candidate SHA. The final `resource-gate: passed` line proves that the gate continued past the sudo exception through both `memory.max` and `cpu.max`. Any mismatch or nonzero exit remains `No-Go`; do not repair the host from this procedure.
