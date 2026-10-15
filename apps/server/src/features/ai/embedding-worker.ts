import { kv } from "@/global/kv";
import { EMBEDDING_QUEUE_CHANNEL, processNextEmbeddingBatch } from "./embedding-queue";
import { dropExpiredRetiredSpaces, promoteBuiltSpaces } from "./embedding-spaces";

/** Batches processed at once per server instance; provider limits still apply across instances. */
const LOOP_COUNT = 2;
/** Fallback poll for delayed retries and missed wake-ups. */
const POLL_INTERVAL_MS = 10_000;
/** Space promotion is checked at least this often, even while the queue is busy. */
const MAINTENANCE_INTERVAL_MS = 30_000;

/**
 * Drains the embedding queue. Each loop claims a batch, embeds it, and repeats until the queue
 * has no due work, then sleeps until woken (new work on any instance) or the poll interval.
 */
export class EmbeddingWorker {
    private running = false;
    private readonly abortController = new AbortController();
    private readonly loops: Promise<void>[] = [];
    private wakeWaiters: Array<() => void> = [];
    private lastMaintenance = 0;

    start(): void {
        if (this.running) return;
        this.running = true;
        kv.subscribe(EMBEDDING_QUEUE_CHANNEL, () => this.wake()).catch((error: unknown) => {
            console.error("[AI EMBED] Failed to subscribe to queue wake-ups; relying on polling.", error);
        });
        for (let index = 0; index < LOOP_COUNT; index++) {
            this.loops.push(this.loop(index === 0));
        }
    }

    wake(): void {
        const waiters = this.wakeWaiters;
        this.wakeWaiters = [];
        for (const resolve of waiters) resolve();
    }

    private sleep(): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, POLL_INTERVAL_MS);
            timer.unref?.();
            this.wakeWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /** Promotes finished spaces and drops retired ones past their retention. */
    private async maintain(): Promise<void> {
        this.lastMaintenance = Date.now();
        await promoteBuiltSpaces();
        await dropExpiredRetiredSpaces();
    }

    /** The first loop also runs maintenance: whenever idle, and periodically while busy. */
    private async loop(maintains: boolean): Promise<void> {
        while (this.running) {
            try {
                const claimed = await processNextEmbeddingBatch(this.abortController.signal);
                const maintenanceDue = Date.now() - this.lastMaintenance >= MAINTENANCE_INTERVAL_MS;
                if (maintains && (claimed.length === 0 || maintenanceDue)) await this.maintain();
                if (claimed.length > 0) continue;
            } catch (error) {
                if (!this.running) break;
                console.error("[AI EMBED] Worker iteration failed:", error);
            }
            if (this.running) await this.sleep();
        }
    }

    /** Stops claiming work and waits for in-flight batches; unfinished rows return to the queue when their claim expires. */
    async drain(timeoutMs = 15_000): Promise<void> {
        this.running = false;
        this.wake();
        const timeout = new Promise<void>((resolve) => {
            setTimeout(() => {
                this.abortController.abort(new Error("Embedding worker shut down"));
                resolve();
            }, timeoutMs).unref?.();
        });
        await Promise.race([Promise.allSettled(this.loops), timeout]);
    }
}

export const embeddingWorker = new EmbeddingWorker();
