import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/global/db";
import { DeleteStatus, File, Media, Post, PostTag, Track } from "@/db/schema";

export async function trashPost(postId: string) {
    const recycleTime = Temporal.Now.instant();

    return db.transaction(async (tx) => {
        const [post] = await tx
            .select({
                id: Post.id,
                delete_status: Post.delete_status,
                recycle_time: Post.recycle_time,
            })
            .from(Post)
            .where(eq(Post.id, postId))
            .limit(1);

        if (!post || post.delete_status !== DeleteStatus.ACTIVE || post.recycle_time) {
            return { postUpdated: 0, mediaUpdated: 0 };
        }

        const updatedPost = await tx
            .update(Post)
            .set({ recycle_time: recycleTime, update_time: recycleTime })
            .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE), isNull(Post.recycle_time)))
            .returning({ id: Post.id });

        if (updatedPost.length === 0) {
            return { postUpdated: 0, mediaUpdated: 0 };
        }

        const updatedMedia = await tx
            .update(Media)
            .set({ recycle_time: recycleTime, update_time: recycleTime })
            .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
            .returning({ id: Media.id });

        return {
            postUpdated: updatedPost.length,
            mediaUpdated: updatedMedia.length,
        };
    });
}

export async function restorePost(postId: string) {
    return db.transaction(async (tx) => {
        const [post] = await tx
            .select({
                id: Post.id,
                delete_status: Post.delete_status,
                recycle_time: Post.recycle_time,
            })
            .from(Post)
            .where(eq(Post.id, postId))
            .limit(1);

        if (!post || post.delete_status !== DeleteStatus.ACTIVE || !post.recycle_time) {
            return { postUpdated: 0, mediaUpdated: 0 };
        }

        const restoredPost = await tx
            .update(Post)
            .set({ recycle_time: null, update_time: Temporal.Now.instant() })
            .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE), isNotNull(Post.recycle_time)))
            .returning({ id: Post.id });

        if (restoredPost.length === 0) {
            return { postUpdated: 0, mediaUpdated: 0 };
        }

        const restoredMedia = await tx
            .update(Media)
            .set({ recycle_time: null, update_time: Temporal.Now.instant() })
            .where(
                and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), eq(Media.recycle_time, post.recycle_time)),
            )
            .returning({ id: Media.id });

        return {
            postUpdated: restoredPost.length,
            mediaUpdated: restoredMedia.length,
        };
    });
}

export async function deletePost(postId: string) {
    const deleteTime = Temporal.Now.instant();

    return db.transaction(async (tx) => {
        const posts = await tx
            .select({ id: Post.id })
            .from(Post)
            .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        if (posts.length === 0) return { postUpdated: 0 };

        const medias = await tx
            .select({ id: Media.id })
            .from(Media)
            .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)));
        const mediaIds = medias.map((media) => media.id);

        let fileIds: string[] = [];
        if (mediaIds.length > 0) {
            const tracks = await tx
                .select({ file_id: Track.file_id })
                .from(Track)
                .where(and(inArray(Track.media_id, mediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));
            fileIds = tracks.map((track) => track.file_id).filter((fileId): fileId is string => Boolean(fileId));
        }

        await tx.delete(PostTag).where(eq(PostTag.post_id, postId));
        await tx
            .update(Post)
            .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
            .where(eq(Post.id, postId));

        if (mediaIds.length > 0) {
            await tx
                .update(Media)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(inArray(Media.id, mediaIds));
            await tx
                .update(Track)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(inArray(Track.media_id, mediaIds));
        }

        if (fileIds.length > 0) {
            await tx
                .update(File)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
        }

        return { postUpdated: 1, mediaUpdated: mediaIds.length, fileUpdated: fileIds.length };
    });
}
