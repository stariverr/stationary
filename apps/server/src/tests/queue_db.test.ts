import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { jobsApp } from "@/api/jobs";
import { ExternalApiToken, JobQueue, Library, Media, MediaOriginal, MediaType, SyncStatus, User } from "@/db/schema";
import { downloadPipeline } from "@/features/ingest/download-pipeline";
import { deleteLibrary } from "@/features/library/delete-library";
import { ApiTokenService } from "@/features/auth/api-token";
import { db } from "@/global/db";
import { markChanged, requeue } from "@/infra/queue/changes";
import { Aspect, PIPELINE_NAMES, scanQueueName } from "@/infra/queue/pipelines";
import { DEFAULT_MAX_ATTEMPTS } from "@/infra/queue/policy";
import {
    LeaseLostError,
    advance,
    claim,
    claimBatch,
    countQueue,
    defer,
    enqueue,
    fence,
    finish,
    giveUp,
    postpone,
    relocate,
    renew,
    setLibraryPaused,
    type ClaimedRow,
} from "@/infra/queue/store";
import type {
    BatchPipelineHandler,
    FailureRecord,
    PipelineHandler,
    PipelineHandlers,
    ReconcileResult,
    SubjectPipelineHandler,
} from "@/infra/queue/types";
import { QueueWorker, type QueueWorkerOptions } from "@/infra/queue/worker";

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
    await db.delete(Library).where(eq(Library.id, libraryId));
    libraryId = crypto.randomUUID();
});

const subject = () => `test-${crypto.randomUUID()}`;

/** Most tests get by without a library row; pausing needs one. */
async function pausedLibrary() {
    await db.insert(Library).values({ id: libraryId, name: "test", description: "", owner_id: crypto.randomUUID() });
    await setLibraryPaused(libraryId, true);
}

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

