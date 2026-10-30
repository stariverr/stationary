import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, ne, sql } from "drizzle-orm";
import { JobQueue } from "@/db/schema";
import { db } from "@/global/db";
import { markChanged, requeue } from "@/infra/queue/changes";
import { Aspect, scanQueueName } from "@/infra/queue/pipelines";
import { DEFAULT_MAX_ATTEMPTS } from "@/infra/queue/policy";
import {
    LeaseLostError,
    advance,
    claim,
    countQueue,
    defer,
    enqueue,
    fence,
    finish,
    giveUp,
    postpone,
    relocate,
    renew,
    type ClaimedRow,
} from "@/infra/queue/store";
import type { FailureRecord, PipelineHandlers, ReconcileResult, SubjectPipelineHandler } from "@/infra/queue/types";
import { QueueWorker } from "@/infra/queue/worker";

const databaseTest = process.env.RUN_QUEUE_DB_TESTS === "1" ? test : test.skip;

/**
 * Every row these tests create belongs to a random library id and outranks real work, so claims pick them first.
 * Each claim asks for exactly as many rows as the test queued and checks that it got only those.
 */
const TEST_PRIORITY = 32_000;
let libraryId = crypto.randomUUID();

afterEach(async () => {
    if (process.env.RUN_QUEUE_DB_TESTS !== "1") return;
    await db.delete(JobQueue).where(eq(JobQueue.library_id, libraryId));
    libraryId = crypto.randomUUID();
});

const subject = () => `test-${crypto.randomUUID()}`;

async function queue(pipeline: string, subjectIds: readonly string[], mode: "change" | "scan" | "absent" = "change") {
    await enqueue(
        db,
        subjectIds.map((subjectId) => ({ pipeline, subjectId, libraryId, priority: TEST_PRIORITY })),
        mode,
    );
}

async function claimOurs(count: number): Promise<ClaimedRow[]> {
    const rows = await claim(count);
    expect(rows.every((row) => row.libraryId === libraryId)).toBe(true);
    return rows;
}

async function rowOf(pipeline: string, subjectId: string) {
    const [row] = await db
        .select()
        .from(JobQueue)
        .where(and(eq(JobQueue.pipeline, pipeline), eq(JobQueue.subject_id, subjectId)));
    return row;
}

