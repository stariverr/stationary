# Stationary (简体中文)

> [English](../README.md)

Stationary 是一个专为创意工作者与内容管理者打造的 **多平台媒体资产管理与集成平台 (MAM)**。它不仅能够作为社交媒体内容（如 X/Twitter、小红书、Bilibili、抖音、TikTok、Instagram 等）的聚合器，更支持高度可定制的多租户媒体库（Library）与协作机制，实现高质量资产的幂等同步、本地持久化归档与快速检索。

---

## 🌟 核心特性

- **多平台元数据同步**：支持对接主流海内外平台文章、标题、标签、发布时间以及复杂的媒体流。
- **高可靠性资产下载流**：利用 Upstash Workflow 与 QStash 驱动的分布式任务系统，实现断点续传、失败重试与并发防抖限制。
- **智能排重与变更检测**：在文件、文章及作者维度进行哈希校验，物理资产改动时自动执行差异更新与 S3 异步软删除清理。
- **无外键松耦合架构**：数据库设计抛弃物理外键约束，采用高性能的逻辑关联，更适应未来的分布式扩展。
- **双轨制展示系统**：前端提供“看板视图”（Post Board）与“平铺/堆叠”双模媒体流（All Pins），满足多样化检索诉求。
- **多租户权限体系**：支持用户组（UserGroup）及细粒度的媒体库（Library）级别权限控制（VIEWER / EDITOR / ADMIN）。

---

## 📂 项目结构

本项目采用 **Bun Workspace Monorepo** 架构：

```text
/ (根目录)
├── apps/
│   ├── server/           # 后端服务：基于 Bun, Hono, Drizzle ORM, Better Auth, Upstash Workflow
│   └── web/              # 前端应用：基于 Nuxt 4, Vue 3, Pinia, Vue Query, Tailwind CSS v4
├── docs/                 # 系统架构、数据契约与流程规约设计文档
└── package.json          # 根 Monorepo 包配置
```

---

## 🛠️ 技术栈

### 后端 (Backend)
- **运行环境**：Bun
- **Web 框架**：Hono (基于 TypeScript)
- **ORM**：Drizzle ORM (配合 PostgreSQL 驱动 `pg`)
- **异步任务**：Upstash Workflow & QStash (用于可靠的长耗时后台下载任务)
- **物理存储**：S3-compatible Object Storage (如 AWS S3, Cloudflare R2 等)
- **缓存/分布式锁**：Redis (用于限流、分布式锁与去重缓存)

### 前端 (Frontend)
- **应用框架**：Nuxt 4 (Nuxt Minimal / Full CSR-SSR)
- **状态管理**：Pinia Stores
- **数据流与缓存**：TanStack Vue Query
- **样式方案**：Tailwind CSS v4 (配合 `@tailwindcss/vite` 编译器)
- **组件库**：Reconstruct UI / Shadcn Vue & Lucide Icons
- **多语言**：`@nuxtjs/i18n` (内置 10+ 种常用语言包)
- **播放器/滑动器**：Plyr (视频播放), Swiper (轮播图)

---

## 🚀 快速上手

### 1. 安装依赖

在项目根目录下执行：

```bash
bun install
```

### 2. 环境变量配置

请分别在后端和前端的子目录中创建 `.env` 配置文件：

- **后端**：参考 `apps/server/.env.example` 创建 `apps/server/.env`，重点配置数据库连接、S3、QStash 凭证。
- **前端**：参考 `apps/web/.env` 配置 `NUXT_PUBLIC_API_BASE_URL` 指向后端地址（开发环境一般为 `http://localhost:8080`）。

### 3. 初始化数据库

在 `apps/server` 目录下，利用 Drizzle 迁移和推送工具快速同步表结构：

```bash
cd apps/server
bun run db:migrate
```

### 4. 启动开发服务器

在项目根目录下，直接启动前后端并行开发环境：

```bash
# 同时启动 Hono 后端 (localhost:8080) 和 Nuxt 前端 (localhost:4000)
bun run dev:server
bun run dev:web
```

---

## 📖 深度设计文档

详细的模块与业务流转设计可前往 `docs/` 查阅：
- **[系统设计与数据库规范说明](file:///Users/kazuha/dev/stationary/docs/system_design.zh-Hans.md)**
- **[媒体元数据同步工作流 & API 契约](file:///Users/kazuha/dev/stationary/docs/external_api.contract.zh-Hans.md)**
- **[Metadata 物理保存与清理流程详细说明](file:///Users/kazuha/dev/stationary/docs/save_metadata_flow.zh-Hans.md)**
- **[TypeScript 编写规范与避坑指南](file:///Users/kazuha/dev/stationary/docs/code.rule.zh-Hans.md)**
