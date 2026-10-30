import { eq } from "drizzle-orm";
import { Client } from "pg";
import { DeleteStatus, Library } from "@/db/schema";
import { db } from "@/global/db";
import { env } from "@/global/env";
import { getErrorMessage } from "@/lib/utils/error";
import { requestScan } from "@/infra/queue/changes";
import { PIPELINE_NAMES, parseQueueName, queueName, type QueueName } from "@/infra/queue/pipelines";
import {
    DEFAULT_MAX_ATTEMPTS,
    HEARTBEAT_INTERVAL_MS,
    PATROL_INTERVAL_MS,
    Priority,
    SCAN_PAGE_SIZE,
    retryDelaySeconds,
} from "@/infra/queue/policy";
import {
    QUEUE_CHANNEL,
    LeaseLostError,
    advance,
    claim,
    claimBatch,
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
    readonly pollIntervalMs?: number;
    /** Set to 0 to disable periodic library scans. */
    readonly patrolIntervalMs?: number;
    /** LISTEN for enqueue notifications on a dedicated connection; polling alone still works without it. */
    readonly listen?: boolean;
}

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

function maxAttemptsOf(handler: PipelineHandler, name: QueueName): number {
    return name.scan ? DEFAULT_MAX_ATTEMPTS : (handler.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
}

export class QueueWorker {
    private readonly concurrency: number;
    private readonly pollIntervalMs: number;
    private readonly patrolIntervalMs: number;
    private readonly listen: boolean;
    private readonly active = new Set<Promise<void>>();
    private running = false;
    private pumping = false;
    private wakeRequested = false;
    private timers: ReturnType<typeof setInterval>[] = [];
    private listener: Client | null = null;

    constructor(
        private readonly handlers: PipelineHandlers,
        options: QueueWorkerOptions = {},
    ) {
        this.concurrency = options.concurrency ?? 8;
        this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
        this.patrolIntervalMs = options.patrolIntervalMs ?? PATROL_INTERVAL_MS;
        this.listen = options.listen ?? true;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.timers.push(setInterval(() => this.wake(), this.pollIntervalMs));
        if (this.patrolIntervalMs > 0) {
            this.timers.push(
                setInterval(() => {
                    this.patrol().catch((error: unknown) => console.error(`[Queue] Patrol failed: ${getErrorMessage(error)}`));
                }, this.patrolIntervalMs),
            );
        }
        for (const timer of this.timers) timer.unref?.();
        if (this.listen) void this.connectListener();
        this.wake();
    }

    wake(): void {
        if (!this.running) return;
        this.wakeRequested = true;
        if (!this.pumping) void this.pump();
    }

    /** Runs the pipelines' upkeep and queues a scan of every library for every pipeline, catching changes no writer reported. */
    async patrol(): Promise<void> {
        for (const pipeline of PIPELINE_NAMES) await this.handlers[pipeline].patrol?.();
        const libraries = await db.select({ id: Library.id }).from(Library).where(eq(Library.delete_status, DeleteStatus.ACTIVE));
        const ids = libraries.map((library) => library.id);
        for (const pipeline of PIPELINE_NAMES) await requestScan(db, pipeline, ids, "absent");
    }

    private async connectListener(): Promise<void> {
        const client = new Client({ connectionString: env.DB_URL });
        const reconnect = () => {
            if (this.listener !== client) return;
            this.listener = null;
            client.end().catch(() => undefined);
            if (this.running) setTimeout(() => void this.connectListener(), 5_000).unref?.();
        };
        client.on("error", (error) => {
            console.warn(`[Queue] Listener connection error: ${error.message}`);
            reconnect();
        });
        client.on("end", reconnect);
        client.on("notification", () => this.wake());
        this.listener = client;
        try {
            await client.connect();
            await client.query(`LISTEN ${QUEUE_CHANNEL}`);
        } catch (error) {
            console.warn(`[Queue] Could not listen for queue notifications: ${getErrorMessage(error)}`);
            reconnect();
        }
    }

    private async pump(): Promise<void> {
        this.pumping = true;
        try {
            while (this.wakeRequested && this.running) {
                this.wakeRequested = false;
                const free = this.concurrency - this.active.size;
                if (free <= 0) break;

                const rows = await claim(free);
                for (const row of rows) {
                    const run = this.run(row)
                        .catch((error: unknown) => console.error(`[Queue] ${row.pipeline}/${row.subjectId} failed unexpectedly:`, error))
                        .finally(() => {
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

    private async run(row: ClaimedRow): Promise<void> {
        const name = parseQueueName(row.pipeline);
        if (!name) {
            console.error(`[Queue] Dropping row of unknown pipeline '${row.pipeline}'`);
            await giveUp(row, async () => undefined);
            return;
        }
        const handler = this.handlers[name.pipeline];
        if (row.attempts > maxAttemptsOf(handler, name)) {
            // Every attempt ended without settling, so running it may be what takes the worker down.
            console.error(`[Queue] ${row.pipeline}/${row.subjectId} was interrupted ${row.attempts - 1} times; giving up.`);
            await this.settle(handler, row, name, { kind: "rejected", error: `The run was interrupted ${row.attempts - 1} times` });
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
        const abort = new AbortController();
        const stopHeartbeat = startHeartbeat([row], abort);
        let result: ReconcileResult;
        try {
            result = await handler.reconcile({
                subjectId: row.subjectId,
                libraryId: row.libraryId,
                space: name.space,
                signal: abort.signal,
                fence: (tx) => fence(tx, row),
            });
        } catch (error) {
            if (error instanceof LeaseLostError || abort.signal.reason instanceof LeaseLostError) {
                console.warn(`[Queue] Dropped the result of ${row.pipeline}/${row.subjectId}; its lease was lost.`);
                return;
            }
            result = { kind: "retry", error: getErrorMessage(error) };
        } finally {
            stopHeartbeat();
        }
        await this.settle(handler, row, name, result);
    }

    /** One step of a library scan: queue the subjects of one page that need work, then continue or finish. */
    private async runScan(handler: PipelineHandler, row: ClaimedRow, name: QueueName): Promise<void> {
        const abort = new AbortController();
        const stopHeartbeat = startHeartbeat([row], abort);
        try {
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
        } catch (error) {
            if (error instanceof LeaseLostError || abort.signal.reason instanceof LeaseLostError) {
                console.warn(`[Queue] Dropped a step of ${row.pipeline}/${row.subjectId}; its lease was lost.`);
                return;
            }
            await this.settle(handler, row, name, { kind: "retry", error: getErrorMessage(error) });
        } finally {
            stopHeartbeat();
        }
    }

    /** Runs a claimed row together with more due rows of its queue, each settled with its own result. */
    private async runBatch(handler: BatchPipelineHandler, head: ClaimedRow, name: QueueName): Promise<void> {
        const rows = [head];
        const abort = new AbortController();
        const stopHeartbeat = startHeartbeat(rows, abort);
        let results: Map<string, ReconcileResult>;
        try {
            results = await handler.reconcileBatch({
                libraryId: head.libraryId,
                space: name.space,
                head: head.subjectId,
                signal: abort.signal,
                claimMore: async (limit) => {
                    if (head.attempts > 1) return [];
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
        } catch (error) {
            if (error instanceof LeaseLostError || abort.signal.reason instanceof LeaseLostError) {
                console.warn(`[Queue] Dropped the result of a ${head.pipeline} batch of ${rows.length}; a lease was lost.`);
                return;
            }
            const failure: ReconcileResult = { kind: "retry", error: getErrorMessage(error) };
            results = new Map(rows.map((row) => [row.subjectId, failure]));
        } finally {
            stopHeartbeat();
        }
        for (const row of rows) await this.settle(handler, row, name, results.get(row.subjectId) ?? { kind: "done" });
    }

    /** Applies a run's result to its queue row. */
    private async settle(handler: PipelineHandler, row: ClaimedRow, name: QueueName, result: ReconcileResult): Promise<void> {
        switch (result.kind) {
            case "done":
                await finish(row);
                return;
            case "deferred":
                await postpone(row, result.delaySeconds);
                return;
            case "retry":
                if (row.attempts < maxAttemptsOf(handler, name)) {
                    await defer(row, retryDelaySeconds(row.attempts));
                    return;
                }
                console.error(`[Queue] ${row.pipeline}/${row.subjectId} failed ${row.attempts} times: ${result.error}`);
                break;
            case "rejected":
                break;
        }
        await giveUp(
            row,
            name.scan
                ? async () => undefined
                : (tx) =>
                      handler.recordFailure(tx, {
                          subjectId: row.subjectId,
                          space: name.space,
                          error: result.error,
                          errorKind: result.errorKind ?? null,
                          rejected: result.kind === "rejected",
                      }),
        );
    }

    async drain(timeoutMs = 15_000): Promise<void> {
        this.running = false;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        const listener = this.listener;
        this.listener = null;
        await listener?.end().catch(() => undefined);

        if (this.active.size === 0) return;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<"timeout">((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const result = await Promise.race([Promise.allSettled(this.active), timedOut]);
        clearTimeout(timeout);
        if (result === "timeout") console.warn(`[Queue] Drain timed out with ${this.active.size} run(s) still in progress.`);
    }
}
