import { Hono } from "hono";
import { db } from "@/global/db";
import { AsyncTask, AsyncTaskStatus, AsyncTaskUnit, AsyncTaskUnitStatus } from "@/db/schema";
import { eq, and, desc, count } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import { JobManager } from "@/infra/jobs/manager";

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
        .orderBy(desc(AsyncTaskUnit.create_time))
        .limit(limit)
        .offset(offset);

    const totalPages = Math.ceil(total / limit);

    return c.json(
        success(Code.SUCCESS, {
            items: units,
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
