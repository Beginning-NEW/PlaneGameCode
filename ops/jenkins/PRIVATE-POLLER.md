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

Every record is keyed by `SHA:run_id:run_attempt`. The owner-only state directory contains a `0600` append-only hash-chain journal, atomic snapshot, and persistent empty `.shared.lock`. The systemd poller, Jenkins revalidation, deployment transitions, and rollback transitions all acquire that exact regular, single-link, no-follow file with non-blocking `flock`; contention fails closed without a request or side effect.

Startup verifies modes, ownership, regular-file/link count, the complete hash chain, and snapshot/journal consistency before network use. A valid journal that is one or more fsynced entries ahead of its snapshot repairs the snapshot; corruption, truncation, snapshot-ahead state, symlinks, other-UID ownership, or clock regression fails closed.

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

`create-poller-token.sh` writes only to an already-created empty owner-only target and uses the interactive admin bootstrap solely for token creation. Do not run it as part of this implementation review. Rotation/revocation and mode enablement require a separately reviewed Operations procedure.

## Persistent poller activation gate

The timer now has an explicit `WantedBy=timers.target` install target, but the repository and installed service still default to `CD_TRIGGER_MODE=disabled`. The opt-in drop-in under `controller-stage-b/systemd-user-activation/` is deliberately outside the default unit directory. Merely starting the timer or supplying a one-shot environment value is not an activation procedure.

After Security, Functional, Operations, and CTO approval, the `plane-preflight` operator may run the bounded activation helper from the canonical `$HOME/plane-game-cd` checkout:

The helper activates only the rootless host poller schedule. It does not enable `plane-game/main-cd` or change Jenkins' committed global selector; the separately reviewed enablement procedure must set that job/global selector to the same exclusive `poller` mode before end-to-end GO.

```sh
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh activate
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh prepare-restart
# Reboot the rehearsal host through the separately approved Operations procedure.
# Wait at least five minutes after the user manager starts.
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh verify-restart
```

`activate` refuses the wrong UID/user, a non-canonical checkout, unsafe or incomplete ledger/credential files, disabled user linger, an active or unverifiable webhook service, symlinked or group/world-writable systemd configuration paths, unsafe activation sources, or an ineffective mode override. It atomically installs the disabled service, the timer, and the reviewed `CD_TRIGGER_MODE=poller` drop-in before running `systemctl --user enable --now plane-game-actions-poller.timer`. The timer must report exactly `enabled` (not `enabled-runtime` or `static`) and `active`.

`prepare-restart` durably records the kernel boot ID in the owner-only poller state directory. `verify-restart` fails until the boot ID changes, user linger remains enabled, the timer is still persistently enabled and active, the poller drop-in is effective, the timer has fired during the new boot, and the resulting oneshot service reports `Result=success` with exit status 0. It then writes the before/after boot IDs and non-secret systemd result fields to `activation-restart-proof`. Operations must retain that file's metadata/content as restart evidence. No implementation or CI run substitutes for this target-host proof, and no GO may be issued without it.

## Persistent poller deactivation gate

Rollback order is job -> poller -> gateway -> controller. After the Jenkins job is disabled and acknowledged, `disable-stage-b.sh` calls the same manager's fail-closed deactivation path before it stops the gateway or controller:

```sh
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh deactivate
# Reboot through the separately approved Operations procedure.
bash ops/jenkins/controller-stage-b/manage-actions-poller.sh verify-disabled-restart
```

`deactivate` is idempotent and does not depend on a complete activation ledger. It restores the reviewed default-disabled service/timer files, stops both units, removes persistent timer enablement and the `CD_TRIGGER_MODE=poller` drop-in, reloads the user manager, and fails unless systemd reports the timer disabled/inactive, the service static/inactive, and exactly one effective `CD_TRIGGER_MODE=disabled`. Only then does it durably record the current boot ID. `verify-disabled-restart` requires a changed boot ID and repeats every disabled/inactive/selector proof before writing `deactivation-restart-proof`. A rollback is not post-reboot complete without that proof.

The self-owned ledger detects accidental corruption and other-UID/path attacks. Malicious replay of an earlier internally consistent journal/snapshot by the same service UID remains explicitly out of scope; preventing it requires a separately trusted root-owned or remote monotonic anchor.
