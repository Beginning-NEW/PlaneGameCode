# Stage B static verification record

- Base: `816b972f66c9de82aa23ce52568b9289ee961690`.
- Jenkins: `2.580.2` / JDK 21, base image digest pinned in `Dockerfile`.
- Plugin closure: 10 direct / 66 total, with exact official artifact hashes.
- Runtime status: **UNEXECUTED**. This repository task does not start Jenkins, enable the job/webhook/gateway, read credentials, or touch a server.

Same-tree verification before the candidate commit:

- `node ops/jenkins/controller-stage-b/validate-contract.mjs` -> exit 0, PASS.
- `node --test tests/jenkins-stage-b-contract.test.mjs` -> exit 0, 6/6 PASS.
- `node --test tests/jenkins-contract.test.mjs tests/jenkins-loopback-contract.test.mjs` -> exit 0, 10/10 PASS.
- `bash -n` over all eight `controller-stage-b/*.sh` files -> exit 0.
- `sha256sum -c config-files.sha256` from `ops/jenkins/controller-stage-b` -> exit 0, 28/28 OK.
- Plaintext key/token scan using the handoff regex -> exit 1, the expected no-match result.
- `jar` -> **MISSING** in the Windows environment. Official plugin archives were instead read with the built-in .NET ZIP API; their downloaded SHA-256 values exactly matched the committed locks.
