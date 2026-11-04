# PlaneGameCode 运维手册（发布候选；未上线）

## 组件和边界

单服务静态页面由非特权 Nginx 容器提供，专用 Compose 网关仅绑定经审计的 `127.0.0.1:APP_PORT`。网关把流量转给 `plane-game-<完整 SHA>` 容器；候选和上一健康版本可并存。既有生产 Nginx、根域、www、DNS、证书都不由这些脚本修改。单服务的 GitHub Actions、Compose、Nginx 和健康检查满足演练范围，无需 K8s/Jenkins/Nacos/Apollo。

## 预备与发布

Operations Lead 先审计端口、现有容器及 Nginx 配置，并获得受保护部署环境的授权；在目标机放置此仓库经审查的版本，准备 Docker Engine、Compose、curl、Bash 和可拉取的不可变 `IMAGE_REPOSITORY:SHA`。只通过受控凭据通道配置 `DEPLOY_*`、`GHCR_READ_TOKEN` 等；仓库不保存值。GitHub Actions `Checks` 面向 PR/main；`Controlled deployment` 仅对 main 上显式手动触发，须经 `production` 环境保护规则批准。先审核 checks 和 QA 结论，部署工作流在受控账户拉取 SHA 镜像并运行部署脚本。

手动预检：`./deploy/deploy.sh --dry-run FULL_SHA IMAGE_REPOSITORY APP_PORT`。预检核对 40 位 SHA、仓库名、端口范围及占用、Docker 镜像、Compose 和应用/网关 Nginx 配置、当前路由的 `/healthz`；不切换流量。正式命令去掉 `--dry-run`。先启动候选容器并等待 Docker 健康状态，通过后校验网关配置并重载；失败恢复原路由。脚本记录 `runtime/active_sha` 和 `runtime/previous_healthy_sha`；留存上一个健康容器，待下一次部署或回滚确认后按运维保留政策清理旧容器。

## 健康、日志与故障

- `curl -fsS http://127.0.0.1:APP_PORT/healthz` 应返回 `{"status":"ok"}`；`curl -I http://127.0.0.1:APP_PORT/` 检查首页。
- `docker compose ps`、`docker inspect -f '{{.State.Health.Status}}' plane-game-FULL_SHA` 查看状态；`docker compose logs --tail=100 gateway`、`docker logs --tail=100 plane-game-FULL_SHA` 查看日志。启动事件记录端口和版本；Nginx access/error 可由容器日志查看。
- 真实生产需由 Operations Lead 单独验证子域解析、TLS、专属 Nginx `nginx -t`、证书续期 `certbot certificates` 和前后 www 探针。异常时立即停止本应用变更，通知 CTO 与 Operations Lead；现有域名和服务不由本脚本操作。

## 回滚

读取 `runtime/previous_healthy_sha`，确认其与运维记录一致，然后执行 `./deploy/rollback.sh --dry-run previous_healthy_sha APP_PORT`；通过后执行 `./deploy/rollback.sh previous_healthy_sha APP_PORT`。脚本只接受明确的上一健康 SHA，并在切换前验证当前健康、上一容器健康和 Compose 语法；切换失败会恢复原路由。记录操作者、UTC 起止时间、两端 SHA、触发原因、`/healthz` 与首页结果、恢复耗时、www 前后探针；若上一容器不健康则不切换，升级给 Operations Lead/CTO。证书续期和生产网关配置由单独运维任务负责。

## 当前限制

离线候选不代表上线：还需真实 CI、授权、独立 QA/首用验收、运维基线、DNS/TLS、专属站点、真实部署与回滚证据。告警入口为受控部署环境的工作流失败和 Operations Lead 的容器健康巡检；密钥仅在 GitHub Environment 和 Paperclip Secrets 管理，必要时按运维账户流程轮换。
