# PlaneGame Jenkins controller Stage B

This directory is a replayable repository package for the persistent Stage B controller. It does not deploy, start, enable, or expose anything by itself. Jenkins, the disabled job, the GitHub webhook, and the rootless gateway remain inactive until separate Operations, security, QA, and CTO approval.

## Immutable inputs

- Jenkins core/JDK: `2.580.2-jdk21`.
- Base image: `jenkins/jenkins@sha256:74401de6a6f92e1afe1b02d1c8e3d0c33f263bfb5275dd8813f9150355f2367b`.
- `direct-plugins.txt` contains 10 exact direct plugins. `plugins.lock`, `plugins.install.txt`, and `plugins.sha256` contain the complete 66-plugin direct/transitive closure.
- `ssh-slaves:3.1097.v868116049892` is locked to SHA-256 `8d6c4996aad23c885928a0d0dc742200ed94473189434a93833b8f0de306597f`.
- `trilead-api:2.209.v0e69b_c43c245` is locked to SHA-256 `7e8c00767ac24d017e262665d676ccd74b1b22028f7210f85520ff139bd821ed`.
- `update-center.snapshot.json` is the previously verified official stable subset. `plugin-supplements.json` records the official historical SSH artifacts and manifest dependencies verified for Stage B.

Regenerate the lock deterministically:

```sh
node ops/jenkins/controller-stage-b/generate-plugin-lock.mjs \
  --input-time 2026-11-06T11:25:00Z \
  --output-dir ops/jenkins/controller-stage-b
```

## Controller contract

`runtime-manifest.json`, `runtime.env`, `Dockerfile`, and `run-controller.sh` jointly enforce:

- only `127.0.0.1:18080 -> 8080`; host ports 8080 and 50000 are forbidden;
- controller executors `0` and inbound agent port `-1`;
- read-only root filesystem, `no-new-privileges`, `cap-drop ALL`, named durable home, and restart `no`;
- `--memory=1g --memory-reservation=768m --memory-swap=1g --cpus=0.50 --pids-limit=256`;
- `-Xms128m -Xmx512m -XX:MaxMetaspaceSize=256m -XX:+ExitOnOutOfMemoryError`;
- rootless UID 1003 `plane-preflight` with `DOCKER_HOST=unix:///run/user/1003/docker.sock`.

`build-image.sh` requires the digest-pinned base image to have been acquired in a separate approved step and records the immutable built image ID. `run-controller.sh` accepts only that image-ID form and only the bounded Stage B home-volume namespace.

## First-run administrator and readiness

The setup wizard remains disabled. A home without the fixed `plane-admin` local principal fails closed unless `admin-bootstrap-bcrypt` is mounted read-only as `/run/secrets/PLANE_ADMIN_BOOTSTRAP_BCRYPT`. The file contains one Jenkins-native bcrypt value (`#jbcrypt:$2...`), never a plaintext password.

Generate the file with the repository helper after the approved Stage B image has been built:

```sh
approved_dir="$HOME/.config/plane-game/controller-stage-b"
image_id_file="$HOME/.config/plane-game/controller-stage-b/image-id"
bash ops/jenkins/controller-stage-b/generate-admin-bootstrap.sh \
  "$image_id_file" "$approved_dir"
```

The helper does not require host `htpasswd`, Python, a package install, or network access. It runs the Jenkins-bundled bcrypt implementation inside the exact immutable Stage B image with `--network none`, a read-only root filesystem, and dropped capabilities. Container UID 0 maps to host UID 1003 under the rootless Docker daemon, so the helper can write to the host-owned private output directory. Both password prompts are interactive and hidden. The plaintext is never placed in an argument, environment value, host file, image layer, or Docker-inspect-visible string; the helper writes only the final hash atomically as mode `0600` and never prints it.

