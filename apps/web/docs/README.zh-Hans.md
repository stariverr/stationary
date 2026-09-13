# Stationary Frontend (Web Client - 简体中文)

> [English](../README.md)

前端基于 **Nuxt 4**、**Vue 3**、**Pinia**、**TanStack Vue Query** 与 **Tailwind CSS v4** 构建。界面融合了多语言本地化配置，支持看板式博文与平铺/堆叠式的全屏媒体资产管理器预览。

---

## 🛠️ 本地开发

### 1. 运行开发服务器
```bash
# 在 apps/web 目录下
bun run dev
```
开发服务器将默认运行在 `http://localhost:4000`。

### 2. 生产环境构建与预览
- **打包编译**：`bun run build`
- **本地预览打包文件**：`bun run preview`
- **部署到 Cloudflare**：`bun run deploy`（基于 Wrangler 驱动进行发布）

---

## 📂 Nuxt 4 目录结构说明

项目在 `nuxt.config.ts` 中设定了 `srcDir: 'app'`，因此所有的核心业务逻辑均位于 `app/` 目录下：

```text
apps/web/app/
├── assets/         # 样式、图片等静态资源（全局样式位于 assets/css/main.css）
├── components/     # UI 基础组件（包含基于 shadcn-vue 的底层组件）
├── layouts/        # 页面布局模板（如默认布局 default.vue）
├── middleware/     # Nuxt 路由中间件（如登录拦截与状态重定向）
├── pages/          # 路由页面（主页、看板页、All Pins 媒体库、设置页等）
├── stores/         # Pinia 状态管理（如用于管理帖子状态的 stores/posts.ts）
├── types/          # TypeScript 类型声明
├── app.vue         # Nuxt 应用挂载根组件
└── ...
```

---

## 🔗 API 直连架构与跨域认证传递

前端请求直接发往后端服务（默认 `localhost:9400`），不经过 Nuxt Nitro 前端代理，保持干净轻量的架构。

### 1. 统一请求客户端 (`composables/useApi.ts`)
所有业务 API 请求均通过 `useApi` composable 发起：
- 自动根据 `runtimeConfig.public.apiBaseUrl` 拼接后端直连地址。
- 开启 `credentials: 'include'`，确保浏览器跨源请求时携带认证 Cookie。
- 在 Nuxt SSR 渲染阶段，自动通过 `useRequestHeaders(['cookie'])` 将用户请求头中的 Cookie 透传至后端服务。

### 2. 身份认证与跨源 Session (`lib/auth-client.ts`)
Better Auth 客户端直接配置 `baseURL` 指向后端 `apiBaseUrl`：
- 注册、登录（含 Turnstile 人机验证头透传）、邮箱 OTP 验证与 OAuth 社交登录均直连后端处理。
- 后端 Hono 服务配置 CORS 信任源（`TRUSTED_ORIGINS`）并开启 `credentials: true`，预检请求动态放行客户端自定义报头。

---

## 🎨 样式与核心模块集成

### 1. Tailwind CSS v4
项目采用了最新的 **Tailwind CSS v4**。与 v3 相比，它在底层由 Vite 插件 `@tailwindcss/vite` 直接驱动，速度更快，配置主要通过 CSS 主文件中的指令进行声明，摒弃了传统的 `tailwind.config.js`。

### 2. 数据请求与缓存控制 (Vue Query)
为了实现高质量的交互体验并减轻服务器压力，页面数据加载统一集成 `@tanstack/vue-query`，可实现查询自动缓存、触底无感式分页数据追加、乐观更新等核心体验。

### 3. 多语言本地化 (`@nuxtjs/i18n`)
支持简/繁体中文、英文、日语、韩语、法语、德语等 12 种主流语言。语言配置文件存放于项目根目录的 `i18n/locales/` 文件夹下，策略设为 `no_prefix`。
