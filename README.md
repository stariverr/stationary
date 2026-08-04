# Stationary

<p align="center">
  <img src="./logo.svg" alt="Stationary Logo" width="120" />
</p>

<h3 align="center">Multi-Platform Media Asset Management & Integration Platform</h3>

<p align="center">
  A high-performance, self-hosted media asset manager (MAM) designed for creative professionals and content managers. Centralize, archive, organize, and search multi-platform media content ingested from external sync agents with interactive playback and hybrid AI search.
</p>

<p align="center">
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-1.3+-black?logo=bun" alt="Bun"></a>
  <a href="https://nuxt.com"><img src="https://img.shields.io/badge/Nuxt-4.5+-00DC82?logo=nuxt&logoColor=white" alt="Nuxt 4"></a>
  <a href="https://hono.dev"><img src="https://img.shields.io/badge/Hono-4.12+-E36002?logo=hono&logoColor=white" alt="Hono"></a>
  <a href="https://flutter.dev"><img src="https://img.shields.io/badge/Flutter-3.12+-02569B?logo=flutter&logoColor=white" alt="Flutter"></a>
  <a href="https://orm.drizzle.team"><img src="https://img.shields.io/badge/Drizzle_ORM-1.0+-C5F74F?logo=drizzle" alt="Drizzle ORM"></a>
  <a href="https://www.postgresql.org"><img src="https://img.shields.io/badge/PostgreSQL-15+-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL"></a>
</p>

<p align="center">
  <a href="#-key-features">Key Features</a> •
  <a href="#-user-interface--views">User Interface</a> •
  <a href="#-tech-stack--monorepo">Monorepo Workspace</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-documentation">Documentation</a>
</p>

<p align="center">
  <a href="./docs/README.zh-Hans.md"><b>简体中文文档</b></a>
</p>

---

## ✨ Key Features

- 🎨 **Card-on-Canvas Design System**: Built on Apple-inspired spatial depth layers and Linear-class desktop refinement with clean HSL palettes.
- 📸 **Native Live Photo & Interactive Media**: Support for Live Photo interactive playback and browser-native HEIC/HEIF decoding.
- 🎬 **Unified DASH Streaming**: Audio/video split streams from multi-track media sources are parsed on-the-fly via dynamic `sidx` SegmentBase extraction and streamed smoothly with `dash.js`.
- 🏷️ **Multi-Tenant Library Management**: Physical asset isolation per Library, fine-grained RBAC (`VIEWER`, `EDITOR`, `ADMIN`), and reconstructive tag normalization with alias mapping.
- 🔍 **Hybrid AI Search & Enrichment**: Reciprocal Rank Fusion (RRF) combining SQL trigram text search, Gemini text embeddings (`text-embedding-004`), and visual similarity vectors (`multimodal-embedding-004`).
- ⚡ **Durable Task Queue Engine**: In-house PostgreSQL-backed task queue with atomic `SKIP LOCKED` lease locking, exponential backoff retries, and automated `JobSweeper` cleanup.

---

## 🎨 User Interface & Views

### 1. Board View (Posts)
Presents content grouped by **Posts**. Each card displays author details, publication timestamps, tags, and a thumbnail of the primary media asset.

![Board View (Posts)](./assets/screenshots/post_list.png)

### 2. Inspector Drawer (Post Details)
Slides out from the right when selecting any post. Features a Swiper-powered interactive media carousel alongside complete post metadata inspectors.

![Inspector Drawer (Post Details)](./assets/screenshots/post_detail.png)

### 3. Media Grid (All Pins)
Directly displays individual **Media** assets with two flexible layout modes:
- **Flat Mode**: Displays all images and videos as independent cards for granular searching and asset inspection.
- **Stacked Mode**: Groups media belonging to the same post into a single card with stack badges (`+N`).

---

## 🛠️ Tech Stack & Monorepo

Stationary is structured as a **Bun Workspace Monorepo**:

```text
stationary/
├── apps/
│   ├── server/       # Bun + Hono API backend, Drizzle ORM, DB Task Queue Engine
│   ├── web/          # Nuxt 4 + Vue 3 SPA/SSR, Tailwind CSS v4, Swiper, Plyr
│   └── flutter/      # Flutter multi-platform client application
└── docs/             # Technical specifications & architecture blueprints
```

| Component | Stack | Responsibilities |
| :--- | :--- | :--- |
| **`apps/server`** | Bun, Hono, Drizzle ORM, PostgreSQL, Redis, `@ai-sdk/google` | REST APIs, authentication (Better Auth), task execution engine, S3 asset handling |
| **`apps/web`** | Nuxt 4, Vue 3, Pinia, Vue Query, Tailwind CSS v4, dash.js | Web desktop client, Card-on-Canvas layout, DASH video player, HEIC renderer |
| **`apps/flutter`** | Flutter, Dart, Chewie, PhotoView | Mobile and desktop cross-platform application |

---

## 🚀 Quick Start

### Prerequisites
- **Bun**: `v1.3.0` or higher
- **PostgreSQL**: `v15` or higher (with `pgvector` & `pg_trgm` extensions enabled)
- **Redis**: For KV caching and rate limiting

### 1. Install Dependencies
```bash
bun install
```

### 2. Environment Configuration
Set up environment configuration files:
- **Backend**: Copy `apps/server/.env.example` to `apps/server/.env` and update PostgreSQL, Redis, and S3 credentials.
- **Frontend**: Copy `apps/web/.env.example` to `apps/web/.env` and set `NUXT_PUBLIC_API_BASE_URL` (default: `http://localhost:9400`).

### 3. Initialize Database Migrations
```bash
cd apps/server
bun run db:migrate
```

### 4. Launch Development Servers
From the repository root, start development servers concurrently:
```bash
bun run dev
```

---

## 📚 Documentation

Detailed specifications and architectural guides are available in the [`docs/`](./docs) directory:

- 📐 **[System Design & Database Specification](./docs/system_design.md)** - Data models, relational schemas, deletion policies, and JobRunner queue specs.
- 🔌 **[Metadata Sync & API Contracts](./docs/external_api.contract.md)** - Integration client schemas, `external_id` deduplication rules, and sync payloads.
- 🔄 **[Metadata Ingestion Pipeline](./docs/save_metadata_flow.md)** - Execution flow of `saveMetadata`, change detection, and S3 soft-delete lifecycle.
- 🔍 **[Multi-Space Hybrid Search Spec](./docs/ai_hybrid_search.md)** - Vector space segregation, pgvector HNSW indexing, and RRF rank fusion.
- ⚖️ **[Architectural Trade-offs](./docs/trade-offs.md)** - Design rationale behind Multi-Track schemas and DASH segment parsing.
- 🛠️ **[Task Engine Extension Guide](./docs/task_engine_extension.md)** - Strategy pattern guide for adding new background job handlers.
- 📜 **[TypeScript & Bun Guidelines](./docs/code.rule.md)** - Mandatory standards for Temporal API, Web API streams, and `bun:File`.

---

## 📄 License

Private repository. All rights reserved.
