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
The server runs by default at `http://localhost:3000`.

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

## 🔗 Nitro Proxy & OAuth Session Persistence

Since the frontend runs at `localhost:3000` and the backend at `localhost:8080`, we use **Nitro Server Proxy** to forward endpoints and handle session cookies.

### 1. Catch-All Proxy Router (`server/api/[...].ts`)
All outgoing calls prefixed with `/api/**` are intercepted by the local Nitro server and forwarded to `NUXT_PUBLIC_API_BASE_URL` defined in the `.env` file.

### 2. 302 Redirection & Cookie Passthrough (Crucial)
In the proxy call within `server/api/[...].ts`, the fetch option is configured with `redirect: 'manual'`:
```typescript
return proxyRequest(event, targetUrl, {
    fetchOptions: {
        redirect: 'manual', // Prevent proxy server from automatically following 302 redirects
    }
})
```
- **Why this is necessary**: During third-party OAuth flows (e.g. GitHub/Google sign-in via Better Auth), the authentication server returns a `302 Found` redirect and a `Set-Cookie` header. If the Nitro proxy follows the redirect internally, the session cookie will be saved inside Nitro instead of reaching the user's browser. Setting `redirect` to `'manual'` forces Nitro to pass the 302 response and cookie headers directly to the browser, preserving active user sessions.

---

## 🎨 Styles & Core Frameworks

### 1. Tailwind CSS v4
The project uses the latest **Tailwind CSS v4**, compiled via the Vite plugin `@tailwindcss/vite`. Configurations are defined directly in the main stylesheet (`main.css`) rather than a standalone `tailwind.config.js` file.

### 2. Data Fetching & Caching (Vue Query)
Data requests utilize `@tanstack/vue-query` to provide reactive caching, infinite scrolling pagination, and optimistic UI updates.

### 3. Localization (`@nuxtjs/i18n`)
The client supports 12 languages (including English, Simplified/Traditional Chinese, Japanese, Korean, French, German, and Spanish). Translations are organized inside `i18n/locales/` with `no_prefix` routing.
