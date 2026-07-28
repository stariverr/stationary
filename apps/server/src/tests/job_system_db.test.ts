import { describe, expect, test } from "bun:test";
import { AsyncSubjectType, AsyncTask, AsyncTaskType, AsyncTaskUnit, AsyncTaskUnitKind, AsyncTaskUnitStatus } from "@/db/schema";
import { db } from "@/global/db";
import { enqueueTaskWithUnits } from "@/infra/jobs/store";
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
});
