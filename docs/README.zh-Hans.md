# Stationary (简体中文)

> [English](../README.md)

Stationary 是一个专为创意工作者与内容管理者打造的 **多平台媒体资产管理与集成平台 (MAM)**。它不仅能够作为社交媒体内容（如 X/Twitter、小红书、Bilibili、抖音、TikTok、Instagram 等）的聚合器，更支持高度可定制的多租户媒体库（Library）与协作机制，实现高质量资产的幂等同步、本地持久化归档与快速检索。

---

## 🎨 用户界面与视图

Stationary 采用精美的桌面级 Canvas 布局设计，融入 Apple 风格的空间层级（**Card-on-Canvas 卡片画布设计系统**）与极简美学。

### 1. 看板视图 (Board View)
**看板视图**以逻辑“帖子 (Post)”为基本单元进行陈列。每个卡片包含作者信息、发布时间、标题、标签，以及该帖子下首个媒体资产的缩略图。

![Post Board - 看板视图](../assets/screenshots/post_list.png)

### 2. 细节审查抽屉 (Detail Inspector Drawer)
点击任意帖子卡片将从右侧滑出**细节审查面板**。该抽屉包含：
* **交互式媒体轮播图**：基于 Swiper 驱动，能够顺畅呈现高清图片和视频播放器。
* **元数据字段**：可快捷查看作者信息、源平台 URL、发布时间、描述正文及所有标签。

![Detail Inspector Panel - 细节审查面板](../assets/screenshots/post_detail.png)

### 3. 资产平铺视图 (All Pins View)
可通过侧边栏导航访问。它越过帖子容器，直接平铺陈列所有媒体文件。支持以下两种布局模式切换：
* **平铺模式 (Flat Mode)**：将所有媒体文件（图片/视频）独立渲染为卡片，适合细粒度地物色特定资产。
* **堆叠模式 (Stacked Mode)**：将同一帖子下的多张媒体折叠在一起。仅显示帖子中的首张媒体（`sort_order = 0`），卡片上会显示数量角标（例如 `+3`）提示当前堆叠下包含的媒体总数。

---

## 🌟 交互式媒体特性

Stationary 原生支持多种专业播放与渲染格式，可完美承载移动端相机的原生多媒体输出：

* **Live Photo (实况照片) 交互播放**：Live Photo 资产被同步为静态封面轨与动态视频轨。鼠标悬停或长按图片即可触发动态交互播放。
* **HEIC/HEIF 图像渲染**：支持在浏览器中直接解码并渲染 Apple 原生的 HEIC/HEIF 高清格式图片。
* **统一 DASH 视频流播**：对于音视频轨分离的高画质源（如 Bilibili 分离轨），系统在后台提取 `sidx` 索引块范围并存入 `Track.metadata.segment_base`，前端利用 `dash.js` 播放器执行 S3 分片 byte range 请求，达成免转码、极速起播的 DASH 统一流媒体播放。
* **字幕自动解析转换**：同步时自动拦截平台专有的 subtitle 数据（如 Bilibili JSON 字幕），并实时将其解析转换为标准 WebVTT 字幕文件 (`.vtt`)，直接上传至 S3 供播放器挂载。

---

## 🏷️ 标签与媒体库管理

### 媒体库切换与多租户隔离
* **媒体库 (Library)** 是资产物理隔离的最小边界。您可以通过侧边栏顶部的 LibrarySwitcher 下拉菜单随时切换当前工作的媒体库。
* 支持用户级别 (`LibraryUserAccess`) 和用户组级别 (`LibraryGroupAccess`) 授权，提供三档细粒度权限：`VIEWER`（只读）、`EDITOR`（读写、同步与移动）、`ADMIN`（完整管理权限）。

