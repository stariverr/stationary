import { isDeepStrictEqual } from "node:util";
import { Temporal } from "@js-temporal/polyfill";
import { v7 as uuidv7 } from "uuid";
import { and, asc, count, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { AsyncOutcomeCode, AsyncTask, AsyncTaskControl, AsyncTaskStatus, AsyncTaskUnit, AsyncTaskUnitStatus } from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { getErrorMessage } from "@/lib/utils/error";
import { getTaskHandler } from "@/infra/jobs/registry";
import {
    DEFAULT_TASK_CONCURRENCY,
    DEFAULT_UNIT_MAX_ATTEMPTS,
    DISCOVERY_LEASE_SECONDS,
    UNIT_LEASE_SECONDS,
    requirePositiveInteger,
    retryDelaySeconds,
    taskStatusAfterDiscovery,
    terminalTaskStatus,
} from "@/infra/jobs/policy";
import type { CreateTaskParams, DiscoveredUnitSpec, TaskResult } from "@/infra/jobs/types";

type TaskRow = typeof AsyncTask.$inferSelect;
type TaskUnitRow = typeof AsyncTaskUnit.$inferSelect;
type WakeCallback = () => void;

interface PreparedTaskParams {
    type: CreateTaskParams["type"];
    libraryId: string | null;
    ownerId: string | null;
    inputSnapshot: Record<string, unknown>;
    configVersion: number;
    maxConcurrency: number;
    idempotencyKey: string | null;
}

const wakeCallbacks = new Set<WakeCallback>();
const activeDiscoveryTasks = new Set<string>();

export function onJobsAvailable(callback: WakeCallback): () => void {
    wakeCallbacks.add(callback);
    return () => wakeCallbacks.delete(callback);
}

export function notifyJobsAvailable(): void {
    for (const callback of wakeCallbacks) {
        try {
            callback();
        } catch (error) {
            console.error("[JobStore] Job wake callback failed:", error);
        }
    }
}

function prepareTaskParams(params: CreateTaskParams): PreparedTaskParams {
    const handler = getTaskHandler(params.type);
    if (!handler) {
        throw new Error(`No task handler is registered for '${params.type}'`);
    }

    const rawInput = { ...params.inputSnapshot };
    const inputSnapshot = handler.validateInput?.(rawInput) ?? rawInput;
    const configVersion = requirePositiveInteger(params.configVersion ?? 1, "configVersion");
    const maxConcurrency = requirePositiveInteger(params.maxConcurrency ?? DEFAULT_TASK_CONCURRENCY, "maxConcurrency");

    return {
        type: params.type,
        libraryId: params.libraryId ?? null,
        ownerId: params.ownerId ?? null,
        inputSnapshot,
        configVersion,
        maxConcurrency,
        idempotencyKey: params.idempotencyKey?.trim() || null,
    };
}

function assertUniqueUnitKeys(unitSpecs: readonly DiscoveredUnitSpec[]): void {
    const keys = new Set<string>();
    for (const spec of unitSpecs) {
        if (!spec.unitKey.trim()) {
            throw new Error("Task unit keys must not be empty");
        }
        if (keys.has(spec.unitKey)) {
            throw new Error(`Duplicate task unit key '${spec.unitKey}'`);
        }
        keys.add(spec.unitKey);
    }
}

async function insertTaskIdempotently(
    tx: Transaction,
    values: typeof AsyncTask.$inferInsert,
    idempotencyKey: string | null,
): Promise<{ task: TaskRow; created: boolean }> {
    const inserted = idempotencyKey
        ? await tx.insert(AsyncTask).values(values).onConflictDoNothing({ target: AsyncTask.idempotency_key }).returning()
        : await tx.insert(AsyncTask).values(values).returning();

    if (inserted[0]) {
        return { task: inserted[0], created: true };
    }

    const existing = await tx.select().from(AsyncTask).where(eq(AsyncTask.idempotency_key, idempotencyKey!)).limit(1);
    if (!existing[0]) {
        throw new Error("Failed to create or retrieve idempotent task");
    }
    const requestMatches =
        existing[0].type === values.type &&
        existing[0].library_id === (values.library_id ?? null) &&
        existing[0].owner_id === (values.owner_id ?? null) &&
        existing[0].config_version === values.config_version &&
        existing[0].max_in_flight === values.max_in_flight &&
        isDeepStrictEqual(existing[0].input_snapshot, values.input_snapshot ?? {});
    if (!requestMatches) {
        throw new Error(`Idempotency key '${idempotencyKey}' was reused with different task parameters`);
    }

    return { task: existing[0], created: false };
}

async function reconcileTaskInTransaction(tx: Transaction, taskId: string): Promise<boolean> {
    const tasks = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, taskId)).for("update").limit(1);
    const task = tasks[0];
    if (!task || [AsyncTaskStatus.COMPLETED, AsyncTaskStatus.FAILED, AsyncTaskStatus.CANCELLED].includes(task.status)) {
        return false;
    }

    const finalStatus = terminalTaskStatus(task);
    if (!finalStatus) return false;

    const handler = getTaskHandler(task.type);
    if (!handler) {
        throw new Error(`No task handler is registered for '${task.type}'`);
    }

    await handler.finalizeTask?.(tx, task, {
        succeededUnits: task.succeeded_units,
        failedUnits: task.failed_units,
        cancelledUnits: task.cancelled_units,
        totalUnits: task.total_units,
    });

    const now = Temporal.Now.instant();
    const updated = await tx
        .update(AsyncTask)
        .set({
            status: finalStatus,
            last_error: finalStatus === AsyncTaskStatus.COMPLETED ? null : task.last_error,
            discovery_lease_token: null,
            discovery_lease_expires_at: null,
            update_time: now,
            complete_time: now,
        })
        .where(
            and(
                eq(AsyncTask.id, taskId),
                inArray(AsyncTask.status, [AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING, AsyncTaskStatus.PAUSED]),
            ),
        )
        .returning({ id: AsyncTask.id });

    return updated.length > 0;
}

