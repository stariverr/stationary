import { Hono } from "hono";
import { validate } from "@/lib/validation/validator";
import { env } from "@/global/env";

import { IngestPipeline } from "@/features/ingest/pipeline";
import { Code } from "@/lib/code";
import { error, success } from "@/lib/response";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { db } from "@/global/db";
import {
    Library,
    File as DbFile,
    DeleteStatus,
    DraftFile,
    DraftFileStatus,
} from "@/db/schema";
import { eq, and, lt } from "drizzle-orm";

import { JobSweeper } from "@/infra/jobs/sweeper";
import { sweepOrphanTags } from "@/scripts/sweep_orphans";
import { runMediaTrackIntegrityScan } from "@/audit/media-track";
import { s3 } from "@/global/s3";

import {
    CreateTaskSchema,
    type AuthorData,
    type MediaItemData,
    type PostItemData,
    type CreateTaskPayload,
    type WorkflowPayload,
} from "@/features/ingest/schema";
import { QueueAiError } from "@/features/ai/errors";
import { QueueAiSchema } from "@/features/ai/schema";
import { queueAiEnrichment } from "@/features/ai/queue-enrichment";
import { RetrySyncError } from "@/features/sync/errors";
import { RetrySyncSchema } from "@/features/sync/schema";
import { retrySync } from "@/features/sync/retry-sync";
import { sweepStuckEntities } from "@/features/sync/sweep-stuck";

export { CreateTaskSchema };
export type { AuthorData, MediaItemData, PostItemData, CreateTaskPayload, WorkflowPayload };

const taskApp = new Hono<AuthEnv>();

// Endpoint to create a task
taskApp.post("/create", requireAuth, validate("json", CreateTaskSchema), async (c) => {
    const user = c.get("user");
    const apiToken = c.get("apiToken");

    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const payload = c.req.valid("json");

    // 1. Verify library exists
    const libs = await db.select().from(Library).where(eq(Library.id, payload.library_id)).limit(1);
    const library = libs[0];
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Target library not found"), 404);
    }

    // 2. Perform library scoping and ownership validation
    if (apiToken) {
        // If API token is scoped to a specific library, check that target matches scope
        if (apiToken.library_id && apiToken.library_id !== payload.library_id) {
            return c.json(error(Code.UNAUTHORIZED, "API token is not scoped for this library"), 403);
        }

        // Ensure library belongs to the token owner
        if (library.owner_id !== user.id) {
            return c.json(error(Code.UNAUTHORIZED, "You do not have access to this library"), 403);
        }
    } else {
        // Logged-in session user, check ownership
        if (library.owner_id !== user.id) {
            return c.json(error(Code.UNAUTHORIZED, "You do not have access to this library"), 403);
        }
    }

    const results = [];
    for (const postData of payload.posts) {
        results.push(
            await IngestPipeline.processPostIngest({
                postData,
                targetLibraryId: payload.library_id,
                ownerId: user.id,
            }),
        );
    }

    const createdTaskIds = results.flatMap((result) => (result.taskId ? [result.taskId] : []));

    return c.json(
        success(Code.SUCCESS, {
            message: "Tasks received and metadata processed",
            count: payload.posts.length,
            processedCount: results.filter((result) => !result.skipped).length,
            task_ids: createdTaskIds,
        }),
    );
});

// Cron endpoint to purge expired soft-deleted files
taskApp.post("/purge-expired-files", async (c) => {
    const thirtyDaysAgo = Temporal.Now.instant().subtract({ hours: 30 * 24 });
    const BATCH_SIZE = 500;

    let purgedCount = 0;
    let failedCount = 0;
    const errors: Array<{ fileId: string; error: string }> = [];

    while (true) {
        const expiredFiles = await db
            .select()
            .from(DbFile)
            .where(and(eq(DbFile.delete_status, DeleteStatus.DELETED), lt(DbFile.delete_time, thirtyDaysAgo)))
            .limit(BATCH_SIZE);

        if (expiredFiles.length === 0) break;

        for (const file of expiredFiles) {
            try {
                try {
                    await s3.delete(file.path, { bucket: file.bucket });
                } catch (s3Err: any) {
                    if (s3Err.name !== "NotFound" && s3Err.name !== "NoSuchKey") {
                        throw s3Err;
                    }
                }

                await db.delete(DbFile).where(eq(DbFile.id, file.id));
                purgedCount++;
            } catch (e: any) {
                failedCount++;
                errors.push({ fileId: file.id, error: e.message || String(e) });
            }
        }
    }

    return c.json(
        success(Code.SUCCESS, {
            purgedCount,
            failedCount,
            errors,
        }),
    );
});

