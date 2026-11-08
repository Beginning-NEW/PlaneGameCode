# PlaneGameCode GitHub Actions + Jenkins CD 迁移手册（候选，未上线）

## 状态与边界

本工程候选从受保护 `main` 候选 `508c17a5ff3e5ae90779995046741b5c3a65c026`（reviewed tree `39a623361b2c82bec50b4f6d2391dbc9ac1b2d54`）派生。本节描述版本化设计边界，不是当前 PR、CI 或目标主机的执行状态；这些状态必须分别从候选精确 SHA 的 Checks 和 Operations 当次证据读取。该候选只交付离线代码、配置和测试：没有安装 Jenkins、没有连接或修改目标机、没有拉取/部署生产镜像，也没有变更 Nginx、DNS、TLS 或 `www`。

GitHub Actions 是 PR/main 重型 CI 和受保护 `main` 的唯一 GHCR 发布者。Jenkins 只在既有 Ubuntu 主机的受限执行器上做轻量 CD、健康/version 校验和失败回滚；不运行 pnpm、Playwright、Docker build 或 push。旧 `.github/workflows/deploy.yml` 已删除，不能与 Jenkins 同时恢复或启用。

## 可信交接链

1. `.github/workflows/checks.yml` 对 PR 和 `main` 运行 lint、format、unit、build、Playwright、容器健康和版本 smoke。PR job 只有 `contents: read`，不绑定 GHCR write、Jenkins、SSH 或部署凭据。
2. 只有仓库 `Beginning-NEW/PlaneGameCode` 的 `refs/heads/main` push 且 `verify` 成功后，`publish` job 才获得 job-scoped `packages: write`。它重新核对当前 main SHA，按完整 SHA 构建、smoke、推送 GHCR，并解析不可变 manifest digest。
3. Actions 当前仍上传 `release-candidate-<SHA>` artifact，供人工作为诊断/追溯材料。它是非权威输出：Jenkins 不枚举、下载或解析该 artifact，artifact 的存在、内容、唯一性和保留期都不参与部署准入，也不能替代公开 API、SCM 或 registry 的实时校验。
4. GitHub repository webhook 只把已完成的 `workflow_run` 的 `head_sha`、`id` 和 `run_attempt` 映射到 Jenkins 参数。参数一律视为不可信。`verify-candidate.sh` 以匿名公开 GitHub API 验证 exact-attempt 的 repository/head repository、workflow name/path、push event、main branch、完整 SHA、run id/attempt、completed/success 结论，并验证当前受保护 main HEAD；随后从公开 GHCR full-SHA tag 解析唯一 canonical `sha256` digest。
5. Jenkins 在 `plane-game-production-cd` 显式锁内完成首次验证；`deploy-local.sh` 在匿名拉取前再次解析 full-SHA tag 并要求 digest 不变，拉取后由 `pre-promote-check.sh` 再次验证 exact-attempt、main ref、GHCR digest 与 SCM `FETCH_HEAD`，全部一致后才允许 promotion。`disableConcurrentBuilds` 与主机 `flock` 是额外两层串行保护；同一 workflow 单调递增的 Actions `run_number` 标记阻止旧候选覆盖新版本，`run_id` 只用于唯一标识 run。

任何仓库/ref/SHA/run id/run attempt/digest 不一致、main 或 full-SHA tag 已移动、公开 API/registry 不可用或限流、匿名拉取失败，都必须失败关闭，不能手工覆盖参数，也不能用 artifact、缓存或 Board-host 证据继续。

## 启用前资源 No-Go

本节定义资源入场线，不陈述当前目标主机状态。是否允许安装、启用 Jenkins 或执行部署，必须由 Operations 对目标主机给出当次连续 24 小时证据和独立批准；历史容量快照不得作为当前 Go/No-Go 结论。

只有 Operations 对同一主机给出以下连续 24 小时证据后，才可提出新的启用审批：

- p5 `MemAvailable >= 3.5 GiB`；
- p95 CPU busy 不超过 4 核中的 2 核；
- 根盘可用空间 `>= 35 GiB`；
- 既有服务健康、延迟和 IO 无回归，候选回环端口仍空闲；
- Aegis/替代安全基线和 rootless Docker 风险有已批准结论。

建议 controller 为 0 executors，systemd/cgroup 上限 `MemoryMax=1024MiB`、`CPUQuota=50%`；单一 `plane-game-cd-rootless` agent 使用独立 `plane-preflight` 用户，上限 `MemoryMax=384MiB`、`CPUQuota=25%`。agent 不得属于 docker/sudo/wheel/admin 组，只能访问其自身 `/run/user/<uid>/docker.sock`；controller 不得访问任何 Docker socket 或部署凭据。

`ops/jenkins/resource-gate.sh` 在每次 CD 前后校验执行器身份、rootless preflight、瞬时 `MemAvailable >= 3.5 GiB`、磁盘 `>= 35 GiB` 和执行器 cgroup 上限。以下任一条件出现即停止试运行、禁用 job 并由 Operations 评估；不得自动重试：

