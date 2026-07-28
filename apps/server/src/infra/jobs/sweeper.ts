import { Temporal } from "@js-temporal/polyfill";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { AsyncOutcomeCode, AsyncTask, AsyncTaskStatus, AsyncTaskUnit, AsyncTaskUnitStatus } from "@/db/schema";
import { db } from "@/global/db";
import { getErrorMessage } from "@/lib/utils/error";
import { retryDelaySeconds } from "@/infra/jobs/policy";
import { discoverTaskBatch, notifyJobsAvailable, reconcileTask, triggerTaskDiscoveryWorkflow } from "@/infra/jobs/store";

let sweeperInterval: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

export interface JobSweepResult {
    reclaimedLeases: number;
    recoveredDiscoveries: number;
    reconciledTasks: number;
    purgedTasks: number;
}

export function startJobSweeper(intervalMs = 30_000): void {
    if (sweeperInterval) return;
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
        throw new RangeError("intervalMs must be a positive integer");
    }

    console.log(`[JobSweeper] Starting background task recovery (interval: ${intervalMs}ms).`);
    void runJobSweep().catch((error: unknown) => {
        console.error(`[JobSweeper] Initial sweep failed: ${getErrorMessage(error)}`);
    });

    sweeperInterval = setInterval(() => {
        void runJobSweep().catch((error: unknown) => {
            console.error(`[JobSweeper] Sweep failed: ${getErrorMessage(error)}`);
        });
    }, intervalMs);
    sweeperInterval.unref?.();
}

export function stopJobSweeper(): void {
    if (!sweeperInterval) return;
    clearInterval(sweeperInterval);
    sweeperInterval = null;
}

export async function runJobSweep(): Promise<JobSweepResult> {
    if (sweepInProgress) {
        return { reclaimedLeases: 0, recoveredDiscoveries: 0, reconciledTasks: 0, purgedTasks: 0 };
    }

    sweepInProgress = true;
    try {
        const reclaimedLeases = await reclaimExpiredLeases();
        const recoveredDiscoveries = await recoverInterruptedDiscovery();
        const reconciledTasks = await reconcileReadyTasks();
        const purgedTasks = await purgeOldTasks();
        notifyJobsAvailable();
        return { reclaimedLeases, recoveredDiscoveries, reconciledTasks, purgedTasks };
    } finally {
        sweepInProgress = false;
    }
}

export async function reclaimExpiredLeases(): Promise<number> {
    const now = Temporal.Now.instant();
    const expiredUnits = await db
        .select()
        .from(AsyncTaskUnit)
        .where(and(eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING), lt(AsyncTaskUnit.lease_expires_at, sql`now()`)))
        .orderBy(asc(AsyncTaskUnit.lease_expires_at))
        .limit(50);

    let reclaimedCount = 0;
    const tasksToReconcile = new Set<string>();

    for (const unit of expiredUnits) {
        const reclaimed = await db.transaction(async (tx) => {
            const tasks = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, unit.task_id)).for("update").limit(1);
            const task = tasks[0];
            if (!task || ![AsyncTaskStatus.RUNNING, AsyncTaskStatus.PAUSED].includes(task.status)) return false;

            const exhausted = unit.attempt_count >= unit.max_attempts;
            const updated = await tx
                .update(AsyncTaskUnit)
                .set({
                    status: exhausted ? AsyncTaskUnitStatus.FAILED : AsyncTaskUnitStatus.PENDING,
                    outcome_code: exhausted ? AsyncOutcomeCode.LEASE_EXPIRED_EXHAUSTED : null,
                    lease_token: null,
                    lease_expires_at: null,
                    last_error: exhausted ? "Execution lease expired and retries were exhausted" : "Execution lease expired",
                    available_at: exhausted ? sql`now()` : sql`now() + (${retryDelaySeconds(unit.attempt_count)} * interval '1 second')`,
                    update_time: now,
                    complete_time: exhausted ? now : null,
                })
                .where(
                    and(
                        eq(AsyncTaskUnit.id, unit.id),
                        eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING),
                        unit.lease_token ? eq(AsyncTaskUnit.lease_token, unit.lease_token) : isNull(AsyncTaskUnit.lease_token),
                        lt(AsyncTaskUnit.lease_expires_at, sql`now()`),
                    ),
                )
                .returning({ id: AsyncTaskUnit.id });
            if (updated.length === 0) return false;

            await tx
                .update(AsyncTask)
                .set({
                    failed_units: exhausted ? task.failed_units + 1 : task.failed_units,
                    last_error: exhausted ? "A task unit exhausted its lease retries" : task.last_error,
                    update_time: now,
                })
                .where(eq(AsyncTask.id, task.id));

            if (exhausted) tasksToReconcile.add(task.id);
            return true;
        });

        if (reclaimed) reclaimedCount++;
    }

    for (const taskId of tasksToReconcile) {
        await reconcileTask(taskId);
    }
    if (reclaimedCount > 0) notifyJobsAvailable();
    return reclaimedCount;
}

