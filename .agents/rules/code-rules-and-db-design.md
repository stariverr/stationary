---
trigger: always_on
---

- [Server] All API Responses should be wrapped by unified functions.
    - For example: 
        - c.json(success(CODE.SUCCESS, null, data))
        - c.json(error(CODE.UNAUTHORIZED, 'please login first'))
- [DB] Field Name: Only snake_case is allowed.
- [DB] No explicit foreign key.
    For modern distributed systems, foreign key might be a burden for scaling.
- [DB] Reference Counting: When multiple entities reference the same physical File, do not use a simple 'ref_count' column on the File table. Use a dedicated 'file_usage' mapping table to count and manage references dynamically.
- [TS/Bun] Date -> Temporal: Do not use the native JavaScript `Date` constructor. All date, time, and timezone operations must utilize the `Temporal` API.
- [TS/Bun] node:stream -> Web API stream: Use standard Web API streams instead of Node.js stream modules.
- [TS/Bun] node:fs -> bun:File: Use the native `bun:File` APIs (such as `Bun.file()`) and Bun's built-in file system utilities.
- [TS] Code Formatting: Always use oxc to format code.


# Important Rules
## S3 & DB Consistency Rules

### core_patterns
* **Upload [State Machine]:** DB `status='pending'` -> Client uploads via Presigned URL -> Client confirms -> DB `status='active'`.
* **Upload [Event Driven]:** Client uploads -> S3 `ObjectCreated` event triggers Queue/Webhook -> Backend creates DB record.
* **Delete [Soft Delete]:** DB `is_deleted=true` + enqueue async task within DB transaction -> Worker deletes S3 object (retry + DLQ).
* **Delete [Lifecycle]:** DB hard deletes record -> Backend writes S3 `Delete Marker` -> S3 Lifecycle Policy purges noncurrent versions automatically.

### anti_patterns
* DO NOT upload files synchronously within a DB transaction.
* DO NOT hard delete DB records before verifying or asynchronously scheduling S3 file deletion.
* DO NOT chain S3 API calls directly in user-facing HTTP request-response cycles.

### edge cases & blind spots
* **Idempotency Required:** S3 delete workers *must* handle "File Not Found" errors gracefully without crashing or infinite retries.
* **Orphan Cleanup:** Implement a scheduled cron job (or S3 Inventory sync) to sweep stale `pending` DB entries and unindexed S3 artifacts.

## Delete Rules Without Physical Foreign Keys

When DB foreign keys are disabled, the application must own referential integrity. Deletes must be **centralized, explicit, idempotent, and recoverable**.

### Normal Pattern

- All deletes go through one `deleteService` / deletion engine.
- Dependencies are declared in one metadata source.
- Use state flow:

```text
active → deleting → deleted → purged
```

- Transaction only:
  - mark root as `deleting`
  - delete small critical dependencies
  - write deletion job / outbox
- Worker handles:
  - large tables
  - logs/events/history
  - files/indexes/cache
  - retries, chunking, rate limits
- Queries must ignore deleted records:

```sql
WHERE deleted_at IS NULL
```

### Do Not

- Do not scatter raw `DELETE`.
- Do not rely on humans/AI to remember relations.
- Do not use one big transaction for all cleanup.
- Do not delete millions of rows in a request.
- Do not call MQ/HTTP/S3 inside a DB transaction.
- Do not make async deletion non-idempotent.
- Do not block core deletion on external cleanup.
- Do not skip orphan scanning.

### Easy To Miss

- Every new `user_id`, `tenant_id`, `project_id`, `workspace_id` needs a deletion policy.
- Orders, payments, invoices, contracts, audit logs are usually preserved/anonymized, not blindly deleted.
- Weak refs like comment authors/message senders should be nullable or snapshot-based.
- Large logs/events need chunk delete, partitioning, TTL, or archival.
- Use Outbox/CDC to avoid “DB committed but event publish failed”.
- Add contract tests + CI scans for unregistered owner fields.

### Minimal Flow

```text
Delete Service
  → transaction: mark deleting + delete critical deps + write job/outbox
  → worker: chunk cleanup + external cleanup + retry + mark purged
  → scanner: detect orphans/stuck jobs
```

### Chunk Rule

Never:

```sql
DELETE FROM logs WHERE user_id = ?;
```

Prefer:

```sql
DELETE FROM logs WHERE user_id = ? LIMIT 1000;
```

Loop with sleep/rate limit until no rows are affected.