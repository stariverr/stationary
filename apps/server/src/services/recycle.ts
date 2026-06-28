import { and, count, eq, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/global/db";
import { DeleteStatus, Media, Post } from "@/db/schema";
import { nowDbTimestamp } from "@/lib/utils/time";

export const RecycleService = {
    async recyclePost(postId: string) {
        const recycleTime = nowDbTimestamp();

        return db.transaction(async (tx) => {
            const postRows = await tx
                .select({
                    id: Post.id,
                    delete_status: Post.delete_status,
                    recycle_time: Post.recycle_time,
                })
                .from(Post)
                .where(eq(Post.id, postId))
                .limit(1);

            const post = postRows[0];
            if (!post || post.delete_status !== DeleteStatus.ACTIVE || post.recycle_time) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const updatedPost = await tx
                .update(Post)
                .set({ recycle_time: recycleTime })
                .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE), isNull(Post.recycle_time)))
                .returning({ id: Post.id });

            if (updatedPost.length === 0) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const updatedMedia = await tx
                .update(Media)
                .set({ recycle_time: recycleTime })
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .returning({ id: Media.id });

            return {
                postUpdated: updatedPost.length,
                mediaUpdated: updatedMedia.length,
            };
        });
    },

    async restorePost(postId: string) {
        return db.transaction(async (tx) => {
            const postRows = await tx
                .select({
                    id: Post.id,
                    delete_status: Post.delete_status,
                    recycle_time: Post.recycle_time,
                })
                .from(Post)
                .where(eq(Post.id, postId))
                .limit(1);

            const post = postRows[0];
            if (!post || post.delete_status !== DeleteStatus.ACTIVE || !post.recycle_time) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const restoredPost = await tx
                .update(Post)
                .set({ recycle_time: null })
                .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE), isNotNull(Post.recycle_time)))
                .returning({ id: Post.id });

            if (restoredPost.length === 0) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const restoredMedia = await tx
                .update(Media)
                .set({ recycle_time: null })
                .where(
                    and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), eq(Media.recycle_time, post.recycle_time)),
                )
                .returning({ id: Media.id });

            return {
                postUpdated: restoredPost.length,
                mediaUpdated: restoredMedia.length,
            };
        });
    },

    async recycleMedia(mediaId: string) {
        const recycleTime = nowDbTimestamp();

        return db.transaction(async (tx) => {
            const mediaRows = await tx
                .select({
                    id: Media.id,
                    post_id: Media.post_id,
                    delete_status: Media.delete_status,
                    recycle_time: Media.recycle_time,
                })
                .from(Media)
                .where(eq(Media.id, mediaId))
                .limit(1);

            const media = mediaRows[0];
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

            const postId = media.post_id;
            if (postId) {
                const remainingMedia = await tx
                    .select({
                        id: Media.id,
                        sort_order: Media.sort_order,
                    })
                    .from(Media)
                    .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                    .orderBy(Media.sort_order);

                // First pass: assign temporary negative sort orders
                for (let i = 0; i < remainingMedia.length; i++) {
                    await tx
                        .update(Media)
                        .set({ sort_order: -1000 - i })
                        .where(eq(Media.id, remainingMedia[i].id));
                }
                // Second pass: assign final contiguous sort orders
                for (let i = 0; i < remainingMedia.length; i++) {
                    await tx.update(Media).set({ sort_order: i }).where(eq(Media.id, remainingMedia[i].id));
                }

                await tx
                    .update(Post)
                    .set({
                        media_count: remainingMedia.length,
                        update_time: recycleTime,
                    })
                    .where(eq(Post.id, postId));
            }

            return { mediaUpdated: updatedMedia.length };
        });
    },

    async restoreMedia(mediaId: string) {
        return db.transaction(async (tx) => {
            const mediaRows = await tx
                .select({
                    id: Media.id,
                    post_id: Media.post_id,
                    delete_status: Media.delete_status,
                    recycle_time: Media.recycle_time,
                })
                .from(Media)
                .where(eq(Media.id, mediaId))
                .limit(1);

            const media = mediaRows[0];
            if (!media || media.delete_status !== DeleteStatus.ACTIVE || !media.recycle_time) {
                return { mediaUpdated: 0 };
            }

            const restoredMedia = await tx
                .update(Media)
                .set({
                    recycle_time: null,
                    update_time: nowDbTimestamp(),
                })
                .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNotNull(Media.recycle_time)))
                .returning({ id: Media.id });

            return { mediaUpdated: restoredMedia.length };
        });
    },

    /** Check if the library has posts or media.
     *
     * Only when the library is empty, can it be deleted.
     */
    async libraryHasContent(libraryId: string) {
        const [postRows, mediaRows] = await Promise.all([
            db
                .select({ total: count() })
                .from(Post)
                .where(and(eq(Post.library_id, libraryId), eq(Post.delete_status, DeleteStatus.ACTIVE)))
                .limit(1),
            db
                .select({ total: count() })
                .from(Media)
                .where(and(eq(Media.library_id, libraryId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                .limit(1),
        ]);

        return (postRows[0]?.total ?? 0) > 0 || (mediaRows[0]?.total ?? 0) > 0;
    },
};
