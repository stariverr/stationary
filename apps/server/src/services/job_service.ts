import { db } from "@/global/db";
import {
    AsyncTask,
    AsyncTaskUnit,
    AsyncTaskStatus,
    AsyncTaskControl,
    AsyncTaskUnitStatus,
    AsyncTaskType,
    AsyncOutcomeCode,
} from "@/db/schema";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { Temporal } from "@js-temporal/polyfill";
import { env } from "@/global/env";
import { Client } from "@upstash/workflow";
import { v7 as uuidv7 } from "uuid";

import type { TaskHandler, TaskUnitContext, TaskResult, DiscoveredUnitSpec } from "@/services/job_types";
export type { TaskHandler, TaskUnitContext, TaskResult, DiscoveredUnitSpec };

/** Registry map for decoupled task handler strategy instances */
const taskHandlers = new Map<string, TaskHandler>();

/**
 * Register a TaskHandler strategy for a specific AsyncTaskType.
 *
 * @param type The unique task type string (e.g. COVER_BATCH, COVER_RECONCILE)
 * @param handler The strategy implementation conforming to TaskHandler interface
 */
export function registerTaskHandler(type: string, handler: TaskHandler) {
    taskHandlers.set(type, handler);
}

/**
 * Retrieve a registered TaskHandler strategy instance by task type.
 *
 * @param type The task type identifier
 */
export function getTaskHandler(type: string): TaskHandler | undefined {
    return taskHandlers.get(type);
}

/**
 * Check whether a URL points to local host environment.
 */
function isLocalUrl(urlStr?: string): boolean {
    if (!urlStr) return true;
    try {
        const u = new URL(urlStr);
        return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0" || u.hostname.endsWith(".local");
    } catch {
        return true;
    }
}

/**
 * Core asynchronous background Task & Unit Management Engine.
 * Responsible for task lifecycle orchestration, batch unit discovery,
 * concurrency-bounded dispatching, fencing lease verification, and retries.
 */
