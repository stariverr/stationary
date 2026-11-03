import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { JobQueue, Library } from "@/db/schema";
import { db, type DbClient, type Transaction } from "@/global/db";
import { queueLockOrder } from "@/infra/queue/pipelines";
import { LEASE_SECONDS } from "@/infra/queue/policy";

/** Postgres channel notified on commit of every enqueue; workers LISTEN on it to wake up. */
export const QUEUE_CHANNEL = "job_queue";

export interface EnqueueRow {
    readonly pipeline: string;
    readonly subjectId: string;
    readonly libraryId: string;
    readonly priority: number;
}

export interface ClaimedRow {
    readonly pipeline: string;
    readonly subjectId: string;
    readonly libraryId: string;
    readonly leaseToken: string;
    /** This run's attempt, starting at 1. Counted at claim, so a run that dies without settling counts too. */
    readonly attempts: number;
    readonly cursor: string | null;
    /** Runs in a row that died without settling, each leaving a lease to expire. Above 0, this run may be what kills a worker. */
    readonly interruptions: number;
}

export type Lease = Pick<ClaimedRow, "pipeline" | "subjectId" | "leaseToken">;

/** The rows of one queue in one library. */
export interface QueueInLibrary {
    readonly pipeline: string;
    readonly libraryId: string;
}

/** The lease was taken over by another worker; nothing this run computed may be written. */
export class LeaseLostError extends Error {
    constructor(lease: Lease) {
        super(`Lease on ${lease.pipeline}/${lease.subjectId} was lost`);
        this.name = "LeaseLostError";
    }
}

const leased = sql`(${JobQueue.lease_token} IS NOT NULL AND ${JobQueue.lease_expires_at} > now())`;

/** `column = ANY(ids)` with the ids bound as one array, so a request is not limited to 65,535 bind parameters. */
export function isAnyOf(column: PgColumn, ids: readonly string[]): SQL {
    return sql`${column} = ANY(${sql.param([...ids])}::${sql.raw(column.getSQLType())}[])`;
}

function holds(lease: Lease) {
    return and(eq(JobQueue.pipeline, lease.pipeline), eq(JobQueue.subject_id, lease.subjectId), eq(JobQueue.lease_token, lease.leaseToken));
}

/**
 * How enqueue treats a row that already exists:
 * - `change`: the subject's input changed. An idle row becomes due now with its retry count reset; a running row is
 *   marked dirty and runs again once the current run finishes; a library scan restarts from the beginning.
 * - `scan`: a library scan found the subject out of date. A running row is marked dirty (it may have read the old
 *   configuration); an idle row keeps its schedule, so a scan does not cut a retry backoff short.
 * - `absent`: only insert missing rows (periodic patrols must not restart scans that are under way).
 */
export type EnqueueMode = "change" | "scan" | "absent";

const ON_CONFLICT: Record<EnqueueMode, SQL> = {
    absent: sql`DO NOTHING`,
    scan: sql`DO UPDATE SET
        priority = greatest(job_queue.priority, excluded.priority),
        dirty = job_queue.dirty OR ${leased}`,
    change: sql`DO UPDATE SET
        library_id = excluded.library_id,
        priority = greatest(job_queue.priority, excluded.priority),
        dirty = job_queue.dirty OR ${leased},
        available_at = CASE WHEN ${leased} THEN job_queue.available_at ELSE now() END,
        attempts = CASE WHEN ${leased} THEN job_queue.attempts ELSE 0 END,
        interruptions = CASE WHEN ${leased} THEN job_queue.interruptions ELSE 0 END,
        cursor = CASE WHEN ${leased} THEN job_queue.cursor ELSE NULL END`,
};

/**
 * The rows are bound as one array per column, so their number is not limited by the protocol's bind parameters.
 * The NOTIFY is transactional, so workers wake only once the caller's transaction commits.
 */