- `MemAvailable < 2 GiB` 持续 5 分钟，或任何一次 `< 1.5 GiB`；
- OOM/进程被杀、根盘可用 `< 30 GiB`；
- 既有 MSSQL/Postgres/Redis/new-api 的健康、延迟、CPU/IO 有回归；
- rootless socket、回环端口、Aegis/替代安全基线或凭据边界不再成立。

## Jenkins public-source identity and permissions

The current repository and package rehearsal is deliberately no-PAT. SCM uses the exact allowlisted anonymous HTTPS URL and no Jenkins credential ID. Jenkins validates the public GitHub Actions exact-attempt endpoint and public main-ref endpoint without an Authorization header. It then resolves the public GHCR full-SHA tag, requires one canonical sha256 digest, and repeats that resolution immediately before deployment.

Application and gateway pulls use an empty temporary Docker config, no login, and digest-only image references. The reviewed gateway digest lives in `ops/jenkins/public-source-images.env`; it is not a private repository variable. A non-2xx response, timeout, 504, rate-limit exhaustion, malformed or inconsistent metadata, tag movement, missing public pull, or main movement fails before the resource gate or deployment.

The host-only `plane-github-webhook-secret` HMAC and minimal Jenkins API token remain separate. Neither is injected into the Pipeline, and the no-webhook rehearsal does not require the HMAC file.

## Jenkins 配置（仅在资源与安全门禁获批后）

1. 建立只发现受保护 `main` 的受限 folder/job；关闭 PR discovery、fork Jenkinsfile 和 synthetic merge builds。controller 0 executors，job 固定 label `plane-game-cd-rootless`。
2. 安装并锁定 Pipeline、GitHub Branch Source、Credentials Binding、Lockable Resources 和 Generic Webhook Trigger 的受审版本。插件安装本身不属于本候选。
3. 普通 `pipelineJob` 以 Jenkins 核心变量精确校验 `JOB_NAME=plane-game/main-cd`；不依赖仅 Multibranch job 才提供的 `BRANCH_NAME`。版本化 `Jenkinsfile` 固定 `DEPLOY_PORT=18081`，Job DSL 不提供端口参数，`deploy-local.sh` 与 `promote.sh` 同时拒绝缺失值和任何其他端口（包括 `9999`）。不提供 branch/SHA/digest/host/port 的人工 override。SCM 仅允许精确的匿名 HTTPS 仓库 URL，不配置 credential ID。
4. repository webhook 仅订阅 `workflow_run`，验证 `plane-github-webhook-secret` HMAC；只在 `action=completed` 且 workflow name 为 `Checks` 时触发。映射 `workflow_run.head_sha -> CANDIDATE_SHA`、`workflow_run.id -> ACTIONS_RUN_ID`、`workflow_run.run_attempt -> ACTIONS_RUN_ATTEMPT`。
5. 先以禁止部署的验证模式检查 webhook、public API 和 public registry；独立安全、QA、Operations 和 CTO 审查均通过后，才允许启用 CD stage。不要恢复 `.github/workflows/deploy.yml`。

## 同机 rootless 部署与回滚

Jenkins checkout 必须是 candidate SHA，且 `origin/main` 与 GitHub API 当前 main 都等于该 SHA。`deploy-local.sh` 从这个已验证 Git object 生成 `compose.yaml` 和 `deploy/` 的 run-specific source，使用空的临时 `DOCKER_CONFIG` 且不登录 registry，按 `repository@digest` 匿名拉取应用和固定 gateway digest，随后调用现有 `deploy/promote.sh`。

`promote.sh` 持有主机 `flock`、拒绝同一 workflow 中较旧或已激活的 Actions `run_number`、保存上一份 source，并调用 `deploy.sh`。`run_attempt` 只验证候选身份；已激活 run number 的重跑不得覆盖当前版本。部署脚本验证 OCI revision label、digest、容器健康、回环 `/healthz`、首页和 `version.json`。`version.json` 必须是 JSON object，且其顶层 `sha` 精确等于批准的完整 SHA；substring 或嵌套字段不通过。

候选失败时，首次发布只清理本轮拥有的容器/网络/route；更新失败恢复上一 source 并调用 `rollback.sh` 回到记录的 `previous_healthy_sha`。恢复校验失败必须输出 `ALERT` 并保持 Jenkins build failed；不得因为旧版本恢复成功而把新发布标记成功。

## 必备证据与最终判定

每次真实演练至少记录：

- Actions run URL/id/attempt/number、workflow path、repository、ref、完整 SHA、结论；
- GHCR repository、首次及 pre-pull/pre-promotion 复核的应用 digest、gateway digest；若保留 Actions artifact，可另记 artifact URL/id 作为非权威诊断证据，但不得作为准入或补缺证据；
- Jenkins build URL/number、job/folder、agent identity、锁等待/获得时间；
- 门禁 UTC、24 小时 p5 memory/p95 CPU、瞬时 memory、磁盘、cgroup limits、既有服务前后健康；
- 部署前后 active/previous SHA、`/healthz`、首页、顶层 `version.json.sha`、Compose 状态；
- 故障注入点、rollback target、恢复耗时、最终 route/source/config 和任何 `ALERT`；
- 公网 HTTPS 与现有 `www` 前后对照（由独立 Operations/QA 执行）。

