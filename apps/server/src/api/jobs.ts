import { Hono } from "hono";
import { db } from "@/global/db";
import { AsyncTask, AsyncTaskStatus, AsyncTaskType, AsyncTaskUnit, AsyncTaskUnitStatus, DeleteStatus, Library } from "@/db/schema";
import { eq, and, asc, desc, count, sql } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import * as v from "valibot";
import { validate } from "@/lib/validation/validator";
import { JobManager } from "@/infra/jobs/manager";
import { parseQueueName } from "@/infra/queue/pipelines";
import { listFailures, pipelineStatus, retryFailures } from "@/infra/queue/status";

export const jobsApp = new Hono<AuthEnv>();

async function checkTaskAccess(userId: string, task: typeof AsyncTask.$inferSelect): Promise<boolean> {
    if (task.owner_id === userId) return true;
    if (task.library_id) {
        const lib = await db.query.Library.findFirst({
            where: { id: task.library_id },
            columns: { owner_id: true },
        });
        return lib?.owner_id === userId;
    }
    return false;
}

// -----------------------------------------------------------------------------
// STATIC ROUTES FIRST (Must be placed before /:id to prevent route hijacking)
// -----------------------------------------------------------------------------

async function ownedLibraries(userId: string, libraryId?: string) {
    const conditions = [eq(Library.owner_id, userId), eq(Library.delete_status, DeleteStatus.ACTIVE)];
    if (libraryId) conditions.push(eq(Library.id, libraryId));
    return db
        .select({ id: Library.id, name: Library.name })
        .from(Library)
        .where(and(...conditions))
        .orderBy(asc(Library.name));
}

/** Resolves `:library_id/:pipeline` to an owned library and a known (non-scan) pipeline. */
async function resolvePipelineParams(userId: string, libraryId: string, pipelineParam: string) {
    const name = parseQueueName(pipelineParam);
    if (!name || name.scan) return null;
    const [library] = await ownedLibraries(userId, libraryId);
    return library ? { library, pipeline: name.pipeline } : null;
}

const PipelinesQuerySchema = v.object({
    library_id: v.optional(v.pipe(v.string(), v.uuid("Invalid library ID format"))),
});

const PipelineParamSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
    pipeline: v.string(),
});

const FailuresQuerySchema = v.object({
    limit: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(200)), "50"),
});

// GET /api/jobs/pipelines - Per library and pipeline: queued, running, retrying and failed subjects
jobsApp.get("/pipelines", requireAuth, validate("query", PipelinesQuerySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const libraries = await ownedLibraries(user.id, c.req.valid("query").library_id);
    const status = await pipelineStatus(libraries.map((library) => library.id));
    return c.json(
        success(Code.SUCCESS, {
            libraries: libraries.map((library) => ({
                library_id: library.id,
                name: library.name,
                pipelines: status.get(library.id) ?? [],
            })),
        }),
    );
});

// GET /api/jobs/pipelines/:library_id/:pipeline/failures - Subjects whose failure still applies
jobsApp.get(
    "/pipelines/:library_id/:pipeline/failures",
    requireAuth,
    validate("param", PipelineParamSchema),
    validate("query", FailuresQuerySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

        const params = c.req.valid("param");
        const target = await resolvePipelineParams(user.id, params.library_id, params.pipeline);
        if (!target) return c.json(error(Code.NOT_FOUND, "Library or pipeline not found"), 404);

        const failures = await listFailures(target.library.id, target.pipeline, Number(c.req.valid("query").limit));
        return c.json(
            success(Code.SUCCESS, {
                items: failures.map((failure) => ({
                    subject_id: failure.subjectId,
                    label: failure.label,
                    error: failure.error,
                    time: failure.time?.toString() ?? null,
                })),
            }),
        );
    },
);

// POST /api/jobs/pipelines/:library_id/:pipeline/retry-failed - Queue every current failure again
jobsApp.post("/pipelines/:library_id/:pipeline/retry-failed", requireAuth, validate("param", PipelineParamSchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const params = c.req.valid("param");
    const target = await resolvePipelineParams(user.id, params.library_id, params.pipeline);
    if (!target) return c.json(error(Code.NOT_FOUND, "Library or pipeline not found"), 404);

    const retried = await retryFailures(target.library.id, target.pipeline);
    return c.json(success(Code.SUCCESS, { retried }));
});