/** What a worker dying in the middle of a run leaves behind. */
async function expireLease(subjectId: string) {
    await db
        .update(JobQueue)
        .set({ lease_expires_at: sql`now() - interval '1 second'` })
        .where(eq(JobQueue.subject_id, subjectId));
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

    databaseTest("claims the highest priority first, then whatever has waited longest", async () => {
        const [lower, earlier, later] = [subject(), subject(), subject()];
        await queue("avatar", [lower, earlier, later]);
        await db
            .update(JobQueue)
            .set({ priority: TEST_PRIORITY - 1, available_at: sql`now() - interval '3 minutes'` })
            .where(eq(JobQueue.subject_id, lower));
        await db
            .update(JobQueue)
            .set({ available_at: sql`now() - interval '2 minutes'` })
            .where(eq(JobQueue.subject_id, earlier));
        await db
            .update(JobQueue)
            .set({ available_at: sql`now() - interval '1 minute'` })
            .where(eq(JobQueue.subject_id, later));

        // One at a time: the rows of a single claim come back in no particular order.
        const order = [await claimOurs(1), await claimOurs(1), await claimOurs(1)].map(([row]) => row?.subjectId);
        expect(order).toEqual([earlier, later, lower]);
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

        // Dirty while the failure is being recorded: the record is rolled back and the row reruns.
        const [again] = await claimOurs(1);
        expect(
            await giveUp(again!, async (tx) => {
                await tx.insert(Library).values({ id: libraryId, name: "test", description: "", owner_id: crypto.randomUUID() });
                await queue("avatar", [id]);
            }),
        ).toBe(true);
        expect(await db.select().from(Library).where(eq(Library.id, libraryId))).toHaveLength(0);
        expect((await rowOf("avatar", id))?.dirty).toBe(false);
        expect((await rowOf("avatar", id))?.lease_token).toBeNull();

        const [last] = await claimOurs(1);
        expect(await giveUp(last!, async () => void recorded++)).toBe(true);
        expect(recorded).toBe(1);
        expect(await rowOf("avatar", id)).toBeUndefined();
    });

    databaseTest("giveUp locks the result rows before the queue row, so it cannot deadlock with a writer", async () => {
        // The library row stands in for the result rows a failure is recorded on.
        await db.insert(Library).values({ id: libraryId, name: "test", description: "", owner_id: crypto.randomUUID() });
        const id = subject();
        await queue("avatar", [id]);
        const [row] = await claimOurs(1);
        const ofLibrary = eq(Library.id, libraryId);

        let recording!: () => void;
        const recordStarted = new Promise<void>((resolve) => (recording = resolve));
        let locked!: () => void;
        const writerLocked = new Promise<void>((resolve) => (locked = resolve));

        // A writer that follows the rule: the result rows first, then the subject's queue row (here: dropping it).
        const writer = db.transaction(async (tx) => {
            await tx.update(Library).set({ description: "writer" }).where(ofLibrary);
            locked();
            await recordStarted;
            await tx.delete(JobQueue).where(eq(JobQueue.subject_id, id));
        });
        const failure = giveUp(row!, async (tx) => {
            recording();
            await writerLocked;
            await tx.update(Library).set({ description: "failure" }).where(ofLibrary);
        });

        const [written, gaveUp] = await Promise.allSettled([writer, failure]);
        expect(written.status).toBe("fulfilled");
        // The writer dropped the row first, so the lease is lost and the failure is not recorded.
        expect(gaveUp).toEqual({ status: "fulfilled", value: false });
        const [library] = await db.select({ description: Library.description }).from(Library).where(ofLibrary);
        expect(library?.description).toBe("writer");
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

    databaseTest("a paused library's rows stay out of every claim, and enqueues carry on, until it is resumed", async () => {
        const waiting = subject();
        const interrupted = subject();
        const other = subject();
        await queue("avatar", [waiting, interrupted]);
        const rows = await claimOurs(2);
        await defer(
            rows.find((row) => row.subjectId === waiting)!,
            0,
        );
        await db
            .update(JobQueue)
            .set({ lease_expires_at: sql`now() - interval '1 second'` })
            .where(eq(JobQueue.subject_id, interrupted));
        await pausedLibrary();

        const added = subject();
        await queue("avatar", [added]);
        await queue("avatar", [waiting]);
        expect(await claim(4)).toEqual([]);
        expect(await claimBatch("avatar", 4)).toEqual([]);

        // Other libraries are not held up.
        const otherLibrary = crypto.randomUUID();
        await enqueue(db, [{ pipeline: "avatar", subjectId: other, libraryId: otherLibrary, priority: TEST_PRIORITY }]);
        const unaffected = await claim(4);
        await db.delete(JobQueue).where(eq(JobQueue.library_id, otherLibrary));
        expect(unaffected.map((row) => row.subjectId)).toEqual([other]);

        await setLibraryPaused(libraryId, false);
        const resumed = await claimOurs(3);
        expect(resumed.map((row) => row.subjectId).sort()).toEqual([added, interrupted, waiting].sort());
        expect(resumed.find((row) => row.subjectId === interrupted)).toMatchObject({ interruptions: 1, attempts: 2 });
    });

    databaseTest("a row that failed stays batched and a row whose run was interrupted does not", async () => {
        const failedId = subject();
        const interruptedId = subject();
        await queue("avatar", [failedId, interruptedId]);
        const rows = await claimOurs(2);
        expect(rows.every((row) => row.interruptions === 0)).toBe(true);
        await defer(
            rows.find((row) => row.subjectId === failedId)!,
            0,
        );
        await db
            .update(JobQueue)
            .set({ lease_expires_at: sql`now() - interval '1 second'` })
            .where(eq(JobQueue.subject_id, interruptedId));

        const batched = await claimBatch("avatar", 10);
        expect(batched.map((row) => row.subjectId)).toEqual([failedId]);
        expect(batched[0]?.attempts).toBe(2);

        const [recovered] = await claimOurs(1);
        expect(recovered).toMatchObject({ subjectId: interruptedId, interruptions: 1, attempts: 2 });
    });

    databaseTest("only runs that settle or a change of input start the count of interruptions over", async () => {
        const id = subject();
        await queue("avatar", [id]);
        const interruptedRun = async () => {
            await claimOurs(1);
            await expireLease(id);
            return (await claimOurs(1))[0]!;
        };

        const first = await interruptedRun();
        expect(first.interruptions).toBe(1);

        // A row held back by a rate limit did not run, so that says nothing about whether it kills workers.
        await postpone(first, 0);
        expect(await claimBatch("avatar", 1)).toEqual([]);
        const postponed = (await claimOurs(1))[0]!;
        expect(postponed.interruptions).toBe(1);

        await defer(postponed, 0);
        expect((await claimOurs(1))[0]?.interruptions).toBe(0);

        await expireLease(id);
        expect((await claimOurs(1))[0]?.interruptions).toBe(1);
        await expireLease(id);
        await queue("avatar", [id]);
        expect((await rowOf("avatar", id))?.interruptions).toBe(0);

        const rerun = await interruptedRun();
        await queue("avatar", [id]);
        await finish(rerun);
        expect((await rowOf("avatar", id))?.interruptions).toBe(0);

        const scan = scanQueueName("preview");
        await db.delete(JobQueue).where(eq(JobQueue.subject_id, id));
        await queue(scan, [libraryId]);
        await claimOurs(1);
        await expireLease(libraryId);
        await advance((await claimOurs(1))[0]!, "page-2");
        expect((await rowOf(scan, libraryId))?.interruptions).toBe(0);
    });

    databaseTest("the age of a row survives retries, postponing and being enqueued again", async () => {
        const id = subject();
        await queue("avatar", [id]);
        await db
            .update(JobQueue)
            .set({ enqueued_at: sql`now() - interval '1 hour'` })
            .where(eq(JobQueue.subject_id, id));

        const [first] = await claimOurs(1);
        expect(await defer(first!, 0)).toBe(true);
        const [second] = await claimOurs(1);
        expect(await postpone(second!, 0)).toBe(true);
        await queue("avatar", [id]);

        const [counts] = await countQueue([libraryId]);
        expect(counts?.oldestSeconds).toBeGreaterThanOrEqual(3600);
        expect(counts?.oldestSeconds).toBeLessThan(3660);
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
        await requeue(db, ["avatar", "preview"], ids);
        expect(await db.$count(JobQueue, eq(JobQueue.library_id, otherLibrary))).toBe(0);
    });

    databaseTest("a library scan keeps its cursor and restarts when the input changes", async () => {
        const name = scanQueueName("preview");
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
                await markChanged(tx, Aspect.LIBRARY_AI_CONFIG, [libraryId]);
                throw rollback;
            }),
        ).rejects.toBe(rollback);
        expect(await rowOf(scanQueueName("ai.describe"), libraryId)).toBeUndefined();

        await db.transaction((tx) => markChanged(tx, Aspect.LIBRARY_AI_CONFIG, [libraryId]));
        expect(await rowOf(scanQueueName("ai.describe"), libraryId)).toBeDefined();
    });
});

