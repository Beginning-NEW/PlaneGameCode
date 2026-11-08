# Stage B G0 integration static verification record

- Webhook identity and reviewed ingress head: `7982dce26e3e3c7477f7b8edd1c71bf3f4d89e3e`
  (parent `fae55a9d6b80b9b79e2705488d2f0793555438e7`).
- Cleanup-validator input: `709ca231f8c2c6cb907a294a818506b208ae7ff9`,
  replayed as `db6a3aeb85a749298b35c7dc68500b55c7d12167`.
- Stage B artifact input: `ca29ef994dbce6b55de891296f94143d7784d629`,
  replayed as `9a9cd78207b835d80febaaeec6aa132e6df78e2b`.
- Secure bootstrap/credential remediation input: protected-main candidate
  `508c17a5ff3e5ae90779995046741b5c3a65c026`, tree
  `39a623361b2c82bec50b4f6d2391dbc9ac1b2d54`.
- Ancestry anchor: `6626517910fabb232374d09aeccc65471611178f` is an
  ancestor of the webhook/ingress head. Both cherry-picks applied without a
  conflict; no source-stream semantics were changed during sealing.
- Jenkins: `2.580.2` / JDK 21, base image digest pinned in `Dockerfile`.
- Plugin closure: 10 direct / 66 total, with exact official artifact hashes.
- Runtime status: **UNEXECUTED**. This repository task does not start Jenkins, enable the job/webhook/gateway, read credentials, or touch a server.

Same-tree verification before the final sealing commit:

- `node ops/jenkins/controller-stage-b/validate-contract.mjs` -> exit 0, PASS.
- Focused first-boot, rotation, authorization, file-readability, credential,
  token-lifecycle, and health contracts -> exit 0, 7/7 PASS.
- Stage B plugin/runtime/negative/checksum contracts -> exit 0, 6/6 PASS.
- Deployment/cleanup contract, validator, and real `deploy -> promote` mock-drill
  batch -> exit 0, 17 PASS / 2 environment skips / 0 FAIL.
- Webhook identity/dedup, Jenkins controller/gateway/rollback, loopback, Stage B,
  and Nginx ingress contract batch -> exit 0, 47/47 PASS.
- Application/version test batch -> exit 0, 6/6 PASS.
- `pnpm lint`, `pnpm format --check`, and `pnpm build` -> exit 0 each.
- `bash -n deploy/*.sh deploy/plane-preflight ops/jenkins/*.sh
  ops/jenkins/controller-stage-b/*.sh` -> exit 0.
- `sha256sum -c config-files.sha256` from `ops/jenkins/controller-stage-b` -> exit 0, 30/30 OK.
- Contract tests confirm the retired Actions deploy workflow is absent, Actions
  remains the image builder/publisher, Jenkins CD and the rootless gateway stay
  disabled, Jenkins remains loopback-only on `18080`, and Nginx exposes only the
  exact HMAC-gated webhook path to loopback `9080`.
- Static negative contracts reject plaintext credentials, root-level/enableable
  gateway units, non-loopback Jenkins, port `50000`, privileged/rootful Docker,
  secret-bearing environment/argument injection, bootstrap replay, broad
  cleanup, wildcard deletion, over-privileged gateway grants, and enabled jobs.