On the first healthy boot, remove `admin-bootstrap-bcrypt` from the approved directory before any ordinary restart. A retained identical file makes the next start fail; this proves the file is one-time. For later starts, run the bounded `disable-stage-b.sh` path and then `run-controller.sh`; the runner removes only the stopped, correctly labelled controller and recreates its read-only mounts while retaining the named home volume. A restart without the bootstrap file succeeds from the persisted user record.

For a controlled rotation, disable the controller, verify the prior bootstrap file is absent, run `generate-admin-bootstrap.sh` again to create a different hash, start once, wait for the authenticated readiness proof, then remove the file. Reusing the previously applied hash is rejected.

### Required target bootstrap drill

Operations must execute this on a disposable Stage B rehearsal home before readiness is frozen. Do not print, copy, upload, or attach the hash; record only exit states and file metadata.

1. With a fresh bounded home volume and no `admin-bootstrap-bcrypt`, run `run-controller.sh`, wait for the controller to exit, and prove exit `78`, no `.stage-b-ready`, and no listening healthy controller.
2. Run `generate-admin-bootstrap.sh` interactively, verify owner UID `1003` and initial mode `0600` without reading the file, add only the mapped Jenkins UID `297607:r--` ACL (resulting mode `0640`), then start the same fresh home and prove `healthcheck.sh` succeeds.
3. Disable the controller, remove exactly `admin-bootstrap-bcrypt`, restart the persisted home, and prove readiness still succeeds.
4. Disable it again, generate a new hash, start once, and prove readiness succeeds with the rotated password. Disable while deliberately retaining that same file, restart once, and prove exit `78` with no readiness marker; then remove the file and prove the persisted restart succeeds.
5. Attach only the candidate SHA/tree, image ID, home-volume name, timestamps, exit codes, readiness results, and `stat` owner/mode to the Operations review. Never attach container logs from a password-entry session or any secret value.

`init.groovy` clears the readiness marker first and recreates it only after SYSTEM has verified the admin ACL, the gateway ACL, the SYSTEM SSH credential, the public-source no-credential job, zero controller executors, the disabled inbound port, and the bounded SSH agent. On a fresh home, JCasC Job DSL can write the new job files after Jenkins loads its in-memory item catalog; the init script reloads that catalog once before checking the live job. The project-level matrix strategy and explicit user grants give the gateway only folder/job Read and job Build. `healthcheck.sh` requires the authorization/bootstrap proof as well as login `200` and anonymous API `403`; those HTTP codes alone cannot make the controller healthy.

## SSH Build Agent and public-source CD

JCasC declares one exclusive `plane-game-cd-rootless` SSH agent with one executor and remote root `/home/plane-preflight/jenkins-agent`. The launcher uses a manually provided Ed25519 host key, never trust-on-first-use or a non-verifying strategy.

No credential value is committed. JCasC strict secret resolution is enabled; every required value uses an explicit, trimmed `/run/secrets` file read. Before a separately approved start, the operator supplies these distinct files from the approved credential/configuration workflow:

- `agent-host`;
- `agent-host-key`, containing one fixed `ssh-ed25519` public host key;
- `agent-private-key` for SYSTEM-scope `plane-game-agent-ssh`.

The public repository is checked out by exact anonymous HTTPS URL with no credential ID. Actions proof uses the unauthenticated exact-attempt and main-ref APIs. GHCR and Docker Hub pulls use an empty temporary Docker config, no login, and digest-only image references; no GitHub or registry credential object or host file is permitted.

The approved directory must be owned by UID 1003 with mode `0750`; each mounted file must be a regular non-symlink owned by UID 1003 with mode `0440` or `0640`. The target rootless mapping gives container Jenkins UID 1000 host UID 297607. Set exactly one named ACL for UID 297607 (`r-x` on the directory, `r--` on each file), with no group or other access. The bcrypt helper first writes mode `0600`; add this narrow ACL before mounting it, yielding mode `0640`. `run-controller.sh` checks the live daemon UID mapping and exact ACL, then proves the image user can read every file under `--network none`; it does not weaken host permissions. Do not reuse or create `PLANE_GAME_GITHUB_TOKEN`. See `credential-manifest.json` for metadata only.