// GET /api/jobs/list - Paginated master tasks list
jobsApp.get("/list", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
    const statusFilter = c.req.query("status");
    const typeFilter = c.req.query("type");
    const offset = (page - 1) * limit;

    const conditions = [];
    if (
        statusFilter &&
        statusFilter !== "ALL" &&
        statusFilter !== "undefined" &&
        Object.values(AsyncTaskStatus).includes(statusFilter as AsyncTaskStatus)
    ) {
        conditions.push(eq(AsyncTask.status, statusFilter as AsyncTaskStatus));
    }
    if (
        typeFilter &&
        typeFilter !== "ALL" &&
        typeFilter !== "undefined" &&
        Object.values(AsyncTaskType).includes(typeFilter as AsyncTaskType)
    ) {
        conditions.push(eq(AsyncTask.type, typeFilter as AsyncTaskType));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const totalResult = await db.select({ count: count() }).from(AsyncTask).where(whereClause);

    const total = Number(totalResult[0]?.count || 0);

    const tasks = await db.select().from(AsyncTask).where(whereClause).orderBy(desc(AsyncTask.update_time)).limit(limit).offset(offset);

    const formattedTasks = tasks.map((task) => {
        const processedUnits = task.succeeded_units + task.failed_units + task.cancelled_units;
        const isTerminal = [AsyncTaskStatus.COMPLETED, AsyncTaskStatus.FAILED, AsyncTaskStatus.CANCELLED].includes(task.status);
        const percentage =
            task.total_units > 0 ? Math.min(100, Math.floor((processedUnits / task.total_units) * 100)) : isTerminal ? 100 : 0;

        return {
            ...task,
            progress: {
                total_units: task.total_units,
                succeeded_units: task.succeeded_units,
                failed_units: task.failed_units,
                cancelled_units: task.cancelled_units,
                processed_units: processedUnits,
                percentage,
            },
        };
    });

    const totalPages = Math.ceil(total / limit);

    return c.json(
        success(Code.SUCCESS, {
            items: formattedTasks,
            pagination: {
                page,
                limit,
                total,
                total_pages: totalPages,
                has_more: page < totalPages,
            },
        }),
    );
});

// GET /api/jobs/stats - Aggregate queue health metrics & status counts
jobsApp.get("/stats", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const [tasksSummary] = await db.select({ total: count() }).from(AsyncTask);
    const [runningTasks] = await db.select({ count: count() }).from(AsyncTask).where(eq(AsyncTask.status, AsyncTaskStatus.RUNNING));
    const [failedTasks] = await db.select({ count: count() }).from(AsyncTask).where(eq(AsyncTask.status, AsyncTaskStatus.FAILED));
    const [completedTasks] = await db.select({ count: count() }).from(AsyncTask).where(eq(AsyncTask.status, AsyncTaskStatus.COMPLETED));

    const [unitsSummary] = await db.select({ total: count() }).from(AsyncTaskUnit);
    const [runningUnits] = await db
        .select({ count: count() })
        .from(AsyncTaskUnit)
        .where(eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.RUNNING));
    const [pendingUnits] = await db
        .select({ count: count() })
        .from(AsyncTaskUnit)
        .where(eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.PENDING));
    const [succeededUnits] = await db
        .select({ count: count() })
        .from(AsyncTaskUnit)
        .where(eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.SUCCEEDED));
    const [failedUnits] = await db
        .select({ count: count() })
        .from(AsyncTaskUnit)
        .where(eq(AsyncTaskUnit.status, AsyncTaskUnitStatus.FAILED));

    return c.json(
        success(Code.SUCCESS, {
            tasks: {
                total: Number(tasksSummary?.total || 0),
                running: Number(runningTasks?.count || 0),
                failed: Number(failedTasks?.count || 0),
                completed: Number(completedTasks?.count || 0),
            },
            units: {
                total: Number(unitsSummary?.total || 0),
                running: Number(runningUnits?.count || 0),
                pending: Number(pendingUnits?.count || 0),
                succeeded: Number(succeededUnits?.count || 0),
                failed: Number(failedUnits?.count || 0),
            },
        }),
    );
});

