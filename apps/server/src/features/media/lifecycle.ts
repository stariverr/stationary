import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/global/db";
import { DeleteStatus, File, Media, MediaTag, Post, Track } from "@/db/schema";
import { deleteMediaAiData } from "@/features/ai/cleanup";

export async function trashMedia(mediaId: string) {
    const recycleTime = Temporal.Now.instant();

    return db.transaction(async (tx) => {
        const [media] = await tx
            .select({
                id: Media.id,
                post_id: Media.post_id,
                delete_status: Media.delete_status,
                recycle_time: Media.recycle_time,
            })
            .from(Media)
            .where(eq(Media.id, mediaId))
            .limit(1);

        if (!media || media.delete_status !== DeleteStatus.ACTIVE || media.recycle_time) {
            return { mediaUpdated: 0 };
        }

        const updatedMedia = await tx
            .update(Media)
            .set({
                recycle_time: recycleTime,
                post_id: null,
                sort_order: 0,
                update_time: recycleTime,
            })
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
            .returning({ id: Media.id });

        if (updatedMedia.length === 0) {
            return { mediaUpdated: 0 };
        }

        if (media.post_id) {
            const remainingMedia = await tx
                .select({ id: Media.id, sort_order: Media.sort_order })
                .from(Media)
                .where(and(eq(Media.post_id, media.post_id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .orderBy(Media.sort_order);

            for (let index = 0; index < remainingMedia.length; index++) {
                await tx
                    .update(Media)
                    .set({ sort_order: -1000 - index })
                    .where(eq(Media.id, remainingMedia[index].id));
            }

            for (let index = 0; index < remainingMedia.length; index++) {
                await tx.update(Media).set({ sort_order: index }).where(eq(Media.id, remainingMedia[index].id));
            }

            await tx.update(Post).set({ media_count: remainingMedia.length, update_time: recycleTime }).where(eq(Post.id, media.post_id));
        }

        return { mediaUpdated: updatedMedia.length };
    });
}

export async function batchRestoreMedia(mediaIds: string[]): Promise<{ mediaUpdated: number }> {
    const uniqueIds = Array.from(new Set(mediaIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
        return { mediaUpdated: 0 };
    }

    const CHUNK_SIZE = 500;
    let totalMediaUpdated = 0;

    for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
        const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
        const now = Temporal.Now.instant();

        const updated = await db
            .update(Media)
            .set({ recycle_time: null, update_time: now })
            .where(and(inArray(Media.id, chunk), eq(Media.delete_status, DeleteStatus.ACTIVE), isNotNull(Media.recycle_time)))
            .returning({ id: Media.id });

        totalMediaUpdated += updated.length;
    }

    return { mediaUpdated: totalMediaUpdated };
}

export async function restoreMedia(mediaId: string) {
    return batchRestoreMedia([mediaId]);
}

export async function batchDeleteMedia(mediaIds: string[]): Promise<{ mediaUpdated: number; fileUpdated: number }> {
    const uniqueIds = Array.from(new Set(mediaIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
        return { mediaUpdated: 0, fileUpdated: 0 };
    }

    const CHUNK_SIZE = 500;
    let totalMediaUpdated = 0;
    let totalFileUpdated = 0;

    for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
        const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
        const deleteTime = Temporal.Now.instant();

        const result = await db.transaction(async (tx) => {
            const activeMedia = await tx
                .select({ id: Media.id, post_id: Media.post_id })
                .from(Media)
                .where(and(inArray(Media.id, chunk), eq(Media.delete_status, DeleteStatus.ACTIVE)));

            if (activeMedia.length === 0) {
                return { mediaUpdated: 0, fileUpdated: 0 };
            }

            const validMediaIds = activeMedia.map((m) => m.id);

            const tracks = await tx
                .select({ file_id: Track.file_id })
                .from(Track)
                .where(and(inArray(Track.media_id, validMediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            const fileIds = Array.from(new Set(tracks.map((t) => t.file_id).filter((fileId): fileId is string => Boolean(fileId))));

            await tx.delete(MediaTag).where(inArray(MediaTag.media_id, validMediaIds));

            const updatedMedia = await tx
                .update(Media)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(inArray(Media.id, validMediaIds))
                .returning({ id: Media.id });

            await tx
                .update(Track)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(inArray(Track.media_id, validMediaIds));
            await deleteMediaAiData(tx, validMediaIds);

            let fileUpdated = 0;
            if (fileIds.length > 0) {
                const updatedFiles = await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)))
                    .returning({ id: File.id });
                fileUpdated = updatedFiles.length;
            }

            const distinctPostIds = Array.from(new Set(activeMedia.map((m) => m.post_id).filter((pid): pid is string => Boolean(pid))));

            for (const postId of distinctPostIds) {
                const [activeCount] = await tx
                    .select({ count: count() })
                    .from(Media)
                    .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
                await tx
                    .update(Post)
                    .set({ media_count: activeCount?.count ?? 0, update_time: deleteTime })
                    .where(eq(Post.id, postId));
            }

            return { mediaUpdated: updatedMedia.length, fileUpdated };
        });

        totalMediaUpdated += result.mediaUpdated;
        totalFileUpdated += result.fileUpdated;
    }

    return { mediaUpdated: totalMediaUpdated, fileUpdated: totalFileUpdated };
}

export async function deleteMedia(mediaId: string) {
    return batchDeleteMedia([mediaId]);
}
