# Jenkins CD operator notes

This directory implements the repository side of the main-only, same-host CD contract. See `RUNBOOK.md` for resource admission, credential ownership, setup, rollback, and evidence requirements.

- `verify-candidate.sh` treats webhook parameters as untrusted and verifies the successful GitHub Actions `Checks` push run, repository/ref/SHA/run attempt, unique candidate artifact, immutable digests, and current protected-main head.
- `resource-gate.sh` enforces the restricted `plane-preflight` executor, rootless Docker, 3.5 GiB current memory admission, 35 GiB disk admission, and the 384 MiB/25% agent cgroup caps.
- `deploy-local.sh` creates source from the verified Git object, uses the separately rotated `plane-ghcr-pull` credential in a temporary Docker config, pulls only immutable digests, and invokes the existing promoter/rollback contract.

The Jenkins controller must have zero executors and no Docker or deployment credential access. The job must use `disableConcurrentBuilds`, the explicit `plane-game-production-cd` lock, and the host `flock`. Do not add build, test, Playwright, image push, SSH, ACR, DNS, Nginx, or certificate operations here.
