import { db } from "@/global/db";
import { AsyncTask, AsyncTaskUnit, AsyncTaskStatus, AsyncTaskUnitStatus, AsyncOutcomeCode } from "@/db/schema";
import { and, eq, lt, sql, isNull, inArray } from "drizzle-orm";

import { Temporal } from "@js-temporal/polyfill";
import { TaskManager } from "@/services/job_service";

let sweeperInterval: ReturnType<typeof setInterval> | null = null;

/**
 * JobSweeper provides generic, automated background sweeping routines for all AsyncTask and AsyncTaskUnit types.
 * It operates independently of specific business domains, managing lease reclamations, unit dispatching,
 * task reconciliation, and historical log purging.
 */
export const JobSweeper = {
    /**
     * Start the periodic background sweeping interval.
     */
    start(intervalMs = 30000) {
        if (sweeperInterval) return;
        console.log(`[JobSweeper] Starting background task sweeper (interval: ${intervalMs}ms)...`);
        sweeperInterval = setInterval(() => {
            this.runSweep().catch((err: any) => {
                const msg = String(err?.message || err);
                if (msg.includes("Connection terminated unexpectedly")) {
                    console.warn("[JobSweeper] Database connection reset, skipping sweep cycle.");
                } else {
                    console.error("[JobSweeper] Sweep error:", err);
                }
            });
        }, intervalMs);
    },

    /**
     * Stop the periodic background sweeping interval.
     */
    stop() {
        if (sweeperInterval) {
            clearInterval(sweeperInterval);
            sweeperInterval = null;
        }
    },

    /**
     * Execute a full generic sweeping cycle across all registered AsyncTask types.
     * Reclaims expired leases, dispatches pending units, reconciles running tasks, and purges old records.
     */
    async runSweep(): Promise<{ reclaimedLeases: number; dispatchedUnits: number; reconciledTasks: number }> {
        const reclaimedLeases = await this.reclaimExpiredLeases();
        const dispatchedUnits = await this.dispatchPendingUnits();
        const reconciledTasks = await this.reconcileTasks();
        await this.purgeOldTasks();
        return { reclaimedLeases, dispatchedUnits, reconciledTasks };
    },

    /**
     * Reclaim running task units whose execution leases have expired.
     * Resets units for retry or marks them as failed if max attempts are reached.
     */
    async reclaimExpiredLeases(): Promise<number> {
        const now = Temporal.Now.instant();
        const expiredUnits = await db
            .select()
            .from(AsyncTaskUnit)
            .where(and(eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING), lt(AsyncTaskUnit.lease_expires_at, now)))
            .limit(50);

        let count = 0;
        for (const unit of expiredUnits) {
            const isExhausted = unit.attempt_count >= unit.max_attempts;

            // Exponential backoff retry delay (10s, 20s, 40s..., capped at 300s)
            const backoffSeconds = Math.min(300, Math.pow(2, Math.max(0, unit.attempt_count - 1)) * 10);
            const availableAt = isExhausted ? now : now.add({ seconds: backoffSeconds });

            await db.transaction(async (tx) => {
                const res = await tx
                    .update(AsyncTaskUnit)
                    .set({
                        status: isExhausted ? AsyncTaskUnitStatus.FAILED : AsyncTaskUnitStatus.PENDING,
                        outcome_code: isExhausted ? AsyncOutcomeCode.LEASE_EXPIRED_EXHAUSTED : null,
                        lease_token: null,
                        lease_expires_at: null,
                        last_error: isExhausted ? "Lease expired and max attempts exceeded." : "Lease expired, scheduled for retry.",
                        available_at: availableAt,
                        update_time: now,
                        complete_time: isExhausted ? now : null,
                    })
                    .where(
                        and(
                            eq(AsyncTaskUnit.id, unit.id),
                            eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING),
                            unit.lease_token ? eq(AsyncTaskUnit.lease_token, unit.lease_token) : isNull(AsyncTaskUnit.lease_token),
                        ),
                    )
                    .returning({ id: AsyncTaskUnit.id });

                if (res.length > 0) {
                    count++;
                    if (isExhausted) {
                        await tx
                            .update(AsyncTask)
                            .set({
                                failed_units: sql`${AsyncTask.failed_units} + 1`,
                                update_time: now,
                            })
                            .where(eq(AsyncTask.id, unit.task_id));
                    }
                }
            });

            if (isExhausted) {
                await TaskManager.checkTaskCompletion(unit.task_id);
            }
        }
        return count;
    },

    /**
     * Dispatch pending task units for active running tasks.
     */
    async dispatchPendingUnits(): Promise<number> {
        const runningTasks = await db.select({ id: AsyncTask.id }).from(AsyncTask).where(eq(AsyncTask.status, AsyncTaskStatus.RUNNING));

        let dispatched = 0;
        for (const task of runningTasks) {
            dispatched += await TaskManager.dispatchTaskUnits(task.id);
        }
        return dispatched;
    },

    /**
     * Check completion status for active running tasks and reconcile state.
     */
    async reconcileTasks(): Promise<number> {
        const activeTasks = await db
            .select()
            .from(AsyncTask)
            .where(and(eq(AsyncTask.status, AsyncTaskStatus.RUNNING), eq(AsyncTask.discovery_complete, true)));

        let reconciledCount = 0;
        for (const task of activeTasks) {
            const completed = await TaskManager.checkTaskCompletion(task.id);
            if (completed) reconciledCount++;
        }
        return reconciledCount;
    },

    /**
     * Purge old completed, failed, or cancelled tasks and their units.
     */
    async purgeOldTasks(daysToKeep = 7): Promise<number> {
        const cutoff = Temporal.Now.instant().subtract({ hours: daysToKeep * 24 });

        const oldTasks = await db
            .select({ id: AsyncTask.id })
            .from(AsyncTask)
            .where(
                and(
                    inArray(AsyncTask.status, [AsyncTaskStatus.COMPLETED, AsyncTaskStatus.FAILED, AsyncTaskStatus.CANCELLED]),
                    lt(AsyncTask.complete_time, cutoff),
                ),
            )
            .limit(50);

        if (oldTasks.length === 0) return 0;

        const taskIds = oldTasks.map((j) => j.id);

        await db.transaction(async (tx) => {
            await tx.delete(AsyncTaskUnit).where(inArray(AsyncTaskUnit.task_id, taskIds));
            await tx.delete(AsyncTask).where(inArray(AsyncTask.id, taskIds));
        });

        return taskIds.length;
    },
};
