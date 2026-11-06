# 飞机打英语 · 发布候选

中文静态网页：看中文题目，移动鼠标或手指控制飞机，点击或触控发射；击中对应英文词加 10 分，错误命中或漏掉正确词扣 1 颗生命。3 颗生命耗尽后可重开。包含开始、暂停、继续、重开和结算，不需要登录或收集个人信息。词库在 `src/words.js`；规则和状态在 `src/game.js`，DOM 绘制在 `src/main.js`。

## 本地开发和验证

Node.js 24、pnpm 10；执行 `pnpm install --frozen-lockfile`、`pnpm dev`，打开 `http://127.0.0.1:4173/`。`pnpm lint` 校验 JS 语法；`pnpm format --check` 校验换行与行尾空白，`pnpm format` 自动规范化；`pnpm test` 校验判题、碰撞、计分和状态。`pnpm build` 产出 `dist/`；`node tools/serve.mjs --dist` 本地预览。安装浏览器 `pnpm exec playwright install chromium` 后用 `pnpm test:e2e` 验证桌面和移动视口的完整游戏流程。

开发服务器和容器均提供 `/healthz`，用 `curl -fsS http://127.0.0.1:4173/healthz` 复核。容器：`docker build -t plane-game:local .`；`docker run --rm -p 127.0.0.1:4180:8080 plane-game:local`，再用 `curl -fsS http://127.0.0.1:4180/healthz` 和 `docker inspect` 查看健康。发布镜像必须使用完整不可变 Git SHA 标签；专用回环网关 Compose、预检、部署和回滚见 [RUNBOOK](RUNBOOK.md)。

工作流 `.github/workflows/checks.yml` 在 PR/main 运行重型校验与容器 smoke，并仅在受保护 main 成功后发布 GHCR 不可变 digest；Jenkins 候选仅负责同机 rootless 轻量 CD、健康/version 校验和回滚。当前资源门禁未满足，未安装 Jenkins、未部署、未声称远端 CI/Jenkins 已执行；迁移与凭据边界见 [RUNBOOK](RUNBOOK.md)。
