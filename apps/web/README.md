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

## 🔗 API Architecture & Session Handling

The browser always talks to a single origin: `/api` is served by the backend through the same-origin gateway (the Nuxt dev proxy locally, Caddy/ingress in production). Server-side rendering calls the backend directly through `runtimeConfig.apiBaseUrl`.

### 1. API Client (`plugins/api.ts` + `composables/useApi.ts`)
The `$api` client created in the plugin carries all HTTP policy, and `useApi` is the typed accessor used by stores and components:
- Base URL from `runtimeConfig.public.apiBaseUrl` (browser) or `runtimeConfig.apiBaseUrl` (SSR).
- Sets `credentials: 'include'` so session cookies are always sent.
- In Nuxt SSR mode, forwards incoming client cookies to the backend via `useRequestHeaders(['cookie'])`.
- On any `401`, signs the session out and redirects to `/login`.

### 2. Authentication (`plugins/auth.ts`)
The Better Auth client is created per app instance with the API base URL from runtime config:
- Sign up, sign in, email OTP verification, and OAuth social flows use the same `/api/auth/*` gateway as the rest of the API.
- Changes to the API base only need to be made in `NUXT_PUBLIC_API_BASE_URL` / `NUXT_API_BASE_URL`.


---

## 🎨 Styles & Core Frameworks

### 1. Tailwind CSS v4
The project uses the latest **Tailwind CSS v4**, compiled via the Vite plugin `@tailwindcss/vite`. Configurations are defined directly in the main stylesheet (`main.css`) rather than a standalone `tailwind.config.js` file.

### 2. Data Fetching & Caching (Vue Query)
Data requests utilize `@tanstack/vue-query` to provide reactive caching, infinite scrolling pagination, and optimistic UI updates.

### 3. Localization (`@nuxtjs/i18n`)
The client supports 12 languages (including English, Simplified/Traditional Chinese, Japanese, Korean, French, German, and Spanish). Translations are organized inside `i18n/locales/` with `no_prefix` routing.
