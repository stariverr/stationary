import { eq } from "drizzle-orm";
import { DeleteStatus, Library } from "@/db/schema";
import { db } from "@/global/db";
import { getErrorMessage } from "@/lib/utils/error";
import { markChanged, requestScan } from "@/infra/queue/changes";
import { PIPELINE_NAMES, parseQueueName, queueName, type PipelineName, type QueueName } from "@/infra/queue/pipelines";
import {
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_RUN_TIMEOUT_MS,
    HEARTBEAT_INTERVAL_MS,
    MAX_STUCK_RUNS,
    PATROL_INTERVAL_MS,
    Priority,
    SCAN_PAGE_SIZE,
    STUCK_AFTER_MS,
    retryDelaySeconds,
} from "@/infra/queue/policy";
import {
    LeaseLostError,
    advance,
    claim,
    claimBatch,
    claimSubjects,
    defer,
    enqueue,
    fence,
    finish,
    giveUp,
    postpone,
    renew,
    type ClaimedRow,
} from "@/infra/queue/store";
import type { BatchPipelineHandler, PipelineHandler, PipelineHandlers, ReconcileResult, SubjectPipelineHandler } from "@/infra/queue/types";

export interface QueueWorkerOptions {
    readonly concurrency?: number;
    /** How often to look for due rows; new work waits at most this long. */
    readonly pollIntervalMs?: number;
    /** Set to 0 to disable periodic library scans. */
    readonly patrolIntervalMs?: number;
    readonly stuckAfterMs?: number;
    readonly maxStuckRuns?: number;
    /** Called when more runs are stuck than `maxStuckRuns`: the process should restart, the only way to end them. */
    readonly onTooManyStuckRuns?: () => void;
}

/** How many subject runs of a pipeline may go at once, and how many do. */
interface RunLimit {
    readonly pipeline: PipelineName;
    readonly limit: number;
    active: number;
}

/** Why a run past its deadline was aborted. Named like the platform's timeouts, so errors are classified the same way. */
class RunTimeoutError extends Error {
    override readonly name = "TimeoutError";

    constructor(timeoutMs: number) {
        super(`The run took longer than ${timeoutMs / 1000} seconds`);
    }
}

/** An aborted run did not return in time, so nothing waits for it any longer. */
class StuckRunError extends Error {}