// GET /api/jobs/units - Global task units list (filterable by status, task_type)
jobsApp.get("/units", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
    const statusFilter = c.req.query("status");
    const taskTypeFilter = c.req.query("task_type");
    const offset = (page - 1) * limit;

    const conditions = [];
    if (
        statusFilter &&
        statusFilter !== "ALL" &&
        statusFilter !== "undefined" &&
        Object.values(AsyncTaskUnitStatus).includes(statusFilter as AsyncTaskUnitStatus)
    ) {
        conditions.push(eq(AsyncTaskUnit.status, statusFilter as AsyncTaskUnitStatus));
    }
    if (
        taskTypeFilter &&
        taskTypeFilter !== "ALL" &&
        taskTypeFilter !== "undefined" &&
        Object.values(AsyncTaskType).includes(taskTypeFilter as AsyncTaskType)
    ) {
        conditions.push(eq(AsyncTask.type, taskTypeFilter as AsyncTaskType));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const totalResult = await db
        .select({ count: count() })
        .from(AsyncTaskUnit)
        .innerJoin(AsyncTask, eq(AsyncTaskUnit.task_id, AsyncTask.id))
        .where(whereClause);

    const total = Number(totalResult[0]?.count || 0);

    const items = await db
        .select({
            id: AsyncTaskUnit.id,
            task_id: AsyncTaskUnit.task_id,
            task_type: AsyncTask.type,
            unit_key: AsyncTaskUnit.unit_key,
            kind: AsyncTaskUnit.kind,
            subject_type: AsyncTaskUnit.subject_type,
            subject_id: AsyncTaskUnit.subject_id,
            status: AsyncTaskUnit.status,
            outcome_code: AsyncTaskUnit.outcome_code,
            attempt_count: AsyncTaskUnit.attempt_count,
            max_attempts: AsyncTaskUnit.max_attempts,
            last_error: AsyncTaskUnit.last_error,
            input_snapshot: AsyncTask.input_snapshot,
            create_time: AsyncTaskUnit.create_time,
            update_time: AsyncTaskUnit.update_time,
            complete_time: AsyncTaskUnit.complete_time,
        })
        .from(AsyncTaskUnit)
        .innerJoin(AsyncTask, eq(AsyncTaskUnit.task_id, AsyncTask.id))
        .where(whereClause)
        .orderBy(desc(AsyncTaskUnit.update_time))
        .limit(limit)
        .offset(offset);

    const totalPages = Math.ceil(total / limit);

    return c.json(
        success(Code.SUCCESS, {
            items,
            pagination: {
                page,
                limit,
                total,
                total_pages: totalPages,
                has_more: page < totalPages,
            },
        }),
    );
});

// POST /api/jobs/units/batch-retry - Bulk units re-enqueue
jobsApp.post("/units/batch-retry", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    let body: { unit_ids?: string[]; task_ids?: string[] } = {};
    try {
        body = await c.req.json();
    } catch {
        // Optional body
    }

    const resetCount = await JobManager.batchRetryFailedUnits({
        unitIds: body.unit_ids,
        taskIds: body.task_ids,
    });

    return c.json(success(Code.SUCCESS, { retried_count: resetCount }));
});

// POST /api/jobs/units/:id/retry - Single unit re-enqueue
jobsApp.post("/units/:id/retry", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const id = c.req.param("id");
    if (!id) return c.json(error(Code.INVALID_PARAMETER, "Unit id is required"), 400);

    const retried = await JobManager.retrySingleFailedUnit(id);
    if (!retried) {
        return c.json(error(Code.INVALID_PARAMETER, "Unit not found or not in FAILED state"), 409);
    }

    return c.json(success(Code.SUCCESS, { status: AsyncTaskUnitStatus.PENDING, unit_id: id }));
});

// POST /api/jobs/batch-pause - Bulk pause selected tasks
jobsApp.post("/batch-pause", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const body: { task_ids?: string[] } = await c.req.json().catch(() => ({}));
    const taskIds = body.task_ids || [];
    let count = 0;
    for (const taskId of taskIds) {
        if (await JobManager.pauseTask(taskId)) count++;
    }
    return c.json(success(Code.SUCCESS, { count }));
});

// POST /api/jobs/batch-resume - Bulk resume selected tasks
jobsApp.post("/batch-resume", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const body: { task_ids?: string[] } = await c.req.json().catch(() => ({}));
    const taskIds = body.task_ids || [];
    let count = 0;
    for (const taskId of taskIds) {
        if (await JobManager.resumeTask(taskId)) count++;
    }
    return c.json(success(Code.SUCCESS, { count }));
});

// POST /api/jobs/batch-cancel - Bulk cancel selected tasks
jobsApp.post("/batch-cancel", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const body: { task_ids?: string[] } = await c.req.json().catch(() => ({}));
    const taskIds = body.task_ids || [];
    let count = 0;
    for (const taskId of taskIds) {
        if (await JobManager.cancelTask(taskId)) count++;
    }
    return c.json(success(Code.SUCCESS, { count }));
});

