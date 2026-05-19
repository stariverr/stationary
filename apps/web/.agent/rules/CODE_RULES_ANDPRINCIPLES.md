---
trigger: always_on
---

General
Type Safety: Try Guarantee Type Safety as you could.
Go
Web Framework: Fiber v3
ORM: gorm/gen > Ent.

Rust
ORM: SeaORM > Toasty.

TypeScript/JavaScript
Replace Date with Temporal API: No Date is allowed unless it has to, such as the function only accepts Date type.
ORM: Drizzle > Kysely.
Runtime Validation: ValiBot > Zod > ArkType > Zod/mini.
Package Manager: bun.
Python
ORM: SQLModel.
JSON Serde (Serialization & Deserialization): orjson.
orjson is written in Rust and has way better performance than json.
Runtime Validation: Pydantic
Use uv whenever possible.

Database Design
Field Name: Only snake_case is allowed.
No explicit foreign key.
For modern distributed systems, foreign key might be a burden for scaling.


Project Structure & Design

Web Design & Logics
- Use TailwindCSS + shadcn components whenever possible.
- Replace: lucide-vue-next -> @lucide/vue