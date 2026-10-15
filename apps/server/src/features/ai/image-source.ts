import { and, eq, inArray, sql } from "drizzle-orm";
import {
    AsyncTask,
    AsyncTaskStatus,
    AsyncTaskType,
    DeleteStatus,
    File as DbFile,
    SyncStatus,
    Track,
    TrackPurpose,
    TrackType,
} from "@/db/schema";
import { db } from "@/global/db";
import { Quality } from "@/lib/types";

type ImageSourceRow = {
    track: Pick<
        typeof Track.$inferSelect,
        | "id"
        | "file_id"
        | "type"
        | "purpose"
        | "quality"
        | "priority"
        | "is_primary"
        | "is_default"
        | "is_generated"
        | "is_stale"
        | "metadata"
    >;
    file: Pick<typeof DbFile.$inferSelect, "id">;
};

const qualityRank: Record<Quality, number> = {
    [Quality.LOW]: 1,
    [Quality.MEDIUM]: 2,
    [Quality.HIGH]: 3,
};

export class CoverNotReadyError extends Error {
    constructor(mediaId: string) {
        super(`Cover generation is still running for media ${mediaId}`);
        this.name = "CoverNotReadyError";
    }
}

/**
 * Select the best completed cover, regardless of its track priority.
 * A generated cover from a superseded content file is not a usable cover.
 * Only image content can serve as a fallback (never a video file).
 */
export function selectAiImageSource<T extends ImageSourceRow>(rows: T[]): T | null {
    const currentContentFileIds = new Set(rows.filter(({ track }) => track.purpose === TrackPurpose.CONTENT).map(({ file }) => file.id));
    const covers = rows
        .filter(
            ({ track }) =>
                track.type === TrackType.IMAGE &&
                track.purpose === TrackPurpose.COVER &&
                !track.is_stale &&
                (!track.is_generated ||
                    (typeof track.metadata.source_file_id === "string" && currentContentFileIds.has(track.metadata.source_file_id))),
        )
        .sort(
            (a, b) =>
                qualityRank[b.track.quality] - qualityRank[a.track.quality] ||
                a.track.priority - b.track.priority ||
                a.track.id.localeCompare(b.track.id),
        );
    if (covers.length > 0) return covers[0]!;

    const images = rows
        .filter(({ track }) => track.type === TrackType.IMAGE && track.purpose === TrackPurpose.CONTENT && !track.is_stale)
        .sort(
            (a, b) =>
                Number(b.track.is_primary) - Number(a.track.is_primary) ||
                Number(b.track.is_default) - Number(a.track.is_default) ||
                a.track.priority - b.track.priority ||
                a.track.id.localeCompare(b.track.id),
        );
    return images[0] ?? null;
}

export async function resolveAiImageSource(mediaId: string, libraryId: string) {
    // Check before loading tracks: a targeted task that finishes while tracks are
    // being read must still prevent an original-image fallback from racing its cover.
    const pendingCoverTask = await db
        .select({ id: AsyncTask.id })
        .from(AsyncTask)
        .where(
            and(
                eq(AsyncTask.library_id, libraryId),
                eq(AsyncTask.type, AsyncTaskType.COVER_BATCH),
                inArray(AsyncTask.status, [AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING]),
                sql`${AsyncTask.input_snapshot}->'media_ids' @> ${JSON.stringify([mediaId])}::jsonb`,
            ),
        )
        .limit(1);

    const rows = await db
        .select({ track: Track, file: DbFile })
        .from(Track)
        .innerJoin(DbFile, and(eq(Track.file_id, DbFile.id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
        .where(
            and(
                eq(Track.media_id, mediaId),
                eq(Track.delete_status, DeleteStatus.ACTIVE),
                eq(Track.sync_status, SyncStatus.COMPLETED),
                inArray(Track.purpose, [TrackPurpose.COVER, TrackPurpose.CONTENT]),
            ),
        );

    const source = selectAiImageSource(rows);
    if (source?.track.purpose === TrackPurpose.COVER) return source;
    // Ingestion schedules this task after downloading content. If it is still
    // generating a cover, do not enrich from the original image yet.
    if (pendingCoverTask.length > 0) throw new CoverNotReadyError(mediaId);

    return source;
}
