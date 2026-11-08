# Private Actions poller package

All host-loopback Jenkins and runtime checks use direct Node HTTP sockets or curl with proxy disabled and redirects forbidden. The packaged poller and webhook services also remove inherited upper/lower-case proxy variables and Node environment-proxy enablement before launch, so a local Basic credential or health response cannot cross or be supplied by an inherited proxy.

This package is configuration-only delivery evidence. It does not enable the Jenkins job, the poller timer, the webhook gateway, or a deployment. `CD_TRIGGER_MODE` remains committed as `disabled` in the service and Jenkins defaults; both user-service paths refuse a disabled, missing, unknown, or mismatched selector. Controlled enablement remains a separate Operations action.

## Fixed trust and request graph

The poller accepts only `Beginning-NEW/PlaneGameCode`, `.github/workflows/checks.yml`, completed successful `push` runs on `main`, and the current public `main` SHA. All GitHub REST traffic is HTTPS to `api.github.com`; image resolution is HTTPS to `ghcr.io`; Jenkins is exactly `http://127.0.0.1:18080`. Redirects, proxy-derived destinations, `Link` pagination, response truncation, malformed JSON, missing rate headers, and any unlisted path/query fail closed. GHCR resolution caps the token body at 64 KiB, the manifest body at 1 MiB, and each header file at 1 MiB while curl is running; every file is measured after download and reaching a cap is rejected.

One changed candidate has a fixed 16-call graph:

1. one conditional workflow-run discovery;
2. initial exact run-attempt, approval history, deployments, selected deployment statuses, and `main` ref;
3. the same five immediately before enqueue;
4. the same five from Jenkins before deployment.

The shared ledger reserves the remaining 15 calls after discovery. It permits at most 30 actual plus reserved calls and one candidate in a strict rolling hour. Candidate validation starts only when GitHub reports at least 46 remaining, preserving a 30-request external reserve. There is no in-attempt retry or pagination expansion.

For this test repository only, `Beginning-NEW` / `183624934` is the reviewed `production` approver even when it is also the run actor. The approval `submitted_at` must fall inside the exact attempt's `run_started_at` through `updated_at` window. An approval from attempt 1 cannot authorize attempt 2. This is a test-only governance limitation, not independent GitHub approval; production reuse must restore a distinct non-self approver.

## Durable identities and recovery

Every record is keyed by `SHA:run_id:run_attempt`. The owner-only state directory contains a `0600` append-only hash-chain journal, atomic snapshot, and persistent empty `.shared.lock`. The systemd poller, Jenkins revalidation, deployment transitions, rollback transitions, and ledger maintenance all acquire that exact regular, single-link, no-follow file with non-blocking `flock`; contention fails closed without a request or side effect.

Startup verifies modes, ownership, regular-file/link count, the complete hash chain, and snapshot/journal consistency before network use. A valid journal that is one or more fsynced entries ahead of its snapshot repairs the snapshot; corruption, truncation, snapshot-ahead state, symlinks, other-UID ownership, or clock regression fails closed.

The current journal hard-stops at 8 MiB. `maintain-poller-ledger.sh` takes the same exclusive lock and checkpoints only after 4 MiB, preserving the full current state (including terminal tuple identities and rate reservations), the prior head/sequence, and SHA-256 hashes of the archived journal/snapshot. It retains at most four owner-only archives. A crash between the two atomic live-file replacements fails closed and is recovered only from the verified archive; maintenance never silently resets the request budget or terminal duplicate suppression.

The poller states are `observed -> eligible -> post_intent -> queued -> building -> deploy_claimed -> succeeded|failed|quarantined`. `post_intent` is fsynced before the sole Jenkins POST. Only HTTP 201 with Jenkins identity headers and an exact loopback `/queue/item/{id}/` Location advances. Before every discovery request, including a conditional 304 cycle, one durable `post_intent` or ambiguous quarantine is authenticated against the fixed Jenkins queue and build APIs. Exactly one full-tuple match may recover `queued` or `building`; zero, multiple, malformed, pruned, or mismatched evidence is durably quarantined after one attempt. The tuple is never posted again, and an exact live build retains its five reserved GitHub calls.

Jenkins revalidation durably binds the queued tuple to the current fixed job's `BUILD_NUMBER` and derived build URL before its five-call validation. A reconciled `building` tuple may resume only inside that exact live build when both persisted identity fields match; a different, malformed, duplicate, sequential, or already-deploying build rejects before validation without poisoning an existing live tuple.

The deployment states are `deploy_observed -> deploy_intent -> runtime_present -> health_verified -> deploy_succeeded`, with `rollback_intent -> rollback_verified -> failed` and `quarantined` branches. `deploy_intent` is durable before pull or runtime mutation and includes the candidate plus previous-good tuple, digest, and deterministic runtime identity. Restart repair closes the `deploy_observed -> deploy_intent`, `deploy_succeeded -> poller succeeded`, and `rollback_verified -> failed` fsync windows only after re-observing the exact candidate or previous-good runtime; it never repeats deployment or rollback. A restart:

- records success without redeployment for exactly one healthy candidate runtime with exact labels and digest;
- records terminal no-side-effect failure only when no candidate exists and the persisted previous-good runtime is exact and healthy;
- durably claims at most one rollback for a mismatched/unhealthy candidate and records failure only after previous-good verification;
- quarantines multiple, missing, pruned, or unverifiable evidence.

