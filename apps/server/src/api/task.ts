import { Hono } from "hono";
import { validate } from "@/lib/validation/validator";

import { IngestPipeline } from "@/features/ingest/pipeline";
import { Code } from "@/lib/code";
import { error, success } from "@/lib/response";
import { AuthEnv, ownedLibrary, requireAuth, requireCronSecret } from "@/lib/auth/middleware";
import { db } from "@/global/db";
import { File as DbFile, DraftFile, DraftFileStatus } from "@/db/schema";
import { eq, and, lt } from "drizzle-orm";

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
import { RetrySyncError } from "@/features/sync/errors";
import { RetrySyncSchema, SweepStuckLibrarySchema } from "@/features/sync/schema";
import { retrySync } from "@/features/sync/retry-sync";
import { sweepStuckEntities } from "@/features/sync/sweep-stuck";
import { purgeExpiredFiles } from "@/features/trash/purge-expired-files";

export { CreateTaskSchema };
export type { AuthorData, MediaItemData, PostItemData, CreateTaskPayload, WorkflowPayload };

const taskApp = new Hono<AuthEnv>();

// Endpoint to create a task
taskApp.post("/create", requireAuth, validate("json", CreateTaskSchema), async (c) => {
    const user = c.get("user");

    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const payload = c.req.valid("json");

    const library = await ownedLibrary(c, user.id, payload.library_id);
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    const results = [];
    for (const postData of payload.posts) {
        results.push(
            await IngestPipeline.processPostIngest({
                postData,
                targetLibraryId: payload.library_id,
            }),
        );
    }

    return c.json(
        success(Code.SUCCESS, {
            message: "Tasks received and metadata processed",
            count: payload.posts.length,
            processedCount: results.filter((result) => !result.skipped).length,
        }),
    );
});

// Manual trigger for the daily purge of expired soft-deleted files
taskApp.post("/purge-expired-files", requireCronSecret, async (c) => {
    return c.json(success(Code.SUCCESS, await purgeExpiredFiles()));
});

// Cron endpoint to purge stale PENDING uploads that were never confirmed
taskApp.post("/purge-stale-pending-drafts", requireCronSecret, async (c) => {
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
            return c.json(error(Code.NOT_FOUND, cause.message), 404);
        }

        const message = cause instanceof Error ? cause.message : String(cause);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, message), 500);
    }
});

/**
 * User-triggered recovery of one library: marks its Post, Media and Track records stuck in IN_PROGRESS as FAILED.
 * The reconcile queue recovers its own expired leases.
 */
taskApp.post("/sweep-stuck-library", requireAuth, validate("json", SweepStuckLibrarySchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const { library_id } = c.req.valid("json");
    const library = await ownedLibrary(c, user.id, library_id);
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    const { sweptCount } = await sweepStuckEntities(30, library_id);
    return c.json(success(Code.SUCCESS, { stuck_entities_swept: sweptCount }));
});

/**
 * Sweeps entity records (Post, Media, Track) stuck in IN_PROGRESS past the threshold and marks them FAILED. The
 * reconcile queue recovers its own expired leases.
 */
taskApp.post("/sweep-stuck-tasks", requireCronSecret, async (c) => {
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
        const entityResult = await sweepStuckEntities(thresholdMinutes);
        return c.json(success(Code.SUCCESS, { stuck_entities_swept: entityResult.sweptCount }));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to sweep stuck tasks: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to sweep orphan tags
taskApp.post("/sweep-orphan-tags", requireCronSecret, async (c) => {
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

taskApp.post("/sweep-media-track-integrity", requireCronSecret, async (c) => {
    try {
        const report = await runMediaTrackIntegrityScan();
        return c.json(success(Code.SUCCESS, report));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to reconcile media/track integrity: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

export default taskApp;
