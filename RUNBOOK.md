# PlaneGameCode 运维手册（发布候选；未上线）

## 组件和边界

单服务静态页面由非特权 Nginx 容器提供，专用 Compose 网关仅绑定经审计的 `127.0.0.1:APP_PORT`。网关把流量转给 `plane-game-<完整 SHA>` 容器；候选和上一健康版本可并存。既有生产 Nginx、根域、www、DNS、证书都不由这些脚本修改。单服务的 GitHub Actions、Compose、Nginx 和健康检查满足演练范围，无需 K8s/Jenkins/Nacos/Apollo。

## 发布前门禁与不可变候选

Operations Lead 先做目标服务器的只读审计：端口、现有容器、专属 Nginx 配置与 `www` 基线；`APP_PORT` 只能使用这份审计中记录的空闲 `127.0.0.1` 端口，不能从开发机或猜测值取得。在目标机放置经审查的仓库版本，并准备 Docker Engine、Compose、curl、Bash、`sha256sum` 和已拉取的不可变镜像。只通过受控凭据通道配置 `DEPLOY_*`、`GHCR_READ_TOKEN` 等；仓库不保存值。

同一候选必须先由 QA 以完整 Git SHA 和镜像 digest 签署，再由 Operations Lead 复审服务器审计和演练记录；两项结论齐备前，CEO 不得批准公开切换。GitHub Actions `Checks` 面向 PR/main；`Controlled deployment` 在 main push CI 成功后自动触发，须经 `production` 环境保护规则批准。

发布输入是五个显式值：

```text
FULL_SHA IMAGE_REPOSITORY APPROVED_IMAGE_DIGEST AUDITED_LOOPBACK_PORT GATEWAY_IMAGE
```

`APPROVED_IMAGE_DIGEST` 必须是 `sha256:<64-hex>`。脚本只接受 `IMAGE_REPOSITORY@APPROVED_IMAGE_DIGEST`，并验证其 OCI `org.opencontainers.image.revision` 标签等于 `FULL_SHA`；仅有可变的 `:SHA` 标签不足以通过检查。网关 `GATEWAY_IMAGE` 必须为 `nginxinc/nginx-unprivileged@sha256:<64-hex>`，渲染后的 Compose 只有这一个镜像。正在运行的网关镜像 ID 若与该 digest 不符，更新和回滚均停止，等待独立审查的网关迁移。

部署工作流在推送后解析 manifest digest，拉取该 digest，再把同一组值传给部署脚本。

## 只读预检与发布

手动只读预检：

```bash
./deploy/deploy.sh --dry-run FULL_SHA IMAGE_REPOSITORY APPROVED_IMAGE_DIGEST AUDITED_LOOPBACK_PORT GATEWAY_IMAGE
```

预检检查参数、Docker daemon、Compose 语法、已在本机的 immutable image digest + revision label，以及已存在网关的 Docker 健康状态和本地 `GET /healthz`。没有网关时只检查经审计端口是否可用。它**不会** pull/run/start/stop/remove/reload/rename 容器，不创建网络，也不写 `runtime/` 或部署配置；因此不会替代实际容器或网关演练。网关 Nginx 语法在实际切换前通过现有专属 gateway 容器的 `nginx -t` 验证。

正式命令去掉 `--dry-run`。候选以 digest 启动、等待 Docker 健康状态，并校验容器内 `version.json` 的 SHA 后才写专属路由。每次成功发布写入：

- `runtime/releases/<SHA>/release.env`：SHA、镜像仓库/digest、网关镜像 digest、配置 revision、gateway 配置 digest、健康状态和时间；
- `runtime/releases/<SHA>/gateway.conf`：可验证的上一健康 gateway 配置；
- `runtime/deployment-snapshots/<UTC>-<SHA>/state.env`：部署前路由/config 快照、网关镜像 digest、结果和时间。

首次发布没有 `previous_healthy_sha` 时，如果 gateway 启动或切换校验失败，脚本只删除本轮 `plane-game-<SHA>` 容器、必要时删除本轮创建的 `plane-game_default` 网络和 gateway，并撤销本轮专属 `runtime/active/upstream.inc`。它不会恢复空 upstream，也不会操作 www、根域、其他 Nginx server block 或其他 Compose 项目。

## 健康、日志与故障

- `curl -fsS http://127.0.0.1:APP_PORT/healthz` 应返回 `{"status":"ok"}`；`curl -I http://127.0.0.1:APP_PORT/` 检查首页。
- `docker compose ps`、`docker inspect -f '{{.State.Health.Status}}' plane-game-FULL_SHA` 查看状态；`docker compose logs --tail=100 gateway`、`docker logs --tail=100 plane-game-FULL_SHA` 查看日志。启动事件记录端口和版本；Nginx access/error 可由容器日志查看。
- 真实生产需由 Operations Lead 单独验证子域解析、TLS、专属 Nginx `nginx -t`、证书续期 `certbot certificates` 和前后 www 探针。异常时立即停止本应用变更，通知 CTO 与 Operations Lead；现有域名和服务不由本脚本操作。

## 故障回滚

读取 `runtime/previous_healthy_sha`，确认其与发布记录一致，然后执行：

```bash
./deploy/rollback.sh --dry-run PREVIOUS_HEALTHY_SHA AUDITED_LOOPBACK_PORT
./deploy/rollback.sh PREVIOUS_HEALTHY_SHA AUDITED_LOOPBACK_PORT
```

