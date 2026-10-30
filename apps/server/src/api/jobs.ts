import { Hono } from "hono";
import { db } from "@/global/db";
import { AsyncTask, AsyncTaskStatus, AsyncTaskUnit, AsyncTaskUnitStatus, DeleteStatus, Library } from "@/db/schema";
import { eq, and, desc, count, sql, inArray, or } from "drizzle-orm";
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

/** The given task ids the user may act on: their own tasks and tasks of libraries they own. */
async function accessibleTaskIds(userId: string, taskIds: readonly string[]): Promise<string[]> {
    if (taskIds.length === 0) return [];
    const rows = await db
        .select({ id: AsyncTask.id })
        .from(AsyncTask)
        .leftJoin(Library, eq(Library.id, AsyncTask.library_id))
        .where(and(inArray(AsyncTask.id, [...taskIds]), or(eq(AsyncTask.owner_id, userId), eq(Library.owner_id, userId))));
    return rows.map((row) => row.id);
}

// -----------------------------------------------------------------------------
// STATIC ROUTES FIRST (Must be placed before /:id to prevent route hijacking)
// -----------------------------------------------------------------------------

async function ownedLibrary(userId: string, libraryId: string) {
    const [library] = await db
        .select({ id: Library.id })
        .from(Library)
        .where(and(eq(Library.id, libraryId), eq(Library.owner_id, userId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
        .limit(1);
    return library ?? null;
}

/** Resolves `:library_id/:pipeline` to an owned library and a known (non-scan) pipeline. */
async function resolvePipelineParams(userId: string, libraryId: string, pipelineParam: string) {
    const name = parseQueueName(pipelineParam);
    if (!name || name.scan) return null;
    const library = await ownedLibrary(userId, libraryId);
    return library ? { library, pipeline: name.pipeline } : null;
}

/** Every jobs listing is scoped to one library the user owns. */
const LibraryQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
});

const PipelineParamSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
    pipeline: v.string(),
});

const FailuresQuerySchema = v.object({
    limit: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(200)), "50"),
});

// GET /api/jobs/pipelines?library_id - Per pipeline of the library: queued, running, retrying and failed subjects
jobsApp.get("/pipelines", requireAuth, validate("query", LibraryQuerySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const library = await ownedLibrary(user.id, c.req.valid("query").library_id);
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);

    const status = await pipelineStatus([library.id]);
    return c.json(success(Code.SUCCESS, { pipelines: status.get(library.id) ?? [] }));
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

// GET /api/jobs/list?library_id - Paginated master tasks of a library
jobsApp.get("/list", requireAuth, validate("query", LibraryQuerySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const library = await ownedLibrary(user.id, c.req.valid("query").library_id);
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);

    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
    const statusFilter = c.req.query("status");
    const offset = (page - 1) * limit;

    const conditions = [eq(AsyncTask.library_id, library.id)];
    if (statusFilter && Object.values(AsyncTaskStatus).includes(statusFilter as AsyncTaskStatus)) {
        conditions.push(eq(AsyncTask.status, statusFilter as AsyncTaskStatus));
    }

    const whereClause = and(...conditions);

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

// GET /api/jobs/stats?library_id - Master task counts of a library, by status
jobsApp.get("/stats", requireAuth, validate("query", LibraryQuerySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const library = await ownedLibrary(user.id, c.req.valid("query").library_id);
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);

    const rows = await db
        .select({ status: AsyncTask.status, count: count() })
        .from(AsyncTask)
        .where(eq(AsyncTask.library_id, library.id))
        .groupBy(AsyncTask.status);

    const statuses = Object.fromEntries(Object.values(AsyncTaskStatus).map((status) => [status, 0])) as Record<AsyncTaskStatus, number>;
    for (const row of rows) statuses[row.status] = Number(row.count);
    const total = rows.reduce((sum, row) => sum + Number(row.count), 0);

    return c.json(success(Code.SUCCESS, { total, statuses }));
});

// POST /api/jobs/units/batch-retry - Bulk units re-enqueue
jobsApp.post("/units/batch-retry", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const body: { task_ids?: string[] } = await c.req.json().catch(() => ({}));
    const taskIds = await accessibleTaskIds(user.id, body.task_ids ?? []);
    const resetCount = await JobManager.batchRetryFailedUnits({ taskIds });

    return c.json(success(Code.SUCCESS, { retried_count: resetCount }));
});

// POST /api/jobs/units/:id/retry - Single unit re-enqueue
jobsApp.post("/units/:id/retry", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const id = c.req.param("id");
    if (!id) return c.json(error(Code.INVALID_PARAMETER, "Unit id is required"), 400);

    const [unit] = await db.select({ task_id: AsyncTaskUnit.task_id }).from(AsyncTaskUnit).where(eq(AsyncTaskUnit.id, id)).limit(1);
    if (!unit || (await accessibleTaskIds(user.id, [unit.task_id])).length === 0) {
        return c.json(error(Code.NOT_FOUND, "Unit not found"), 404);
    }

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
    const taskIds = await accessibleTaskIds(user.id, body.task_ids ?? []);
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
    const taskIds = await accessibleTaskIds(user.id, body.task_ids ?? []);
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
    const taskIds = await accessibleTaskIds(user.id, body.task_ids ?? []);
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
