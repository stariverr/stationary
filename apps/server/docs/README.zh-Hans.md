# Stationary Backend (Server - 简体中文)

> [English](../README.md)

后端基于 **Bun** 运行时、**Hono** 框架以及 **Drizzle ORM** 构建。主要负责管理元数据、与 S3 兼容的对象存储交互、处理基于 Better Auth 的用户鉴权，以及调度基于 Upstash Workflow 的分布式媒体文件下载同步任务。

---

## 🛠️ 本地开发

### 1. 安装依赖
请确保在根目录使用 Bun 安装依赖：
```bash
bun install
```

### 2. 启动开发服务器
```bash
# 在 apps/server 目录下
bun run dev
```
开发服务器会以热重载模式运行在 `http://localhost:9400` 上。

### 3. 类型检查与构建
- **类型检查**：`bun run typecheck`
- **构建生产文件**：`bun run build`（输出至 `./dist`）

---

## 🗄️ 数据库操作 (Drizzle ORM)

项目使用 PostgreSQL 作为关系型数据库。表结构定义均位于 `src/db/schema/index.ts`，逻辑关联关系声明位于 `src/db/schema/relations.ts`。

#### 1. 结构变更与同步
当修改了 `schema/index.ts` 文件后，通过以下命令生成迁移 SQL 并同步推送至数据库：
```bash
bun run db:migrate
```
该命令在底层执行 `drizzle-kit generate` 与 `drizzle-kit push`，实现 Schema 的自动更新。

#### 2. Drizzle 配置
配置文件位于 `drizzle.config.ts`。

---

## 🔄 后台任务队列 (Background Job Queue)

下载、封面、头像和 AI 工作都跑在 PostgreSQL 里的调和队列（`job_queue`）和进程内的 `QueueWorker` 上（`src/infra/queue`）。

### 1. 核心设计原则
- **调和而不是重放**：写入方在同一个事务里报告对象的哪个方面变了（`markChanged`）；每条流水线读取对象的当前状态，把产出补到最新。每个队列、每个对象只有一行，重复的变化会合并。
- **租约与 Fencing**：认领用 `FOR NO KEY UPDATE SKIP LOCKED`，租约按数据库时钟计时，由心跳续期。先写结果再 fence 队列行，丢了租约的 worker 提交不了。
- **至少一次执行**：崩溃后同一次运行可能重复，所以 handler 必须幂等。
- **自动恢复**：过期租约由下一次认领回收；每小时巡检会扫描每个库，补上写入方漏报的工作。

> 📖 **规范**：队列和封面规则见 [系统设计与数据库规范第 6 节](../../../docs/system_design.zh-Hans.md#6-后台任务队列-background-job-queue)，完整设计见 [job_queue.zh-Hans.md](../../../docs/job_queue.zh-Hans.md)。

---

## 📦 对象存储目录规范 (S3)

物理资产统一保存在 S3 中，存储桶由 `.env` 中的 `S3_BUCKET` 指定。
在 `TaskService` 中，物理资产的存储路径（S3 Key）遵循以下防碰撞命名规约：

- **媒体资产**：
  `v2/p/{postId.slice(-2)}/{postId}/{media_index}_{role}.{ext}`
  - *例如*：`v2/p/a3/550e8400-e29b-41d4-a716-4466554400a3/0_PRIMARY.jpg`
  - 角色（role）后缀包括：`file` (PRIMARY), `alt` (ALTERNATIVE), `live` (LIVE_PHOTO_VIDEO), `cover` (COVER)。
- **博主头像**：
  `v2/a/{authorId.slice(-2)}/{authorId}/original.{ext}`

---

## 🔑 认证与用户流转

系统使用 **Better Auth** 驱动底层鉴权（账号密码登录，GitHub/Google 三方登录），API 入口为 `app.all("/api/auth/*")`。

1. **业务用户同步钩子**：
   在 `src/lib/auth/index.ts` 的 `databaseHooks` 中，注册了 `user.create.after` 钩子。每当 Better Auth 建立一个新账户，会自动在业务表 `User` 中插入一条对应的用户记录，将鉴权 ID 与业务 ID 关联。
2. **鉴权中间件**：
   - `authMiddleware`：非强制校验，若 Request Header 中携带有效 Cookie/Token，则解析 Session 并在 Context 中注入 `c.get("authUser")` 及业务 `c.get("user")` 实体。
   - `requireAuth`：强制鉴权。如未登录或业务用户档案不存在，则返回 `1004` (UNAUTHORIZED) 错误响应。
