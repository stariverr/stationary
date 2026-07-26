import type { AsyncTask, AsyncTaskUnit, AsyncTaskUnitKind, AsyncSubjectType, AsyncOutcomeCode } from "@/db/schema";

export interface TaskUnitContext {
    task: typeof AsyncTask.$inferSelect;
    unit: typeof AsyncTaskUnit.$inferSelect;
    reportProgress: (value: number, total: number) => Promise<void>;
    /** Atomically renew the execution lease for this task unit */
    renewLease: (extendSeconds?: number) => Promise<boolean>;
    /** Start an automated background heartbeat timer to periodically extend lease */
    startHeartbeat: (intervalMs?: number, extendSeconds?: number) => { stop: () => void };
}

export interface TaskResult {
    success: boolean;
    skipped?: boolean;
    outcomeCode?: AsyncOutcomeCode | string;
    retryable?: boolean;
    data?: unknown;
    error?: string;
}

export interface DiscoveredUnitSpec {
    unitKey: string;
    kind: AsyncTaskUnitKind;
    subjectType: AsyncSubjectType;
    subjectId: string;
    specHash?: string;
    inputSnapshot?: Record<string, unknown>;
    isAlreadyCompleted?: boolean;
    existingResultRef?: Record<string, unknown> | null;
}

export interface TaskHandler {
    validateInput?(input: unknown): unknown;
    discoverUnits?(
        task: typeof AsyncTask.$inferSelect,
        discoveryCursor: Record<string, unknown> | null,
        batchSize: number,
    ): Promise<{
        units: DiscoveredUnitSpec[];
        nextCursor: Record<string, unknown> | null;
        hasMore: boolean;
    }>;
    execute(context: TaskUnitContext): Promise<TaskResult>;
    cancel?(context: TaskUnitContext): Promise<void>;
}
