# K8s + ArgoCD GitOps 现代部署改造方案

本文档记录 Stationary 从“单仓单容器 Kustomize + Bot 直推 `main`”向“**双仓分离 + Tag 发布 + OCI Helm Chart + Gateway API**”架构演进的设计方案与分步实施计划。

---

## 1. 现状盘点与核心问题

### 1.1 仓库与流水线现状

- **CI/CD 耦合源码分支**：`.github/workflows/deploy.yaml` 在推送 `main` 后构建镜像，并由 `github-actions[bot]` 直接提交 `ci(gitops): deploy <sha> [skip ci]` 回写 `deploy/k8s/overlays/production/kustomization.yaml`，污染提交历史且与分支保护冲突；同时发布流水线未前置运行 `typecheck` / `oxlint` / 测试门禁。
- **单容器多进程耦合**：`Dockerfile` + `docker/entrypoint.ts` 将 Caddy (`4000`)、Nuxt (`3000`)、Hono API (`9400`) 与 `QueueWorker` 打进同一个容器，在 K8s 中形成了 `Traefik -> NodePort -> Caddy -> Nuxt/Hono` 的冗余转发。
- **探活与迁移缺失**：
  - `apps/server/src/index.ts` 目前只有根路径 `/` 返回 `"Hello Hono!"`，缺少检查 DB / Redis 的 `/api/health` 探活端点。
  - 镜像未打包 `apps/server/drizzle/` SQL 迁移目录，K8s 也没有 `PreSync` 迁移任务（`apps/server/package.json` 的 `db:migrate` 目前是开发期用的 `drizzle-kit generate && drizzle-kit push`）。
- **队列与数据库连接池约束**（见 `docs/job_queue.zh-Hans.md`）：
  - `QueueWorker` 与 API 同进程运行，当 `MAX_STUCK_RUNS`（8 次）触发进程重启时会连带中断 API；同时 `QueueWorker` 已改用 PostgreSQL 轮询而非 `LISTEN/NOTIFY`，天然支持拆分为独立进程。
  - 按工作负载显式配置 `DB_POOL_MAX`，避免多组件或滚动更新时数据库连接数突增。
  - `apps/server/src/features/media/create-from-draft.ts` 等接口也会直接调用 `ffmpeg` / `ffprobe` / `magick`，因此 API 与 Worker 均需媒体处理工具链，可共用同一个 server 镜像；而 `web` 只需纯 Node 运行时。

### 1.2 目标集群环境特征

- **节点环境**：单节点 `amd64`（`x86_64`），`k3s v1.36.2+k3s1`。
- **ArgoCD**：`v3.5.2`，原生支持 OCI Helm Chart、`ApplicationSet`、`PreSync` Hook 及 `ServerSideApply`。
- **网关与流量入口**：
  - 集群已预装 Gateway API CRD（`GatewayClass`、`Gateway`、`HTTPRoute` 等），k3s 内置 Traefik 通过 `HelmChartConfig` 启用 `kubernetesGateway` provider。
  - 公网流量经宿主机 Tunnel 进入集群，切流时需先确保 Traefik `:80` 路由就绪再切换 Tunnel 指向，最后移除旧 `NodePort`。
- **密钥管理**：通过 `sealed-secrets` 将加密后的 `SealedSecret` 纳入 GitOps。

---

## 2. 目标架构

采用 **App Repo + Cluster/Infra Repo 双仓分离** 与 **Tag 驱动的 OCI Helm 发布**：

```text
[stationary 源码仓]
  ├─ main 分支：日常开发，仅跑 lint / typecheck / test
  └─ 打 v* Tag（如 v0.1.0）
       ├─ 1. 跑 CI 门禁（typecheck + oxlint + unit tests）
       ├─ 2. 构建并推送 linux/amd64 镜像到 GHCR：
       │     ├─ ghcr.io/stariverr/stationary-web:<tag>
       │     └─ ghcr.io/stariverr/stationary-server:<tag>（API / Worker / Migrate 共用）
       ├─ 3. 打包并推送 Helm Chart 到 GHCR OCI：
       │     └─ oci://ghcr.io/stariverr/charts/stationary:<version>
       └─ 4. 发送 repository_dispatch 到集群仓

[stariverr/stationary-gitops 集群仓]
  ├─ bootstrap/         # ArgoCD App-of-Apps / ApplicationSet 入口
  ├─ infra/             # Traefik Gateway HelmChartConfig、Gateway、SealedSecrets Controller
  ├─ apps/stationary/   # Application + values.yaml + SealedSecret
  └─ GitHub Actions     # 接收 dispatch -> 更新版本并开 PR（合并后触发 ArgoCD Sync）

[hydro@rewind k3s]
  ├─ ArgoCD PreSync Hook：stationary-migrate Job（执行 SQL 迁移）
  ├─ stationary-web Deployment + ClusterIP (:3000)
  ├─ stationary-server Deployment + ClusterIP (:9400)
  ├─ stationary-worker Deployment（QueueWorker + 定期清理）
  └─ Traefik Gateway API HTTPRoute：/api -> server:9400，/ -> web:3000
```

