import { eq } from "drizzle-orm";
import { Client } from "pg";
import { DeleteStatus, Library } from "@/db/schema";
import { db } from "@/global/db";
import { env } from "@/global/env";
import { getErrorMessage } from "@/lib/utils/error";
import { requestScan } from "@/infra/queue/changes";
import { PIPELINE_NAMES, parseQueueName } from "@/infra/queue/pipelines";
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
    defer,
    enqueue,
    fence,
    finish,
    giveUp,
    renew,
    type ClaimedRow,
} from "@/infra/queue/store";
import type { PipelineHandler, PipelineHandlers } from "@/infra/queue/types";

export interface QueueWorkerOptions {
    readonly concurrency?: number;
    readonly pollIntervalMs?: number;
    /** Set to 0 to disable periodic library scans. */
    readonly patrolIntervalMs?: number;
    /** LISTEN for enqueue notifications on a dedicated connection; polling alone still works without it. */
    readonly listen?: boolean;
}

/** Keeps the lease alive while a run is in progress and aborts the run if it is lost. */
function startHeartbeat(row: ClaimedRow, abort: AbortController): () => void {
    let inFlight = false;
    const timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        renew(row)
            .then((renewed) => {
                if (!renewed) abort.abort(new LeaseLostError(row));
            })
            .catch((error: unknown) => console.error(`[Queue] Lease renewal failed for ${row.pipeline}/${row.subjectId}:`, error))
            .finally(() => {
                inFlight = false;
            });
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
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

    /** Queues a scan of every library for every pipeline, catching changes no writer reported. */
    async patrol(): Promise<void> {
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

        const abort = new AbortController();
        const stopHeartbeat = startHeartbeat(row, abort);
        try {
            if (name.scan) {
                await this.scan(handler, row, name.pipeline);
                return;
            }
            const result = await handler.reconcile({
                subjectId: row.subjectId,
                libraryId: row.libraryId,
                attempts: row.attempts,
                signal: abort.signal,
                fence: (tx) => fence(tx, row),
            });
            if (result.kind === "done") {
                await finish(row);
            } else {
                await giveUp(row, (tx) => handler.recordFailure(tx, row.subjectId, result.error));
            }
        } catch (error) {
            if (error instanceof LeaseLostError || abort.signal.reason instanceof LeaseLostError) {
                console.warn(`[Queue] Dropped the result of ${row.pipeline}/${row.subjectId}; its lease was lost.`);
                return;
            }
            const message = getErrorMessage(error);
            const attempt = row.attempts + 1;
            const maxAttempts = name.scan ? DEFAULT_MAX_ATTEMPTS : (handler.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
            if (attempt < maxAttempts) {
                await defer(row, retryDelaySeconds(attempt));
                return;
            }
            console.error(`[Queue] ${row.pipeline}/${row.subjectId} failed ${attempt} times: ${message}`);
            await giveUp(row, name.scan ? async () => undefined : (tx) => handler.recordFailure(tx, row.subjectId, message));
        } finally {
            stopHeartbeat();
        }
    }

    /** One step of a library scan: queue the subjects of one page that need work, then continue or finish. */
    private async scan(handler: PipelineHandler, row: ClaimedRow, pipeline: string): Promise<void> {
        const page = await handler.scanPage(row.libraryId, row.cursor, SCAN_PAGE_SIZE);
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
