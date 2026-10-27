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

## 🔗 API 架构与会话处理

浏览器始终只访问同源 `/api`：开发环境由 Nuxt 开发代理转发，生产环境由 Caddy / Ingress 网关转发。服务端渲染阶段则通过 `runtimeConfig.apiBaseUrl` 直连后端。

### 1. 统一请求客户端 (`plugins/api.ts` + `composables/useApi.ts`)
插件中创建的 `$api` 实例承载全部请求策略，`useApi` 是对外暴露的类型化入口，供各 store 与组件使用：
- 浏览器端使用 `runtimeConfig.public.apiBaseUrl`，SSR 端使用 `runtimeConfig.apiBaseUrl`。
- 开启 `credentials: 'include'`，确保始终携带认证 Cookie。
- 在 Nuxt SSR 渲染阶段，自动通过 `useRequestHeaders(['cookie'])` 将用户请求头中的 Cookie 透传至后端服务。
- 任何请求返回 `401` 时，自动退出登录并跳转 `/login`。

### 2. 身份认证 (`plugins/auth.ts`)
Better Auth 客户端在插件中按应用实例创建，`baseURL` 来自 runtime config：
- 注册、登录（含 Turnstile 人机验证头透传）、邮箱 OTP 验证与 OAuth 社交登录均走与业务 API 相同的 `/api/auth/*` 网关。
- 调整 API 地址只需修改 `NUXT_PUBLIC_API_BASE_URL` / `NUXT_API_BASE_URL`。

---

## 🎨 样式与核心模块集成

### 1. Tailwind CSS v4
项目采用了最新的 **Tailwind CSS v4**。与 v3 相比，它在底层由 Vite 插件 `@tailwindcss/vite` 直接驱动，速度更快，配置主要通过 CSS 主文件中的指令进行声明，摒弃了传统的 `tailwind.config.js`。

### 2. 数据请求与缓存控制 (Vue Query)
为了实现高质量的交互体验并减轻服务器压力，页面数据加载统一集成 `@tanstack/vue-query`，可实现查询自动缓存、触底无感式分页数据追加、乐观更新等核心体验。

### 3. 多语言本地化 (`@nuxtjs/i18n`)
支持简/繁体中文、英文、日语、韩语、法语、德语等 12 种主流语言。语言配置文件存放于项目根目录的 `i18n/locales/` 文件夹下，策略设为 `no_prefix`。
