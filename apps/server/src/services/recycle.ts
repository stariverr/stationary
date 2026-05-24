import { and, count, eq, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/global/db";
import { Media, Post } from "@/db/schema";
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
            if (!post || post.delete_status !== "ACTIVE" || post.recycle_time) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const updatedPost = await tx
                .update(Post)
                .set({ recycle_time: recycleTime })
                .where(
                    and(
                        eq(Post.id, postId),
                        eq(Post.delete_status, "ACTIVE"),
                        isNull(Post.recycle_time),
                    ),
                )
                .returning({ id: Post.id });

            if (updatedPost.length === 0) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const updatedMedia = await tx
                .update(Media)
                .set({ recycle_time: recycleTime })
                .where(
                    and(
                        eq(Media.post_id, postId),
                        eq(Media.delete_status, "ACTIVE"),
                        isNull(Media.recycle_time),
                    ),
                )
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
            if (!post || post.delete_status !== "ACTIVE" || !post.recycle_time) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const restoredPost = await tx
                .update(Post)
                .set({ recycle_time: null })
                .where(
                    and(
                        eq(Post.id, postId),
                        eq(Post.delete_status, "ACTIVE"),
                        isNotNull(Post.recycle_time),
                    ),
                )
                .returning({ id: Post.id });

            if (restoredPost.length === 0) {
                return { postUpdated: 0, mediaUpdated: 0 };
            }

            const restoredMedia = await tx
                .update(Media)
                .set({ recycle_time: null })
                .where(
                    and(
                        eq(Media.post_id, postId),
                        eq(Media.delete_status, "ACTIVE"),
                        eq(Media.recycle_time, post.recycle_time),
                    ),
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

        const updatedMedia = await db
            .update(Media)
            .set({ recycle_time: recycleTime })
            .where(
                and(
                    eq(Media.id, mediaId),
                    eq(Media.delete_status, "ACTIVE"),
                    isNull(Media.recycle_time),
                ),
            )
            .returning({ id: Media.id });

        return { mediaUpdated: updatedMedia.length };
    },

    async restoreMedia(mediaId: string) {
        const restoredMedia = await db
            .update(Media)
            .set({ recycle_time: null })
            .where(
                and(
                    eq(Media.id, mediaId),
                    eq(Media.delete_status, "ACTIVE"),
                    isNotNull(Media.recycle_time),
                ),
            )
            .returning({ id: Media.id });

        return { mediaUpdated: restoredMedia.length };
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
                .where(and(eq(Post.library_id, libraryId), eq(Post.delete_status, "ACTIVE")))
                .limit(1),
            db
                .select({ total: count() })
                .from(Media)
                .where(and(eq(Media.library_id, libraryId), eq(Media.delete_status, "ACTIVE")))
                .limit(1),
        ]);

        return (postRows[0]?.total ?? 0) > 0 || (mediaRows[0]?.total ?? 0) > 0;
    },
};
