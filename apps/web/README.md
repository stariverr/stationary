# Stationary Frontend (Web Client)

> [简体中文](./docs/README.zh-Hans.md)

The frontend client is built on **Nuxt 4**, **Vue 3**, **Pinia**, **TanStack Vue Query**, and **Tailwind CSS v4**. It features built-in internationalization and supports both "Post Board" list views and a dedicated "All Pins" full-screen media asset preview manager.

---

## 🛠️ Local Development

### 1. Run Development Server
```bash
# In the apps/web directory
bun run dev
```
The server runs by default at `http://localhost:4000`.

### 2. Production Build & Preview
- **Build Bundle**: `bun run build`
- **Preview Production Bundle Locally**: `bun run preview`
- **Deploy to Cloudflare**: `bun run deploy` (uses Wrangler under the hood)

---

## 📂 Nuxt 4 Directory Layout

The project defines `srcDir: 'app'` in `nuxt.config.ts`, making the `app/` folder the root for all client-side code:

```text
apps/web/app/
├── assets/         # CSS styles and images (Global stylesheet at assets/css/main.css)
├── components/     # UI components (including components based on shadcn-vue)
├── layouts/        # Layout templates (such as default.vue)
├── middleware/     # Nuxt routing middleware (for auth redirection)
├── pages/          # Routing pages (Home, Board, All Pins library, Settings)
├── stores/         # Pinia stores (such as stores/posts.ts to handle aggregate post states)
├── types/          # TypeScript type definitions
└── app.vue         # Root Vue app component
```

---

## 🔗 Direct API Architecture & Cross-Origin Auth Persistence

Frontend requests communicate directly with the backend API (default: `localhost:9400`) without a frontend reverse proxy, keeping the application architecture clean and performant.

### 1. Unified API Composable (`composables/useApi.ts`)
All data requests are dispatched through the `useApi` composable:
- Automatically prefixes the backend URL from `runtimeConfig.public.apiBaseUrl`.
- Sets `credentials: 'include'` to ensure cross-origin authentication cookies are preserved in browser sessions.
- In Nuxt SSR mode, forwards incoming client cookies to the backend via `useRequestHeaders(['cookie'])`.

### 2. Authentication & Session Persistence (`lib/auth-client.ts`)
Better Auth client points directly to the backend `apiBaseUrl`:
- Sign up, sign in, email OTP verification, and OAuth social flows talk directly to backend auth endpoints.
- Backend Hono server configures CORS trusted origins (`TRUSTED_ORIGINS`) with `credentials: true` and dynamically allows required preflight headers (such as `x-captcha-response`).


---

## 🎨 Styles & Core Frameworks

### 1. Tailwind CSS v4
The project uses the latest **Tailwind CSS v4**, compiled via the Vite plugin `@tailwindcss/vite`. Configurations are defined directly in the main stylesheet (`main.css`) rather than a standalone `tailwind.config.js` file.

### 2. Data Fetching & Caching (Vue Query)
Data requests utilize `@tanstack/vue-query` to provide reactive caching, infinite scrolling pagination, and optimistic UI updates.

### 3. Localization (`@nuxtjs/i18n`)
The client supports 12 languages (including English, Simplified/Traditional Chinese, Japanese, Korean, French, German, and Spanish). Translations are organized inside `i18n/locales/` with `no_prefix` routing.