async function enqueueTaskWithUnitsInTransaction(
    tx: Transaction,
    params: PreparedTaskParams,
    unitSpecs: readonly DiscoveredUnitSpec[],
): Promise<TaskRow> {
    const now = Temporal.Now.instant();
    const succeededUnits = unitSpecs.filter((spec) => spec.isAlreadyCompleted).length;
    const insertedTask = await insertTaskIdempotently(
        tx,
        {
            type: params.type,
            status: AsyncTaskStatus.RUNNING,
            library_id: params.libraryId,
            owner_id: params.ownerId,
            input_snapshot: params.inputSnapshot,
            config_version: params.configVersion,
            discovery_cursor: null,
            discovery_complete: true,
            total_units: unitSpecs.length,
            succeeded_units: succeededUnits,
            failed_units: 0,
            cancelled_units: 0,
            control_requested: AsyncTaskControl.NONE,
            max_in_flight: params.maxConcurrency,
            idempotency_key: params.idempotencyKey,
            create_time: now,
            update_time: now,
        },
        params.idempotencyKey,
    );

    if (!insertedTask.created) {
        const existingUnits = await tx
            .select({
                unitKey: AsyncTaskUnit.unit_key,
                kind: AsyncTaskUnit.kind,
                subjectType: AsyncTaskUnit.subject_type,
                subjectId: AsyncTaskUnit.subject_id,
                specHash: AsyncTaskUnit.spec_hash,
                inputSnapshot: AsyncTaskUnit.input_snapshot,
            })
            .from(AsyncTaskUnit)
            .where(eq(AsyncTaskUnit.task_id, insertedTask.task.id))
            .orderBy(asc(AsyncTaskUnit.unit_key));
        const requestedUnits = unitSpecs
            .map((spec) => ({
                unitKey: spec.unitKey,
                kind: spec.kind,
                subjectType: spec.subjectType,
                subjectId: spec.subjectId,
                specHash: spec.specHash ?? "",
                inputSnapshot: spec.inputSnapshot ?? {},
            }))
            .sort((left, right) => left.unitKey.localeCompare(right.unitKey));

        if (!isDeepStrictEqual(existingUnits, requestedUnits)) {
            throw new Error(`Idempotency key '${params.idempotencyKey}' was reused with different task units`);
        }
        return insertedTask.task;
    }

    if (unitSpecs.length > 0) {
        await tx.insert(AsyncTaskUnit).values(
            unitSpecs.map((spec) => {
                const isCompleted = spec.isAlreadyCompleted === true;
                return {
                    task_id: insertedTask.task.id,
                    unit_key: spec.unitKey,
                    kind: spec.kind,
                    subject_type: spec.subjectType,
                    subject_id: spec.subjectId,
                    status: isCompleted ? AsyncTaskUnitStatus.SUCCEEDED : AsyncTaskUnitStatus.PENDING,
                    outcome_code: isCompleted ? AsyncOutcomeCode.SKIPPED : null,
                    attempt_count: 0,
                    max_attempts: DEFAULT_UNIT_MAX_ATTEMPTS,
                    spec_hash: spec.specHash ?? "",
                    input_snapshot: spec.inputSnapshot ?? {},
                    result_ref: spec.existingResultRef ?? null,
                    available_at: now,
                    create_time: now,
                    update_time: now,
                    complete_time: isCompleted ? now : null,
                };
            }),
        );
    }

    if (succeededUnits === unitSpecs.length) {
        await reconcileTaskInTransaction(tx, insertedTask.task.id);
        const finalized = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, insertedTask.task.id)).limit(1);
        return finalized[0] ?? insertedTask.task;
    }

    return insertedTask.task;
}

