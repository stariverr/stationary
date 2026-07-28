import { executeUnit } from "@/infra/jobs/executor";
import { claimUnits, onJobsAvailable } from "@/infra/jobs/store";
import { getErrorMessage } from "@/lib/utils/error";

export class JobRunner {
    private static instance: JobRunner | null = null;

    private readonly maxConcurrency: number;
    private readonly activeUnits = new Map<string, Promise<void>>();
    private readonly unsubscribeWake: () => void;
    private isRunning = false;
    private isPumping = false;
    private wakeRequested = false;
    private pumpScheduled = false;
    private pumpPromise: Promise<void> | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(maxConcurrency = 8) {
        if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
            throw new RangeError("maxConcurrency must be a positive integer");
        }
        this.maxConcurrency = maxConcurrency;
        this.unsubscribeWake = onJobsAvailable(() => this.wake());
    }

    public static getInstance(): JobRunner {
        JobRunner.instance ??= new JobRunner();
        return JobRunner.instance;
    }

    public start(pollIntervalMs = 5_000): void {
        if (this.isRunning) return;
        if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
            throw new RangeError("pollIntervalMs must be a positive integer");
        }

        this.isRunning = true;
        this.pollTimer = setInterval(() => this.wake(), pollIntervalMs);
        this.pollTimer.unref?.();
        this.wake();
    }

    public wake(): void {
        if (!this.isRunning) return;

        this.wakeRequested = true;
        if (!this.isPumping && !this.pumpScheduled) {
            this.schedulePump();
        }
    }

    private schedulePump(): void {
        if (this.pumpScheduled || !this.isRunning) return;
        this.pumpScheduled = true;

        setImmediate(() => {
            this.pumpScheduled = false;
            const pumpPromise = this.pump();
            this.pumpPromise = pumpPromise;
            void pumpPromise.finally(() => {
                if (this.pumpPromise === pumpPromise) this.pumpPromise = null;
            });
        });
    }

    private async pump(): Promise<void> {
        if (this.isPumping || !this.isRunning) return;
        this.isPumping = true;

        try {
            while (this.wakeRequested && this.isRunning) {
                this.wakeRequested = false;
                const freeSlots = this.maxConcurrency - this.activeUnits.size;
                if (freeSlots <= 0) break;

                const claimedUnits = await claimUnits(freeSlots);
                if (claimedUnits.length === 0) break;

                for (const unit of claimedUnits) {
                    const execution = executeUnit(unit)
                        .then(() => undefined)
                        .catch((error: unknown) => {
                            console.error(`[JobRunner] Unit ${unit.id} execution failed unexpectedly:`, error);
                        })
                        .finally(() => {
                            this.activeUnits.delete(unit.id);
                            this.wake();
                        });
                    this.activeUnits.set(unit.id, execution);
                }
            }
        } catch (error) {
            console.error(`[JobRunner] Scheduler iteration failed: ${getErrorMessage(error)}`);
        } finally {
            this.isPumping = false;
            if (this.wakeRequested && this.isRunning) {
                this.schedulePump();
            }
        }
    }

    public stopAccepting(): void {
        this.isRunning = false;
        this.wakeRequested = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    public async drain(timeoutMs = 15_000): Promise<void> {
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            throw new RangeError("timeoutMs must be a positive integer");
        }
        this.stopAccepting();

        if (this.pumpPromise) {
            await this.pumpPromise;
        }
        if (this.activeUnits.size === 0) return;

        let timeout: ReturnType<typeof setTimeout> | undefined;
        const completed = Promise.allSettled(this.activeUnits.values());
        const timedOut = new Promise<"timeout">((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const result = await Promise.race([completed, timedOut]);
        if (timeout) clearTimeout(timeout);

        if (result === "timeout") {
            console.warn(`[JobRunner] Drain timed out with ${this.activeUnits.size} unit(s) still running.`);
        }
    }

    public getActiveCount(): number {
        return this.activeUnits.size;
    }

    public dispose(): void {
        this.stopAccepting();
        this.unsubscribeWake();
    }
}

export const jobRunner = JobRunner.getInstance();
