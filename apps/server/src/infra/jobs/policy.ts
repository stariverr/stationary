import { AsyncTaskStatus, type AsyncTask } from "@/db/schema";

export const DEFAULT_TASK_CONCURRENCY = 5;
export const DEFAULT_UNIT_MAX_ATTEMPTS = 5;
export const UNIT_LEASE_SECONDS = 60;
export const DISCOVERY_LEASE_SECONDS = 120;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const MAX_RETRY_DELAY_SECONDS = 300;
export const JOB_WAKE_CHANNEL = "jobs:wake_channel";


type TaskProgress = Pick<
    typeof AsyncTask.$inferSelect,
    "discovery_complete" | "total_units" | "succeeded_units" | "failed_units" | "cancelled_units"
>;

export function taskStatusAfterDiscovery(currentStatus: AsyncTaskStatus, discoveryComplete: boolean): AsyncTaskStatus {
    if (discoveryComplete) return AsyncTaskStatus.RUNNING;
    return currentStatus === AsyncTaskStatus.RUNNING ? AsyncTaskStatus.RUNNING : AsyncTaskStatus.DISCOVERING;
}

export function terminalTaskStatus(progress: TaskProgress): AsyncTaskStatus.COMPLETED | AsyncTaskStatus.FAILED | null {
    if (!progress.discovery_complete) return null;

    const processed = progress.succeeded_units + progress.failed_units + progress.cancelled_units;
    if (processed > progress.total_units) {
        throw new Error(`Task counters are inconsistent: ${processed} processed units exceeds total ${progress.total_units}`);
    }
    if (processed < progress.total_units) return null;

    return progress.failed_units > 0 ? AsyncTaskStatus.FAILED : AsyncTaskStatus.COMPLETED;
}

export function retryDelaySeconds(attemptCount: number, random = Math.random): number {
    const normalizedAttempt = Math.max(1, Math.trunc(attemptCount));
    const exponentialDelay = Math.min(MAX_RETRY_DELAY_SECONDS, 5 * 2 ** (normalizedAttempt - 1));
    const jitterMultiplier = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
    return Math.min(MAX_RETRY_DELAY_SECONDS, Math.max(1, Math.round(exponentialDelay * jitterMultiplier)));
}

export function requirePositiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
    }
    return value;
}