export async function enqueue(client: DbClient, rows: readonly EnqueueRow[], mode: EnqueueMode = "change"): Promise<void> {
    const unique = new Map<string, EnqueueRow>();
    for (const row of rows) {
        const key = `${row.pipeline}\u0000${row.subjectId}`;
        const existing = unique.get(key);
        if (!existing || existing.priority < row.priority) unique.set(key, row);
    }
    if (unique.size === 0) return;

    // Sorted so concurrent transactions lock rows in the same order, the one a run's follow-ups are queued in.
    const order = new Map([...unique.values()].map((row) => [row.pipeline, queueLockOrder(row.pipeline)]));
    const sorted = [...unique.values()].sort(
        (a, b) =>
            order.get(a.pipeline)! - order.get(b.pipeline)! ||
            a.pipeline.localeCompare(b.pipeline) ||
            a.subjectId.localeCompare(b.subjectId),
    );

    await client.execute(sql`
        INSERT INTO job_queue (pipeline, subject_id, library_id, priority)
        SELECT * FROM unnest(
            ${sql.param(sorted.map((row) => row.pipeline))}::text[],
            ${sql.param(sorted.map((row) => row.subjectId))}::text[],
            ${sql.param(sorted.map((row) => row.libraryId))}::uuid[],
            ${sql.param(sorted.map((row) => row.priority))}::smallint[]
        )
        ON CONFLICT (pipeline, subject_id) ${ON_CONFLICT[mode]}
    `);
    await client.execute(sql`SELECT pg_notify(${QUEUE_CHANNEL}, '')`);
}

type ClaimedRecord = {
    pipeline: string;
    subject_id: string;
    library_id: string;
    lease_token: string;
    attempts: number;
    cursor: string | null;
    interruptions: number;
};

// NULLS LAST only matches job_queue_claim_idx (priority is never null): plain DESC means NULLS FIRST, which sorts every due row.
async function claimWhere(filter: SQL, limit: number): Promise<ClaimedRow[]> {
    if (limit <= 0) return [];
    const result = await db.execute<ClaimedRecord>(sql`
        WITH picked AS (
            SELECT pipeline, subject_id, lease_token IS NOT NULL AS interrupted FROM job_queue
            WHERE available_at <= now() AND (lease_token IS NULL OR lease_expires_at < now()) AND ${filter}
                AND library_id NOT IN (SELECT id FROM library WHERE jobs_paused)
            ORDER BY priority DESC NULLS LAST, available_at
            LIMIT ${limit}
            FOR NO KEY UPDATE SKIP LOCKED
        )
        UPDATE job_queue q
        SET
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
            attempts = q.attempts + 1,
            interruptions = q.interruptions + picked.interrupted::int
        FROM picked
        WHERE q.pipeline = picked.pipeline AND q.subject_id = picked.subject_id
        RETURNING q.pipeline, q.subject_id, q.library_id, q.lease_token, q.attempts, q.cursor, q.interruptions
    `);
    return result.rows.map((row) => ({
        pipeline: row.pipeline,
        subjectId: row.subject_id,
        libraryId: row.library_id,
        leaseToken: row.lease_token,
        attempts: row.attempts,
        cursor: row.cursor,
        interruptions: row.interruptions,
    }));
}

/**
 * Leases up to `limit` due rows, highest priority first, leaving out the `paused` queues (a worker's own note that
 * their provider is out of capacity) and every library the user put on hold. Expired leases are reclaimed here; there
 * is no sweeper.
 */
export function claim(limit: number, paused: readonly QueueInLibrary[] = []): Promise<ClaimedRow[]> {
    if (paused.length === 0) return claimWhere(sql`true`, limit);
    const pipelines = sql.param(paused.map((queue) => queue.pipeline));
    const libraries = sql.param(paused.map((queue) => queue.libraryId));
    return claimWhere(sql`(pipeline, library_id) NOT IN (SELECT * FROM unnest(${pipelines}::text[], ${libraries}::uuid[]))`, limit);
}

/**
 * Leases up to `limit` more due rows of one queue to batch with a row already claimed. Rows that were interrupted are
 * left out: running one may be what took the worker down, so it must not take a batch with it.
 */
