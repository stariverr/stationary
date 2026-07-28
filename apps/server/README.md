# Stationary Backend (Server)

> [简体中文](./docs/README.zh-Hans.md)

The backend is built on the **Bun** runtime, the **Hono** framework, and **Drizzle ORM**. It is responsible for metadata management, interfacing with S3-compatible object storage, handling user authentication via Better Auth, and scheduling distributed media downloads using Upstash Workflow.

---

## 🛠️ Local Development

### 1. Install Dependencies
Ensure dependencies are installed at the monorepo root:
```bash
bun install
```

### 2. Run Development Server
```bash
# In the apps/server directory
bun run dev
```
The development server will run with hot-reloading at `http://localhost:9400`.

### 3. Type Checking & Building
- **Type Check**: `bun run typecheck`
- **Build**: `bun run build` (outputs to `./dist`)

---

## 🗄️ Database Operations (Drizzle ORM)

The project uses PostgreSQL. Database schemas are defined in `src/db/schema/index.ts` and logical relations in `src/db/schema/relations.ts`.

#### 1. Schema Syncing
After making changes to schemas, sync them to the database by running:
```bash
bun run db:migrate
```
This triggers `drizzle-kit generate` and `drizzle-kit push` under the hood to automatically sync changes.

#### 2. Drizzle Configuration
The config resides in `drizzle.config.ts`.

---

## 🔄 Durable Background Job Engine (PostgreSQL Queue & JobRunner)

Because downloading media assets and generating video covers is I/O intensive, the system manages background execution using PostgreSQL as the single source of truth (`AsyncTask` / `AsyncTaskUnit`) driven by an in-process Bun `JobRunner`.

### 1. Key Principles
- **PostgreSQL Single Source of Truth**: All tasks and units are transactionally committed to DB prior to execution.
- **Leases and Fencing**: Claims use `SELECT ... FOR UPDATE SKIP LOCKED`, database-clock leases, and fencing tokens so stale workers cannot commit queue state.
- **At-Least-Once Execution**: A worker can crash after producing an external side effect but before committing its result, so handlers must make business side effects idempotent.
- **Automatic Recovery**: The sweeper reclaims expired unit leases, resumes discovery through a separate fenced lease, and reconciles unfinished terminal transitions.

> 📖 **Task Engine & Cover Reconciliation Specification**: For architecture details, task engine rules, and cover generation/reconciliation policies (`COVER_RECONCILE`, multi-quality coexistence and overwriting), refer to the [System Design Document](../../docs/system_design.md#64-cover-generation--reconciliation-specification) and [Task Engine Extension Guide](../../docs/task_engine_extension.md).

---

## 📦 Object Storage Paths (S3)

All files are stored in an S3-compatible bucket specified by `S3_BUCKET` in the `.env` file.
Physical files follow a collision-resistant path convention (S3 Keys):

- **Media Assets**:
  `v2/p/{postId.slice(-2)}/{postId}/{media_index}_{role}.{ext}`
  - *Example*: `v2/p/a3/550e8400-e29b-41d4-a716-4466554400a3/0_PRIMARY.jpg`
  - Valid roles include: `file` (PRIMARY), `alt` (ALTERNATIVE), `live` (LIVE_PHOTO_VIDEO), and `cover` (COVER).
- **Author Avatars**:
  `v2/a/{authorId.slice(-2)}/{authorId}/original.{ext}`

---

## 🔑 Authentication & User Lifecycles

The system uses **Better Auth** for session authentication (supporting credentials and OAuth providers like GitHub and Google). The API endpoints catch all routes under `/api/auth/*`.

1. **User Profile Sync Hook**:
   Under `src/lib/auth/index.ts` in `databaseHooks`, a `user.create.after` hook automatically inserts a corresponding profile into the business `User` table whenever a new user registers via Better Auth.
2. **Auth Middlewares**:
   - `authMiddleware`: Non-blocking. Parses cookies/headers and attaches `authUser` (Better Auth session) and the business `user` record to the Hono context (`c.get("user")`).
   - `requireAuth`: Blocking. Rejects requests with a `1004` (UNAUTHORIZED) response code if no active session is present.