export async function enqueueTaskWithUnits(
    params: CreateTaskParams,
    unitSpecs: readonly DiscoveredUnitSpec[],
    transaction?: Transaction,
): Promise<TaskRow> {
    const prepared = prepareTaskParams(params);
    assertUniqueUnitKeys(unitSpecs);

    if (transaction) {
        return enqueueTaskWithUnitsInTransaction(transaction, prepared, unitSpecs);
    }

    const task = await db.transaction((tx) => enqueueTaskWithUnitsInTransaction(tx, prepared, unitSpecs));
    notifyJobsAvailable();
    return task;
}

export async function createTask(params: CreateTaskParams): Promise<TaskRow> {
    const prepared = prepareTaskParams(params);
    const handler = getTaskHandler(prepared.type);
    if (!handler?.discoverUnits) {
        throw new Error(`Task type '${prepared.type}' requires pre-built units and cannot use createTask()`);
    }

    const now = Temporal.Now.instant();
    const result = await db.transaction((tx) =>
        insertTaskIdempotently(
            tx,
            {
                type: prepared.type,
                status: AsyncTaskStatus.DISCOVERING,
                library_id: prepared.libraryId,
                owner_id: prepared.ownerId,
                input_snapshot: prepared.inputSnapshot,
                config_version: prepared.configVersion,
                discovery_cursor: null,
                discovery_complete: false,
                total_units: 0,
                succeeded_units: 0,
                failed_units: 0,
                cancelled_units: 0,
                control_requested: AsyncTaskControl.NONE,
                max_in_flight: prepared.maxConcurrency,
                idempotency_key: prepared.idempotencyKey,
                create_time: now,
                update_time: now,
            },
            prepared.idempotencyKey,
        ),
    );

    if (!result.task.discovery_complete && [AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING].includes(result.task.status)) {
        triggerTaskDiscoveryWorkflow(result.task.id);
    } else if (result.task.status === AsyncTaskStatus.RUNNING) {
        notifyJobsAvailable();
    }

    return result.task;
}

