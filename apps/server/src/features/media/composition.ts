import { and, eq, isNull } from "drizzle-orm";
import { db, type Transaction } from "@/global/db";
import {
    DeleteStatus,
    File as DbFile,
    Media,
    MediaType,
    Post,
    SyncStatus,
    Track,
    TrackPurpose,
    TrackType,
} from "@/db/schema";
import { validateMediaComposition } from "@/lib/validation/media-composition";

const requiredContentTypes = (mediaType: MediaType): TrackType[] => {
    if (mediaType === MediaType.LIVE_PHOTO) return [TrackType.IMAGE, TrackType.VIDEO];
    if (mediaType === MediaType.IMAGE) return [TrackType.IMAGE];
    if (mediaType === MediaType.VIDEO) return [TrackType.VIDEO];
    if (mediaType === MediaType.AUDIO) return [TrackType.AUDIO];
    if (mediaType === MediaType.PDF) return [TrackType.PDF];
    return [];
};

export async function getMediaCompletionError(mediaId: string, requireFiles = true, tx?: Transaction): Promise<string | null> {
    const executor = tx ?? db;
    const [media] = await executor
        .select({ id: Media.id, type: Media.type })
        .from(Media)
        .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
        .limit(1);
    if (!media) return "Media not found or is inactive";

    const tracks = await executor
        .select({
            type: Track.type,
            purpose: Track.purpose,
            is_default: Track.is_default,
            sync_status: Track.sync_status,
            file_id: Track.file_id,
            file_delete_status: DbFile.delete_status,
        })
        .from(Track)
        .leftJoin(DbFile, eq(Track.file_id, DbFile.id))
        .where(and(eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

    const compositionError = validateMediaComposition(
        media.type,
        tracks.map((track) => ({
            type: track.type,
            purpose: track.purpose,
            is_default: track.is_default,
        })),
    );
    if (compositionError) return compositionError;

    if (!requireFiles) return null;

    for (const requiredType of requiredContentTypes(media.type)) {
        const ready = tracks.some(
            (track) =>
                track.type === requiredType &&
                track.purpose === TrackPurpose.CONTENT &&
                track.is_default &&
                track.sync_status === SyncStatus.COMPLETED &&
                track.file_id !== null &&
                track.file_delete_status === DeleteStatus.ACTIVE,
        );
        if (!ready) {
            return `${media.type} media requires a completed default ${requiredType} CONTENT track with an active file`;
        }
    }

    return null;
}

export async function assertMediaComposition(mediaId: string, tx: Transaction) {
    const compositionError = await getMediaCompletionError(mediaId, false, tx);
    if (compositionError) throw new Error(compositionError);
}

export async function assertMediaReady(mediaId: string, tx: Transaction) {
    const completionError = await getMediaCompletionError(mediaId, true, tx);
    if (completionError) throw new Error(completionError);
}

export async function syncMediaAndPostStatus(mediaId: string, tx: Transaction, now = Temporal.Now.instant()) {
    const completionError = await getMediaCompletionError(mediaId, true, tx);
    if (completionError) {
        await tx
            .update(Media)
            .set({
                sync_status: SyncStatus.PENDING,
                last_error: completionError,
                update_time: now,
            })
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)));

        const [media] = await tx
            .select({ post_id: Media.post_id })
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        if (media?.post_id) {
            await tx
                .update(Post)
                .set({
                    sync_status: SyncStatus.PENDING,
                    last_error: completionError,
                    update_time: now,
                })
                .where(and(eq(Post.id, media.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)));
        }
        return false;
    }

    await tx
        .update(Media)
        .set({
            sync_status: SyncStatus.COMPLETED,
            last_error: null,
            update_time: now,
        })
        .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)));

    const [media] = await tx
        .select({ post_id: Media.post_id })
        .from(Media)
        .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
        .limit(1);
    if (media?.post_id) {
        const activeMedias = await tx
            .select({ sync_status: Media.sync_status })
            .from(Media)
            .where(and(eq(Media.post_id, media.post_id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));

        const allCompleted = activeMedias.every((item) => item.sync_status === SyncStatus.COMPLETED);
        if (allCompleted) {
            await tx
                .update(Post)
                .set({
                    sync_status: SyncStatus.COMPLETED,
                    last_error: null,
                    update_time: now,
                })
                .where(and(eq(Post.id, media.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)));
        }
    }

    return true;
}