// -----------------------------------------------------------------------------
// PARAMETERIZED ROUTE HANDLERS (Placed AFTER static routes)
// -----------------------------------------------------------------------------

// POST /api/jobs/:id/pause
jobsApp.post("/:id/pause", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const id = c.req.param("id");
    if (!id) return c.json(error(Code.INVALID_PARAMETER, "Task id is required"), 400);

    const task = await db.query.AsyncTask.findFirst({
        where: { id },
    });
    if (!task) return c.json(error(Code.NOT_FOUND, "Task not found"), 404);

    const isAuthorized = await checkTaskAccess(user.id, task);
    if (!isAuthorized) return c.json(error(Code.UNAUTHORIZED, "Forbidden access to background task"), 403);

    const paused = await JobManager.pauseTask(id);
    if (!paused) {
        return c.json(error(Code.INVALID_PARAMETER, `Task cannot be paused from status '${task.status}'`), 409);
    }
    return c.json(success(Code.SUCCESS, { status: AsyncTaskStatus.PAUSED }));
});

// POST /api/jobs/:id/resume
jobsApp.post("/:id/resume", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const id = c.req.param("id");
    if (!id) return c.json(error(Code.INVALID_PARAMETER, "Task id is required"), 400);

    const task = await db.query.AsyncTask.findFirst({
        where: { id },
    });
    if (!task) return c.json(error(Code.NOT_FOUND, "Task not found"), 404);

    const isAuthorized = await checkTaskAccess(user.id, task);
    if (!isAuthorized) return c.json(error(Code.UNAUTHORIZED, "Forbidden access to background task"), 403);

    const resumed = await JobManager.resumeTask(id);
    if (!resumed) {
        return c.json(error(Code.INVALID_PARAMETER, `Task cannot be resumed from status '${task.status}'`), 409);
    }
    return c.json(success(Code.SUCCESS, { status: AsyncTaskStatus.RUNNING }));
});

// POST /api/jobs/:id/cancel
jobsApp.post("/:id/cancel", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const id = c.req.param("id");
    if (!id) return c.json(error(Code.INVALID_PARAMETER, "Task id is required"), 400);

    const task = await db.query.AsyncTask.findFirst({
        where: { id },
    });
    if (!task) return c.json(error(Code.NOT_FOUND, "Task not found"), 404);

    const isAuthorized = await checkTaskAccess(user.id, task);
    if (!isAuthorized) return c.json(error(Code.UNAUTHORIZED, "Forbidden access to background task"), 403);

    const cancelled = await JobManager.cancelTask(id);
    if (!cancelled) {
        return c.json(error(Code.INVALID_PARAMETER, `Task cannot be cancelled from status '${task.status}'`), 409);
    }
    return c.json(success(Code.SUCCESS, { status: AsyncTaskStatus.CANCELLED }));
});

// POST /api/jobs/:id/retry-failed
jobsApp.post("/:id/retry-failed", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const id = c.req.param("id");
    if (!id) return c.json(error(Code.INVALID_PARAMETER, "Task id is required"), 400);

    const task = await db.query.AsyncTask.findFirst({
        where: { id },
    });
    if (!task) return c.json(error(Code.NOT_FOUND, "Task not found"), 404);

    const isAuthorized = await checkTaskAccess(user.id, task);
    if (!isAuthorized) return c.json(error(Code.UNAUTHORIZED, "Forbidden access to background task"), 403);

    const retriedCount = await JobManager.retryFailedUnits(id);
    if (retriedCount === 0) {
        return c.json(error(Code.INVALID_PARAMETER, "Task has no retryable failed units"), 409);
    }
    return c.json(success(Code.SUCCESS, { status: AsyncTaskStatus.RUNNING, retried_count: retriedCount }));
});