async function claimDiscoveryTask(taskId: string): Promise<{ task: TaskRow; leaseToken: string } | null> {
    const now = Temporal.Now.instant();
    const leaseToken = uuidv7();
    const claimed = await db
        .update(AsyncTask)
        .set({
            discovery_lease_token: leaseToken,
            discovery_lease_expires_at: sql`now() + (${DISCOVERY_LEASE_SECONDS} * interval '1 second')`,
            update_time: now,
        })
        .where(
            and(
                eq(AsyncTask.id, taskId),
                eq(AsyncTask.discovery_complete, false),
                inArray(AsyncTask.status, [AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING]),
                or(isNull(AsyncTask.discovery_lease_expires_at), lt(AsyncTask.discovery_lease_expires_at, sql`now()`)),
            ),
        )
        .returning();

    return claimed[0] ? { task: claimed[0], leaseToken } : null;
}

async function releaseDiscoveryLease(taskId: string, leaseToken: string, error: unknown): Promise<void> {
    const now = Temporal.Now.instant();
    await db
        .update(AsyncTask)
        .set({
            discovery_lease_token: null,
            discovery_lease_expires_at: null,
            last_error: `Discovery failed: ${getErrorMessage(error)}`,
            update_time: now,
        })
        .where(and(eq(AsyncTask.id, taskId), eq(AsyncTask.discovery_lease_token, leaseToken)));
}

export async function discoverTaskBatch(taskId: string, batchSize = 100): Promise<boolean> {
    requirePositiveInteger(batchSize, "batchSize");
    const claim = await claimDiscoveryTask(taskId);
    if (!claim) return false;

    try {
        const handler = getTaskHandler(claim.task.type);
        if (!handler?.discoverUnits) {
            throw new Error(`No discovery handler is registered for '${claim.task.type}'`);
        }

        const currentCursor = claim.task.discovery_cursor as Record<string, unknown> | null;
        const discovery = await handler.discoverUnits(claim.task, currentCursor, batchSize);
        assertUniqueUnitKeys(discovery.units);

        if (discovery.hasMore && !discovery.nextCursor) {
            throw new Error(`Discovery handler '${claim.task.type}' returned hasMore without a next cursor`);
        }
        if (discovery.hasMore && isDeepStrictEqual(currentCursor, discovery.nextCursor)) {
            throw new Error(`Discovery handler '${claim.task.type}' did not advance its cursor`);
        }

        const now = Temporal.Now.instant();
        const discoveryComplete = !discovery.hasMore;
        const applied = await db.transaction(async (tx) => {
            const tasks = await tx
                .select()
                .from(AsyncTask)
                .where(and(eq(AsyncTask.id, taskId), eq(AsyncTask.discovery_lease_token, claim.leaseToken)))
                .for("update")
                .limit(1);
            const task = tasks[0];
            if (!task || task.discovery_complete || ![AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING].includes(task.status)) {
                return false;
            }

            let insertedUnits: Array<{ status: AsyncTaskUnitStatus }> = [];
            if (discovery.units.length > 0) {
                insertedUnits = await tx
                    .insert(AsyncTaskUnit)
                    .values(
                        discovery.units.map((spec) => {
                            const isCompleted = spec.isAlreadyCompleted === true;
                            return {
                                task_id: taskId,
                                kind: spec.kind,
                                subject_type: spec.subjectType,
                                subject_id: spec.subjectId,
                                unit_key: spec.unitKey,
                                spec_hash: spec.specHash ?? "",
                                status: isCompleted ? AsyncTaskUnitStatus.SUCCEEDED : AsyncTaskUnitStatus.PENDING,
                                outcome_code: isCompleted ? AsyncOutcomeCode.SKIPPED : null,
                                available_at: now,
                                attempt_count: 0,
                                max_attempts: DEFAULT_UNIT_MAX_ATTEMPTS,
                                input_snapshot: spec.inputSnapshot ?? {},
                                result_ref: spec.existingResultRef ?? null,
                                create_time: now,
                                update_time: now,
                                complete_time: isCompleted ? now : null,
                            };
                        }),
                    )
                    .onConflictDoNothing()
                    .returning({ status: AsyncTaskUnit.status });
            }

            const newSucceededUnits = insertedUnits.filter((unit) => unit.status === AsyncTaskUnitStatus.SUCCEEDED).length;
            await tx
                .update(AsyncTask)
                .set({
                    status: taskStatusAfterDiscovery(task.status, discoveryComplete),
                    discovery_cursor: discovery.nextCursor ?? null,
                    discovery_complete: discoveryComplete,
                    discovery_lease_token: null,
                    discovery_lease_expires_at: null,
                    total_units: task.total_units + insertedUnits.length,
                    succeeded_units: task.succeeded_units + newSucceededUnits,
                    last_error: null,
                    update_time: now,
                })
                .where(and(eq(AsyncTask.id, taskId), eq(AsyncTask.discovery_lease_token, claim.leaseToken)));

            return true;
        });

        if (!applied) return false;

        notifyJobsAvailable();
        if (discoveryComplete) {
            await reconcileTask(taskId);
        }
        return discovery.hasMore;
    } catch (error) {
        try {
            await releaseDiscoveryLease(taskId, claim.leaseToken, error);
        } catch (releaseError) {
            console.error(`[JobStore] Failed to release discovery lease for task ${taskId}:`, releaseError);
        }
        throw error;
    }
}

