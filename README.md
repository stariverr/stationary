# Stationary

> [简体中文](./docs/README.zh-Hans.md)

Stationary is a multi-platform media asset management and integration platform (MAM) designed for creative professionals and content managers. It functions as an aggregator for social media content (such as X/Twitter, Xiaohongshu, Bilibili, Douyin, TikTok, and Instagram) and supports highly customizable multi-tenant libraries (Library) and collaboration mechanisms, enabling idempotent synchronization, local archiving, and fast retrieval.

---

## 🌟 Core Features

- **Multi-Platform Metadata Sync**: Connects with major platforms to synchronize posts, titles, tags, publishing times, and complex media streams.
- **Reliable Asset Downloads**: Employs Upstash Workflow and QStash to download assets with retry logic, resumption, and rate-limiting.
- **Smart Deduplication & Change Detection**: Performs hash checks across files, posts, and authors to run differential updates and S3 soft-deletion cleanup.
- **Foreign-Key-Free Architecture**: Decouples physical foreign keys in the database for better scalability, managing relations logically via ORM-level definitions.
- **Dual-View UI**: Offers a "Post Board" (aggregating posts) and "All Pins" (flat or stacked media files view).
- **Multi-Tenant Permissions**: Supports User Groups and Library-level role controls (VIEWER, EDITOR, ADMIN).

---

## 📂 Project Structure

This project uses a **Bun Workspace Monorepo** architecture:

```text
/ (Root)
├── apps/
│   ├── server/           # Backend: Bun, Hono, Drizzle ORM, Better Auth, Upstash Workflow
│   └── web/              # Frontend: Nuxt 4, Vue 3, Pinia, Vue Query, Tailwind CSS v4
├── docs/                 # System architecture, API contracts, and design workflows
└── package.json          # Root Monorepo configuration
```

---

## 🛠️ Tech Stack

### Backend
- **Runtime**: Bun
- **Web Framework**: Hono (TypeScript-based)
- **ORM**: Drizzle ORM (with PostgreSQL driver `pg`)
- **Asynchronous Workflows**: Upstash Workflow & QStash
- **Physical Storage**: S3-compatible Object Storage (AWS S3, Cloudflare R2, etc.)
- **Caching & Distributed Locks**: Redis

### Frontend
- **Framework**: Nuxt 4 (configured for clean Client-Side Rendering with SSR fallback)
- **State Management**: Pinia Stores
- **Data Fetching & Caching**: TanStack Vue Query
- **Styling**: Tailwind CSS v4 (with `@tailwindcss/vite` compiler)
- **Component Library**: Reconstruct UI / Shadcn Vue & Lucide Icons
- **Internationalization**: `@nuxtjs/i18n` (built-in 10+ language packs)
- **Player & Slider**: Plyr (video playback), Swiper (carousel)

---

## 🚀 Quick Start

### 1. Install Dependencies

From the root directory, run:

```bash
bun install
```

### 2. Configure Environment Variables

Create `.env` configuration files in the subdirectories:

- **Backend**: Refer to `apps/server/.env.example` to create `apps/server/.env`. Make sure to configure the database connection, S3 details, and QStash credentials.
- **Frontend**: Refer to `apps/web/.env` and set `NUXT_PUBLIC_API_BASE_URL` pointing to the backend (defaults to `http://localhost:9400` in development).

### 3. Initialize the Database

In the `apps/server` directory, run migration scripts to push schemas:

```bash
cd apps/server
bun run db:migrate
```

### 4. Run Development Servers

From the root directory, run:

```bash
# Launch Hono backend (localhost:9400) and Nuxt frontend (localhost:4000) concurrently
bun run dev
```

---

## 📖 Deep-Dive Documentation

Detailed modules and design flows can be found in the `docs/` folder:
- **[System Design & Database Specifications](file:///Users/kazuha/dev/stationary/docs/system_design.md)**
- **[Metadata Sync Workflows & API Contracts](file:///Users/kazuha/dev/stationary/docs/external_api.contract.md)**
- **[Metadata Save & S3 Cleanup Flow Details](file:///Users/kazuha/dev/stationary/docs/save_metadata_flow.md)**
- **[TypeScript Coding Rules & Best Practices](file:///Users/kazuha/dev/stationary/docs/code.rule.md)**
