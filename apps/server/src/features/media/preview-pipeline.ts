import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { DeleteStatus, Media, MediaPreview } from "@/db/schema";
import { db } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { SubjectPipelineHandler } from "@/infra/queue/types";
import { UndecodableSourceError } from "@/lib/utils/preview_renderer";
import { clearPreviews, loadPreviewStates, planPreviews, previewsNeedWork, renderAndStorePreview, storePreviewFailure } from "./preview";

const failedPreviews = (libraryIds: readonly string[]) =>
    and(
        inArray(Media.library_id, [...libraryIds]),
        eq(Media.delete_status, DeleteStatus.ACTIVE),
        isNull(Media.recycle_time),
        isNotNull(MediaPreview.last_error),
    );

/**
 * `preview`: renders the three preview sizes of a media from its cover or content (docs/media_refactor.zh-Hans.md, 5),
 * and removes the previews of a media that has nothing to render them from.
 *
 * It reports `media.preview` whenever a run ends, even with nothing to do or for good on a failure: AI work waits while
 * the media is queued here, and would otherwise never be queued again.
 */
export const previewPipeline: SubjectPipelineHandler = {
    // A render may need about 800 MiB: libheif decoding a 48 MP HEIC, or FFmpeg and SVT-AV1 on a 4K frame. Two at once
    // beside the server already fill a 2 GiB container.
    concurrency: 1,

    async reconcile(ctx) {
        // Reported as the queue row goes: AI work waits while the media is queued here, so the last report must come
        // once it no longer is.
        const finished = { kind: "done", changed: Aspect.MEDIA_PREVIEW } as const;
        const [state] = await loadPreviewStates(db, [ctx.subjectId]);
        if (!state) return finished;

        if (!state.source) {
            if (state.previews.length > 0) {
                await db.transaction(async (tx) => {
                    await clearPreviews(tx, [state.media.id]);
                    await ctx.fence(tx);
                });
            }
            return finished;
        }

        for (const size of planPreviews(state, false)) {
            try {
                const stored = await renderAndStorePreview({
                    state: { ...state, source: state.source },
                    size,
                    signal: ctx.signal,
                    afterPersist: ctx.fence,
                });
                // The media or its source changed meanwhile; that change queues this media again.
                if (!stored) return finished;
            } catch (error) {
                if (error instanceof UndecodableSourceError) return { kind: "rejected", error: error.message };
                throw error;
            }
        }
        return finished;
    },

    /** Records the failure on every size still missing, for the source it failed on. AI work goes on without previews. */
    async recordFailure(tx, { subjectId: mediaId, error }) {
        await markChanged(tx, Aspect.MEDIA_PREVIEW, [mediaId]);
        const [state] = await loadPreviewStates(tx, [mediaId]);
        if (state) await storePreviewFailure(tx, state, error);
    },

    async scanPage(libraryId, cursor, limit) {
        const conditions = [eq(Media.library_id, libraryId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)];
        if (cursor) conditions.push(gt(Media.id, cursor));
        const page = await db
            .select({ id: Media.id })
            .from(Media)
            .where(and(...conditions))
            .orderBy(asc(Media.id))
            .limit(limit);
        const states = await loadPreviewStates(
            db,
            page.map((media) => media.id),
        );
        return {
            subjectIds: states.filter((state) => previewsNeedWork(state, true)).map((state) => state.media.id),
            nextCursor: page.length === limit ? page[page.length - 1]!.id : null,
        };
    },

    async countFailures(libraryIds) {
        if (libraryIds.length === 0) return new Map();
        const rows = await db
            .select({ libraryId: Media.library_id, count: sql<number>`count(DISTINCT ${Media.id})::int` })
            .from(MediaPreview)
            .innerJoin(Media, eq(Media.id, MediaPreview.media_id))
            .where(failedPreviews(libraryIds))
            .groupBy(Media.library_id);
        return new Map(rows.map((row) => [row.libraryId, row.count]));
    },

    async listFailures(libraryId, limit) {
        const latest = db
            .selectDistinctOn([Media.id], {
                subjectId: Media.id,
                label: Media.title,
                error: MediaPreview.last_error,
                time: MediaPreview.update_time,
            })
            .from(MediaPreview)
            .innerJoin(Media, eq(Media.id, MediaPreview.media_id))
            .where(failedPreviews([libraryId]))
            .orderBy(Media.id, desc(MediaPreview.update_time))
            .as("latest");
        const query = db.select().from(latest).orderBy(desc(latest.time)).$dynamic();
        const rows = limit === undefined ? await query : await query.limit(limit);
        return rows.map((row) => ({ ...row, error: row.error ?? "" }));
    },
};
