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

## 🔗 Nitro 代理网关与 OAuth 状态穿透

由于前端在 `localhost:4000`，后端在 `localhost:9400`，为规避跨域问题并保证认证 Session 的传递，项目在 Nuxt 底层引入了 **Nitro Server Proxy**。

### 1. 代理逻辑 (`server/api/[...].ts`)
所有发往 `/api/**` 的请求都会被 Nitro 服务拦截，自动转发至 `.env` 中 `NUXT_PUBLIC_API_BASE_URL` 配置的后端地址。

### 2. 302 重定向穿透魔法 (重要)
在 `server/api/[...].ts` 代理请求中，配置了 `redirect: 'manual'` 参数：
```typescript
return proxyRequest(event, targetUrl, {
    fetchOptions: {
        redirect: 'manual', // 禁止服务端自动跟随重定向
    }
})
```
- **原理解析**：如果在服务端执行了自动跟随重定向，Better Auth（OAuth 如 GitHub 登录）成功后的 `Set-Cookie` 和 `302 Found` 会在 Nitro 代理服务器内部消化，用户的浏览器将无法接收到身份 Cookie。通过设定为 `manual`，可保证 302 状态码与 `Set-Cookie` 报头原封不动透传至浏览器，完成正常的登录会话持久化。

---

## 🎨 样式与核心模块集成

### 1. Tailwind CSS v4
项目采用了最新的 **Tailwind CSS v4**。与 v3 相比，它在底层由 Vite 插件 `@tailwindcss/vite` 直接驱动，速度更快，配置主要通过 CSS 主文件中的指令进行声明，摒弃了传统的 `tailwind.config.js`。

### 2. 数据请求与缓存控制 (Vue Query)
为了实现高质量的交互体验并减轻服务器压力，页面数据加载统一集成 `@tanstack/vue-query`，可实现查询自动缓存、触底无感式分页数据追加、乐观更新等核心体验。

### 3. 多语言本地化 (`@nuxtjs/i18n`)
支持简/繁体中文、英文、日语、韩语、法语、德语等 12 种主流语言。语言配置文件存放于项目根目录的 `i18n/locales/` 文件夹下，策略设为 `no_prefix`。