本地契约测试、Jenkinsfile 静态检查和本手册只能证明候选设计，不能证明真实 Jenkins、目标机或公网 PASS。缺少任一真实证据时结论必须保持 BLOCKED/No-Go。

## 迁移回退

Jenkins 首次启用前的回退是禁用/删除 main-only job 和 webhook，并撤销 Jenkins 网关 API token；Actions `Checks` 重型 CI 和 GHCR 发布可继续，但没有自动 CD。不得用恢复旧 `deploy.yml` 作为临时回退；若未来确需恢复 Actions CD，必须作为独立变更重新安全/QA 审查，并先禁用 Jenkins，保证始终只有一条自动发布路径。
# Trusted handoff correction (authoritative for the Jenkins candidate)

- Release ordering uses the `run_number` returned by the public exact-attempt API, not `run_id`; `run_id` remains identity only. A run number may activate at most once: a later successful attempt may deploy only when that run number has never activated, and a rerun of an already active/recorded run number is rejected.
- The image pulls finish before the final anonymous exact-attempt, main-ref, full-SHA-tag digest, and SCM `FETCH_HEAD` checks. The promoter is called only after those checks still bind the same SHA, run id, run attempt, run number, and immutable digests. Main or tag movement during a pull rejects the candidate.
- The final loopback health and exact `version.json` checks are inside the promoter's rollback trap. A failure keeps Jenkins red and restores `previous_healthy_sha`; any incomplete source, route, marker, or health recovery emits `ALERT`.
- The privileged `publish` job pins `actions/checkout` and `actions/upload-artifact` to reviewed full commit SHAs; moving major-version tags are forbidden in that job. The uploaded artifact remains non-authoritative and is never read by Jenkins. The ordinary unprivileged `verify` job remains outside this publish-only pin contract.
- `resource-gate.sh` runs both before promotion and after the new route passes health/version checks. The post-CD invocation is the candidate-owned archived script and remains inside the promoter's rollback trap; a gate failure restores the previous healthy route and run-order markers, while its redacted numeric output is the instantaneous post-CD evidence.
- The reviewable webhook controls are `ops/jenkins/webhook-admission.mjs`, `ops/jenkins/webhook-gateway.mjs`, `ops/jenkins/config/plane-game-webhook-gateway.service`, and `ops/jenkins/config/plane-game-job.groovy`. The CD Job DSL has no direct webhook trigger. API verification remains mandatory.
- Public GHCR and Docker Hub pulls use no login and an empty temporary Docker config. There is no PAT, cached-evidence, or Board-host fallback.
- The continuous 24-hour p5 memory, p95 CPU, disk, existing-service, and security baseline remains evidence owned by [YOU-47](/YOU/issues/YOU-47) and Operations. The instantaneous `resource-gate.sh` check cannot replace that admission gate.
- Repository tests and the offline webhook dry-run prove only the candidate contract. They do not claim a real Jenkins controller, target host, or public endpoint PASS.

## Durable webhook admission (authoritative)

- GitHub sends `workflow_run` only to the admission gateway. It must never target `/generic-webhook-trigger/invoke` or the Jenkins job directly.
- The gateway verifies `X-Hub-Signature-256` over the raw body before validating the non-empty canonical UUID in `X-GitHub-Delivery`. It then admits only the exact repository, workflow path/name, `push` event, `main` branch, completed/success conclusion, full SHA, positive `run_id`, and positive `run_attempt`.
- Before any Jenkins credential read or queue request, SQLite atomically inserts `delivery_id` as the primary key and `(run_id, run_attempt)` as a second unique constraint. The database uses WAL, `synchronous=FULL`, and a single active process enforced by the service `flock`.
- State semantics are: `dispatching` is a pre-POST reservation; `submitted` is the durable no-retry boundary; `queued` stores the validated same-origin numeric queue item identity; `running` stores the build number/URL; and `completed` stores the terminal result. Startup retries only interrupted pre-submit `dispatching`. Legacy `dispatching`/`failed` rows are conservatively migrated to `submitted` because their POST outcome is ambiguous.
- A reservation or `submitted` write failure performs no Jenkins credential read or queue call. After `submitted`, an enqueue error or a failed queued-state write remains non-retryable and returns non-success. Signed replays only reconcile the persisted queue item, exact job queue, and retained build history; an empty queue/build result remains unknown and never authorizes a second POST. Operators must investigate persistently unknown submissions instead of deleting or resetting their SQLite rows. Rejected paths log only bounded outcome codes, never the secret, signature, or payload.
- The gateway webhook secret and its minimal Jenkins API token are separate systemd credentials. The Jenkins principal has only read/build access to the one disabled-by-default job plus queue/build read for reconciliation; it has no Jenkins credential, GHCR, Docker, target-host, Configure, or Administer access.
- Removing the SQLite state, allowing more than one gateway process, reintroducing Generic Webhook Trigger, bypassing the gateway, or widening the gateway principal is a No-Go and rollback condition.