export async function recoverInterruptedDiscovery(): Promise<number> {
    const tasks = await db
        .select({ id: AsyncTask.id })
        .from(AsyncTask)
        .where(
            and(
                eq(AsyncTask.discovery_complete, false),
                inArray(AsyncTask.status, [AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING]),
                or(isNull(AsyncTask.discovery_lease_expires_at), lt(AsyncTask.discovery_lease_expires_at, sql`now()`)),
            ),
        )
        .orderBy(asc(AsyncTask.update_time))
        .limit(10);

    let recoveredCount = 0;
    for (const task of tasks) {
        try {
            const hasMore = await discoverTaskBatch(task.id);
            recoveredCount++;
            if (hasMore) triggerTaskDiscoveryWorkflow(task.id);
        } catch (error) {
            console.error(`[JobSweeper] Failed to recover discovery for task ${task.id}: ${getErrorMessage(error)}`);
        }
    }
    return recoveredCount;
}

export async function reconcileReadyTasks(): Promise<number> {
    const tasks = await db
        .select({ id: AsyncTask.id })
        .from(AsyncTask)
        .where(and(inArray(AsyncTask.status, [AsyncTaskStatus.RUNNING, AsyncTaskStatus.PAUSED]), eq(AsyncTask.discovery_complete, true)))
        .orderBy(asc(AsyncTask.update_time))
        .limit(100);

    let reconciledCount = 0;
    for (const task of tasks) {
        if (await reconcileTask(task.id)) reconciledCount++;
    }
    return reconciledCount;
}

export async function purgeOldTasks(daysToKeep = 7): Promise<number> {
    if (!Number.isInteger(daysToKeep) || daysToKeep <= 0) {
        throw new RangeError("daysToKeep must be a positive integer");
    }

    const cutoff = Temporal.Now.instant().subtract({ hours: daysToKeep * 24 });
    const tasks = await db
        .select({ id: AsyncTask.id })
        .from(AsyncTask)
        .where(
            and(
                inArray(AsyncTask.status, [AsyncTaskStatus.COMPLETED, AsyncTaskStatus.FAILED, AsyncTaskStatus.CANCELLED]),
                lt(AsyncTask.complete_time, cutoff),
            ),
        )
        .orderBy(asc(AsyncTask.complete_time))
        .limit(50);

    const taskIds = tasks.map((task) => task.id);
    if (taskIds.length === 0) return 0;

    await db.transaction(async (tx) => {
        await tx.delete(AsyncTaskUnit).where(inArray(AsyncTaskUnit.task_id, taskIds));
        await tx.delete(AsyncTask).where(inArray(AsyncTask.id, taskIds));
    });
    return taskIds.length;
}

export const JobSweeper = Object.freeze({
    start: startJobSweeper,
    stop: stopJobSweeper,
    runSweep: runJobSweep,
    reclaimExpiredLeases,
    recoverInterruptedDiscovery,
    reconcileTasks: reconcileReadyTasks,
    purgeOldTasks,
});