describe("database connections", () => {
    databaseTest("every connection carries the limits that keep a hung statement from holding it forever", async () => {
        const setting = async (name: string) => {
            const result = await db.execute<{ value: string }>(sql`SELECT current_setting(${name}) AS value`);
            return result.rows[0]?.value;
        };
        expect(await setting("statement_timeout")).toBe("2min");
        expect(await setting("lock_timeout")).toBe("30s");
        expect(await setting("idle_in_transaction_session_timeout")).toBe("1min");
    });
});

describe("QueueWorker", () => {
    const idleHandler: SubjectPipelineHandler = {
        reconcile: async () => ({ kind: "done" }),
        recordFailure: async () => undefined,
        scanPage: async () => ({ subjectIds: [], nextCursor: null }),
        countFailures: async () => new Map(),
        listFailures: async () => [],
    };
    const everyPipeline = (handler: PipelineHandler) =>
        Object.fromEntries(PIPELINE_NAMES.map((pipeline) => [pipeline, handler])) as PipelineHandlers;
    const workers: QueueWorker[] = [];
    function worker(handlers: PipelineHandlers, concurrency: number, options: QueueWorkerOptions = {}) {
        const started = new QueueWorker(handlers, { concurrency, pollIntervalMs: 50, patrolIntervalMs: 0, ...options });
        workers.push(started);
        return started;
    }

    // A worker left running by a failed test would claim the rows of the next one.
    afterEach(async () => {
        await Promise.all(workers.splice(0).map((started) => started.drain(100, 100)));
    });

    async function until(condition: () => boolean | Promise<boolean>) {
        const deadline = Date.now() + 5_000;
        while (!(await condition())) {
            if (Date.now() > deadline) throw new Error("The condition did not hold in time");
            await Bun.sleep(20);
        }
    }

    /** Seconds until each of the test rows is due. */
    async function dueInSeconds() {
        const rows = await db
            .select({ seconds: sql<number>`extract(epoch FROM ${JobQueue.available_at} - now())::float` })
            .from(JobQueue)
            .where(eq(JobQueue.library_id, libraryId));
        return rows.map((row) => row.seconds);
    }

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
            preview: handler,
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

    databaseTest("a run in progress finishes after its library is paused, and the next attempt waits for the resume", async () => {
        const running = subject();
        const next = subject();
        const { promise: released, resolve: release } = Promise.withResolvers<void>();
        const reconciled: string[] = [];
        let attempts = 0;
        const handler: SubjectPipelineHandler = {
            ...idleHandler,
            async reconcile(ctx) {
                reconciled.push(ctx.subjectId);
                if (ctx.subjectId !== running) return { kind: "done" };
                attempts += 1;
                if (attempts > 1) return { kind: "done" };
                await released;
                await db.transaction((tx) => ctx.fence(tx));
                return { kind: "retry", error: "try again" };
            },
        };
        await queue("avatar", [running]);
        worker(everyPipeline(handler), 2).start();
        await until(() => attempts === 1);

        await pausedLibrary();
        await queue("avatar", [next]);
        release();
        await until(async () => (await rowOf("avatar", running))?.lease_token === null);
        await db
            .update(JobQueue)
            .set({ available_at: sql`now()` })
            .where(eq(JobQueue.subject_id, running));

        await Bun.sleep(200);
        expect(reconciled).toEqual([running]);
        expect((await rowOf("avatar", running))?.attempts).toBe(1);

        await setLibraryPaused(libraryId, false);
        await until(async () => (await db.$count(JobQueue, eq(JobQueue.library_id, libraryId))) === 0);
        expect(reconciled.sort()).toEqual([running, running, next].sort());
    });

    databaseTest("runs queued subjects to completion and records a rejected input at once", async () => {
        const ok = [subject(), subject()];
        const bad = subject();
        const { reconciled, failures } = await runWorker(
            (id) => (id === bad ? { kind: "rejected", error: "unrenderable" } : { kind: "done" }),
            [...ok, bad],
        );

        expect(reconciled.sort()).toEqual([...ok, bad].sort());
        expect(failures).toEqual([{ subjectId: bad, space: null, error: "unrenderable", errorKind: null }]);
    });

    databaseTest("records a failure without blaming the input once its attempts run out", async () => {
        const id = subject();
        const { reconciled, failures } = await runWorker(() => ({ kind: "retry", error: "bad gateway", errorKind: "TRANSIENT" }), [id], 1);

        expect(reconciled).toEqual([id]);
        expect(failures).toEqual([{ subjectId: id, space: null, error: "bad gateway", errorKind: "TRANSIENT" }]);
    });

    databaseTest("gives up on a subject interrupted too many times in a row, and never runs it again", async () => {
        const id = subject();
        await queue("avatar", [id]);
        for (let run = 0; run < DEFAULT_MAX_ATTEMPTS; run += 1) {
            await claimOurs(1);
            await expireLease(id);
        }

        const { reconciled, failures } = await runWorker(() => ({ kind: "done" }), []);

        expect(reconciled).toEqual([]);
        expect(failures).toEqual([
            {
                subjectId: id,
                space: null,
                error: `The run was interrupted ${DEFAULT_MAX_ATTEMPTS} times in a row`,
                errorKind: null,
            },
        ]);
    });

    databaseTest("leaves the rows of a pipeline it does not know to the newer version that queued them", async () => {
        const known = subject();
        const [unknown, unknownSpace] = [subject(), subject()];
        await queue("avatar", [known]);
        await queue("ai.future", [unknown]);
        await queue("preview:space", [unknownSpace]);
        let reconciled = false;
        worker(
            everyPipeline({
                ...idleHandler,
                async reconcile() {
                    reconciled = true;
                    return { kind: "done" };
                },
            }),
            4,
        ).start();
        await until(async () => reconciled && !(await rowOf("avatar", known)));
        await Bun.sleep(200);

        expect(await rowOf("ai.future", unknown)).toMatchObject({ attempts: 0, lease_token: null });
        expect(await rowOf("preview:space", unknownSpace)).toMatchObject({ attempts: 0, lease_token: null });
    });

    databaseTest("an interruption after ordinary failures does not blame the input", async () => {
        const id = subject();
        await queue("avatar", [id]);
        for (let run = 1; run < DEFAULT_MAX_ATTEMPTS; run += 1) await defer((await claimOurs(1))[0]!, 0);
        await claimOurs(1);
        await expireLease(id);

        const { reconciled, failures } = await runWorker(() => ({ kind: "retry", error: "bad gateway" }), []);

        expect(reconciled).toEqual([id]);
        expect(failures).toEqual([{ subjectId: id, space: null, error: "bad gateway", errorKind: null }]);
    });

    databaseTest("patrols when it starts, as the timer starts over with the process", async () => {
        const patrolling = new QueueWorker(everyPipeline(idleHandler), { patrolIntervalMs: 3_600_000 });
        const patrol = spyOn(patrolling, "patrol").mockResolvedValue();
        patrolling.start();
        await patrolling.drain();
        expect(patrol).toHaveBeenCalledTimes(1);
    });

    databaseTest("a failing upkeep does not stop the others or the scans", async () => {
        await db.insert(Library).values({ id: libraryId, name: "Queue test", description: "", owner_id: crypto.randomUUID() });
        const ran: string[] = [];
        const patrolling = new QueueWorker(
            {
                ...everyPipeline(idleHandler),
                avatar: { ...idleHandler, patrol: () => Promise.reject(new Error("upkeep failed")) },
                preview: {
                    ...idleHandler,
                    patrol: async () => {
                        ran.push("preview");
                    },
                },
            },
            {},
        );
        try {
            await patrolling.patrol();
            expect(ran).toEqual(["preview"]);
            expect(await rowOf(scanQueueName("download"), libraryId)).toBeDefined();
        } finally {
            await db.delete(Library).where(eq(Library.id, libraryId));
            await db.delete(JobQueue).where(sql`${JobQueue.pipeline} LIKE 'scan:%'`);
        }
    });

    databaseTest("a scan never gives up: it keeps its place and retries", async () => {
        const name = scanQueueName("preview");
        await queue(name, [libraryId]);
        await db.update(JobQueue).set({ attempts: 99, cursor: "page-7" }).where(eq(JobQueue.library_id, libraryId));
        const failures: FailureRecord[] = [];
        const running = worker(
            everyPipeline({
                ...idleHandler,
                scanPage: () => Promise.reject(new Error("database went away")),
                recordFailure: async (_tx, failure) => {
                    failures.push(failure);
                },
            }),
            1,
        );

        running.start();
        await until(async () => (await rowOf(name, libraryId))?.attempts === 100);
        await until(async () => (await rowOf(name, libraryId))?.lease_token === null);
        await running.drain();

        expect(await rowOf(name, libraryId)).toMatchObject({ cursor: "page-7", dirty: false });
        expect(failures).toEqual([]);
    });

    /** Handles every queue with `run`, as a batch pipeline. */
    const batchHandlers = (run: BatchPipelineHandler["reconcileBatch"], options: Partial<BatchPipelineHandler> = {}) =>
        everyPipeline({ ...idleHandler, ...options, reconcile: undefined, reconcileBatch: run } as unknown as BatchPipelineHandler);

    databaseTest("a row whose run was interrupted runs alone", async () => {
        const interruptedId = subject();
        await queue("avatar", [interruptedId, subject()]);
        await claimOurs(2);
        await db.update(JobQueue).set({ lease_token: null, lease_expires_at: null }).where(ne(JobQueue.subject_id, interruptedId));
        await db
            .update(JobQueue)
            .set({ lease_expires_at: sql`now() - interval '1 second'` })
            .where(eq(JobQueue.subject_id, interruptedId));

        const batches: string[][] = [];
        const running = worker(
            batchHandlers(async (ctx) => {
                batches.push([ctx.head, ...(await ctx.claimMore(10))]);
                return new Map();
            }),
            1,
        );
        running.start();
        await until(async () => (await db.$count(JobQueue, eq(JobQueue.library_id, libraryId))) === 0);
        await running.drain();

        expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
    });

    databaseTest("rows that fail in one batch come back together", async () => {
        const fresh = subject();
        const failedTwice = subject();
        await queue("avatar", [fresh, failedTwice]);
        await db.update(JobQueue).set({ attempts: 2 }).where(eq(JobQueue.subject_id, failedTwice));

        const running = worker(
            batchHandlers(async (ctx) => {
                const subjects = [ctx.head, ...(await ctx.claimMore(10))];
                return new Map(subjects.map((id) => [id, { kind: "retry", error: "bad gateway" } as const]));
            }),
            1,
        );
        running.start();
        await until(async () => (await dueInSeconds()).every((seconds) => seconds > 30));
        await running.drain();

        const delays = await dueInSeconds();
        expect(delays).toHaveLength(2);
        expect(Math.abs(delays[0]! - delays[1]!)).toBeLessThan(1);
        expect(await rowOf("avatar", fresh)).toMatchObject({ attempts: 1, lease_token: null });
        expect(await rowOf("avatar", failedTwice)).toMatchObject({ attempts: 3, lease_token: null });
    });

    databaseTest("a shutdown aborts the runs still going and puts their rows back without using an attempt", async () => {
        const id = subject();
        const failures: FailureRecord[] = [];
        let started = false;
        const running = worker(
            everyPipeline({
                ...idleHandler,
                reconcile: (ctx) =>
                    new Promise((_resolve, reject) => {
                        started = true;
                        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
                    }),
                recordFailure: async (_tx, failure) => {
                    failures.push(failure);
                },
            }),
            1,
        );

        await queue("avatar", [id]);
        running.start();
        await until(() => started);
        await running.drain(50, 2_000);

        expect(await rowOf("avatar", id)).toMatchObject({ attempts: 0, lease_token: null, dirty: false });
        expect(failures).toEqual([]);
    });

    databaseTest("a run past its deadline is aborted and its row retried, whatever the run reports", async () => {
        const id = subject();
        const failures: FailureRecord[] = [];
        const running = worker(
            everyPipeline({
                ...idleHandler,
                timeoutMs: 50,
                // A kill by the abort can look like a bad input: a renderer that exits with an error, say.
                reconcile: (ctx) =>
                    new Promise((resolve) =>
                        ctx.signal.addEventListener("abort", () => resolve({ kind: "rejected", error: "cannot decode" })),
                    ),
                recordFailure: async (_tx, failure) => {
                    failures.push(failure);
                },
            }),
            1,
        );

        await queue("avatar", [id]);
        running.start();
        await until(async () => (await dueInSeconds()).every((seconds) => seconds > 1));

        expect(await rowOf("avatar", id)).toMatchObject({ attempts: 1, lease_token: null });
        expect(failures).toEqual([]);
    });

    databaseTest("a batch past its deadline retries its rows and claims no more", async () => {
        const claimed: string[][] = [];
        const failures: FailureRecord[] = [];
        const running = worker(
            batchHandlers(
                async (ctx) => {
                    await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
                    claimed.push(await ctx.claimMore(10));
                    return new Map([[ctx.head, { kind: "rejected", error: "cannot decode" }]]);
                },
                {
                    timeoutMs: 50,
                    recordFailure: async (_tx, failure) => {
                        failures.push(failure);
                    },
                },
            ),
            1,
        );

        await queue("avatar", [subject(), subject()]);
        running.start();
        await until(async () => (await dueInSeconds()).every((seconds) => seconds > 1));

        expect(claimed).toEqual([[], []]);
        expect(failures).toEqual([]);
    });

    databaseTest("a scan that ignores its abort signal does not hold up a shutdown", async () => {
        let scanning = false;
        const running = worker(
            everyPipeline({
                ...idleHandler,
                scanPage() {
                    scanning = true;
                    return new Promise(() => undefined);
                },
            }),
            1,
            { stuckAfterMs: 20 },
        );

        await queue(scanQueueName("avatar"), [libraryId]);
        running.start();
        await until(() => scanning);

        const start = performance.now();
        await running.drain(0, 5_000);
        expect(performance.now() - start).toBeLessThan(1_000);
    });

    databaseTest("a run that ignores its abort signal gives up its slot and its lease", async () => {
        const stuckId = subject();
        const nextId = subject();
        const ran: string[] = [];
        const running = worker(
            everyPipeline({
                ...idleHandler,
                timeoutMs: 50,
                async reconcile(ctx) {
                    ran.push(ctx.subjectId);
                    if (ctx.subjectId === stuckId) await new Promise(() => undefined);
                    return { kind: "done" };
                },
            }),
            1,
            { stuckAfterMs: 50 },
        );

        await queue("avatar", [stuckId]);
        running.start();
        await until(() => ran.length === 1);
        await queue("avatar", [nextId]);

        // The only slot was taken, so this run proves the stuck one no longer holds it.
        await until(async () => (await rowOf("avatar", nextId)) === undefined);
        expect(ran).toEqual([stuckId, nextId]);

        // Nothing renews the lease any more, so the row comes back as interrupted once it expires.
        const row = await rowOf("avatar", stuckId);
        expect(row).toMatchObject({ attempts: 1 });
        expect(row?.lease_token).not.toBeNull();
        await running.drain();
        await db
            .update(JobQueue)
            .set({ lease_expires_at: sql`now() - interval '1 second'` })
            .where(eq(JobQueue.subject_id, stuckId));
        const [recovered] = await claimOurs(1);
        expect(recovered).toMatchObject({ subjectId: stuckId, interruptions: 1, attempts: 2 });
    });

    databaseTest("asks for a restart only while too many runs are stuck", async () => {
        let restarts = 0;
        const hung: (() => void)[] = [];
        const running = worker(
            everyPipeline({
                ...idleHandler,
                timeoutMs: 20,
                async reconcile() {
                    await new Promise<void>((resolve) => hung.push(resolve));
                    return { kind: "done" };
                },
            }),
            2,
            { stuckAfterMs: 20, maxStuckRuns: 1, onTooManyStuckRuns: () => (restarts += 1) },
        );

        await queue("avatar", [subject()]);
        running.start();
        await until(() => hung.length === 1);
        await Bun.sleep(150);
        expect(restarts).toBe(0);

        // It came back after all, so the next stuck run is the only one.
        hung[0]?.();
        await queue("avatar", [subject()]);
        await until(() => hung.length === 2);
        await Bun.sleep(150);
        expect(restarts).toBe(0);

        await queue("avatar", [subject()]);
        await until(() => restarts === 1);
        for (const release of hung) release();
    });

    databaseTest("a run that finishes within the grace period settles normally", async () => {
        const id = subject();
        const { promise: finishing, resolve: finish } = Promise.withResolvers<void>();
        let started = false;
        const running = worker(
            everyPipeline({
                ...idleHandler,
                async reconcile() {
                    started = true;
                    await finishing;
                    return { kind: "done" };
                },
            }),
            1,
        );

        await queue("avatar", [id]);
        running.start();
        await until(() => started);
        const drained = running.drain(2_000, 100);
        finish();
        await drained;

        expect(await rowOf("avatar", id)).toBeUndefined();
    });
});