export function triggerTaskDiscoveryWorkflow(taskId: string): void {
    if (activeDiscoveryTasks.has(taskId)) return;
    activeDiscoveryTasks.add(taskId);

    setImmediate(() => {
        void (async () => {
            try {
                let hasMore = true;
                while (hasMore) {
                    hasMore = await discoverTaskBatch(taskId);
                }
            } catch (error) {
                console.error(`[JobStore] Discovery workflow failed for task ${taskId}:`, error);
            } finally {
                activeDiscoveryTasks.delete(taskId);
            }
        })();
    });
}

export async function claimUnits(maxBatchSize = 8): Promise<TaskUnitRow[]> {
    requirePositiveInteger(maxBatchSize, "maxBatchSize");
    const now = Temporal.Now.instant();
    const leaseExpiry = sql`now() + (${UNIT_LEASE_SECONDS} * interval '1 second')`;

    return db.transaction(async (tx) => {
        const claimedUnits: TaskUnitRow[] = [];
        const activeTasks = await tx
            .select()
            .from(AsyncTask)
            .where(and(eq(AsyncTask.status, AsyncTaskStatus.RUNNING), eq(AsyncTask.control_requested, AsyncTaskControl.NONE)))
            .orderBy(asc(AsyncTask.update_time), asc(AsyncTask.create_time))
            .limit(Math.max(20, maxBatchSize * 4))
            .for("update", { skipLocked: true });

        for (const task of activeTasks) {
            if (claimedUnits.length >= maxBatchSize) break;

            const runningResult = await tx
                .select({ value: count() })
                .from(AsyncTaskUnit)
                .where(and(eq(AsyncTaskUnit.task_id, task.id), eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING)));
            const availableCapacity = Math.min(
                maxBatchSize - claimedUnits.length,
                Math.max(0, task.max_in_flight - Number(runningResult[0]?.value ?? 0)),
            );
            if (availableCapacity === 0) {
                await tx.update(AsyncTask).set({ update_time: now }).where(eq(AsyncTask.id, task.id));
                continue;
            }

            const candidates = await tx
                .select()
                .from(AsyncTaskUnit)
                .where(
                    and(
                        eq(AsyncTaskUnit.task_id, task.id),
                        eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.PENDING),
                        lte(AsyncTaskUnit.available_at, sql`now()`),
                    ),
                )
                .orderBy(asc(AsyncTaskUnit.available_at), asc(AsyncTaskUnit.create_time))
                .limit(availableCapacity)
                .for("update", { skipLocked: true });

            for (const unit of candidates) {
                const claimed = await tx
                    .update(AsyncTaskUnit)
                    .set({
                        status: AsyncTaskUnitStatus.RUNNING,
                        lease_token: uuidv7(),
                        lease_expires_at: leaseExpiry,
                        attempt_count: unit.attempt_count + 1,
                        update_time: now,
                    })
                    .where(
                        and(
                            eq(AsyncTaskUnit.id, unit.id),
                            eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.PENDING),
                            lte(AsyncTaskUnit.available_at, sql`now()`),
                        ),
                    )
                    .returning();

                if (claimed[0]) {
                    claimedUnits.push(claimed[0]);
                }
            }

            await tx.update(AsyncTask).set({ update_time: now }).where(eq(AsyncTask.id, task.id));
        }

        return claimedUnits;
    });
}