export function claimBatch(pipeline: string, limit: number): Promise<ClaimedRow[]> {
    return claimWhere(sql`pipeline = ${pipeline} AND lease_token IS NULL AND interruptions = 0`, limit);
}

/**
 * Puts a library's background work on hold or lets it go on. Only claims read this: runs in progress finish, retries
 * and new work wait in the queue, and the NOTIFY gets a resumed library going without waiting for the next poll.
 */
export async function setLibraryPaused(libraryId: string, paused: boolean): Promise<void> {
    await db.transaction(async (tx) => {
        await tx.update(Library).set({ jobs_paused: paused, update_time: Temporal.Now.instant() }).where(eq(Library.id, libraryId));
        await tx.execute(sql`SELECT pg_notify(${QUEUE_CHANNEL}, '')`);
    });
}

export async function renew(lease: Lease, seconds = LEASE_SECONDS): Promise<boolean> {
    const rows = await db
        .update(JobQueue)
        .set({ lease_expires_at: sql`now() + make_interval(secs => ${seconds})` })
        .where(holds(lease))
        .returning({ token: JobQueue.lease_token });
    return rows.length > 0;
}

/**
 * Fencing: called inside the transaction that writes a run's results, after those writes. Locks the queue row while
 * the lease is still ours, so a worker whose lease was reclaimed rolls back, and nobody can reclaim it until this
 * commits. Writers lock result rows and then queue rows; a fence taken first would lock them the other way round.
 */
export async function fence(tx: Transaction, lease: Lease): Promise<void> {
    const rows = await tx.select({ dirty: JobQueue.dirty }).from(JobQueue).where(holds(lease)).for("no key update");
    if (rows.length === 0) throw new LeaseLostError(lease);
}

/** Releases a row that was marked dirty while running, so it runs again from scratch right away. */
async function rerun(client: DbClient, lease: Lease): Promise<boolean> {
    const rows = await client
        .update(JobQueue)
        .set({
            lease_token: null,
            lease_expires_at: null,
            dirty: false,
            available_at: sql`now()`,
            attempts: 0,
            interruptions: 0,
            cursor: null,
        })
        .where(and(holds(lease), eq(JobQueue.dirty, true)))
        .returning({ pipeline: JobQueue.pipeline });
    return rows.length > 0;
}

/** The run succeeded: delete the row, or rerun it when it was marked dirty meanwhile. False when the lease was lost. */
export async function finish(lease: Lease, client: DbClient = db): Promise<boolean> {
    const deleted = await client
        .delete(JobQueue)
        .where(and(holds(lease), eq(JobQueue.dirty, false)))
        .returning({ pipeline: JobQueue.pipeline });
    return deleted.length > 0 || rerun(client, lease);
}

/**
 * The run failed and will be retried after `delaySeconds`. A row marked dirty meanwhile reruns now with a fresh
 * count instead, since the failure may be about input that has changed since.
 */
export async function defer(lease: Lease, delaySeconds: number): Promise<boolean> {
    if (await rerun(db, lease)) return true;
    const rows = await db
        .update(JobQueue)
        .set({
            lease_token: null,
            lease_expires_at: null,
            interruptions: 0,
            available_at: sql`now() + make_interval(secs => ${delaySeconds})`,
        })
        .where(holds(lease))
        .returning({ pipeline: JobQueue.pipeline });
    return rows.length > 0;
}

/**
 * The run could not start yet (a provider at its rate limit): release the row to run after `delaySeconds` and take
 * its attempt back. It says nothing about the subject, so a count of interruptions stands. A row marked dirty
 * meanwhile reruns now.
 */
export async function postpone(lease: Lease, delaySeconds: number): Promise<boolean> {
    if (await rerun(db, lease)) return true;
    const rows = await db
        .update(JobQueue)
        .set({
            lease_token: null,
            lease_expires_at: null,
            attempts: sql`${JobQueue.attempts} - 1`,
            available_at: sql`now() + make_interval(secs => ${delaySeconds})`,
        })
        .where(holds(lease))
        .returning({ pipeline: JobQueue.pipeline });
    return rows.length > 0;
}