describe("pausing a library", () => {
    async function newUser(name: string) {
        const [user] = await db.insert(User).values({ auth_id: subject(), name }).returning();
        return user!;
    }

    databaseTest("the endpoint reaches only the libraries the caller's token may reach, and the status reports it", async () => {
        const owner = await newUser("owner");
        const stranger = await newUser("stranger");
        const sibling = crypto.randomUUID();
        await db.insert(Library).values([
            { id: libraryId, name: "test", description: "", owner_id: owner.id },
            { id: sibling, name: "sibling", description: "", owner_id: owner.id },
        ]);
        const token = async (userId: string, scope?: string) => (await ApiTokenService.generateToken(userId, "test", scope)).rawToken;
        const [ownerToken, strangerToken, scopedToken] = await Promise.all([token(owner.id), token(stranger.id), token(owner.id, sibling)]);
        const request = (bearer: string, path: string, init: RequestInit = {}) =>
            jobsApp.request(path, {
                ...init,
                headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
            });
        const setPaused = (bearer: string, paused: boolean) =>
            request(bearer, `/pipelines/${libraryId}/paused`, { method: "PUT", body: JSON.stringify({ paused }) });
        const isPaused = async () => {
            const [library] = await db.select({ paused: Library.jobs_paused }).from(Library).where(eq(Library.id, libraryId));
            return library?.paused;
        };

        try {
            expect((await setPaused(strangerToken, true)).status).toBe(404);
            expect((await setPaused(scopedToken, true)).status).toBe(404);
            expect((await request(scopedToken, `/pipelines?library_id=${libraryId}`)).status).toBe(404);
            expect(await isPaused()).toBe(false);

            expect((await setPaused(ownerToken, true)).status).toBe(200);
            expect(await isPaused()).toBe(true);
            const status = await request(ownerToken, `/pipelines?library_id=${libraryId}`);
            expect(((await status.json()) as { data: { paused: boolean } }).data.paused).toBe(true);

            expect((await setPaused(ownerToken, false)).status).toBe(200);
            expect(await isPaused()).toBe(false);
        } finally {
            await db.delete(ExternalApiToken).where(inArray(ExternalApiToken.owner_id, [owner.id, stranger.id]));
            await db.delete(User).where(inArray(User.id, [owner.id, stranger.id]));
            await db.delete(Library).where(eq(Library.id, sibling));
        }
    });

    databaseTest("deleting a paused library lets its rows run out", async () => {
        const ownerId = crypto.randomUUID();
        await db.insert(Library).values({ id: libraryId, name: "test", description: "", owner_id: ownerId });
        await setLibraryPaused(libraryId, true);
        await queue("avatar", [subject()]);

        await deleteLibrary(libraryId, { ownerId });
        expect(await claimOurs(1)).toHaveLength(1);
    });
});

