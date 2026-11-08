# Private Actions poller package

This package is configuration-only delivery evidence. It does not enable the Jenkins job, the poller timer, the webhook gateway, or a deployment. `CD_TRIGGER_MODE` is committed as `disabled`; the job and both user-service paths refuse a disabled, missing, unknown, or mismatched selector. Controlled enablement remains a separate Operations action.

## Fixed trust and request graph

The poller accepts only `Beginning-NEW/PlaneGameCode`, `.github/workflows/checks.yml`, completed successful `push` runs on `main`, and the current public `main` SHA. All GitHub REST traffic is HTTPS to `api.github.com`; image resolution is HTTPS to `ghcr.io`; Jenkins is exactly `http://127.0.0.1:18080`. Redirects, proxy-derived destinations, `Link` pagination, response truncation, malformed JSON, missing rate headers, and any unlisted path/query fail closed.

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

The poller states are `observed -> eligible -> post_intent -> queued -> building -> deploy_claimed -> succeeded|failed|quarantined`. `post_intent` is fsynced before the sole Jenkins POST. Only HTTP 201 with Jenkins identity headers and an exact loopback `/queue/item/{id}/` Location advances. Ambiguous POST outcomes are quarantined and require authenticated exact-`TRIGGER_ID` operator reconciliation; they are never posted again automatically.

The deployment states are `deploy_observed -> deploy_intent -> runtime_present -> health_verified -> deploy_succeeded`, with `rollback_intent -> rollback_verified -> failed` and `quarantined` branches. `deploy_intent` is durable before pull or runtime mutation and includes the candidate plus previous-good tuple, digest, and deterministic runtime identity. A restart:

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

The self-owned ledger detects accidental corruption and other-UID/path attacks. Malicious replay of an earlier internally consistent journal/snapshot by the same service UID remains explicitly out of scope; preventing it requires a separately trusted root-owned or remote monotonic anchor.
