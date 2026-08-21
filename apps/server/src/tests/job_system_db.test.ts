import { describe, expect, test } from "bun:test";

import {
    AsyncOutcomeCode,
    AsyncSubjectType,
    AsyncTask,
    AsyncTaskType,
    AsyncTaskUnit,
    AsyncTaskUnitKind,
    AsyncTaskUnitStatus,
} from "@/db/schema";
import { db } from "@/global/db";
import { enqueueTaskWithUnits, settleTaskUnit } from "@/infra/jobs/store";
import { TaskRetryReason } from "@/infra/jobs/types";
import { initJobHandlers } from "@/services/job_handlers";
import { eq } from "drizzle-orm";

const databaseTest = process.env.RUN_JOB_DB_TESTS === "1" ? test : test.skip;

describe("Job engine PostgreSQL integration", () => {
    databaseTest("enqueue is atomic, counted from persisted units, and idempotent", async () => {
        initJobHandlers();
        const rollback = new Error("ROLLBACK_JOB_ENGINE_TEST");
        const idempotencyKey = `job-test:${crypto.randomUUID()}`;
        let taskId: string | null = null;

        try {
            await db.transaction(async (tx) => {
                const firstSubjectId = crypto.randomUUID();
                const pendingSubjectId = crypto.randomUUID();
                const pendingInput = { sourceAuthorId: firstSubjectId, targetAuthorId: crypto.randomUUID() };
                const firstTask = await enqueueTaskWithUnits(
                    {
                        type: AsyncTaskType.COVER_BATCH,
                        inputSnapshot: { source_type: "MANUAL" },
                        idempotencyKey,
                    },
                    [
                        {
                            unitKey: "already-complete",
                            kind: AsyncTaskUnitKind.COVER_DERIVATIVE,
                            subjectType: AsyncSubjectType.MEDIA,
                            subjectId: firstSubjectId,
                            isAlreadyCompleted: true,
                        },
                        {
                            unitKey: "pending",
                            kind: AsyncTaskUnitKind.COVER_DERIVATIVE,
                            subjectType: AsyncSubjectType.MEDIA,
                            subjectId: pendingSubjectId,
                            inputSnapshot: pendingInput,
                        },
                    ],
                    tx,
                );
                taskId = firstTask.id;

                const duplicate = await enqueueTaskWithUnits(
                    {
                        type: AsyncTaskType.COVER_BATCH,
                        inputSnapshot: { source_type: "MANUAL" },
                        idempotencyKey,
                    },
                    [
                        {
                            unitKey: "already-complete",
                            kind: AsyncTaskUnitKind.COVER_DERIVATIVE,
                            subjectType: AsyncSubjectType.MEDIA,
                            subjectId: firstSubjectId,
                            isAlreadyCompleted: true,
                        },
                        {
                            unitKey: "pending",
                            kind: AsyncTaskUnitKind.COVER_DERIVATIVE,
                            subjectType: AsyncSubjectType.MEDIA,
                            subjectId: pendingSubjectId,
                            inputSnapshot: pendingInput,
                        },
                    ],
                    tx,
                );

                const persistedTask = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, firstTask.id)).limit(1);
                const persistedUnits = await tx.select().from(AsyncTaskUnit).where(eq(AsyncTaskUnit.task_id, firstTask.id));

                expect(duplicate.id).toBe(firstTask.id);
                expect(persistedTask[0]?.total_units).toBe(2);
                expect(persistedTask[0]?.succeeded_units).toBe(1);
                expect(persistedUnits).toHaveLength(2);
                expect(persistedUnits.filter((unit) => unit.status === AsyncTaskUnitStatus.SUCCEEDED)).toHaveLength(1);

                throw rollback;
            });
        } catch (error) {
            if (error !== rollback) throw error;
        }

        if (!taskId) throw new Error("Test task was not created");
        const rolledBackTask = await db.select({ id: AsyncTask.id }).from(AsyncTask).where(eq(AsyncTask.id, taskId));
        expect(rolledBackTask).toHaveLength(0);
    });

    databaseTest("lock contention retries are delayed but still bounded", async () => {
        initJobHandlers();
        const task = await enqueueTaskWithUnits(
            {
                type: AsyncTaskType.POST_PROCESS,
                inputSnapshot: { post_id: crypto.randomUUID() },
                idempotencyKey: `job-lock-test:${crypto.randomUUID()}`,
            },
            [
                {
                    unitKey: "media:locked",
                    kind: AsyncTaskUnitKind.MEDIA_DOWNLOAD,
                    subjectType: AsyncSubjectType.MEDIA,
                    subjectId: crypto.randomUUID(),
                },
            ],
        );

        try {
            const units = await db.select().from(AsyncTaskUnit).where(eq(AsyncTaskUnit.task_id, task.id)).limit(1);
            const unit = units[0];
            if (!unit) throw new Error("Test task unit was not created");

            const firstLeaseToken = crypto.randomUUID();
            const firstClaim = await db
                .update(AsyncTaskUnit)
                .set({
                    status: AsyncTaskUnitStatus.RUNNING,
                    lease_token: firstLeaseToken,
                    lease_expires_at: Temporal.Now.instant().add({ minutes: 1 }),
                    attempt_count: 1,
                })
                .where(eq(AsyncTaskUnit.id, unit.id))
                .returning();

            const contentionResult = {
                success: false,
                retryable: true,
                retryReason: TaskRetryReason.LOCK_CONTENTION,
                outcomeCode: AsyncOutcomeCode.LOCKED_CONCURRENT_EXECUTION,
                error: "Lock is held by another execution",
            } as const;

            expect(await settleTaskUnit(firstClaim[0], firstLeaseToken, contentionResult)).toBe("retrying");

            const retryingUnits = await db.select().from(AsyncTaskUnit).where(eq(AsyncTaskUnit.id, unit.id)).limit(1);
            const retryingUnit = retryingUnits[0];
            expect(retryingUnit?.status).toBe(AsyncTaskUnitStatus.PENDING);
            expect(retryingUnit?.attempt_count).toBe(1);
            expect(retryingUnit?.outcome_code).toBe(AsyncOutcomeCode.LOCKED_CONCURRENT_EXECUTION);

            if (!retryingUnit) throw new Error("Retrying task unit was not found");
            const finalLeaseToken = crypto.randomUUID();
            const finalClaim = await db
                .update(AsyncTaskUnit)
                .set({
                    status: AsyncTaskUnitStatus.RUNNING,
                    lease_token: finalLeaseToken,
                    lease_expires_at: Temporal.Now.instant().add({ minutes: 1 }),
                    attempt_count: retryingUnit.max_attempts,
                })
                .where(eq(AsyncTaskUnit.id, unit.id))
                .returning();

            expect(await settleTaskUnit(finalClaim[0], finalLeaseToken, contentionResult)).toBe("failed");

            const failedUnits = await db.select().from(AsyncTaskUnit).where(eq(AsyncTaskUnit.id, unit.id)).limit(1);
            expect(failedUnits[0]?.status).toBe(AsyncTaskUnitStatus.FAILED);
        } finally {
            await db.delete(AsyncTaskUnit).where(eq(AsyncTaskUnit.task_id, task.id));
            await db.delete(AsyncTask).where(eq(AsyncTask.id, task.id));
        }
    });
});