## Rootless gateway and disabled defaults

`systemd-user/plane-game-webhook-gateway.service` is a `plane-preflight` user-service template. It has no `[Install]` section, no `User=`/`Group=`, no root-level target, `Restart=no`, the UID-1003 rootless Docker socket, loopback Jenkins only, and approved credential-file references. The repository's existing root-level gateway template is not a Stage B enablement path.

The JCasC Job DSL creates `plane-game/main-cd` with `disabled(true)` and no webhook trigger. See `ROLLBACK.md` for deterministic job -> gateway -> controller disablement, checksum-verified cold backup/restore, first-release no-Jenkins/no-app rollback, and later last-healthy selection.

JCasC also creates the fixed, non-interactive `plane-webhook-gateway` local principal. It receives only global `Overall/Read`, folder/job `Item/Read`, and job `Item/Build`; startup fails if it has Administer, Script Console, Credentials/View, folder Configure, job Configure, or job Delete.

For the separately approved gateway phase, pre-create the existing host-only token target and its private parent, then run the bounded helper. It never prints a token, puts a secret in an argument/environment value, or contacts a non-loopback address:

```sh
install -d -m 0700 "$HOME/.config/plane-game/credentials"
install -m 0600 /dev/null "$HOME/.config/plane-game/credentials/jenkins-api-token"
bash ops/jenkins/controller-stage-b/manage-gateway-token.sh create
bash ops/jenkins/controller-stage-b/manage-gateway-token.sh rotate
bash ops/jenkins/controller-stage-b/manage-gateway-token.sh prune
bash ops/jenkins/controller-stage-b/manage-gateway-token.sh revoke
```

`create` prompts twice, without echo, for the known `plane-admin` password corresponding to the bcrypt bootstrap. The host-only token file is one mode-`0600` JSON document containing version, token, and UUID. Every helper operation holds a private file lock; `rotate` publishes the complete new document with one fsynced atomic rename, then revokes prior tokens. If revocation is interrupted, `prune` uses the published UUID to complete it; a consumer reads only a complete old or new generation. `revoke` revokes all gateway tokens and atomically empties the existing target. The separate host-only `webhook-secret` HMAC file is untouched and is not required for a no-webhook controller rehearsal. The gateway remains disabled and loopback-only.

## Separately approved persistent poller activation

The packaged poller service remains disabled by default. The timer has an install target so a later approved Operations action can persist it under `timers.target`; the reviewed poller-mode override lives separately under `systemd-user-activation/` and is installed only by `manage-actions-poller.sh activate`. That helper also requires user linger, mutual exclusion with the webhook service, the canonical checkout, and the complete owner-only poller state before it enables the timer.

Before any GO, Operations must use the helper's `prepare-restart` action, restart the target host, wait for the five-minute timer, and run `verify-restart`. Verification requires a changed kernel boot ID plus a still-enabled/active timer and a successful poller invocation in the new boot. A one-shot `systemctl start` or environment override is not accepted. See `../PRIVATE-POLLER.md` for the exact sequence. This repository change does not run that sequence or enable a runtime.

## Offline verification

From the repository root:

```sh
node ops/jenkins/controller-stage-b/validate-contract.mjs
node --test tests/jenkins-stage-b-contract.test.mjs
node --test tests/jenkins-stage-b-bootstrap.test.mjs
node --test tests/jenkins-public-source.test.mjs
bash -n ops/jenkins/controller-stage-b/*.sh ops/jenkins/*.sh
(
  cd ops/jenkins/controller-stage-b
  sha256sum -c config-files.sha256
)
```

The public-source test executes the production verification, registry resolver, and digest-only pull helper against injected API timeout, HTTP, rate-limit, metadata, SHA/run/attempt, and digest-change failures. The validator rejects root-level/enableable gateway units, non-loopback or port-50000 exposure, controller executors, enabled jobs, host-key bypass, plaintext key/token patterns, rootful Docker, sudo, prune, wildcard deletion, and unbounded cleanup.