// GET /api/jobs/:id/items - Task units paginated list with optional status filter
jobsApp.get("/:id/items", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const id = c.req.param("id");
    if (!id) return c.json(error(Code.INVALID_PARAMETER, "Task id is required"), 400);

    const task = await db.query.AsyncTask.findFirst({
        where: { id },
    });
    if (!task) return c.json(error(Code.NOT_FOUND, "Task not found"), 404);

    const isAuthorized = await checkTaskAccess(user.id, task);
    if (!isAuthorized) return c.json(error(Code.UNAUTHORIZED, "Forbidden access to background task"), 403);

    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
    const statusFilter = c.req.query("status") as AsyncTaskUnitStatus | undefined;
    const offset = (page - 1) * limit;

    const conditions = [eq(AsyncTaskUnit.task_id, id)];
    if (statusFilter && Object.values(AsyncTaskUnitStatus).includes(statusFilter)) {
        conditions.push(eq(AsyncTaskUnit.status, statusFilter));
    }

    const totalResult = await db
        .select({ count: count() })
        .from(AsyncTaskUnit)
        .where(and(...conditions));

    const total = Number(totalResult[0]?.count || 0);

    // Status distribution of the whole task, so the UI can render accurate filter counts.
    const statusRows = await db
        .select({ status: AsyncTaskUnit.status, count: count() })
        .from(AsyncTaskUnit)
        .where(eq(AsyncTaskUnit.task_id, id))
        .groupBy(AsyncTaskUnit.status);

    const counts: Record<string, number> = {};
    for (const row of statusRows) {
        counts[row.status] = Number(row.count || 0);
    }

    const units = await db
        .select({
            id: AsyncTaskUnit.id,
            task_id: AsyncTaskUnit.task_id,
            unit_key: AsyncTaskUnit.unit_key,
            kind: AsyncTaskUnit.kind,
            subject_type: AsyncTaskUnit.subject_type,
            subject_id: AsyncTaskUnit.subject_id,
            status: AsyncTaskUnit.status,
            outcome_code: AsyncTaskUnit.outcome_code,
            attempt_count: AsyncTaskUnit.attempt_count,
            max_attempts: AsyncTaskUnit.max_attempts,
            last_error: AsyncTaskUnit.last_error,
            create_time: AsyncTaskUnit.create_time,
            complete_time: AsyncTaskUnit.complete_time,
        })
        .from(AsyncTaskUnit)
        .where(and(...conditions))
        // Failures surface first, then live work, then quiet outcomes.
        .orderBy(
            sql`case ${AsyncTaskUnit.status}
                when ${AsyncTaskUnitStatus.FAILED} then 0
                when ${AsyncTaskUnitStatus.RUNNING} then 1
                when ${AsyncTaskUnitStatus.PENDING} then 2
                when ${AsyncTaskUnitStatus.SUCCEEDED} then 3
                else 4
            end`,
            desc(AsyncTaskUnit.update_time),
        )
        .limit(limit)
        .offset(offset);

    const totalPages = Math.ceil(total / limit);

    return c.json(
        success(Code.SUCCESS, {
            items: units,
            counts,
            pagination: {
                page,
                limit,
                total,
                total_pages: totalPages,
                has_more: page < totalPages,
            },
        }),
    );
});

// GET /api/jobs/:id - Master task status & progress detail
jobsApp.get("/:id", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const id = c.req.param("id");
    if (!id) return c.json(error(Code.INVALID_PARAMETER, "Task id is required"), 400);

    const task = await db.query.AsyncTask.findFirst({
        where: { id },
    });
    if (!task) return c.json(error(Code.NOT_FOUND, "Background task not found"), 404);

    const isAuthorized = await checkTaskAccess(user.id, task);
    if (!isAuthorized) return c.json(error(Code.UNAUTHORIZED, "Forbidden access to background task"), 403);

    const processedUnits = task.succeeded_units + task.failed_units + task.cancelled_units;
    const isTerminal = [AsyncTaskStatus.COMPLETED, AsyncTaskStatus.FAILED, AsyncTaskStatus.CANCELLED].includes(task.status);
    const percentage = task.total_units > 0 ? Math.min(100, Math.floor((processedUnits / task.total_units) * 100)) : isTerminal ? 100 : 0;

    return c.json(
        success(Code.SUCCESS, {
            id: task.id,
            type: task.type,
            status: task.status,
            library_id: task.library_id,
            owner_id: task.owner_id,
            config_version: task.config_version,
            control_requested: task.control_requested,
            discovery_complete: task.discovery_complete,
            input_snapshot: task.input_snapshot,
            total_units: task.total_units,
            succeeded_units: task.succeeded_units,
            failed_units: task.failed_units,
            cancelled_units: task.cancelled_units,
            progress: {
                total_units: task.total_units,
                succeeded_units: task.succeeded_units,
                failed_units: task.failed_units,
                cancelled_units: task.cancelled_units,
                processed_units: processedUnits,
                percentage,
            },
            last_error: task.last_error,
            create_time: task.create_time,
            update_time: task.update_time,
            complete_time: task.complete_time,
        }),
    );
});