describe("job_queue store", () => {
    databaseTest("enqueue merges into one row and marks a running row dirty", async () => {
        const id = subject();
        await queue("avatar", [id, id]);
        await queue("avatar", [id]);
        expect(await db.$count(JobQueue, eq(JobQueue.library_id, libraryId))).toBe(1);

        const [row] = await claimOurs(1);
        await queue("avatar", [id]);
        expect((await rowOf("avatar", id))?.dirty).toBe(true);

        // A dirty row is released to run again instead of being deleted.
        expect(await finish(row!)).toBe(true);
        const rerun = await rowOf("avatar", id);
        expect(rerun?.dirty).toBe(false);
        expect(rerun?.lease_token).toBeNull();

        const [again] = await claimOurs(1);
        expect(await finish(again!)).toBe(true);
        expect(await rowOf("avatar", id)).toBeUndefined();
    });

    databaseTest("scan and absent enqueues keep an idle row's retry backoff", async () => {
        const id = subject();
        await queue("avatar", [id]);
        await db
            .update(JobQueue)
            .set({ attempts: 2, available_at: sql`now() + interval '1 hour'` })
            .where(eq(JobQueue.subject_id, id));

        await queue("avatar", [id], "scan");
        await queue("avatar", [id], "absent");
        const kept = await rowOf("avatar", id);
        expect(kept?.attempts).toBe(2);
        expect(kept!.available_at.epochMilliseconds).toBeGreaterThan(Date.now());

        await queue("avatar", [id], "change");
        const reset = await rowOf("avatar", id);
        expect(reset?.attempts).toBe(0);
        expect(reset!.available_at.epochMilliseconds).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    databaseTest("concurrent claims never lease the same row", async () => {
        await queue(
            "avatar",
            Array.from({ length: 6 }, () => subject()),
        );
        const [first, second] = await Promise.all([claim(3), claim(3)]);
        const claimed = [...first, ...second];
        expect(claimed.every((row) => row.libraryId === libraryId)).toBe(true);
        expect(new Set(claimed.map((row) => row.subjectId)).size).toBe(6);
    });

    databaseTest("a run whose lease was taken over cannot write or settle", async () => {
        const id = subject();
        await queue("avatar", [id]);
        const [row] = await claimOurs(1);
        await db.update(JobQueue).set({ lease_token: crypto.randomUUID() }).where(eq(JobQueue.subject_id, id));

        await expect(db.transaction((tx) => fence(tx, row!))).rejects.toBeInstanceOf(LeaseLostError);
        expect(await renew(row!)).toBe(false);
        expect(await finish(row!)).toBe(false);
        expect(await defer(row!, 5)).toBe(false);
        expect(await rowOf("avatar", id)).toBeDefined();
    });

    databaseTest("defer backs off and giveUp records the failure once", async () => {
        const id = subject();
        await queue("avatar", [id]);
        const [row] = await claimOurs(1);
        expect(await defer(row!, 60)).toBe(true);
        const deferred = await rowOf("avatar", id);
        expect(deferred?.attempts).toBe(1);
        expect(deferred?.lease_token).toBeNull();
        expect(deferred!.available_at.epochMilliseconds).toBeGreaterThan(Date.now() + 30_000);

        await db
            .update(JobQueue)
            .set({ available_at: sql`now()` })
            .where(eq(JobQueue.subject_id, id));
        const [retry] = await claimOurs(1);
        expect(retry?.attempts).toBe(2);

        // Dirty while running: rerun instead of recording.
        await queue("avatar", [id]);
        let recorded = 0;
        expect(await giveUp(retry!, async () => void recorded++)).toBe(true);
        expect(recorded).toBe(0);
        expect((await rowOf("avatar", id))?.attempts).toBe(0);

        const [last] = await claimOurs(1);
        expect(await giveUp(last!, async () => void recorded++)).toBe(true);
        expect(recorded).toBe(1);
        expect(await rowOf("avatar", id)).toBeUndefined();
    });

    databaseTest("a claim counts as an attempt unless the run is postponed, and only idle rows count as retrying", async () => {
        const id = subject();
        await queue("avatar", [id]);
        const [first] = await claimOurs(1);
        expect(first?.attempts).toBe(1);
        expect((await countQueue([libraryId]))[0]).toMatchObject({ queued: 1, running: 1, retrying: 0 });

        expect(await postpone(first!, 0)).toBe(true);
        expect((await rowOf("avatar", id))?.attempts).toBe(0);
        expect((await countQueue([libraryId]))[0]).toMatchObject({ queued: 1, running: 0, retrying: 0 });

        const [second] = await claimOurs(1);
        expect(second?.attempts).toBe(1);
        expect(await defer(second!, 0)).toBe(true);
        expect((await countQueue([libraryId]))[0]).toMatchObject({ queued: 1, running: 0, retrying: 1 });
    });

    databaseTest("a crashed run counts: reclaiming an expired lease adds an attempt", async () => {
        const id = subject();
        await queue("avatar", [id]);
        for (const attempt of [1, 2, 3]) {
            const [row] = await claimOurs(1);
            expect(row?.attempts).toBe(attempt);
            await db
                .update(JobQueue)
                .set({ lease_expires_at: sql`now() - interval '1 second'` })
                .where(eq(JobQueue.subject_id, id));
        }
    });

    databaseTest("enqueue and the requests around it take more rows than the protocol has bind parameters", async () => {
        const ids = Array.from({ length: 70_000 }, () => crypto.randomUUID());
        for (const mode of ["absent", "scan", "change"] as const) await queue("avatar", ids, mode);
        expect(await db.$count(JobQueue, eq(JobQueue.library_id, libraryId))).toBe(ids.length);

        const otherLibrary = crypto.randomUUID();
        await relocate(db, ids, otherLibrary);
        expect(await db.$count(JobQueue, eq(JobQueue.library_id, otherLibrary))).toBe(ids.length);
        await db.delete(JobQueue).where(eq(JobQueue.library_id, otherLibrary));

        // None of these exist, so this only proves the lookup of their libraries runs.
        await requeue(db, ["avatar", "cover"], ids);
        expect(await db.$count(JobQueue, eq(JobQueue.library_id, otherLibrary))).toBe(0);
    });

    databaseTest("a library scan keeps its cursor and restarts when the input changes", async () => {
        const name = scanQueueName("cover");
        await queue(name, [libraryId]);
        const [first] = await claimOurs(1);
        expect(first?.cursor).toBeNull();
        expect(await advance(first!, "page-1")).toBe(true);

        const [second] = await claimOurs(1);
        expect(second?.cursor).toBe("page-1");
        await queue(name, [libraryId]);
        expect(await advance(second!, "page-2")).toBe(true);
        const restarted = await rowOf(name, libraryId);
        expect(restarted?.cursor).toBeNull();
        expect(restarted?.dirty).toBe(false);

        const [third] = await claimOurs(1);
        expect(await advance(third!, "page-1")).toBe(true);
        await queue(name, [libraryId]);
        expect((await rowOf(name, libraryId))?.cursor).toBeNull();
    });

    databaseTest("markChanged is queued only when the transaction commits", async () => {
        const rollback = new Error("ROLLBACK_QUEUE_TEST");
        await expect(
            db.transaction(async (tx) => {
                await markChanged(tx, Aspect.LIBRARY_COVER_CONFIG, [libraryId]);
                throw rollback;
            }),
        ).rejects.toBe(rollback);
        expect(await rowOf(scanQueueName("cover"), libraryId)).toBeUndefined();

        await db.transaction((tx) => markChanged(tx, Aspect.LIBRARY_COVER_CONFIG, [libraryId]));
        expect(await rowOf(scanQueueName("cover"), libraryId)).toBeDefined();
    });
});

describe("QueueWorker", () => {
    /** Runs a worker over `subjectIds` until their rows are gone; returns the subjects it reconciled and the recorded failures. */
    async function runWorker(reconcile: (subjectId: string) => ReconcileResult, subjectIds: readonly string[], maxAttempts?: number) {
        // The worker claims any due row, so only run it when the queue holds nothing else.
        const others = await db.$count(JobQueue, ne(JobQueue.library_id, libraryId));
        if (others > 0) throw new Error(`job_queue holds ${others} other row(s); run this test against an idle queue`);

        const reconciled: string[] = [];
        const failures: FailureRecord[] = [];
        const handler: SubjectPipelineHandler = {
            maxAttempts,
            async reconcile(ctx) {
                reconciled.push(ctx.subjectId);
                await db.transaction((tx) => ctx.fence(tx));
                return reconcile(ctx.subjectId);
            },
            async recordFailure(_tx, failure) {
                failures.push(failure);
            },
            scanPage: async () => ({ subjectIds: [], nextCursor: null }),
            countFailures: async () => new Map(),
            listFailures: async () => [],
        };
        const handlers: PipelineHandlers = {
            download: handler,
            avatar: handler,
            cover: handler,
            "ai.describe": handler,
            "ai.index": handler,
            "ai.text": handler,
            "ai.image": handler,
        };
        const worker = new QueueWorker(handlers, { concurrency: 2, pollIntervalMs: 100, patrolIntervalMs: 0 });

        worker.start();
        try {
            await queue("avatar", subjectIds);
            const deadline = Date.now() + 10_000;
            while ((await db.$count(JobQueue, eq(JobQueue.library_id, libraryId))) > 0) {
                if (Date.now() > deadline) throw new Error("Worker did not drain the test rows in time");
                await Bun.sleep(100);
            }
        } finally {
            await worker.drain();
        }
        return { reconciled, failures };
    }

    databaseTest("runs queued subjects to completion and records a rejected input at once", async () => {
        const ok = [subject(), subject()];
        const bad = subject();
        const { reconciled, failures } = await runWorker(
            (id) => (id === bad ? { kind: "rejected", error: "unrenderable" } : { kind: "done" }),
            [...ok, bad],
        );

        expect(reconciled.sort()).toEqual([...ok, bad].sort());
        expect(failures).toEqual([{ subjectId: bad, space: null, error: "unrenderable", errorKind: null, rejected: true }]);
    });

    databaseTest("records a failure without blaming the input once its attempts run out", async () => {
        const id = subject();
        const { reconciled, failures } = await runWorker(() => ({ kind: "retry", error: "bad gateway", errorKind: "TRANSIENT" }), [id], 1);

        expect(reconciled).toEqual([id]);
        expect(failures).toEqual([{ subjectId: id, space: null, error: "bad gateway", errorKind: "TRANSIENT", rejected: false }]);
    });

    databaseTest("gives up on a subject whose every attempt was interrupted, and never runs it again", async () => {
        const id = subject();
        await queue("avatar", [id]);
        await db.update(JobQueue).set({ attempts: DEFAULT_MAX_ATTEMPTS }).where(eq(JobQueue.subject_id, id));

        const { reconciled, failures } = await runWorker(() => ({ kind: "done" }), []);

        expect(reconciled).toEqual([]);
        expect(failures).toEqual([
            { subjectId: id, space: null, error: `The run was interrupted ${DEFAULT_MAX_ATTEMPTS} times`, errorKind: null, rejected: true },
        ]);
    });
});
