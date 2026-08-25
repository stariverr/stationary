import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/global/db";
import { DeleteStatus, File, Media, MediaTag, Post, Track } from "@/db/schema";

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

            await tx
                .update(Post)
                .set({ media_count: remainingMedia.length, update_time: recycleTime })
                .where(eq(Post.id, media.post_id));
        }

        return { mediaUpdated: updatedMedia.length };
    });
}

export async function restoreMedia(mediaId: string) {
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

        if (!media || media.delete_status !== DeleteStatus.ACTIVE || !media.recycle_time) {
            return { mediaUpdated: 0 };
        }

        const restoredMedia = await tx
            .update(Media)
            .set({ recycle_time: null, update_time: Temporal.Now.instant() })
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNotNull(Media.recycle_time)))
            .returning({ id: Media.id });

        return { mediaUpdated: restoredMedia.length };
    });
}

export async function deleteMedia(mediaId: string) {
    const deleteTime = Temporal.Now.instant();

    return db.transaction(async (tx) => {
        const [media] = await tx
            .select({ id: Media.id, post_id: Media.post_id })
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        if (!media) return { mediaUpdated: 0 };

        const tracks = await tx
            .select({ file_id: Track.file_id })
            .from(Track)
            .where(and(eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));
        const fileIds = tracks.map((track) => track.file_id).filter((fileId): fileId is string => Boolean(fileId));

        await tx.delete(MediaTag).where(eq(MediaTag.media_id, mediaId));
        await tx
            .update(Media)
            .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
            .where(eq(Media.id, mediaId));
        await tx
            .update(Track)
            .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
            .where(eq(Track.media_id, mediaId));

        if (fileIds.length > 0) {
            await tx
                .update(File)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
        }

        if (media.post_id) {
            const [activeCount] = await tx
                .select({ count: count() })
                .from(Media)
                .where(and(eq(Media.post_id, media.post_id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
            await tx
                .update(Post)
                .set({ media_count: activeCount?.count ?? 0, update_time: deleteTime })
                .where(eq(Post.id, media.post_id));
        }

        return { mediaUpdated: 1, fileUpdated: fileIds.length };
    });
}
