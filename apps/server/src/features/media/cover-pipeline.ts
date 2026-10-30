import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { DeleteStatus, File as DbFile, Library, Media, SyncStatus, Track, TrackPurpose, TrackType } from "@/db/schema";
import { db, type DbClient } from "@/global/db";
import { CoverService, coverPriority, coverVariantKey, pickCoverSource, type ResolvedCoverSource } from "@/features/media/cover";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { SubjectPipelineHandler } from "@/infra/queue/types";
import type { Quality } from "@/lib/types";
import { UndecodableSourceError } from "@/lib/utils/cover_renderer";

type TrackRow = typeof Track.$inferSelect;
type CoverTrack = Pick<
    TrackRow,
    "purpose" | "variant_key" | "is_generated" | "quality" | "sync_status" | "is_stale" | "file_id" | "metadata" | "last_error"
>;

const matchesQuality = (track: CoverTrack, quality: Quality) =>
    track.purpose === TrackPurpose.COVER &&
    (track.variant_key === coverVariantKey(quality) || (!track.is_generated && track.quality === quality));

/**
 * The cover qualities that need rendering from `sourceFileId`. A quality is current when a matching cover track is
 * completed, not stale, has an active file, and is either supplied by the source (not generated) or was generated
 * from this source file. With `skipRejected`, qualities rejected on this source file are left out too, so library
 * scans do not retry them; a change or an explicit requeue still does.
 */
export function planCover(
    sourceFileId: string,
    tracks: readonly CoverTrack[],
    activeFileIds: ReadonlySet<string>,
    qualities: readonly Quality[],
    skipRejected: boolean,
): Quality[] {
    return qualities.filter((quality) => {
        const matching = tracks.filter((track) => matchesQuality(track, quality));
        const current = matching.some(
            (track) =>
                track.sync_status === SyncStatus.COMPLETED &&
                !track.is_stale &&
                track.file_id !== null &&
                activeFileIds.has(track.file_id) &&
                (!track.is_generated || track.metadata.source_file_id === sourceFileId),
        );
        if (current) return false;
        if (skipRejected && matching.some((track) => track.last_error && track.metadata.error_source_file_id === sourceFileId))
            return false;
        return true;
    });
}

interface CoverState {
    media: typeof Media.$inferSelect;
    source: ResolvedCoverSource;
    tracks: TrackRow[];
    activeFileIds: Set<string>;
    qualities: Quality[];
}

