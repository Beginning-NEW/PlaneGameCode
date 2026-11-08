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

## SSH Build Agent and credentials

JCasC declares one exclusive `plane-game-cd-rootless` SSH agent with one executor and remote root `/home/plane-preflight/jenkins-agent`. The launcher uses a manually provided Ed25519 host key, never trust-on-first-use or a non-verifying strategy.

No credential value is committed. Before a separately approved start, the operator supplies three mode-0600 files from the approved credential/configuration workflow:

- `agent-host`;
- `agent-host-key`, containing one fixed `ssh-ed25519` public host key;
- `agent-private-key`, mounted read-only as the JCasC Docker secret `PLANE_AGENT_PRIVATE_KEY`.

JCasC creates only the SYSTEM-scope `plane-game-agent-ssh` reference from that file-backed secret. The job's deploy credential IDs remain references owned by the existing Jenkins credential workflow.

## Rootless gateway and disabled defaults

`systemd-user/plane-game-webhook-gateway.service` is a `plane-preflight` user-service template. It has no `[Install]` section, no `User=`/`Group=`, no root-level target, `Restart=no`, the UID-1003 rootless Docker socket, loopback Jenkins only, and approved credential-file references. The repository's existing root-level gateway template is not a Stage B enablement path.

The JCasC Job DSL creates `plane-game/main-cd` with `disabled(true)` and no webhook trigger. See `ROLLBACK.md` for deterministic job -> gateway -> controller disablement, checksum-verified cold backup/restore, first-release no-Jenkins/no-app rollback, and later last-healthy selection.

## Offline verification

From the repository root:

```sh
node ops/jenkins/controller-stage-b/validate-contract.mjs
node --test tests/jenkins-stage-b-contract.test.mjs
bash -n ops/jenkins/controller-stage-b/*.sh
(
  cd ops/jenkins/controller-stage-b
  sha256sum -c config-files.sha256
)
```

The validator rejects root-level/enableable gateway units, non-loopback or port-50000 exposure, controller executors, enabled jobs, host-key bypass, plaintext key/token patterns, rootful Docker, sudo, prune, wildcard deletion, and unbounded cleanup.