export async function renewUnitLease(unitId: string, leaseToken: string, extendSeconds = UNIT_LEASE_SECONDS): Promise<boolean> {
    requirePositiveInteger(extendSeconds, "extendSeconds");
    const now = Temporal.Now.instant();
    const renewed = await db
        .update(AsyncTaskUnit)
        .set({
            lease_expires_at: sql`now() + (${extendSeconds} * interval '1 second')`,
            update_time: now,
        })
        .where(
            and(
                eq(AsyncTaskUnit.id, unitId),
                eq(AsyncTaskUnit.lease_token, leaseToken),
                eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING),
                gt(AsyncTaskUnit.lease_expires_at, sql`now()`),
            ),
        )
        .returning({ id: AsyncTaskUnit.id });

    return renewed.length > 0;
}

export type UnitSettlement = "succeeded" | "retrying" | "failed" | "lease-lost";

export async function settleTaskUnit(unit: TaskUnitRow, leaseToken: string, result: TaskResult): Promise<UnitSettlement> {
    const now = Temporal.Now.instant();
    const succeeded = result.success || result.skipped === true;
    const exhausted = unit.attempt_count >= unit.max_attempts || result.retryable === false;

    const settlement = await db.transaction(async (tx): Promise<UnitSettlement> => {
        const tasks = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, unit.task_id)).for("update").limit(1);
        const task = tasks[0];
        if (!task || ![AsyncTaskStatus.RUNNING, AsyncTaskStatus.PAUSED].includes(task.status)) {
            return "lease-lost";
        }

        if (succeeded) {
            const updated = await tx
                .update(AsyncTaskUnit)
                .set({
                    status: AsyncTaskUnitStatus.SUCCEEDED,
                    outcome_code: result.outcomeCode ?? (result.skipped ? AsyncOutcomeCode.SKIPPED : AsyncOutcomeCode.EXECUTED),
                    result_ref: result.data ?? null,
                    last_error: result.error ?? null,
                    lease_token: null,
                    lease_expires_at: null,
                    update_time: now,
                    complete_time: now,
                })
                .where(
                    and(
                        eq(AsyncTaskUnit.id, unit.id),
                        eq(AsyncTaskUnit.lease_token, leaseToken),
                        eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING),
                    ),
                )
                .returning({ id: AsyncTaskUnit.id });
            if (updated.length === 0) return "lease-lost";

            await tx
                .update(AsyncTask)
                .set({ succeeded_units: task.succeeded_units + 1, update_time: now })
                .where(eq(AsyncTask.id, task.id));
            return "succeeded";
        }

        if (!exhausted) {
            const updated = await tx
                .update(AsyncTaskUnit)
                .set({
                    status: AsyncTaskUnitStatus.PENDING,
                    outcome_code: result.outcomeCode ?? AsyncOutcomeCode.UNHANDLED_EXCEPTION,
                    last_error: result.error ?? "Task unit execution failed",
                    available_at: sql`now() + (${retryDelaySeconds(unit.attempt_count)} * interval '1 second')`,
                    lease_token: null,
                    lease_expires_at: null,
                    update_time: now,
                    complete_time: null,
                })
                .where(
                    and(
                        eq(AsyncTaskUnit.id, unit.id),
                        eq(AsyncTaskUnit.lease_token, leaseToken),
                        eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING),
                    ),
                )
                .returning({ id: AsyncTaskUnit.id });
            if (updated.length === 0) return "lease-lost";

            await tx
                .update(AsyncTask)
                .set({ last_error: result.error ?? "Task unit execution failed", update_time: now })
                .where(eq(AsyncTask.id, task.id));
            return "retrying";
        }

        const updated = await tx
            .update(AsyncTaskUnit)
            .set({
                status: AsyncTaskUnitStatus.FAILED,
                outcome_code: result.outcomeCode ?? AsyncOutcomeCode.MAX_ATTEMPTS_EXCEEDED,
                last_error: result.error ?? "Task unit retries exhausted",
                lease_token: null,
                lease_expires_at: null,
                update_time: now,
                complete_time: now,
            })
            .where(
                and(
                    eq(AsyncTaskUnit.id, unit.id),
                    eq(AsyncTaskUnit.lease_token, leaseToken),
                    eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING),
                ),
            )
            .returning({ id: AsyncTaskUnit.id });
        if (updated.length === 0) return "lease-lost";

        await tx
            .update(AsyncTask)
            .set({
                failed_units: task.failed_units + 1,
                last_error: result.error ?? "Task unit retries exhausted",
                update_time: now,
            })
            .where(eq(AsyncTask.id, task.id));
        return "failed";
    });

    if (settlement === "succeeded" || settlement === "failed") {
        await reconcileTask(unit.task_id);
    } else if (settlement === "retrying") {
        notifyJobsAvailable();
    }

    return settlement;
}

