import { db } from "@/global/db";
import {
    Media,
    Track,
    File as DbFile,
    DeleteStatus,
    SyncStatus,
    TrackPurpose,
    AsyncTaskUnitKind,
    AsyncSubjectType,
    AsyncOutcomeCode,
    type GeneratedCoverMetadata,
} from "@/db/schema";
import { and, eq, gt, asc, inArray, type SQL } from "drizzle-orm";
import { RECIPE_VERSION } from "@/lib/utils/cover_profiles";
import { z } from "zod";
import { Quality } from "@/lib/types";
import { CoverService, rankCoverCandidateTrack, type ResolvedCoverSource } from "@/services/cover";
import type { TaskHandler, TaskUnitContext, TaskResult, DiscoveredUnitSpec } from "@/infra/jobs/types";

const CoverTaskInputSchema = z.object({
    qualities: z.array(z.enum(Quality)).nullable().optional(),
    media_ids: z.array(z.string()).nullable().optional(),
    source_type: z
        .string()
        .nullable()
        .optional()
        .transform((v) => v || "RECONCILE"),
    force: z
        .boolean()
        .nullable()
        .optional()
        .transform((v) => v === true),
});

const CoverUnitInputSchema = z.object({
    quality: z.enum(Quality),
    sourceFileId: z.string(),
    sourceTrackId: z.string().nullable().optional(),
});

/**
 * Helper to build DiscoveredUnitSpec array for a single media item.
 *
 * Reconcile & Batch Rules:
 * 1. Incremental Dispatch: Only dispatches units for qualities present in targetQualities.
 *    Non-targeted qualities (e.g. HIGH if config is LOW+MEDIUM) are NOT dispatched, deleted, or pruned.
 * 2. Completion Check: If !isForce, checks if an active cover Track already exists for the expected
 *    variant_key and matching source_file_id. If so, marks isAlreadyCompleted = true to avoid re-rendering.
 */
function buildUnitsForMedia(
    media: typeof Media.$inferSelect,
    existingTracks: (typeof Track.$inferSelect)[],
    source: ResolvedCoverSource,
    targetQualities: Quality[],
    configVersion: number,
    isForce: boolean,
): DiscoveredUnitSpec[] {
    const units: DiscoveredUnitSpec[] = [];

    for (const quality of targetQualities) {
        let isAlreadyCompleted = false;
        if (!isForce) {
            const expectedVariantKey = `cover:${quality.toLowerCase()}:recipe:${RECIPE_VERSION}`;
            const existingTrack = existingTracks.find(
                (t) =>
                    t.purpose === TrackPurpose.COVER &&
                    (t.variant_key === expectedVariantKey || (!t.is_generated && t.quality === quality)),
            );
            if (existingTrack && existingTrack.sync_status === SyncStatus.COMPLETED && existingTrack.file_id) {
                const metadata = (existingTrack.metadata as GeneratedCoverMetadata) || {};
                if (!existingTrack.is_generated || metadata.source_file_id === source.fileId) {
                    isAlreadyCompleted = true;
                }
            }
        }

        units.push({
            unitKey: `${media.id}:${quality}:${source.fileId}`,
            kind: AsyncTaskUnitKind.COVER_DERIVATIVE,
            subjectType: AsyncSubjectType.MEDIA,
            subjectId: media.id,
            specHash: `${RECIPE_VERSION}:${configVersion}`,
            inputSnapshot: {
                quality,
                sourceFileId: source.fileId,
                sourceTrackId: source.track.id,
            },
            isAlreadyCompleted,
        });
    }

    return units;
}

/**
 * Helper to resolve source track for a media item from in-memory batched maps.
 */
function resolveSourceTrackInBatch(
    tracks: (typeof Track.$inferSelect)[],
    filesMap: Map<string, typeof DbFile.$inferSelect>,
): ResolvedCoverSource | null {
    const candidates: { track: typeof Track.$inferSelect; file: typeof DbFile.$inferSelect }[] = [];

    for (const track of tracks) {
        if (track.purpose === TrackPurpose.CONTENT && track.file_id) {
            const file = filesMap.get(track.file_id);
            if (file) {
                candidates.push({ track, file });
            }
        }
    }

    if (!candidates.length) {
        return null;
    }

    candidates.sort(rankCoverCandidateTrack);

    const best = candidates[0]!;
    return {
        track: best.track,
        fileId: best.file.id,
        filePath: best.file.path,
        fileBucket: best.file.bucket,
    };
}

