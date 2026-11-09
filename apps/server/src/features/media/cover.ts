import { and, eq, inArray } from "drizzle-orm";
import { DeleteStatus, File as DbFile, MediaCover, MediaType, SyncStatus } from "@/db/schema";
import { db, type DbClient } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { COVER_MEDIA_TYPES } from "@/lib/validation/media-composition";
import { clearPreviews } from "./preview";

type CoverRow = typeof MediaCover.$inferSelect;

export interface UploadedCoverFile {
    path: string;
    bucket: string;
    mime_type: string;
    extension: string;
    size: number;
}

export class CoverNotAllowedError extends Error {
    constructor(type: MediaType) {
        super(`${type} media cannot have a cover`);
        this.name = "CoverNotAllowedError";
    }
}

async function softDeleteFile(client: DbClient, fileId: string | null): Promise<void> {
    if (!fileId) return;
    await client
        .update(DbFile)
        .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
        .where(and(eq(DbFile.id, fileId), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));
}

async function lockCover(client: DbClient, mediaId: string): Promise<CoverRow | undefined> {
    const [row] = await client.select().from(MediaCover).where(eq(MediaCover.media_id, mediaId)).for("update");
    return row;
}

/** Deletes the cover row and soft deletes its file; returns whether there was one. */
async function deleteCover(client: DbClient, mediaId: string): Promise<boolean> {
    const [deleted] = await client.delete(MediaCover).where(eq(MediaCover.media_id, mediaId)).returning({ fileId: MediaCover.file_id });
    if (!deleted) return false;
    await softDeleteFile(client, deleted.fileId);
    return true;
}

/** Releases the cover and previews of media being deleted: their rows go, their files are marked deleted. */
export async function deleteMediaImages(client: DbClient, mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    const covers = await client
        .delete(MediaCover)
        .where(inArray(MediaCover.media_id, [...mediaIds]))
        .returning({ fileId: MediaCover.file_id });
    for (const cover of covers) await softDeleteFile(client, cover.fileId);
    await clearPreviews(client, mediaIds);
}

/**
 * The original cover of a media (docs/media_refactor.zh-Hans.md, 3.4). Every write reports `media.cover` once the cover
 * it leaves behind is usable, so previews follow it.
 */
export const CoverService = {
    /** Sets the cover to a stored file, replacing any cover the media had. */
    async setFile(client: DbClient, media: { id: string; type: MediaType }, fileId: string): Promise<void> {
        if (!COVER_MEDIA_TYPES.has(media.type)) throw new CoverNotAllowedError(media.type);
        const existing = await lockCover(client, media.id);
        const values = { file_id: fileId, source_url: null, status: SyncStatus.COMPLETED, last_error: null, update_time: Temporal.Now.instant() };
        await client.insert(MediaCover).values({ media_id: media.id, ...values }).onConflictDoUpdate({ target: MediaCover.media_id, set: values });
        if (existing?.file_id !== fileId) await softDeleteFile(client, existing?.file_id ?? null);
        await markChanged(client, Aspect.MEDIA_COVER, [media.id]);
    },

    /** Sets the cover to a file the user uploaded through a presigned URL. */
    async setUploaded(client: DbClient, media: { id: string; type: MediaType }, upload: UploadedCoverFile): Promise<void> {
        if (!COVER_MEDIA_TYPES.has(media.type)) throw new CoverNotAllowedError(media.type);
        const [file] = await client
            .insert(DbFile)
            .values({ path: upload.path, bucket: upload.bucket, mime_type: upload.mime_type, extension: upload.extension, size: upload.size })
            .returning({ id: DbFile.id });
        await CoverService.setFile(client, media, file!.id);
    },

    /** Removes the cover; previews fall back to the content. Returns whether the media had one. */
    async remove(client: DbClient, mediaId: string): Promise<boolean> {
        const removed = await deleteCover(client, mediaId);
        if (removed) await markChanged(client, Aspect.MEDIA_COVER, [mediaId]);
        return removed;
    },

    /**
     * Applies the cover a platform import offers. A new URL leaves the cover pending for the download pipeline (the old
     * file is released now); the same URL changes nothing. Without one, a previously imported cover goes, while a cover
     * the user uploaded stays. Media types that cannot have a cover ignore it. Returns whether a download is needed.
     */
    async syncImported(client: DbClient, media: { id: string; type: MediaType }, url: string | null): Promise<boolean> {
        if (!COVER_MEDIA_TYPES.has(media.type)) return false;
        const existing = await lockCover(client, media.id);
        if (!url) {
            if (existing?.source_url) await CoverService.remove(client, media.id);
            return false;
        }
        if (existing?.source_url === url) return existing.status !== SyncStatus.COMPLETED;

        const values = { file_id: null, source_url: url, status: SyncStatus.PENDING, last_error: null, update_time: Temporal.Now.instant() };
        await client.insert(MediaCover).values({ media_id: media.id, ...values }).onConflictDoUpdate({ target: MediaCover.media_id, set: values });
        if (existing?.file_id) {
            await softDeleteFile(client, existing.file_id);
            // The old cover is gone until the new one arrives; previews fall back to the content meanwhile.
            await markChanged(client, Aspect.MEDIA_COVER, [media.id]);
        }
        return true;
    },

    /** The completed cover of each media that has one, for responses. */
    async loadUrls(mediaIds: readonly string[]): Promise<Map<string, { url: string }>> {
        if (mediaIds.length === 0) return new Map();
        const rows = await db
            .select({ mediaId: MediaCover.media_id, bucket: DbFile.bucket, path: DbFile.path })
            .from(MediaCover)
            .innerJoin(DbFile, and(eq(DbFile.id, MediaCover.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(and(inArray(MediaCover.media_id, [...mediaIds]), eq(MediaCover.status, SyncStatus.COMPLETED)));
        return new Map(rows.map((row) => [row.mediaId, { url: buildCdnUrl(row.bucket, row.path) }]));
    },
};