export async function failOrphanedUnit(unitId: string, leaseToken: string, error: string): Promise<void> {
    const now = Temporal.Now.instant();
    await db
        .update(AsyncTaskUnit)
        .set({
            status: AsyncTaskUnitStatus.FAILED,
            outcome_code: AsyncOutcomeCode.UNHANDLED_EXCEPTION,
            last_error: error,
            lease_token: null,
            lease_expires_at: null,
            update_time: now,
            complete_time: now,
        })
        .where(
            and(
                eq(AsyncTaskUnit.id, unitId),
                eq(AsyncTaskUnit.lease_token, leaseToken),
                eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING),
            ),
        );
}

export async function reconcileTask(taskId: string, transaction?: Transaction): Promise<boolean> {
    if (transaction) {
        return reconcileTaskInTransaction(transaction, taskId);
    }

    try {
        return await db.transaction((tx) => reconcileTaskInTransaction(tx, taskId));
    } catch (error) {
        const message = `Task finalization failed: ${getErrorMessage(error)}`;
        console.error(`[JobStore] ${message} (${taskId})`);
        try {
            await db
                .update(AsyncTask)
                .set({ last_error: message, update_time: Temporal.Now.instant() })
                .where(
                    and(
                        eq(AsyncTask.id, taskId),
                        inArray(AsyncTask.status, [AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING, AsyncTaskStatus.PAUSED]),
                    ),
                );
        } catch (updateError) {
            console.error(`[JobStore] Failed to persist finalization error for task ${taskId}:`, updateError);
        }
        return false;
    }
}

export async function pauseTask(taskId: string): Promise<boolean> {
    const updated = await db
        .update(AsyncTask)
        .set({
            status: AsyncTaskStatus.PAUSED,
            control_requested: AsyncTaskControl.PAUSE,
            update_time: Temporal.Now.instant(),
        })
        .where(and(eq(AsyncTask.id, taskId), eq(AsyncTask.status, AsyncTaskStatus.RUNNING)))
        .returning({ id: AsyncTask.id });

    return updated.length > 0;
}