/** Keeps the leases of a run alive while it is in progress (`rows` may grow) and aborts the run if one is lost. */
function startHeartbeat(rows: readonly ClaimedRow[], abort: AbortController): () => void {
    let inFlight = false;
    const timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        Promise.all(
            rows.map((row) =>
                renew(row).then((renewed) => {
                    if (!renewed) abort.abort(new LeaseLostError(row));
                }),
            ),
        )
            .catch((error: unknown) => console.error(`[Queue] Lease renewal failed for ${rows[0]?.pipeline}:`, error))
            .finally(() => {
                inFlight = false;
            });
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

/** A scan has no result rows to hold a failure and would lose its place, so it retries until it gets through. */
function maxAttemptsOf(handler: PipelineHandler, name: QueueName): number {
    return name.scan ? Number.POSITIVE_INFINITY : (handler.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
}

/** What a run reports once its deadline aborted it says little about its subject: only the deadline counts. */
function afterDeadline(result: ReconcileResult, signal: AbortSignal): ReconcileResult {
    const timedOut = signal.reason instanceof RunTimeoutError && result.kind !== "done";
    return timedOut ? { kind: "retry", error: signal.reason.message } : result;
}

export class QueueWorker {
    private readonly concurrency: number;
    private readonly pollIntervalMs: number;
    private readonly patrolIntervalMs: number;
    private readonly stuckAfterMs: number;
    private readonly maxStuckRuns: number;
    private readonly onTooManyStuckRuns?: () => void;
    private readonly active = new Set<Promise<void>>();
    /** Pipelines that limit their own runs (SubjectPipelineHandler.concurrency). */
    private readonly limited: RunLimit[];
    private readonly limitedPipelines: PipelineName[];
    private readonly runs = new Set<AbortController>();
    private stuckRuns = 0;
    private running = false;
    private aborting = false;
    private pumping = false;
    private wakeRequested = false;
    private timers: ReturnType<typeof setInterval>[] = [];

    constructor(
        private readonly handlers: PipelineHandlers,
        options: QueueWorkerOptions = {},
    ) {
        this.concurrency = options.concurrency ?? 8;
        this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
        this.patrolIntervalMs = options.patrolIntervalMs ?? PATROL_INTERVAL_MS;
        this.stuckAfterMs = options.stuckAfterMs ?? STUCK_AFTER_MS;
        this.maxStuckRuns = options.maxStuckRuns ?? MAX_STUCK_RUNS;
        this.onTooManyStuckRuns = options.onTooManyStuckRuns;
        this.limited = PIPELINE_NAMES.flatMap((pipeline) => {
            const handler = handlers[pipeline];
            const limit = "reconcile" in handler ? handler.concurrency : undefined;
            return limit === undefined ? [] : [{ pipeline, limit, active: 0 }];
        });
        this.limitedPipelines = this.limited.map((limited) => limited.pipeline);
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.timers.push(setInterval(() => this.wake(), this.pollIntervalMs));
        if (this.patrolIntervalMs > 0) {
            const patrol = () => {
                this.patrol().catch((error: unknown) => console.error(`[Queue] Patrol failed: ${getErrorMessage(error)}`));
            };
            this.timers.push(setInterval(patrol, this.patrolIntervalMs));
            // The timer starts over with the process, so a server restarted more often than the interval needs this one.
            patrol();
        }
        for (const timer of this.timers) timer.unref?.();
        this.wake();
    }

    wake(): void {
        if (!this.running) return;
        this.wakeRequested = true;
        if (!this.pumping) void this.pump();
    }

    /** Runs the pipelines' upkeep and queues a scan of every library for every pipeline, catching changes no writer reported. */
    async patrol(): Promise<void> {
        for (const pipeline of PIPELINE_NAMES) {
            await this.handlers[pipeline].patrol?.().catch((error: unknown) => {
                console.error(`[Queue] Upkeep of ${pipeline} failed: ${getErrorMessage(error)}`);
            });
        }
        const libraries = await db.select({ id: Library.id }).from(Library).where(eq(Library.delete_status, DeleteStatus.ACTIVE));
        const ids = libraries.map((library) => library.id);
        for (const pipeline of PIPELINE_NAMES) await requestScan(db, pipeline, ids, "absent");
    }

    private async pump(): Promise<void> {
        this.pumping = true;
        try {
            while (this.wakeRequested && this.running) {
                this.wakeRequested = false;
                const free = this.concurrency - this.active.size;
                if (free <= 0) break;

                // A limited pipeline is claimed on its own, up to its limit; the general claim leaves its rows alone.
                const rows: ClaimedRow[] = [];
                for (const limited of this.limited) {
                    const room = Math.min(free - rows.length, limited.limit - limited.active);
                    if (room > 0) rows.push(...(await claimSubjects(limited.pipeline, room)));
                }
                rows.push(...(await claim(free - rows.length, this.limitedPipelines)));
                for (const row of rows) {
                    const limited = this.limitedOf(row);
                    if (limited) limited.active += 1;
                    const run = this.run(row)
                        .catch((error: unknown) => console.error(`[Queue] ${row.pipeline}/${row.subjectId} failed unexpectedly:`, error))
                        .finally(() => {
                            if (limited) limited.active -= 1;
                            this.active.delete(run);
                            this.wake();
                        });
                    this.active.add(run);
                }
                if (rows.length === free) this.wakeRequested = true;
            }
        } catch (error) {
            console.error(`[Queue] Claim failed: ${getErrorMessage(error)}`);
        } finally {
            this.pumping = false;
            // A wake that arrived after the loop's last check must not be lost.
            if (this.wakeRequested && this.running && this.active.size < this.concurrency) void this.pump();
        }
    }

    /** The limit a claimed row counts against: a subject row of a limited pipeline. Scans are not limited. */
    private limitedOf(row: ClaimedRow): RunLimit | undefined {
        const name = parseQueueName(row.pipeline);
        if (!name || name.scan) return undefined;
        return this.limited.find((limited) => limited.pipeline === name.pipeline);
    }

    /** Tracks a run's abort signal, keeps its leases alive (`rows` may grow) and enforces its deadline until `stop` is called. */
    private watch(rows: readonly ClaimedRow[], timeoutMs: number): { abort: AbortController; stop: () => void } {
        const abort = new AbortController();
        const stopHeartbeat = startHeartbeat(rows, abort);
        const deadline = setTimeout(() => abort.abort(new RunTimeoutError(timeoutMs)), timeoutMs);
        this.runs.add(abort);
        return {
            abort,
            stop: () => {
                stopHeartbeat();
                clearTimeout(deadline);
                this.runs.delete(abort);
            },
        };
    }

    /**
     * Waits for a run, but not for long once its signal is aborted. A run that ignores the signal throws StuckRunError
     * here: it can't be killed, but it stops holding a slot. Its lease then expires and the row counts as interrupted,
     * and the fence keeps out whatever the run still tries to write.
     */
    private async supervise<T>(run: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
        const { promise: stuck, reject } = Promise.withResolvers<never>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const startClock = () => {
            timer = setTimeout(() => reject(new StuckRunError()), this.stuckAfterMs);
        };
        if (signal.aborted) startClock();
        else signal.addEventListener("abort", startClock, { once: true });
        try {
            return await Promise.race([run, stuck]);
        } catch (error) {
            if (error instanceof StuckRunError) this.countStuck(run, label);
            throw error;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", startClock);
        }
    }

    private countStuck(run: Promise<unknown>, label: string): void {
        this.stuckRuns += 1;
        console.error(`[Queue] ${label} ignored its abort signal; freeing its slot (${this.stuckRuns} stuck).`);
        void run
            .catch(() => undefined)
            .finally(() => {
                this.stuckRuns -= 1;
            });
        if (this.stuckRuns > this.maxStuckRuns) this.onTooManyStuckRuns?.();
    }

    private async run(row: ClaimedRow): Promise<void> {
        const name = parseQueueName(row.pipeline);
        // Claims only take the queue names this version knows.
        if (!name) throw new Error(`Claimed a row of unknown pipeline '${row.pipeline}'`);
        const handler = this.handlers[name.pipeline];
        if (row.interruptions >= maxAttemptsOf(handler, name)) {
            // None of these runs got as far as failing, so running it may be what takes the worker down.
            const error = `The run was interrupted ${row.interruptions} times in a row`;
            console.error(`[Queue] ${row.pipeline}/${row.subjectId}: ${error}; giving up.`);
            await this.settle(handler, row, name, { kind: "rejected", error });
        } else if (name.scan) {
            await this.runScan(handler, row, name);
        } else if ("reconcileBatch" in handler) {
            await this.runBatch(handler, row, name);
        } else {
            await this.runSubject(handler, row, name);
        }
        if (name.space && handler.settled) {
            await handler.settled(row.libraryId, name.space).catch((error: unknown) => {
                console.error(`[Queue] Settling ${row.pipeline} failed: ${getErrorMessage(error)}`);
            });
        }
    }

    private async runSubject(handler: SubjectPipelineHandler, row: ClaimedRow, name: QueueName): Promise<void> {
        const { abort, stop } = this.watch([row], handler.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
        let result: ReconcileResult;
        try {
            const run = handler.reconcile({
                subjectId: row.subjectId,
                libraryId: row.libraryId,
                space: name.space,
                signal: abort.signal,
                fence: (tx) => fence(tx, row),
            });
            result = await this.supervise(run, abort.signal, `${row.pipeline}/${row.subjectId}`);
        } catch (error) {
            if (error instanceof StuckRunError) return;
            if (error instanceof LeaseLostError || abort.signal.reason instanceof LeaseLostError) {
                console.warn(`[Queue] Dropped the result of ${row.pipeline}/${row.subjectId}; its lease was lost.`);
                return;
            }
            result = { kind: "retry", error: getErrorMessage(error) };
        } finally {
            stop();
        }
        await this.settle(handler, row, name, afterDeadline(result, abort.signal));
    }

    /** One step of a library scan: queue the subjects of one page that need work, then continue or finish. */
    private async runScan(handler: PipelineHandler, row: ClaimedRow, name: QueueName): Promise<void> {
        const { abort, stop } = this.watch([row], DEFAULT_RUN_TIMEOUT_MS);
        const step = async () => {
            const page = await handler.scanPage(row.libraryId, row.cursor, SCAN_PAGE_SIZE, name.space);
            const pipeline = queueName(name.pipeline, name.space);
            await db.transaction(async (tx) => {
                await fence(tx, row);
                await enqueue(
                    tx,
                    page.subjectIds.map((subjectId) => ({ pipeline, subjectId, libraryId: row.libraryId, priority: Priority.BACKFILL })),
                    "scan",
                );
                if (page.nextCursor) await advance(row, page.nextCursor, tx);
                else await finish(row, tx);
            });
        };
        try {
            await this.supervise(step(), abort.signal, `${row.pipeline}/${row.subjectId}`);
        } catch (error) {
            if (error instanceof StuckRunError) return;
            if (error instanceof LeaseLostError || abort.signal.reason instanceof LeaseLostError) {
                console.warn(`[Queue] Dropped a step of ${row.pipeline}/${row.subjectId}; its lease was lost.`);
                return;
            }
            console.error(`[Queue] ${row.pipeline}/${row.subjectId} failed ${row.attempts} times in a row: ${getErrorMessage(error)}`);
            await this.settle(handler, row, name, { kind: "retry", error: getErrorMessage(error) });
        } finally {
            stop();
        }
    }

    /** Runs a claimed row together with more due rows of its queue, each settled with its own result. */
    private async runBatch(handler: BatchPipelineHandler, head: ClaimedRow, name: QueueName): Promise<void> {
        const rows = [head];
        const { abort, stop } = this.watch(rows, handler.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
        let results: Map<string, ReconcileResult>;
        try {
            const run = handler.reconcileBatch({
                libraryId: head.libraryId,
                space: name.space,
                head: head.subjectId,
                signal: abort.signal,
                claimMore: async (limit) => {
                    if (head.interruptions > 0 || abort.signal.aborted) return [];
                    const more = await claimBatch(head.pipeline, limit);
                    rows.push(...more);
                    return more.map((row) => row.subjectId);
                },
                fence: (tx, subjectId) => {
                    const row = rows.find((candidate) => candidate.subjectId === subjectId);
                    if (!row) throw new Error(`${subjectId} is not part of this batch`);
                    return fence(tx, row);
                },
            });
            results = await this.supervise(run, abort.signal, `${head.pipeline} batch of ${head.subjectId}`);
        } catch (error) {
            if (error instanceof StuckRunError) return;
            if (error instanceof LeaseLostError || abort.signal.reason instanceof LeaseLostError) {
                console.warn(`[Queue] Dropped the result of a ${head.pipeline} batch of ${rows.length}; a lease was lost.`);
                return;
            }
            const failure: ReconcileResult = { kind: "retry", error: getErrorMessage(error) };
            results = new Map(rows.map((row) => [row.subjectId, failure]));
        } finally {
            stop();
        }
        // Rows that fail together come back together, so the retry is one request again.
        const retryDelay = retryDelaySeconds(Math.max(...rows.map((row) => row.attempts)));
        for (const row of rows) {
            const result = afterDeadline(results.get(row.subjectId) ?? { kind: "done" }, abort.signal);
            await this.settle(handler, row, name, result, retryDelay);
        }
    }

    /** Applies a run's result to its queue row. */
    private async settle(
        handler: PipelineHandler,
        row: ClaimedRow,
        name: QueueName,
        result: ReconcileResult,
        retryDelay = retryDelaySeconds(row.attempts),
    ): Promise<void> {
        // A run cut short by the shutdown says nothing about its subject, so the row goes back as it came.
        if (this.aborting && result.kind !== "done") {
            await postpone(row, 0);
            return;
        }
        switch (result.kind) {
            case "done": {
                const { changed } = result;
                if (!changed) await finish(row);
                else
                    await db.transaction(async (tx) => {
                        if (await finish(row, tx)) await markChanged(tx, changed, [row.subjectId]);
                    });
                return;
            }
            case "deferred":
                await postpone(row, result.delaySeconds);
                return;
            case "retry":
                if (row.attempts < maxAttemptsOf(handler, name)) {
                    await defer(row, retryDelay);
                    return;
                }
                console.error(`[Queue] ${row.pipeline}/${row.subjectId} failed ${row.attempts} times: ${result.error}`);
                break;
            case "rejected":
                break;
        }
        await giveUp(row, (tx) =>
            handler.recordFailure(tx, {
                subjectId: row.subjectId,
                space: name.space,
                error: result.error,
                errorKind: result.errorKind ?? null,
            }),
        );
    }

    /**
     * Stops claiming and gives the runs in progress `graceMs` to finish. The others are aborted, which puts their rows
     * back without using an attempt. A run that ignores the signal keeps its lease until it expires and counts as
     * interrupted.
     */
    async drain(graceMs = 10_000, abortMs = 5_000): Promise<void> {
        this.running = false;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];

        if (await this.idleWithin(graceMs)) return;
        this.aborting = true;
        for (const run of this.runs) run.abort();
        if (!(await this.idleWithin(abortMs))) console.warn(`[Queue] Drain timed out with ${this.active.size} run(s) still in progress.`);
    }

    private async idleWithin(ms: number): Promise<boolean> {
        if (this.active.size === 0) return true;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<"timeout">((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), ms);
        });
        const result = await Promise.race([Promise.allSettled(this.active), timedOut]);
        clearTimeout(timeout);
        return result !== "timeout";
    }
}