### 设计原则

1. **源码仓零机器人提交**：`stationary` 的 `main` 分支只放源码、镜像构建与 Chart 模板，可正常启用分支保护。
2. **版本原子对齐**：`web`、`server`、`worker` 与 `db-migrate` 通过 Helm Chart 的统一版本/tag 联动发布，避免多组件版本错位。
3. **保留单机 Docker Compose 体验**：根目录 `Dockerfile` 默认 target 与 `docker-compose.yml` 继续保留 Caddy 一体镜像供本地/单机自托管使用；K8s 使用拆分后的轻量镜像目标。
4. **不保留过时 K8s 兼容层**：新方案上线并验证稳定后，直接清理旧的 `deploy/k8s/`、`deploy/argocd/` 与 `.github/workflows/deploy.yaml`。

---

## 3. 分层实施计划

### Layer 1：应用就绪改造（`stationary` 代码层）

1. **新增健康检查接口**：在 `apps/server` 增加 `GET /api/health`，检测进程存活与 PostgreSQL（`SELECT 1`）/ Redis（`PING`）连通性，供 K8s `readinessProbe` 与 `livenessProbe` 使用。
2. **拆分运行模式（API vs Worker）**：
   - 将 `apps/server/src/index.ts` 中的 `QueueWorker` 与 `startFilePurgeSchedule()` 解耦为可配置的启动模式（或独立入口 `worker.ts`）：
     - `api` 模式：仅启动 Hono HTTP 服务（`9400`），不跑队列与定时任务。
     - `worker` 模式：仅启动 `QueueWorker` 与 `startFilePurgeSchedule()`，负责消费任务队列与优雅排空（`queueWorker.drain()`）。
     - `all` 模式（默认）：保持两者同进程运行，兼容 `bun run dev` 与 `docker-compose.yml`。
3. **生产级 SQL 迁移入口**：
   - 新增迁移执行脚本（如 `apps/server/src/db/migrate.ts`），使用 `drizzle-orm/node-postgres/migrator` 确定性地执行 `apps/server/drizzle/` 下已提交的 SQL 迁移文件，替代开发期的 `generate && push`。
4. **数据库连接池配置**：
   - K8s 配置中按工作负载显式设置 `DB_POOL_MAX`（例如 `server: 5`、`worker: 5`、`migrate: 2`），控制并发连接规模。

### Layer 2：多 Target 容器镜像与 OCI Helm Chart（`stationary` 打包层）

1. **扩展 `Dockerfile` 多 Target（`linux/amd64`）**：
   - 保留默认 `release` target（含 Caddy + Nuxt + Hono）不破坏 `docker-compose.yml`。
   - 新增 `web-release` target：基于 `node:alpine`，仅拷贝 `apps/web/.output`。
   - 新增 `server-release` target：基于 `oven/bun:alpine`，安装 `ffmpeg`、`imagemagick`、`imagemagick-heic`、`imagemagick-jxl`，拷贝 `/app/server/index.js`、`worker.js`、`migrate.js` 及 `apps/server/drizzle/`。
2. **创建 `charts/stationary/` Helm Chart**：
   - `stationary-web`：`Deployment` + `ClusterIP Service (3000)`，注入 `NUXT_API_BASE_URL=http://stationary-server:9400/api` 让 SSR 走集群内网直连后端。
   - `stationary-server`：`Deployment` + `ClusterIP Service (9400)`，探活指向 `/api/health`，挂载 `/tmp` `emptyDir`（配置 `sizeLimit`）。
   - `stationary-worker`：`Deployment`（无 Service），配置 `terminationGracePeriodSeconds: 45` 覆盖 `queueWorker.drain()` 与中断收尾，挂载 `/tmp` `emptyDir`。
   - `stationary-migrate`：`Job`（带 `argocd.argoproj.io/hook: PreSync` 与 `argocd.argoproj.io/hook-delete-policy: BeforeHookCreation`），每次同步新版本前自动跑迁移。
   - `HTTPRoute`（Gateway API）：绑定 `stationary.stariver.xyz`，将 `/api` 路由到 `stationary-server:9400`，其余 `/` 路由到 `stationary-web:3000`。
   - `ConfigMap` 与外部 `Secret` 引用（默认引用 `stationary-secrets`）。