// Cron endpoint to purge stale PENDING uploads that were never confirmed
taskApp.post("/purge-stale-pending-drafts", async (c) => {
    // Auth Check: Validate cron secret
    const cronSecret = env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = c.req.header("Authorization");
        const internalHeader = c.req.header("X-Internal-Token");
        let token = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        } else if (internalHeader) {
            token = internalHeader;
        }
        if (token !== cronSecret) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
    } else {
        if (process.env.NODE_ENV === "production") {
            return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
        }
    }

    // Set expiration threshold to 2 hours ago
    const twoHoursAgo = Temporal.Now.instant().subtract({ hours: 2 });
    const BATCH_SIZE = 500;

    let purgedCount = 0;
    let failedCount = 0;
    const errors: Array<{ draftId: string; error: string }> = [];

    while (true) {
        const staleDrafts = await db
            .select({
                draftId: DraftFile.id,
                fileId: DbFile.id,
                filePath: DbFile.path,
                fileBucket: DbFile.bucket,
            })
            .from(DraftFile)
            .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
            .where(and(eq(DraftFile.status, DraftFileStatus.PENDING), lt(DraftFile.create_time, twoHoursAgo)))
            .limit(BATCH_SIZE);

        if (staleDrafts.length === 0) break;

        for (const draft of staleDrafts) {
            try {
                try {
                    await s3.delete(draft.filePath, { bucket: draft.fileBucket });
                } catch (s3Err: any) {
                    if (s3Err.name !== "NotFound" && s3Err.name !== "NoSuchKey") {
                        throw s3Err;
                    }
                }

                await db.transaction(async (tx) => {
                    await tx.delete(DraftFile).where(eq(DraftFile.id, draft.draftId));
                    await tx.delete(DbFile).where(eq(DbFile.id, draft.fileId));
                });
                purgedCount++;
            } catch (e: any) {
                failedCount++;
                errors.push({ draftId: draft.draftId, error: e.message || String(e) });
            }
        }
    }

    return c.json(
        success(Code.SUCCESS, {
            purgedCount,
            failedCount,
            errors,
        }),
    );
});

// Endpoint to retry sync for failed items
taskApp.post("/retry-sync", requireAuth, validate("json", RetrySyncSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    try {
        const result = await retrySync(c.req.valid("json"), {
            ownerId: user.id,
            scopedLibraryId: c.get("apiToken")?.library_id,
        });

        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        if (cause instanceof RetrySyncError) {
            if (cause.kind === "FORBIDDEN") {
                return c.json(error(Code.FORBIDDEN, cause.message), 403);
            }
            return c.json(error(Code.INVALID_PARAMETER, cause.message), 400);
        }

        const message = cause instanceof Error ? cause.message : String(cause);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, message), 500);
    }
});

/**
 * Universal endpoint to sweep stuck background processes and jobs.
 *
 * Performs a two-tier cleanup:
 * 1. Entity-level sync timeout sweep: Marks legacy entity records (Post, Media, Track) stuck in IN_PROGRESS as FAILED.
 * 2. Generic async job system sweep (JobSweeper): Reclaims expired task unit leases, dispatches pending units,
 *    reconciles completed tasks, and purges obsolete job records across all registered AsyncTask types automatically.
 */
taskApp.post("/sweep-stuck-tasks", async (c) => {
    // Auth Check: Validate cron secret
    const cronSecret = env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = c.req.header("Authorization");
        const internalHeader = c.req.header("X-Internal-Token");

        let token = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        } else if (internalHeader) {
            token = internalHeader;
        }

        if (token !== cronSecret) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
    } else {
        if (process.env.NODE_ENV === "production") {
            return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
        }
    }

    let thresholdMinutes = 30;
    try {
        const body = await c.req.json();
        if (body && typeof body.threshold_minutes === "number") {
            thresholdMinutes = body.threshold_minutes;
        }
    } catch {
        // Fallback to default
    }

    try {
        // Step 1: Sweep legacy entity sync statuses (Post / Media / Track)
        const entityResult = await sweepStuckEntities(thresholdMinutes);
        // Step 2: Execute full generic sweep across all registered AsyncTask job handlers
        const jobResult = await JobSweeper.runSweep();

        return c.json(
            success(Code.SUCCESS, {
                stuck_entities_swept: entityResult.sweptCount,
                async_job_sweep: jobResult,
            }),
        );
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to sweep stuck tasks: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to sweep orphan tags
taskApp.post("/sweep-orphan-tags", async (c) => {
    const cronSecret = env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = c.req.header("Authorization");
        const internalHeader = c.req.header("X-Internal-Token");

        let token = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        } else if (internalHeader) {
            token = internalHeader;
        }

        if (token !== cronSecret) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
    } else {
        if (process.env.NODE_ENV === "production") {
            return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
        }
    }

    try {
        const result = await sweepOrphanTags();
        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to sweep orphan tags: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to reconcile Media / Track / File logical references

taskApp.post("/sweep-media-track-integrity", async (c) => {
    const cronSecret = env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = c.req.header("Authorization");
        const internalHeader = c.req.header("X-Internal-Token");
        let token = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        } else if (internalHeader) {
            token = internalHeader;
        }
        if (token !== cronSecret) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
    } else if (process.env.NODE_ENV === "production") {
        return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
    }

    try {
        const report = await runMediaTrackIntegrityScan();
        return c.json(success(Code.SUCCESS, report));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to reconcile media/track integrity: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to queue items for AI enrichment
taskApp.post("/queue-ai", requireAuth, validate("json", QueueAiSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    try {
        const result = await queueAiEnrichment(c.req.valid("json"), {
            ownerId: user.id,
            scopedLibraryId: c.get("apiToken")?.library_id,
        });
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        if (cause instanceof QueueAiError) {
            if (cause.kind === "FORBIDDEN") {
                return c.json(error(Code.UNAUTHORIZED, cause.message), 403);
            }
            return c.json(error(Code.INVALID_PARAMETER, cause.message), 400);
        }
        throw cause;
    }
});

export default taskApp;