Runtime labels and the release record carry the full tuple and digest. A terminal failed/quarantined tuple never retries automatically; only a distinct GitHub run attempt can be admitted.

## Credential and package lifecycle

The dedicated Jenkins principal is `plane-actions-poller` with only inherited `Overall/Read` and explicit `Job/Read` plus `Job/Build` on `plane-game/main-cd`. Its username and API token live together in `~/.local/state/plane-game-poller/jenkins-api-token`, a pre-created owner-only `0600` JSON file inside the persistent `0700` poller state directory. The provider revalidates the absolute path, every ancestor component, owner/mode, regular-file identity, link count, bounded size, and schema on every read. The credentials do not appear in arguments, environment variables, service definitions, logs, images, or Docker metadata. API-token requests do not fetch crumbs and have no password, anonymous, or broader-credential fallback.

An operator may initialize an empty state directory while all paths remain disabled:

```sh
install -d -m 0700 "$HOME/.local/state/plane-game-poller"
node ops/jenkins/private-actions-poller.mjs --initialize "$HOME/.local/state/plane-game-poller"
install -m 0600 /dev/null "$HOME/.local/state/plane-game-poller/jenkins-api-token"
```

`create-poller-token.sh create|rotate|prune|revoke` holds a private lock and stores one atomic `{version,username,token,uuid}` document. `create` uses the interactive admin bootstrap only to mint the first token. `rotate` authenticates with the current file-backed token, publishes the new token/UUID with fsync-before-rename, then revokes every prior token. If that final revocation is interrupted, `prune` completes it from the published UUID. `revoke` revokes all poller tokens and atomically empties the existing target. Token values are carried only by owner-only files and netrc, never argv, environment, logs, images, or service definitions. These commands remain a separately approved Operations action.

The poller oneshot is bounded by `MemoryMax=192M`, `CPUQuota=25%`, `TasksMax=32`, and the effective oneshot execution limit `TimeoutStartSec=240s`, safely below the five-minute cadence. (`RuntimeMaxSec` does not apply to `Type=oneshot`, so the unit does not claim it as a control.) Unit-local journal output is rate-limited to 50 messages per 60 seconds; the ledger procedure above bounds package-owned persistent audit storage.

## Persistent poller activation gate

The timer now has an explicit `WantedBy=timers.target` install target, but the repository and installed service still default to `CD_TRIGGER_MODE=disabled`. The opt-in drop-in under `controller-stage-b/systemd-user-activation/` is deliberately outside the default unit directory. Merely starting the timer or supplying a one-shot environment value is not an activation procedure.

After Security, Functional, Operations, and CTO approval, the `plane-preflight` operator may run the bounded activation helper from the canonical `$HOME/plane-game-cd` checkout:

The controller's approved directory contains `cd-trigger-mode`, default-created as `disabled` with the same narrow mapped-Jenkins ACL as other mounted files. JCasC and Job DSL read that fixed file, so a controller restart restores one selector/job state instead of reverting independently. The activation helper persists `poller`, applies the fixed live Jenkins script that verifies selector `poller` plus job enabled, installs the matching systemd drop-in, and only then enables the timer. A failure after intent stops/disables the poller, removes the drop-in, and restores the persisted/live Jenkins state to disabled.

```sh
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh activate
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh prepare-restart
# Reboot the rehearsal host through the separately approved Operations procedure.
# Wait at least five minutes after the user manager starts.
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh verify-restart
```

`activate` refuses the wrong UID/user, a non-canonical checkout, unsafe or incomplete ledger/credential files, disabled user linger, an active or unverifiable webhook service, an unsafe approved selector directory, symlinked or group/world-writable systemd paths, unsafe sources, a failed Jenkins selector/job update, or an ineffective mode override. The timer must report exactly `enabled` (not `enabled-runtime` or `static`) and `active`, the persisted selector must be `poller`, and the fixed live script must report the Jenkins job enabled under that selector.

`prepare-restart` durably records the kernel boot ID in the owner-only poller state directory. `verify-restart` fails until the boot ID changes, user linger remains enabled, the timer is still persistently enabled and active, the poller drop-in and persisted selector remain `poller`, the timer has fired during the new boot, the oneshot reports success/0, and the fixed live Jenkins script verifies selector `poller` plus job enabled. It records all non-secret tuple fields in `activation-restart-proof`. Operations must retain that proof; a 304/no-candidate cycle alone cannot pass while Jenkins is disabled.

## Persistent poller deactivation gate

Rollback order is job -> poller -> gateway -> controller. After the Jenkins job is disabled and acknowledged, `disable-stage-b.sh` calls the same manager's fail-closed deactivation path before it stops the gateway or controller:

```sh
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh deactivate
# Reboot through the separately approved Operations procedure.
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh verify-disabled-restart
```

`deactivate` is idempotent and does not depend on a complete activation ledger. It stops/disables both poller units first, removes the drop-in, persists `disabled`, applies the fixed live Jenkins script that disables the job and global selector, and fails unless systemd and both selector layers agree. `verify-disabled-restart` requires a changed boot ID and repeats the timer/service, persisted selector, live selector, and disabled-job proof before writing `deactivation-restart-proof`. A rollback is not post-reboot complete without that proof.

The self-owned ledger detects accidental corruption and other-UID/path attacks. Malicious replay of an earlier internally consistent journal/snapshot by the same service UID remains explicitly out of scope; preventing it requires a separately trusted root-owned or remote monotonic anchor.