describe("download pipeline", () => {
    databaseTest("a media whose attempts are used up waits for a retry instead of the next scan", async () => {
        const mediaId = crypto.randomUUID();
        await db.insert(Library).values({ id: libraryId, name: "test", description: "", owner_id: crypto.randomUUID() });
        await db.insert(Media).values({
            id: mediaId,
            library_id: libraryId,
            eid: `download-${mediaId}`,
            title: "",
            description: "",
            type: MediaType.IMAGE,
            sort_order: 0,
        });
        await db.insert(MediaOriginal).values({ media_id: mediaId, source_url: "https://cdn.test/a.jpg", source_key: "image", status: SyncStatus.PENDING });
        try {
            expect((await downloadPipeline.scanPage(libraryId, null, 100, null)).subjectIds).toEqual([mediaId]);

            await db.transaction((tx) =>
                downloadPipeline.recordFailure(tx, { subjectId: mediaId, space: null, error: "503 from the CDN", errorKind: null }),
            );

            expect((await downloadPipeline.scanPage(libraryId, null, 100, null)).subjectIds).toEqual([]);
            expect(await downloadPipeline.countFailures([libraryId])).toEqual(new Map([[libraryId, 1]]));
        } finally {
            await db.delete(MediaOriginal).where(eq(MediaOriginal.media_id, mediaId));
            await db.delete(Media).where(eq(Media.id, mediaId));
        }
    });
});