3. **Tag 驱动的发布 Workflow**：
   - 新建 `.github/workflows/release.yaml`（触发条件：`push` tag `v*` 或 `workflow_dispatch`）：
     1. 运行 `bun run typecheck`、`bunx oxlint` 与单元测试。
     2. 构建并推送 `stationary-web:<tag>`、`stationary-server:<tag>`（`platforms: linux/amd64`）。
     3. 执行 `helm package` 与 `helm push` 到 `oci://ghcr.io/stariverr/charts/stationary`。
     4. 调用 GitHub `repository_dispatch` 通知集群仓更新版本。
   - 保留并扩展 `.github/workflows/ci.yaml`，在 `main` 分支和 PR 上持续运行检查。

### Layer 3：建立集群 GitOps 仓库（`stationary-gitops`）

1. **GitOps 仓库 `https://github.com/stariverr/stationary-gitops`**，推荐结构：
   ```text
   stationary-gitops/
   ├── .github/workflows/bump-stationary.yaml  # 接收 dispatch，更新版本号并创建 PR
   ├── bootstrap/
   │   └── root-app.yaml                       # ArgoCD App-of-Apps 入口
   ├── infra/
   │   ├── traefik-gateway/
   │   │   ├── helmchartconfig.yaml            # 开启 k3s Traefik kubernetesGateway provider
   │   │   └── gateway.yaml                    # 定义共用 Gateway (port 80)
   │   └── sealed-secrets/                     # Bitnami Sealed Secrets 控制器
   └── apps/
       └── stationary/
           ├── application.yaml                # 引用 oci://ghcr.io/stariverr/charts/stationary
           ├── values.yaml                     # 域名、副本数、DB_POOL_MAX、资源配额
           └── sealed-secret.yaml              # 加密后的 stationary-secrets
   ```
2. **集群侧一次性准备**：
   - 先保持兼容 `http://127.0.0.1:30000` 或部署完 Gateway + `HTTPRoute` 后，在 Cloudflare Zero Trust Tunnel 后台将 `stationary.stariver.xyz` 从 `http://127.0.0.1:30000` 改指 `http://127.0.0.1:80`（Traefik），验证通过后再移除旧的 `NodePort: 30000`。
   - 配置 ArgoCD 读取私有 `stationary-gitops` 仓库与 GHCR OCI Chart/镜像拉取凭证（以及 GitHub Webhook 加速同步）。
   - 使用 `kubeseal` 将现有集群内的 `stationary-secrets` 加密导出为 `sealed-secret.yaml` 提交进 `stationary-gitops`。

### Layer 4：切换上线、验证与旧配置清理

1. **平滑切换**：在 `hydro@rewind` 应用 `bootstrap/root-app.yaml`，验证 Traefik `Gateway`、`HTTPRoute`、首次 `PreSync` 迁移与三个拆分后的 Pod 全部 `Running / Ready`，并确认公网 `https://stationary.stariver.xyz` 访问及后台队列正常。
2. **端到端发布演练**：在 `stationary` 打一个测试 Tag（如 `v0.1.0`），验证 `CI 门禁 -> GHCR 镜像 & OCI Chart -> stationary-gitops 自动 PR -> 合并 -> ArgoCD 自动迁移并滚动发布` 全流程。
3. **清理旧路径**：确认无回滚需求后，移除 `stationary` 仓库内的 `deploy/` 与旧 `.github/workflows/deploy.yaml`，更新 `README.md` / `docs/README.zh-Hans.md` 的部署说明。

---

## 4. 关键注意事项与风险点

- **Tunnel 断流风险**：切勿在将 Tunnel 改指 Traefik `:80` 并验证通过前移除旧 `NodePort`。
- **ArgoCD 资源接管冲突**：接管前需先移除旧资源上的 `argocd.argoproj.io/tracking-id` 注解并做非级联删除，避免新应用同步时误删旧 Pod 与 Namespace。
- **GHCR 私有包鉴权**：`stationary-web`、`stationary-server` 与 `charts/stationary` 首次创建后默认私有；需将包设为 Public，或在集群配置 `imagePullSecrets` 与 ArgoCD OCI 仓库凭证。
- **Drizzle 迁移基线对齐**：从 `drizzle-kit push` 切换为 SQL `migrate()` 前，需先完成各环境数据库 `drizzle.__drizzle_migrations` 表的基线对齐。
