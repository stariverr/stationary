import { and, eq, inArray, sql } from "drizzle-orm";
import { JobQueue } from "@/db/schema";
import { db, type DbClient, type Transaction } from "@/global/db";
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
    /** Failed attempts before this one. */
    readonly attempts: number;
    readonly cursor: string | null;
}

export type Lease = Pick<ClaimedRow, "pipeline" | "subjectId" | "leaseToken">;

/** The lease was taken over by another worker; nothing this run computed may be written. */
export class LeaseLostError extends Error {
    constructor(lease: Lease) {
        super(`Lease on ${lease.pipeline}/${lease.subjectId} was lost`);
        this.name = "LeaseLostError";
    }
}

const leased = sql`(${JobQueue.lease_token} IS NOT NULL AND ${JobQueue.lease_expires_at} > now())`;

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

/** The NOTIFY is transactional, so workers wake only once the caller's transaction commits. */
export async function enqueue(client: DbClient, rows: readonly EnqueueRow[], mode: EnqueueMode = "change"): Promise<void> {
    const unique = new Map<string, EnqueueRow>();
    for (const row of rows) {
        const key = `${row.pipeline}\u0000${row.subjectId}`;
        const existing = unique.get(key);
        if (!existing || existing.priority < row.priority) unique.set(key, row);
    }
    if (unique.size === 0) return;

    // Sorted so concurrent enqueues lock rows in the same order.
    const values = [...unique.values()]
        .sort((a, b) => a.pipeline.localeCompare(b.pipeline) || a.subjectId.localeCompare(b.subjectId))
        .map((row) => ({ pipeline: row.pipeline, subject_id: row.subjectId, library_id: row.libraryId, priority: row.priority }));

    const insert = client.insert(JobQueue).values(values);
    if (mode === "absent") {
        await insert.onConflictDoNothing();
    } else if (mode === "scan") {
        await insert.onConflictDoUpdate({
            target: [JobQueue.pipeline, JobQueue.subject_id],
            set: {
                priority: sql`greatest(${JobQueue.priority}, excluded.priority)`,
                dirty: sql`${JobQueue.dirty} OR ${leased}`,
            },
        });
    } else {
        await insert.onConflictDoUpdate({
            target: [JobQueue.pipeline, JobQueue.subject_id],
            set: {
                library_id: sql`excluded.library_id`,
                priority: sql`greatest(${JobQueue.priority}, excluded.priority)`,
                dirty: sql`${JobQueue.dirty} OR ${leased}`,
                available_at: sql`CASE WHEN ${leased} THEN ${JobQueue.available_at} ELSE now() END`,
                attempts: sql`CASE WHEN ${leased} THEN ${JobQueue.attempts} ELSE 0 END`,
                cursor: sql`CASE WHEN ${leased} THEN ${JobQueue.cursor} ELSE NULL END`,
            },
        });
    }
    await client.execute(sql`SELECT pg_notify(${QUEUE_CHANNEL}, '')`);
}

/** Leases up to `limit` due rows, highest priority first. Expired leases are reclaimed here; there is no sweeper. */
export async function claim(limit: number): Promise<ClaimedRow[]> {
    const result = await db.execute<{
        pipeline: string;
        subject_id: string;
        library_id: string;
        lease_token: string;
        attempts: number;
        cursor: string | null;
    }>(sql`
        WITH picked AS (
            SELECT pipeline, subject_id FROM job_queue
            WHERE available_at <= now() AND (lease_token IS NULL OR lease_expires_at < now())
            ORDER BY priority DESC, available_at
            LIMIT ${limit}
            FOR NO KEY UPDATE SKIP LOCKED
        )
        UPDATE job_queue q
        SET lease_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
        FROM picked
        WHERE q.pipeline = picked.pipeline AND q.subject_id = picked.subject_id
        RETURNING q.pipeline, q.subject_id, q.library_id, q.lease_token, q.attempts, q.cursor
    `);
    return result.rows.map((row) => ({
        pipeline: row.pipeline,
        subjectId: row.subject_id,
        libraryId: row.library_id,
        leaseToken: row.lease_token,
        attempts: row.attempts,
        cursor: row.cursor,
    }));
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
 * Fencing: called first inside the transaction that writes a run's results. Locks the queue row while the lease is
 * still ours, so a worker whose lease was reclaimed cannot write, and nobody can reclaim it until this commits.
 */
export async function fence(tx: Transaction, lease: Lease): Promise<void> {
    const rows = await tx.select({ dirty: JobQueue.dirty }).from(JobQueue).where(holds(lease)).for("no key update");
    if (rows.length === 0) throw new LeaseLostError(lease);
}

/** Releases a row that was marked dirty while running, so it runs again from scratch right away. */
async function rerun(client: DbClient, lease: Lease): Promise<boolean> {
    const rows = await client
        .update(JobQueue)
        .set({ lease_token: null, lease_expires_at: null, dirty: false, available_at: sql`now()`, attempts: 0, cursor: null })
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
            attempts: sql`${JobQueue.attempts} + 1`,
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
        })
        .where(holds(lease))
        .returning({ pipeline: JobQueue.pipeline });
    return rows.length > 0;
}

/** Moves the queued rows of subjects that moved to another library, so they count towards it. */
export async function relocate(client: DbClient, subjectIds: readonly string[], libraryId: string): Promise<void> {
    if (subjectIds.length === 0) return;
    await client
        .update(JobQueue)
        .set({ library_id: libraryId })
        .where(inArray(JobQueue.subject_id, [...subjectIds]));
}

export interface QueueCounts {
    readonly libraryId: string;
    readonly pipeline: string;
    readonly queued: number;
    readonly running: number;
    readonly retrying: number;
}

/** Per library and queue name: rows waiting, rows with a live lease, and rows that already failed at least once. */
export async function countQueue(libraryIds: readonly string[]): Promise<QueueCounts[]> {
    if (libraryIds.length === 0) return [];
    const rows = await db
        .select({
            libraryId: JobQueue.library_id,
            pipeline: JobQueue.pipeline,
            queued: sql<number>`count(*)::int`,
            running: sql<number>`(count(*) FILTER (WHERE ${leased}))::int`,
            retrying: sql<number>`(count(*) FILTER (WHERE ${JobQueue.attempts} > 0))::int`,
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