回滚**不要求当前版本健康**：当前故障正是触发条件。它要求并验证上一健康版本的 release record、镜像 digest/revision label、保存的 gateway 配置 digest、上一容器健康和 `version.json`；只有这些真实存在才会恢复保存的专属 gateway 配置并切换路由。任一校验或切换失败都会恢复本次操作前的专属 route/config，不触及其他服务。成功输出包含起止 SHA、digest、配置 revision、健康状态、UTC 时间与 `duration_seconds`。

记录操作者、触发原因、命令输出、`/healthz`、首页、两端 SHA/digest/config revision 和恢复耗时；由 Operations Lead 单独完成 www 前后只读探针。若上一容器或其记录不健康，保持现状并升级给 Operations Lead/CTO。证书续期和生产站点配置由单独运维任务负责。

## 非生产演练记录

在隔离的 Docker 主机/目录中，用与 QA 签署相同的 SHA + digest 依次记录以下两条命令及完整输出：

1. 首发故障：让候选在健康或 route 校验阶段失败；确认 `runtime/deployment-snapshots/.../state.env` 是 `outcome=reverted`，`runtime/active/upstream.inc` 不存在（若部署前不存在），本轮容器、gateway 和本轮网络均已删除。
2. 更新故障回退：保留一个真实 `previous_healthy_sha` 的健康容器和 release record，使当前版本的应用健康检查失败；执行回滚并确认输出的 `previous_health=healthy`、`duration_seconds`、回退后的 `/healthz`/`version.json`，以及保存的 gateway config digest。

演练记录必须包含 SHA、digest、配置 revision、健康状态、回滚耗时和 `docker compose ps`；不把预检输出误称为演练。任何实际服务器操作仍只限本应用 Docker/回环端口/专属站点，且在 CEO Go/No-Go 前不得公开切换。

## 当前限制

离线候选不代表上线：还需真实 CI、授权、独立 QA/首用验收、运维基线、DNS/TLS、专属站点、真实部署与回滚证据。告警入口为受控部署环境的工作流失败和 Operations Lead 的容器健康巡检；密钥仅在 GitHub Environment 和 Paperclip Secrets 管理，必要时按运维账户流程轮换。

## Automatic CD (pending production verification)

A successful `Checks` **push to protected main** starts `Controlled deployment` through
`workflow_run`. Failed CI and pull-request checks do not build or publish a release.
The build job rechecks the exact main commit, runs the project checks and browser
tests, builds a container for the full commit SHA, checks container health,
homepage and the exact `version.json` SHA, pushes the image to GHCR and records
its immutable digest. It archives `compose.yaml` and `deploy/` from that SHA.
The production job waits for the GitHub `production` environment reviewers,
rechecks the current main SHA, verifies the archived checksum locally and on the
host. It streams the archived executable `deploy/plane-preflight` via pinned-key,
public-key-only SSH before transfer, GHCR login or pull. It then passes SHA,
application and gateway digests, port and GitHub run number to the promoter.

Operations must configure `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
`DEPLOY_KNOWN_HOSTS`, `GHCR_READ_TOKEN` as production environment secrets, and `GHCR_READ_USER` as a production variable, and
`DEPLOY_PORT` as a production variable after independent host preflight.
`DEPLOY_KNOWN_HOSTS` must be a pinned, independently verified host key, never
a fresh `ssh-keyscan` result obtained in the workflow. The dedicated deploy user
must be the fixed `plane-preflight` account, with no sudo entitlement,
privileged groups or writable rootful Docker socket. The host gate verifies the
non-root UID, home, and the same account's rootless Docker daemon at
`/run/user/$(id -u)/docker.sock`; rootful Docker, root login and free choice
of host port are rejected. The only application listener is the audited
`127.0.0.1:DEPLOY_PORT`. Production Nginx, DNS and TLS remain Operations work.
Keep environment review and the first public cutover gated by CEO approval; an
automatic workflow trigger does not mean an unattended public release.

The remote account uses `$HOME/plane-game` as its dedicated application root.
It verifies the source archive checksum before extraction, saves the previous
source, rejects older GitHub run numbers, applies this commit's Compose and
scripts, and calls `deploy.sh`. The deployment verifies rootless digest binding and the immutable Compose gateway
reference, records that gateway digest in release and rollback state,
container health, the loopback `/healthz`, homepage and exact `version.json`
before recording a healthy release. On failure it restores the previous source
and validates the previous route; incomplete recovery emits `ALERT` and fails
the Actions job. First-release failures use resource ownership labels to remove
only this application's new containers, network and route. The local run marker
does not decrease on rollback. A failed Actions run must be investigated by
Operations and the CTO before another release.

To finish acceptance, capture the real Actions run URL, SHA, immutable digest,
host and public before/after checks, failure drill and recovery records for the
same approved candidate. Local tests and this runbook do not substitute for
an actual production-environment review or host exercise.

The build job also requires repository variables `NODE_BASE_IMAGE` and
`NGINX_BASE_IMAGE` with independently reviewed sha256 digests for the
specified Node and Nginx image tags. It builds the fixed linux/amd64 platform
from those digests and refuses to publish if either pin is missing. Local
development and the earlier CI smoke still use the Dockerfile tag defaults;
production release builds always supply immutable base image references.