export const CoverJobHandler: TaskHandler = {
    validateInput(input) {
        return CoverTaskInputSchema.parse(input);
    },

    async discoverUnits(task, discoveryCursor, batchSize) {
        if (!task.library_id) {
            return { units: [], nextCursor: null, hasMore: false };
        }

        const parseResult = CoverTaskInputSchema.safeParse(task.input_snapshot || {});
        if (!parseResult.success) {
            throw new Error(`Invalid task input_snapshot schema: ${parseResult.error.message}`);
        }
        const inputSnapshot = parseResult.data;
        const targetQualities =
            inputSnapshot.qualities && inputSnapshot.qualities.length > 0 ? inputSnapshot.qualities : [Quality.LOW, Quality.MEDIUM];

        const sourceType = inputSnapshot.source_type;
        const isForce = inputSnapshot.force;

        let mediaBatch: (typeof Media.$inferSelect)[] = [];
        let hasMore = false;
        let nextCursor: Record<string, unknown> | null = null;

        if (inputSnapshot.media_ids && inputSnapshot.media_ids.length > 0 && sourceType === "MANUAL") {
            mediaBatch = await db
                .select()
                .from(Media)
                .where(
                    and(
                        eq(Media.library_id, task.library_id),
                        eq(Media.delete_status, DeleteStatus.ACTIVE),
                        inArray(Media.id, inputSnapshot.media_ids),
                    ),
                );
        } else {
            // RECONCILE mode with JSONB discovery cursor
            const lastMediaId = (discoveryCursor?.lastMediaId as string) || null;
            const queryConditions: SQL[] = [eq(Media.library_id, task.library_id), eq(Media.delete_status, DeleteStatus.ACTIVE)];
            if (lastMediaId) {
                queryConditions.push(gt(Media.id, lastMediaId));
            }

            mediaBatch = await db
                .select()
                .from(Media)
                .where(and(...queryConditions))
                .orderBy(asc(Media.id))
                .limit(batchSize);

            hasMore = mediaBatch.length === batchSize;
            if (mediaBatch.length > 0) {
                nextCursor = { lastMediaId: mediaBatch[mediaBatch.length - 1]!.id };
            }
        }

        if (mediaBatch.length === 0) {
            return { units: [], nextCursor: null, hasMore: false };
        }

        // 1. Bulk fetch all active tracks for media items in batch
        const mediaIds = mediaBatch.map((m) => m.id);
        const allTracks = await db
            .select()
            .from(Track)
            .where(and(inArray(Track.media_id, mediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));

        const tracksByMediaId = new Map<string, (typeof Track.$inferSelect)[]>();
        for (const t of allTracks) {
            let list = tracksByMediaId.get(t.media_id);
            if (!list) {
                list = [];
                tracksByMediaId.set(t.media_id, list);
            }
            list.push(t);
        }

        // 2. Bulk fetch all content files referenced by tracks
        const fileIds = Array.from(
            new Set(allTracks.filter((t) => t.purpose === TrackPurpose.CONTENT && t.file_id).map((t) => t.file_id!)),
        );

        const filesMap = new Map<string, typeof DbFile.$inferSelect>();
        if (fileIds.length > 0) {
            const files = await db
                .select()
                .from(DbFile)
                .where(and(inArray(DbFile.id, fileIds), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));
            for (const f of files) {
                filesMap.set(f.id, f);
            }
        }

        // 3. Build units in memory
        const units: DiscoveredUnitSpec[] = [];
        for (const media of mediaBatch) {
            const tracks = tracksByMediaId.get(media.id) || [];
            const source = resolveSourceTrackInBatch(tracks, filesMap);
            if (!source) continue;

            const mediaUnits = buildUnitsForMedia(media, tracks, source, targetQualities, task.config_version, isForce);
            units.push(...mediaUnits);
        }

        return { units, nextCursor, hasMore };
    },

    async execute({ unit, signal }: TaskUnitContext): Promise<TaskResult> {
        signal.throwIfAborted();
        const parseResult = CoverUnitInputSchema.safeParse(unit.input_snapshot || {});
        if (!parseResult.success) {
            return {
                success: false,
                retryable: false,
                outcomeCode: AsyncOutcomeCode.INVALID_INPUT,
                error: "Missing or invalid required item input parameters",
            };
        }
        const input = parseResult.data;

        const mediaList = await db
            .select()
            .from(Media)
            .where(and(eq(Media.id, unit.subject_id), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        const media = mediaList[0];
        if (!media) {
            return {
                success: false,
                retryable: false,
                outcomeCode: AsyncOutcomeCode.MEDIA_NOT_FOUND,
                error: `Media ${unit.subject_id} not found`,
            };
        }

        const source = await CoverService.resolveSourceTrack(media);
        if (!source || source.fileId !== input.sourceFileId) {
            return { success: false, skipped: true, outcomeCode: AsyncOutcomeCode.SOURCE_CHANGED, error: "Source file changed" };
        }

        signal.throwIfAborted();
        const res = await CoverService.generateCover({
            media,
            quality: input.quality,
            source,
            sourceTrackId: input.sourceTrackId || undefined,
            sourceFileId: input.sourceFileId,
        });

        return {
            success: res.success,
            skipped: res.skipped,
            outcomeCode: res.outcomeCode,
            error: res.error,
            retryable: res.retryable,
            data: res.fileId ? { fileId: res.fileId } : undefined,
        };
    },
};
