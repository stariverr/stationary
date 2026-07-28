import { eq } from "drizzle-orm";
import { AsyncOutcomeCode, AsyncTask, AsyncTaskControl, AsyncTaskStatus, type AsyncTaskUnit } from "@/db/schema";
import { db } from "@/global/db";
import { getErrorMessage } from "@/lib/utils/error";
import { getTaskHandler } from "@/infra/jobs/registry";
import { HEARTBEAT_INTERVAL_MS, UNIT_LEASE_SECONDS } from "@/infra/jobs/policy";
import { failOrphanedUnit, renewUnitLease, settleTaskUnit } from "@/infra/jobs/store";
import type { TaskResult, TaskUnitContext } from "@/infra/jobs/types";

type TaskUnitRow = typeof AsyncTaskUnit.$inferSelect;

interface LeaseHeartbeat {
    stop(): void;
}

function startLeaseHeartbeat(
    unitId: string,
    leaseToken: string,
    onLeaseLost: () => void,
    intervalMs = HEARTBEAT_INTERVAL_MS,
): LeaseHeartbeat {
    let stopped = false;
    let renewalInFlight = false;

    const timer = setInterval(() => {
        if (stopped || renewalInFlight) return;
        renewalInFlight = true;

        void renewUnitLease(unitId, leaseToken, UNIT_LEASE_SECONDS)
            .then((renewed) => {
                if (!renewed && !stopped) {
                    stopped = true;
                    clearInterval(timer);
                    onLeaseLost();
                }
            })
            .catch((error: unknown) => {
                console.error(`[JobExecutor] Heartbeat renewal failed for unit ${unitId}:`, error);
            })
            .finally(() => {
                renewalInFlight = false;
            });
    }, intervalMs);

    timer.unref?.();

    return {
        stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
        },
    };
}

export async function executeUnit(unit: TaskUnitRow): Promise<TaskResult> {
    const leaseToken = unit.lease_token;
    if (!leaseToken) {
        return { success: false, retryable: false, error: "Claimed task unit has no lease token" };
    }

    const tasks = await db.select().from(AsyncTask).where(eq(AsyncTask.id, unit.task_id)).limit(1);
    const task = tasks[0];
    if (!task) {
        const error = "Parent task not found";
        await failOrphanedUnit(unit.id, leaseToken, error);
        return { success: false, retryable: false, error };
    }

    if (
        task.status === AsyncTaskStatus.CANCELLED ||
        task.control_requested === AsyncTaskControl.CANCEL ||
        ![AsyncTaskStatus.RUNNING, AsyncTaskStatus.PAUSED].includes(task.status)
    ) {
        return {
            success: false,
            retryable: false,
            outcomeCode: AsyncOutcomeCode.CANCELLED_BY_USER,
            error: "Parent task is not executable",
        };
    }

    const handler = getTaskHandler(task.type);
    if (!handler) {
        const result: TaskResult = {
            success: false,
            retryable: false,
            outcomeCode: AsyncOutcomeCode.UNHANDLED_EXCEPTION,
            error: `No task handler is registered for '${task.type}'`,
        };
        await settleTaskUnit(unit, leaseToken, result);
        return result;
    }

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(unit.id, leaseToken, () => {
        abortController.abort(new Error("Task unit execution lease was lost"));
    });

    const renewLease = async (extendSeconds?: number): Promise<boolean> => {
        const renewed = await renewUnitLease(unit.id, leaseToken, extendSeconds);
        if (!renewed && !abortController.signal.aborted) {
            abortController.abort(new Error("Task unit execution lease was lost"));
        }
        return renewed;
    };

    const context: TaskUnitContext = {
        task,
        unit,
        signal: abortController.signal,
        renewLease,
    };

    let result: TaskResult;
    try {
        result = await handler.execute(context);
    } catch (error) {
        result = {
            success: false,
            retryable: true,
            outcomeCode: AsyncOutcomeCode.UNHANDLED_EXCEPTION,
            error: getErrorMessage(error),
        };
    } finally {
        heartbeat.stop();
    }

    const settlement = await settleTaskUnit(unit, leaseToken, result);
    if (settlement === "lease-lost") {
        console.warn(`[JobExecutor] Ignored stale result for unit ${unit.id}; its lease is no longer valid.`);
    }
    return result;
}