/** Loads what planCover needs for each active media that has a renderable source. */
async function loadCoverStates(client: DbClient, mediaIds: readonly string[]): Promise<CoverState[]> {
    if (mediaIds.length === 0) return [];
    const mediaRows = await client
        .select({ media: Media, qualities: Library.cover_qualities })
        .from(Media)
        .innerJoin(Library, eq(Library.id, Media.library_id))
        .where(and(inArray(Media.id, [...mediaIds]), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
    if (mediaRows.length === 0) return [];

    const rows = await client
        .select({ track: Track, file: DbFile })
        .from(Track)
        .leftJoin(DbFile, and(eq(DbFile.id, Track.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
        .where(
            and(
                inArray(
                    Track.media_id,
                    mediaRows.map((row) => row.media.id),
                ),
                eq(Track.delete_status, DeleteStatus.ACTIVE),
            ),
        );
    const byMedia = new Map<string, typeof rows>();
    for (const row of rows) {
        const list = byMedia.get(row.track.media_id) ?? [];
        list.push(row);
        byMedia.set(row.track.media_id, list);
    }

    return mediaRows.flatMap(({ media, qualities }) => {
        const mediaTracks = byMedia.get(media.id) ?? [];
        const source = pickCoverSource(mediaTracks);
        if (!source) return [];
        return [
            {
                media,
                source,
                qualities,
                tracks: mediaTracks.map((row) => row.track),
                activeFileIds: new Set(mediaTracks.flatMap((row) => (row.file ? [row.file.id] : []))),
            },
        ];
    });
}

const failedCovers = (libraryIds: readonly string[]) =>
    and(
        inArray(Media.library_id, [...libraryIds]),
        eq(Media.delete_status, DeleteStatus.ACTIVE),
        isNull(Media.recycle_time),
        eq(Track.purpose, TrackPurpose.COVER),
        eq(Track.delete_status, DeleteStatus.ACTIVE),
        isNotNull(Track.last_error),
    );

/**
 * `cover`: renders the cover qualities the library is configured for from the media's best content track.
 * Qualities outside the library configuration are left alone.
 */
export const coverPipeline: SubjectPipelineHandler = {
    async reconcile(ctx) {
        const [state] = await loadCoverStates(db, [ctx.subjectId]);
        if (!state) return { kind: "done" };

        for (const quality of planCover(state.source.fileId, state.tracks, state.activeFileIds, state.qualities, false)) {
            try {
                const stored = await CoverService.generateCover({
                    media: state.media,
                    quality,
                    source: state.source,
                    signal: ctx.signal,
                    beforePersist: async (tx) => {
                        await ctx.fence(tx);
                        await markChanged(tx, Aspect.MEDIA_COVER, [state.media.id]);
                    },
                });
                // The media or its source changed meanwhile; that change queues this media again.
                if (!stored) return { kind: "done" };
            } catch (error) {
                if (error instanceof UndecodableSourceError) return { kind: "rejected", error: error.message };
                throw error;
            }
        }
        return { kind: "done" };
    },

    /** Records the failure on the cover track of every quality still missing, tagged with the source file if that is at fault. */
    async recordFailure(tx, { subjectId: mediaId, error, rejected }) {
        const [state] = await loadCoverStates(tx, [mediaId]);
        if (!state) return;
        const now = Temporal.Now.instant();
        const errorSource = { error_source_file_id: rejected ? state.source.fileId : undefined };
        for (const quality of planCover(state.source.fileId, state.tracks, state.activeFileIds, state.qualities, false)) {
            const variantKey = coverVariantKey(quality);
            const existing = state.tracks.find((track) => track.purpose === TrackPurpose.COVER && track.variant_key === variantKey);
            if (existing) {
                // A completed cover from an older source stays visible; only the error is added.
                await tx
                    .update(Track)
                    .set({
                        last_error: error,
                        metadata: { ...existing.metadata, ...errorSource },
                        update_time: now,
                    })
                    .where(eq(Track.id, existing.id));
                continue;
            }
            await tx.insert(Track).values({
                media_id: state.media.id,
                type: TrackType.IMAGE,
                purpose: TrackPurpose.COVER,
                quality,
                priority: coverPriority(quality),
                sync_status: SyncStatus.FAILED,
                last_error: error,
                metadata: errorSource,
                variant_key: variantKey,
                is_generated: true,
                is_original: false,
                source_track_id: state.source.track.id,
            });
        }
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

        const states = await loadCoverStates(
            db,
            page.map((media) => media.id),
        );
        const subjectIds = states
            .filter((state) => planCover(state.source.fileId, state.tracks, state.activeFileIds, state.qualities, true).length > 0)
            .map((state) => state.media.id);
        return { subjectIds, nextCursor: page.length === limit ? page[page.length - 1]!.id : null };
    },

    async countFailures(libraryIds) {
        if (libraryIds.length === 0) return new Map();
        const rows = await db
            .select({ libraryId: Media.library_id, count: sql<number>`count(DISTINCT ${Media.id})::int` })
            .from(Track)
            .innerJoin(Media, eq(Media.id, Track.media_id))
            .where(failedCovers(libraryIds))
            .groupBy(Media.library_id);
        return new Map(rows.map((row) => [row.libraryId, row.count]));
    },

    async listFailures(libraryId, limit) {
        const latest = db
            .selectDistinctOn([Media.id], { subjectId: Media.id, label: Media.title, error: Track.last_error, time: Track.update_time })
            .from(Track)
            .innerJoin(Media, eq(Media.id, Track.media_id))
            .where(failedCovers([libraryId]))
            .orderBy(Media.id, desc(Track.update_time))
            .as("latest");
        const query = db.select().from(latest).orderBy(desc(latest.time)).$dynamic();
        const rows = limit === undefined ? await query : await query.limit(limit);
        return rows.map((row) => ({ ...row, error: row.error ?? "" }));
    },
};

/**
 * Marks the generated covers of the media matching `mediaWhere` stale, so the cover pipeline renders them again
 * (an explicit regenerate). The caller queues the cover pipeline in the same transaction.
 */
export async function markCoversStale(client: DbClient, mediaWhere: SQL): Promise<void> {
    await client
        .update(Track)
        .set({ is_stale: true, update_time: sql`now()` })
        .where(
            and(
                inArray(Track.media_id, client.select({ id: Media.id }).from(Media).where(mediaWhere)),
                eq(Track.purpose, TrackPurpose.COVER),
                eq(Track.is_generated, true),
                eq(Track.delete_status, DeleteStatus.ACTIVE),
            ),
        );
}