### 重构标签索引
* 用户可以在设置面板中管理所有同步导入和手动创建的标签。
* **规范化与别名 (Normalization & Alias)**：支持将重复的标签别名映射到同一个 `canonical_tag_id` 下，实现规范化管理。
* **标签状态控制**：
  * `ACTIVE`：已激活，将在帖子卡片上正常显示，并可用于筛选与检索。
  * `CANDIDATE`：新同步导入的标签默认状态，作为候选，等待管理员审核。
  * `IGNORED`：已忽略，隐藏展示，且在搜索中不可检索。

---

## 🔍 混合检索与 AI 富化

* **模糊 Trigram 与向量检索**：搜索功能使用倒数排序融合 (RRF) 算法，将传统的 SQL Trigram 模糊文本匹配、AI 文本语义检索 (`text-embedding-004`) 和多模态图像视觉相似度检索 (`multimodal-embedding-004`) 的结果进行加权融合。
* **AI 标注与富化**：支持对选中的媒体资源一键触发 AI 富化流水线，利用 Gemini Flash 自动提取 Caption（描述文案）、Tags（摘要标签）、场景信息、OCR 文字、色调与视觉风格。

---

## 🚀 快速上手

### 1. 安装依赖
```bash
bun install
```

### 2. 环境变量配置
在以下目录中分别创建并配置 `.env` 文件：
* **后端 (Server)**：复制 `apps/server/.env.example` 为 `apps/server/.env`，重点填写 PostgreSQL 数据库连接串、S3 凭证、Upstash QStash Token 和 Redis 缓存配置。
* **前端 (Web)**：复制 `apps/web/.env.example` 为 `apps/web/.env`，设置 `NUXT_PUBLIC_API_BASE_URL` 指向后端服务地址（开发环境通常为 `http://localhost:9400`）。

### 3. 初始化数据库
在 `apps/server` 目录下，运行 Drizzle 数据库同步指令：
```bash
cd apps/server
bun run db:migrate
```

### 4. 配置本地开发隧道 (非常重要)
由于后台长耗时下载任务由 Upstash Workflow 协调驱动，Upstash 服务器必须能够回调您本地运行的 API 端点。
1. 在本地使用 `ngrok` 或 `cloudflared` 隧道工具将端口 `9400` 映射到公网：
   ```bash
   ngrok http 9400
   ```
2. 复制生成的公网 URL（例如 `https://xxxx.ngrok-free.app`）。
3. 将该 URL 填入 `apps/server/.env` 的 `UPSTASH_WORKFLOW_URL` 字段中。

### 5. 启动开发服务器
在项目根目录下，执行并行启动指令：
```bash
bun run dev
```

---

## 🛠️ 技术栈与工作空间

项目采用 **Bun Workspace Monorepo** 进行模块化开发：

* **[apps/server](file:///Users/kazuha/dev/stationary/apps/server)**：后端 API。基于 Bun 运行环境，Hono Web 框架，Drizzle ORM (PostgreSQL) 与 Upstash Workflows 异步编排服务。
* **[apps/web](file:///Users/kazuha/dev/stationary/apps/web)**：前端 Web 应用。基于 Nuxt 4, Vue 3, Pinia 状态管理，Vue Query 异步请求管理，Tailwind CSS v4，以及 Plyr (播放器) 与 Swiper (轮播图)。
* **[docs](file:///Users/kazuha/dev/stationary/docs)**：系统架构规约与核心流转文档。
  * [系统设计与数据库规范说明](file:///Users/kazuha/dev/stationary/docs/system_design.zh-Hans.md)
  * [媒体元数据同步工作流 & API 契约](file:///Users/kazuha/dev/stationary/docs/external_api.contract.zh-Hans.md)
  * [Metadata 物理保存与清理流程详细说明](file:///Users/kazuha/dev/stationary/docs/save_metadata_flow.zh-Hans.md)
  * [TypeScript 编写规范与避坑指南](file:///Users/kazuha/dev/stationary/docs/code.rule.zh-Hans.md)
  * [系统架构设计取舍与 Trade-offs](file:///Users/kazuha/dev/stationary/docs/trade-offs.zh-Hans.md)