export const TaskManager = {
    /**
     * Create a new master AsyncTask record and trigger initial unit discovery workflow.
     *
     * @param params Parameters required to initialize an AsyncTask
     * @returns The created (or idempotent existing) AsyncTask record
     */
    async createTask(params: {
        type: AsyncTaskType;
        libraryId?: string | null;
        ownerId?: string | null;
        inputSnapshot?: Record<string, unknown>;
        configVersion?: number;
        maxConcurrency?: number;
        idempotencyKey?: string | null;
        originUrl?: string;
    }): Promise<typeof AsyncTask.$inferSelect> {
        const now = Temporal.Now.instant();

        // 1. Check idempotency key for active duplicate tasks
        if (params.idempotencyKey) {
            const existing = await db.select().from(AsyncTask).where(eq(AsyncTask.idempotency_key, params.idempotencyKey)).limit(1);
            if (
                existing[0] &&
                existing[0].status !== AsyncTaskStatus.COMPLETED &&
                existing[0].status !== AsyncTaskStatus.CANCELLED &&
                existing[0].status !== AsyncTaskStatus.FAILED
            ) {
                return existing[0];
            }
        }

        // 2. Insert new master AsyncTask record
        const task = await db.transaction(async (tx) => {
            const insertResult = await tx
                .insert(AsyncTask)
                .values({
                    type: params.type,
                    status: AsyncTaskStatus.DISCOVERING,
                    library_id: params.libraryId || null,
                    owner_id: params.ownerId || null,
                    input_snapshot: params.inputSnapshot || {},
                    config_version: params.configVersion || 1,
                    discovery_cursor: null,
                    discovery_complete: false,
                    total_units: 0,
                    succeeded_units: 0,
                    failed_units: 0,
                    cancelled_units: 0,
                    control_requested: AsyncTaskControl.NONE,
                    max_in_flight: params.maxConcurrency || 5,
                    idempotency_key: params.idempotencyKey || null,
                    create_time: now,
                    update_time: now,
                })
                .returning();

            return insertResult[0];
        });

        // 3. Trigger initial async discovery workflow
        await this.triggerTaskDiscoveryWorkflow(task.id, params.originUrl);
        return task;
    },

    /**
     * Discover a batch of child AsyncTaskUnit work items using the registered TaskHandler strategy.
     * Supports incremental cursor-based discovery and physical deduplication via `onConflictDoNothing()`.
     *
     * @param taskId Master task UUID
     * @param batchSize Maximum number of units to discover in single iteration
     * @returns Boolean indicating whether there are more units remaining to be discovered
     */
    async discoverTaskBatch(taskId: string, batchSize = 100): Promise<boolean> {
        const tasks = await db.select().from(AsyncTask).where(eq(AsyncTask.id, taskId)).limit(1);
        const task = tasks[0];
        if (!task || task.discovery_complete || task.status === AsyncTaskStatus.CANCELLED) {
            return false;
        }

        const handler = getTaskHandler(task.type);
        if (!handler || !handler.discoverUnits) {
            await db
                .update(AsyncTask)
                .set({
                    discovery_complete: true,
                    status: AsyncTaskStatus.RUNNING,
                    update_time: Temporal.Now.instant(),
                })
                .where(eq(AsyncTask.id, taskId));
            return false;
        }

        const now = Temporal.Now.instant();
        const cursorPayload = task.discovery_cursor;
        const discovery = await handler.discoverUnits(task, cursorPayload, batchSize);

        // Handle case where no units were found and discovery reached the end
        if (discovery.units.length === 0 && !discovery.hasMore) {
            await db
                .update(AsyncTask)
                .set({
                    discovery_complete: true,
                    status: task.total_units === 0 ? AsyncTaskStatus.COMPLETED : AsyncTaskStatus.RUNNING,
                    update_time: now,
                    complete_time: task.total_units === 0 ? now : null,
                })
                .where(eq(AsyncTask.id, taskId));
            return false;
        }

        let newDiscoveredCount = 0;
        let newSucceededCount = 0;

        const isComplete = !discovery.hasMore;

        // Execute unit creation and task cursor/counter updates in a single transaction
        await db.transaction(async (tx) => {
            if (discovery.units.length > 0) {
                const unitsToInsert = discovery.units.map((unitSpec) => {
                    const isCompleted = !!unitSpec.isAlreadyCompleted;
                    return {
                        task_id: taskId,
                        kind: unitSpec.kind,
                        subject_type: unitSpec.subjectType,
                        subject_id: unitSpec.subjectId,
                        unit_key: unitSpec.unitKey,
                        spec_hash: unitSpec.specHash || "",
                        status: isCompleted ? AsyncTaskUnitStatus.SUCCEEDED : AsyncTaskUnitStatus.PENDING,
                        outcome_code: isCompleted ? AsyncOutcomeCode.SKIPPED : null,
                        available_at: now,
                        input_snapshot: unitSpec.inputSnapshot || {},
                        result_ref: unitSpec.existingResultRef || null,
                        create_time: now,
                        update_time: now,
                        complete_time: isCompleted ? now : null,
                    };
                });

                const insertedUnits = await tx.insert(AsyncTaskUnit).values(unitsToInsert).onConflictDoNothing().returning({
                    status: AsyncTaskUnit.status,
                });

                newDiscoveredCount = insertedUnits.length;
                newSucceededCount = insertedUnits.filter((u) => u.status === AsyncTaskUnitStatus.SUCCEEDED).length;
            }

            await tx
                .update(AsyncTask)
                .set({
                    discovery_cursor: discovery.nextCursor,
                    discovery_complete: isComplete,
                    total_units: sql`${AsyncTask.total_units} + ${newDiscoveredCount}`,
                    succeeded_units: sql`${AsyncTask.succeeded_units} + ${newSucceededCount}`,
                    status: AsyncTaskStatus.RUNNING,
                    update_time: now,
                })
                .where(eq(AsyncTask.id, taskId));
        });

        // Immediately attempt dispatching candidate PENDING units
        await this.dispatchTaskUnits(taskId);
        return discovery.hasMore;
    },

    /**
     * Dispatch PENDING units for execution respecting the task's `max_in_flight` concurrency limit.
     * Employs DB pessimistic locking (`FOR UPDATE SKIP LOCKED`) to issue 120s fencing lease tokens safely across workers.
     *
     * @param taskId Master task UUID
     * @param originUrl Optional base URL for workflow callback dispatching
     * @returns Number of units successfully claimed and dispatched
     */
    async dispatchTaskUnits(taskId: string, originUrl?: string): Promise<number> {
        const now = Temporal.Now.instant();
        const leaseExpiry = now.add({ seconds: 120 });

        const unitsToTrigger: { unitId: string; leaseToken: string; taskId: string }[] = [];

        await db.transaction(async (tx) => {
            const tasks = await tx.select().from(AsyncTask).where(eq(AsyncTask.id, taskId)).limit(1);
            const task = tasks[0];
            if (!task) return 0;

            // 1. Check if user requested task cancellation
            if (task.control_requested === AsyncTaskControl.CANCEL || task.status === AsyncTaskStatus.CANCELLED) {
                if (task.status !== AsyncTaskStatus.CANCELLED) {
                    await tx
                        .update(AsyncTaskUnit)
                        .set({
                            status: AsyncTaskUnitStatus.CANCELLED,
                            outcome_code: AsyncOutcomeCode.CANCELLED_BY_USER,
                            update_time: Temporal.Now.instant(),
                            complete_time: Temporal.Now.instant(),
                        })
                        .where(and(eq(AsyncTaskUnit.task_id, taskId), eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.PENDING)));

                    await tx
                        .update(AsyncTask)
                        .set({
                            status: AsyncTaskStatus.CANCELLED,
                            update_time: Temporal.Now.instant(),
                            complete_time: Temporal.Now.instant(),
                        })
                        .where(eq(AsyncTask.id, taskId));
                }
                return 0;
            }

            // 2. Check if user requested task pause
            if (task.status === AsyncTaskStatus.PAUSED || task.control_requested === AsyncTaskControl.PAUSE) {
                if (task.status !== AsyncTaskStatus.PAUSED) {
                    await tx.update(AsyncTask).set({ status: AsyncTaskStatus.PAUSED, update_time: now }).where(eq(AsyncTask.id, taskId));
                }
                return 0;
            }

            // 3. Evaluate available concurrency slots under max_in_flight threshold
            const runningUnits = await tx
                .select({ id: AsyncTaskUnit.id })
                .from(AsyncTaskUnit)
                .where(and(eq(AsyncTaskUnit.task_id, taskId), eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING)));

            const currentRunning = runningUnits.length;
            const availableCapacity = Math.max(0, task.max_in_flight - currentRunning);
            if (availableCapacity <= 0) return 0;

            // 4. Claim pending candidate units with pessimistic lock (SKIP LOCKED)
            const candidateUnits = await tx
                .select()
                .from(AsyncTaskUnit)
                .where(
                    and(
                        eq(AsyncTaskUnit.task_id, taskId),
                        eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.PENDING),
                        lte(AsyncTaskUnit.available_at, now),
                    ),
                )
                .limit(availableCapacity)
                .for("update", { skipLocked: true });

            let count = 0;
            for (const unit of candidateUnits) {
                const leaseToken = uuidv7();

                const claim = await tx
                    .update(AsyncTaskUnit)
                    .set({
                        status: AsyncTaskUnitStatus.RUNNING,
                        lease_token: leaseToken,
                        lease_expires_at: leaseExpiry,
                        attempt_count: unit.attempt_count + 1,
                        update_time: now,
                    })
                    .where(and(eq(AsyncTaskUnit.id, unit.id), eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.PENDING)))
                    .returning({ id: AsyncTaskUnit.id });

                if (claim.length > 0) {
                    count++;
                    unitsToTrigger.push({ unitId: unit.id, leaseToken, taskId: task.id });
                }
            }
        });

        // 5. Trigger execution workflows asynchronously
        for (const target of unitsToTrigger) {
            await this.triggerUnitWorkflow(target.unitId, target.leaseToken, originUrl);
        }

        return unitsToTrigger.length;
    },

    /**
     * Execute a claimed AsyncTaskUnit with fencing lease verification.
     * Invokes the target TaskHandler strategy, records execution results,
     * and performs exponential backoff retries on transient failures.
     *
     * @param unitId AsyncTaskUnit UUID
     * @param leaseToken Unique fencing token issued during unit claim
     * @returns Execution TaskResult summary
     */
    async executeUnit(unitId: string, leaseToken: string): Promise<TaskResult> {
        const now = Temporal.Now.instant();
        const units = await db.select().from(AsyncTaskUnit).where(eq(AsyncTaskUnit.id, unitId)).limit(1);
        const unit = units[0];

        // 1. Verify fencing lease token and current RUNNING status
        if (!unit || unit.lease_token !== leaseToken || unit.status !== AsyncTaskUnitStatus.RUNNING) {
            return { success: false, error: "Task unit lease expired or invalid fencing token" };
        }

        const tasks = await db.select().from(AsyncTask).where(eq(AsyncTask.id, unit.task_id)).limit(1);
        const task = tasks[0];
        if (!task) {
            return { success: false, error: "Parent task not found" };
        }

        // 2. Check parent task cancellation status
        if (task.status === AsyncTaskStatus.CANCELLED || task.control_requested === AsyncTaskControl.CANCEL) {
            await db
                .update(AsyncTaskUnit)
                .set({
                    status: AsyncTaskUnitStatus.CANCELLED,
                    outcome_code: AsyncOutcomeCode.CANCELLED_BY_USER,
                    lease_token: null,
                    lease_expires_at: null,
                    update_time: now,
                    complete_time: now,
                })
                .where(eq(AsyncTaskUnit.id, unitId));

            await this.checkTaskCompletion(task.id);
            return { success: false, error: "Parent task cancelled" };
        }

        // 3. Locate registered strategy handler
        const handler = getTaskHandler(task.type);
        if (!handler) {
            const errStr = `No registered TaskHandler for type '${task.type}'`;
            await db
                .update(AsyncTaskUnit)
                .set({
                    status: AsyncTaskUnitStatus.FAILED,
                    outcome_code: AsyncOutcomeCode.UNHANDLED_EXCEPTION,
                    last_error: errStr,
                    lease_token: null,
                    lease_expires_at: null,
                    update_time: now,
                    complete_time: now,
                })
                .where(eq(AsyncTaskUnit.id, unitId));

            await db
                .update(AsyncTask)
                .set({
                    failed_units: sql`${AsyncTask.failed_units} + 1`,
                    update_time: now,
                })
                .where(eq(AsyncTask.id, task.id));

            await this.checkTaskCompletion(task.id);
            return { success: false, error: errStr };
        }

        // 4. Construct execution context with heartbeat support and invoke TaskHandler strategy
        const autoHeartbeat = this.startLeaseHeartbeat(unit.id, leaseToken);

        const context: TaskUnitContext = {
            task,
            unit,
            reportProgress: async (_val, _total) => {
                // Progress reporter callback
            },
            renewLease: (extendSeconds) => this.renewUnitLease(unit.id, leaseToken, extendSeconds),
            startHeartbeat: (intervalMs, extendSeconds) => this.startLeaseHeartbeat(unit.id, leaseToken, intervalMs, extendSeconds),
        };

        let result: TaskResult;
        try {
            result = await handler.execute(context);
        } catch (err: any) {
            result = {
                success: false,
                outcomeCode: AsyncOutcomeCode.UNHANDLED_EXCEPTION,
                error: err.message || String(err),
                retryable: true,
            };
        } finally {
            autoHeartbeat.stop();
        }

        // 5. Update unit and parent task status based on result in a single atomic transaction
        await db.transaction(async (tx) => {
            if (result.success || result.skipped) {
                const outcomeCode = result.outcomeCode || (result.skipped ? AsyncOutcomeCode.SKIPPED : AsyncOutcomeCode.EXECUTED);

                await tx
                    .update(AsyncTaskUnit)
                    .set({
                        status: AsyncTaskUnitStatus.SUCCEEDED,
                        outcome_code: outcomeCode,
                        result_ref: (result.data as Record<string, unknown>) || null,
                        lease_token: null,
                        lease_expires_at: null,
                        update_time: now,
                        complete_time: now,
                    })
                    .where(eq(AsyncTaskUnit.id, unitId));

                await tx
                    .update(AsyncTask)
                    .set({
                        succeeded_units: sql`${AsyncTask.succeeded_units} + 1`,
                        update_time: now,
                    })
                    .where(eq(AsyncTask.id, task.id));
            } else {
                const isExhausted = unit.attempt_count >= unit.max_attempts || result.retryable === false;
                const outcomeCode = result.outcomeCode || (isExhausted ? AsyncOutcomeCode.MAX_ATTEMPTS_EXCEEDED : "FAILED");

                if (!isExhausted) {
                    // Calculate exponential backoff delay (min 5s, exponential growth, capped at 300s)
                    const backoffSeconds = Math.min(300, Math.pow(2, unit.attempt_count) * 5);
                    const nextAvailable = now.add({ seconds: backoffSeconds });

                    await tx
                        .update(AsyncTaskUnit)
                        .set({
                            status: AsyncTaskUnitStatus.PENDING,
                            outcome_code: outcomeCode,
                            last_error: result.error || "Execution failed",
                            available_at: nextAvailable,
                            lease_token: null,
                            lease_expires_at: null,
                            update_time: now,
                        })
                        .where(eq(AsyncTaskUnit.id, unitId));
                } else {
                    await tx
                        .update(AsyncTaskUnit)
                        .set({
                            status: AsyncTaskUnitStatus.FAILED,
                            outcome_code: outcomeCode,
                            last_error: result.error || "Execution failed and retries exhausted",
                            lease_token: null,
                            lease_expires_at: null,
                            update_time: now,
                            complete_time: now,
                        })
                        .where(eq(AsyncTaskUnit.id, unitId));

                    await tx
                        .update(AsyncTask)
                        .set({
                            failed_units: sql`${AsyncTask.failed_units} + 1`,
                            update_time: now,
                        })
                        .where(eq(AsyncTask.id, task.id));
                }
            }
        });

        // 6. Check task overall completion & trigger next candidate units
        await this.checkTaskCompletion(task.id);
        await this.dispatchTaskUnits(task.id);

        return result;
    },

    /**
     * Check if all discovered units in an AsyncTask have completed.
     * Updates parent task status to COMPLETED or FAILED once all units are processed.
     *
     * @param taskId Master task UUID
     * @returns True if task reached terminal completion state
     */
    async checkTaskCompletion(taskId: string): Promise<boolean> {
        const tasks = await db.select().from(AsyncTask).where(eq(AsyncTask.id, taskId)).limit(1);
        const task = tasks[0];
        if (
            !task ||
            !task.discovery_complete ||
            task.status === AsyncTaskStatus.CANCELLED ||
            task.status === AsyncTaskStatus.COMPLETED ||
            task.status === AsyncTaskStatus.FAILED
        ) {
            return false;
        }

        const processed = task.succeeded_units + task.failed_units + task.cancelled_units;
        if (processed >= task.total_units) {
            const now = Temporal.Now.instant();
            const finalStatus = task.failed_units > 0 && task.succeeded_units === 0 ? AsyncTaskStatus.FAILED : AsyncTaskStatus.COMPLETED;

            const res = await db
                .update(AsyncTask)
                .set({
                    status: finalStatus,
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
            return res.length > 0;
        }
        return false;
    },

    /**
     * Request pause control for an active task.
     *
     * @param taskId Master task UUID
     */
    async pauseTask(taskId: string): Promise<void> {
        await db
            .update(AsyncTask)
            .set({
                control_requested: AsyncTaskControl.PAUSE,
                status: AsyncTaskStatus.PAUSED,
                update_time: Temporal.Now.instant(),
            })
            .where(eq(AsyncTask.id, taskId));
    },

    /**
     * Resume a paused task and trigger unit dispatching.
     *
     * @param taskId Master task UUID
     * @param originUrl Optional base URL for workflow callback dispatching
     */
    async resumeTask(taskId: string, originUrl?: string): Promise<void> {
        await db
            .update(AsyncTask)
            .set({
                control_requested: AsyncTaskControl.NONE,
                status: AsyncTaskStatus.RUNNING,
                update_time: Temporal.Now.instant(),
            })
            .where(eq(AsyncTask.id, taskId));

        await this.dispatchTaskUnits(taskId, originUrl);
    },

    /**
     * Cancel an active task and mark all pending child units as CANCELLED.
     *
     * @param taskId Master task UUID
     */
    async cancelTask(taskId: string): Promise<void> {
        const now = Temporal.Now.instant();

        await db.transaction(async (tx) => {
            await tx
                .update(AsyncTask)
                .set({
                    control_requested: AsyncTaskControl.CANCEL,
                    status: AsyncTaskStatus.CANCELLED,
                    update_time: now,
                    complete_time: now,
                })
                .where(eq(AsyncTask.id, taskId));

            await tx
                .update(AsyncTaskUnit)
                .set({
                    status: AsyncTaskUnitStatus.CANCELLED,
                    outcome_code: AsyncOutcomeCode.CANCELLED_BY_USER,
                    update_time: now,
                    complete_time: now,
                })
                .where(and(eq(AsyncTaskUnit.task_id, taskId), eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.PENDING)));
        });
    },

    /**
     * Reset all FAILED units under a task back to PENDING status for re-execution.
     *
     * @param taskId Master task UUID
     * @param originUrl Optional base URL for workflow callback dispatching
     * @returns Number of failed units reset
     */
    async retryFailedUnits(taskId: string, originUrl?: string): Promise<number> {
        const now = Temporal.Now.instant();
        let resetCount = 0;

        await db.transaction(async (tx) => {
            const updated = await tx
                .update(AsyncTaskUnit)
                .set({
                    status: AsyncTaskUnitStatus.PENDING,
                    attempt_count: 0,
                    last_error: null,
                    available_at: now,
                    update_time: now,
                })
                .where(and(eq(AsyncTaskUnit.task_id, taskId), eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.FAILED)))
                .returning({ id: AsyncTaskUnit.id });

            resetCount = updated.length;

            if (resetCount > 0) {
                await tx
                    .update(AsyncTask)
                    .set({
                        status: AsyncTaskStatus.RUNNING,
                        failed_units: sql`GREATEST(0, ${AsyncTask.failed_units} - ${resetCount})`,
                        update_time: now,
                    })
                    .where(eq(AsyncTask.id, taskId));
            }
        });

        if (resetCount > 0) {
            await this.dispatchTaskUnits(taskId, originUrl);
        }
        return resetCount;
    },

    /**
     * Dispatch discovery workflow execution to QStash or local async event queue.
     */
    async triggerTaskDiscoveryWorkflow(taskId: string, originUrl?: string): Promise<void> {
        if (process.env.NODE_ENV === "test" || !env.QSTASH_TOKEN || isLocalUrl(originUrl)) {
            setTimeout(async () => {
                try {
                    let hasMore = true;
                    while (hasMore) {
                        hasMore = await TaskManager.discoverTaskBatch(taskId);
                    }
                } catch (err) {
                    console.error(`[LOCAL DISCOVERY WORKFLOW ERROR] Task ${taskId}:`, err);
                }
            }, 10);
            return;
        }

        try {
            const client = new Client({ token: env.QSTASH_TOKEN });
            await client.trigger({
                url: `${originUrl}/api/task/workflow-job-discover`,
                body: { jobId: taskId },
            });
        } catch (err) {
            console.error(`[QSTASH TRIGGER DISCOVERY ERROR] Task ${taskId}:`, err);
        }
    },

    /**
     * Dispatch unit execution workflow to QStash or local async event queue.
     */
    async triggerUnitWorkflow(unitId: string, leaseToken: string, originUrl?: string): Promise<void> {
        if (process.env.NODE_ENV === "test" || !env.QSTASH_TOKEN || isLocalUrl(originUrl)) {
            setTimeout(async () => {
                try {
                    await TaskManager.executeUnit(unitId, leaseToken);
                } catch (err) {
                    console.error(`[LOCAL UNIT WORKFLOW ERROR] Unit ${unitId}:`, err);
                }
            }, 10);
            return;
        }

        try {
            const client = new Client({ token: env.QSTASH_TOKEN });
            await client.trigger({
                url: `${originUrl}/api/task/workflow-job-item`,
                body: { itemId: unitId, leaseToken },
            });
        } catch (err) {
            console.error(`[QSTASH TRIGGER UNIT ERROR] Unit ${unitId}:`, err);
        }
    },

    /**
     * Atomically extend the lease expiration timestamp for a running task unit.
     *
     * @param unitId AsyncTaskUnit UUID
     * @param leaseToken Fencing lease token
     * @param extendSeconds Additional lease time to add from current timestamp (default: 60s)
     * @returns True if lease was successfully renewed
     */
    async renewUnitLease(unitId: string, leaseToken: string, extendSeconds = 60): Promise<boolean> {
        const now = Temporal.Now.instant();
        const newExpiration = now.add({ seconds: extendSeconds });

        const res = await db
            .update(AsyncTaskUnit)
            .set({
                lease_expires_at: newExpiration,
                update_time: now,
            })
            .where(
                and(
                    eq(AsyncTaskUnit.id, unitId),
                    eq(AsyncTaskUnit.lease_token, leaseToken),
                    eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING),
                ),
            )
            .returning({ id: AsyncTaskUnit.id });

        return res.length > 0;
    },

    /**
     * Start an automated background heartbeat timer to periodically renew a unit's lease during long executions.
     *
     * @param unitId AsyncTaskUnit UUID
     * @param leaseToken Fencing lease token
     * @param intervalMs Heartbeat interval in milliseconds (default: 20000ms)
     * @param extendSeconds Time extension per heartbeat (default: 60s)
     * @returns Handle object with a stop() method to stop the heartbeat
     */
    startLeaseHeartbeat(unitId: string, leaseToken: string, intervalMs = 20000, extendSeconds = 60): { stop: () => void } {
        const timer = setInterval(() => {
            this.renewUnitLease(unitId, leaseToken, extendSeconds).catch((err) => {
                console.error(`[TaskManager] Heartbeat renewal failed for unit ${unitId}:`, err);
            });
        }, intervalMs);

        return {
            stop: () => clearInterval(timer),
        };
    },
};
