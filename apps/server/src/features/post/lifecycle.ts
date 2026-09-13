import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/global/db";
import { DeleteStatus, File, Media, MediaTag, Post, PostTag, Track } from "@/db/schema";

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

export async function batchRestorePost(postIds: string[]): Promise<{
    postUpdated: number;
    mediaUpdated: number;
}> {
    const uniqueIds = Array.from(new Set(postIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
        return { postUpdated: 0, mediaUpdated: 0 };
    }

    const CHUNK_SIZE = 500;
    let totalPostUpdated = 0;
    let totalMediaUpdated = 0;

    for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
        const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
        const now = Temporal.Now.instant();

        const result = await db.transaction(async (tx) => {
            const validPosts = await tx
                .select({ id: Post.id, recycle_time: Post.recycle_time })
                .from(Post)
                .where(and(inArray(Post.id, chunk), eq(Post.delete_status, DeleteStatus.ACTIVE), isNotNull(Post.recycle_time)));

            if (validPosts.length === 0) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const validPostIds = validPosts.map((p) => p.id);

            const restoredPosts = await tx
                .update(Post)
                .set({ recycle_time: null, update_time: now })
                .where(inArray(Post.id, validPostIds))
                .returning({ id: Post.id });

            const restoredMedias = await tx
                .update(Media)
                .set({ recycle_time: null, update_time: now })
                .where(
                    and(inArray(Media.post_id, validPostIds), eq(Media.delete_status, DeleteStatus.ACTIVE), isNotNull(Media.recycle_time)),
                )
                .returning({ id: Media.id });

            return {
                postUpdated: restoredPosts.length,
                mediaUpdated: restoredMedias.length,
            };
        });

        totalPostUpdated += result.postUpdated;
        totalMediaUpdated += result.mediaUpdated;
    }

    return {
        postUpdated: totalPostUpdated,
        mediaUpdated: totalMediaUpdated,
    };
}

export async function restorePost(postId: string) {
    return batchRestorePost([postId]);
}

export async function batchDeletePost(postIds: string[]): Promise<{
    postUpdated: number;
    mediaUpdated: number;
    fileUpdated: number;
}> {
    const uniqueIds = Array.from(new Set(postIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
        return { postUpdated: 0, mediaUpdated: 0, fileUpdated: 0 };
    }

    const CHUNK_SIZE = 500;
    let totalPostUpdated = 0;
    let totalMediaUpdated = 0;
    let totalFileUpdated = 0;

    for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
        const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
        const deleteTime = Temporal.Now.instant();

        const result = await db.transaction(async (tx) => {
            const validPosts = await tx
                .select({ id: Post.id })
                .from(Post)
                .where(and(inArray(Post.id, chunk), eq(Post.delete_status, DeleteStatus.ACTIVE)));

            if (validPosts.length === 0) {
                return { postUpdated: 0, mediaUpdated: 0, fileUpdated: 0 };
            }

            const validPostIds = validPosts.map((p) => p.id);

            const childMedias = await tx
                .select({ id: Media.id })
                .from(Media)
                .where(and(inArray(Media.post_id, validPostIds), eq(Media.delete_status, DeleteStatus.ACTIVE)));

            const mediaIds = childMedias.map((m) => m.id);

            let fileIds: string[] = [];
            if (mediaIds.length > 0) {
                const tracks = await tx
                    .select({ file_id: Track.file_id })
                    .from(Track)
                    .where(and(inArray(Track.media_id, mediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));
                fileIds = Array.from(new Set(tracks.map((t) => t.file_id).filter((fileId): fileId is string => Boolean(fileId))));
            }

            await tx.delete(PostTag).where(inArray(PostTag.post_id, validPostIds));
            if (mediaIds.length > 0) {
                await tx.delete(MediaTag).where(inArray(MediaTag.media_id, mediaIds));
            }

            const updatedPosts = await tx
                .update(Post)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(inArray(Post.id, validPostIds))
                .returning({ id: Post.id });

            let mediaUpdated = 0;
            if (mediaIds.length > 0) {
                const updatedMedias = await tx
                    .update(Media)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                    .where(inArray(Media.id, mediaIds))
                    .returning({ id: Media.id });
                mediaUpdated = updatedMedias.length;

                await tx
                    .update(Track)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                    .where(inArray(Track.media_id, mediaIds));
            }

            let fileUpdated = 0;
            if (fileIds.length > 0) {
                const updatedFiles = await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)))
                    .returning({ id: File.id });
                fileUpdated = updatedFiles.length;
            }

            return {
                postUpdated: updatedPosts.length,
                mediaUpdated,
                fileUpdated,
            };
        });

        totalPostUpdated += result.postUpdated;
        totalMediaUpdated += result.mediaUpdated;
        totalFileUpdated += result.fileUpdated;
    }

    return {
        postUpdated: totalPostUpdated,
        mediaUpdated: totalMediaUpdated,
        fileUpdated: totalFileUpdated,
    };
}

export async function deletePost(postId: string) {
    return batchDeletePost([postId]);
}