/**
 * The run failed for good: `record` stores the failure on the result rows, and the queue row is deleted in the same
 * transaction. A row marked dirty meanwhile reruns instead and nothing is recorded.
 */
export async function giveUp(lease: Lease, record: (tx: Transaction) => Promise<void>): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [row] = await tx.select({ dirty: JobQueue.dirty }).from(JobQueue).where(holds(lease)).for("no key update");
        if (!row) return false;
        if (row.dirty) return rerun(tx, lease);
        await record(tx);
        await tx.delete(JobQueue).where(holds(lease));
        return true;
    });
}

/** Library scans: store how far the scan got and release the row to continue right away (from scratch if dirty). */
export async function advance(lease: Lease, cursor: string, client: DbClient = db): Promise<boolean> {
    const rows = await client
        .update(JobQueue)
        .set({
            lease_token: null,
            lease_expires_at: null,
            cursor: sql`CASE WHEN ${JobQueue.dirty} THEN NULL ELSE ${cursor} END`,
            dirty: false,
            available_at: sql`now()`,
            attempts: 0,
            interruptions: 0,
        })
        .where(holds(lease))
        .returning({ pipeline: JobQueue.pipeline });
    return rows.length > 0;
}

/** Moves the queued rows of subjects that moved to another library, so they count towards it. */
export async function relocate(client: DbClient, subjectIds: readonly string[], libraryId: string): Promise<void> {
    if (subjectIds.length === 0) return;
    await client.update(JobQueue).set({ library_id: libraryId }).where(isAnyOf(JobQueue.subject_id, subjectIds));
}

/** Deletes every row of the given queues, e.g. those of an embedding space that was dropped. */
export async function deleteQueues(client: DbClient, names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    await client.delete(JobQueue).where(inArray(JobQueue.pipeline, [...names]));
}

/** Rows of the given queues in a library, scans included; zero once they have settled every subject. */
export async function countRows(libraryId: string, names: readonly string[]): Promise<number> {
    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(JobQueue)
        .where(and(eq(JobQueue.library_id, libraryId), inArray(JobQueue.pipeline, [...names])));
    return row?.count ?? 0;
}

export interface QueueCounts {
    readonly libraryId: string;
    readonly pipeline: string;
    readonly queued: number;
    readonly running: number;
    readonly retrying: number;
    readonly oldestSeconds: number;
}

/** Per library and queue name: all rows, rows with a live lease, rows waiting for another attempt, and how long the oldest row has been here. */
export async function countQueue(libraryIds: readonly string[]): Promise<QueueCounts[]> {
    if (libraryIds.length === 0) return [];
    const rows = await db
        .select({
            libraryId: JobQueue.library_id,
            pipeline: JobQueue.pipeline,
            queued: sql<number>`count(*)::int`,
            running: sql<number>`(count(*) FILTER (WHERE ${leased}))::int`,
            retrying: sql<number>`(count(*) FILTER (WHERE ${JobQueue.attempts} > 0 AND NOT ${leased}))::int`,
            oldestSeconds: sql<number>`extract(epoch FROM now() - min(${JobQueue.enqueued_at}))::int`,
        })
        .from(JobQueue)
        .where(inArray(JobQueue.library_id, [...libraryIds]))
        .groupBy(JobQueue.library_id, JobQueue.pipeline);
    return rows;
}

/** Whether a subject still has a row for a pipeline, i.e. that pipeline has not settled it yet. */
export async function isQueued(pipeline: string, subjectId: string): Promise<boolean> {
    const rows = await db
        .select({ pipeline: JobQueue.pipeline })
        .from(JobQueue)
        .where(and(eq(JobQueue.pipeline, pipeline), eq(JobQueue.subject_id, subjectId)))
        .limit(1);
    return rows.length > 0;
}
