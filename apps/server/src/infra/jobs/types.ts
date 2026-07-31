import type { AsyncOutcomeCode, AsyncSubjectType, AsyncTask, AsyncTaskType, AsyncTaskUnit, AsyncTaskUnitKind } from "@/db/schema";
import type { Transaction } from "@/global/db";

export interface TaskUnitContext {
    readonly task: typeof AsyncTask.$inferSelect;
    readonly unit: typeof AsyncTaskUnit.$inferSelect;
    readonly signal: AbortSignal;
    readonly renewLease: (extendSeconds?: number) => Promise<boolean>;
}

export const TaskRetryReason = {
    LOCK_CONTENTION: "LOCK_CONTENTION",
} as const;

export type TaskRetryReason = (typeof TaskRetryReason)[keyof typeof TaskRetryReason];

export interface TaskResult {
    success: boolean;
    skipped?: boolean;
    outcomeCode?: AsyncOutcomeCode | string;
    retryable?: boolean;
    retryReason?: TaskRetryReason;
    data?: Record<string, unknown> | null;
    error?: string;
}

export interface DiscoveredUnitSpec {
    readonly unitKey: string;
    readonly kind: AsyncTaskUnitKind;
    readonly subjectType: AsyncSubjectType;
    readonly subjectId: string;
    readonly specHash?: string;
    readonly inputSnapshot?: Record<string, unknown>;
    readonly isAlreadyCompleted?: boolean;
    readonly existingResultRef?: Record<string, unknown> | null;
}

export interface CreateTaskParams {
    readonly type: AsyncTaskType;
    readonly libraryId?: string | null;
    readonly ownerId?: string | null;
    readonly inputSnapshot?: Record<string, unknown>;
    readonly configVersion?: number;
    readonly maxConcurrency?: number;
    readonly idempotencyKey?: string | null;
}

export interface TaskExecutionSummary {
    succeededUnits: number;
    failedUnits: number;
    cancelledUnits: number;
    totalUnits: number;
}

export interface TaskHandler {
    validateInput?(input: Record<string, unknown>): Record<string, unknown>;
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
    finalizeTask?(tx: Transaction, task: typeof AsyncTask.$inferSelect, summary: TaskExecutionSummary): Promise<void>;
}