export async function resumeTask(taskId: string): Promise<boolean> {
    const result = await db.transaction(async (tx) => {
        const tasks = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, taskId)).for("update").limit(1);
        const task = tasks[0];
        if (!task || task.status !== AsyncTaskStatus.PAUSED) return null;

        const status = task.discovery_complete ? AsyncTaskStatus.RUNNING : AsyncTaskStatus.DISCOVERING;
        await tx
            .update(AsyncTask)
            .set({ status, control_requested: AsyncTaskControl.NONE, update_time: Temporal.Now.instant() })
            .where(eq(AsyncTask.id, taskId));
        return { discoveryComplete: task.discovery_complete };
    });

    if (!result) return false;
    if (result.discoveryComplete) {
        notifyJobsAvailable();
    } else {
        triggerTaskDiscoveryWorkflow(taskId);
    }
    return true;
}

export async function cancelTask(taskId: string): Promise<boolean> {
    const now = Temporal.Now.instant();
    return db.transaction(async (tx) => {
        const tasks = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, taskId)).for("update").limit(1);
        const task = tasks[0];
        if (!task || ![AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING, AsyncTaskStatus.PAUSED].includes(task.status)) {
            return false;
        }

        const cancelledUnits = await tx
            .update(AsyncTaskUnit)
            .set({
                status: AsyncTaskUnitStatus.CANCELLED,
                outcome_code: AsyncOutcomeCode.CANCELLED_BY_USER,
                lease_token: null,
                lease_expires_at: null,
                update_time: now,
                complete_time: now,
            })
            .where(
                and(
                    eq(AsyncTaskUnit.task_id, taskId),
                    inArray(AsyncTaskUnit.status, [AsyncTaskUnitStatus.PENDING, AsyncTaskUnitStatus.RUNNING]),
                ),
            )
            .returning({ id: AsyncTaskUnit.id });

        await tx
            .update(AsyncTask)
            .set({
                status: AsyncTaskStatus.CANCELLED,
                control_requested: AsyncTaskControl.CANCEL,
                discovery_lease_token: null,
                discovery_lease_expires_at: null,
                cancelled_units: task.cancelled_units + cancelledUnits.length,
                update_time: now,
                complete_time: now,
            })
            .where(eq(AsyncTask.id, taskId));

        return true;
    });
}

export async function retryFailedUnits(taskId: string): Promise<number> {
    const now = Temporal.Now.instant();
    const resetCount = await db.transaction(async (tx) => {
        const tasks = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, taskId)).for("update").limit(1);
        const task = tasks[0];
        if (!task || task.status !== AsyncTaskStatus.FAILED) return 0;

        const resetUnits = await tx
            .update(AsyncTaskUnit)
            .set({
                status: AsyncTaskUnitStatus.PENDING,
                outcome_code: null,
                last_error: null,
                available_at: now,
                lease_token: null,
                lease_expires_at: null,
                attempt_count: 0,
                update_time: now,
                complete_time: null,
            })
            .where(and(eq(AsyncTaskUnit.task_id, taskId), eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.FAILED)))
            .returning({ id: AsyncTaskUnit.id });

        if (resetUnits.length === 0) return 0;

        await tx
            .update(AsyncTask)
            .set({
                status: AsyncTaskStatus.RUNNING,
                control_requested: AsyncTaskControl.NONE,
                failed_units: Math.max(0, task.failed_units - resetUnits.length),
                last_error: null,
                update_time: now,
                complete_time: null,
            })
            .where(eq(AsyncTask.id, taskId));

        return resetUnits.length;
    });

    if (resetCount > 0) notifyJobsAvailable();
    return resetCount;
}
