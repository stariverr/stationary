import { and, count, eq, isNull, inArray } from "drizzle-orm";
import { db, Transaction } from "@/global/db";
import { DeleteStatus, Media, Post, PostTag } from "@/db/schema";
import { nowDbTimestamp } from "@/lib/utils/time";
import { Temporal } from "@js-temporal/polyfill";

/**
 * Transactional helper to replace post tags.
 * Computes a diff of existing vs new tags to minimize database operations,
 * deleting only removed associations and inserting only new ones.
 *
 * @param tx - The active database transaction
 * @param postId - ID of the target post
 * @param libraryId - ID of the parent library
 * @param tagIds - List of new tag IDs to associate
 */
export async function replacePostTagsTx(tx: Transaction, postId: string, libraryId: string, tagIds: string[]) {
    // 1. Fetch current tag associations for the post
    const existing = await tx.select({ tag_id: PostTag.tag_id }).from(PostTag).where(eq(PostTag.post_id, postId));
    const existingIds = new Set(existing.map((r) => r.tag_id));
    const newIds = new Set(tagIds);

    // 2. Identify associations to remove and to add
    const toDelete = Array.from(existingIds).filter((id) => !newIds.has(id));
    const toInsert = Array.from(newIds).filter((id) => !existingIds.has(id));

    // 3. Perform batch deletions for removed tags
    if (toDelete.length > 0) {
        await tx.delete(PostTag).where(and(eq(PostTag.post_id, postId), inArray(PostTag.tag_id, toDelete)));
    }

    // 4. Perform batch insertions for new tags
    if (toInsert.length > 0) {
        await tx.insert(PostTag).values(
            toInsert.map((tagId) => ({
                post_id: postId,
                tag_id: tagId,
            })),
        );
    }
}

/**
 * Service to handle business logic for Posts.
 */
export const PostService = {
    /**
     * Updates post details such as title, description, published time, and URL.
     *
     * @param id - The ID of the post to update
     * @param fields - Partial set of fields to update
     * @returns The updated post record
     */
    async updateInfo(
        id: string,
        fields: {
            title?: string;
            description?: string;
            published_time?: Temporal.Instant | null;
            url?: string | null;
        },
    ) {
        const updateFields: any = {
            update_time: nowDbTimestamp(),
        };
        if (fields.title !== undefined) updateFields.title = fields.title;
        if (fields.description !== undefined) updateFields.description = fields.description;
        if (fields.published_time !== undefined) updateFields.published_time = fields.published_time;
        if (fields.url !== undefined) updateFields.url = fields.url;

        const updated = await db.update(Post).set(updateFields).where(eq(Post.id, id)).returning();
        return updated[0];
    },

    /**
     * Wraps the tag replacement helper inside a database transaction.
     *
     * @param id - The ID of the post
     * @param libraryId - The ID of the library the post belongs to
     * @param tagIds - List of tag IDs to assign
     * @returns The resolved list of tag IDs
     */
    async replaceTags(id: string, libraryId: string, tagIds: string[]) {
        return db.transaction(async (tx) => {
            await replacePostTagsTx(tx, id, libraryId, tagIds);
            return tagIds;
        });
    },

    /**
     * Attaches media items to a post.
     * Performs boundary checks to verify that the media items exist, are active,
     * belong to the correct library, and are not already attached to another post.
     * Calculates the sorting order to append them at the end.
     *
     * @param postId - ID of the target post
     * @param libraryId - ID of the parent library
     * @param mediaIds - List of media IDs to attach
     * @returns An object indicating success, number of attached items, and new total media count, or an error message
     */
    async bindMedia(postId: string, libraryId: string, mediaIds: string[]) {
        return db.transaction(async (tx) => {
            // Deduplicate input media IDs to avoid redundant processing
            const uniqueMediaIds = Array.from(new Set(mediaIds));

            // Fetch target media items that are
            // 1. Active
            // 2. Not in the recycle bin
            // 3. Belonging to the same library
            const targetMedias = await tx
                .select({
                    id: Media.id,
                    post_id: Media.post_id,
                    library_id: Media.library_id,
                    delete_status: Media.delete_status,
                    recycle_time: Media.recycle_time,
                })
                .from(Media)
                .where(
                    and(
                        eq(Media.library_id, libraryId),
                        eq(Media.delete_status, DeleteStatus.ACTIVE),
                        inArray(Media.id, uniqueMediaIds),
                        isNull(Media.recycle_time),
                    ),
                );

            // Validate that all requested media items were found
            if (targetMedias.length !== uniqueMediaIds.length) {
                return { error: "Some media items do not exist or are in the recycle bin" };
            }

            // Ensure access control rules and single-association rules are respected
            for (const media of targetMedias) {
                if (media.post_id !== null && media.post_id !== postId) {
                    return { error: `Media item ${media.id} is not isolated media, please unattach it from other post` };
                }
            }

            // Fetch current active media items already attached to the post to determine current sorting boundaries
            const currentActiveMedias = await tx
                .select({
                    id: Media.id,
                    sort_order: Media.sort_order,
                })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .orderBy(Media.sort_order);

            // Compute the maximum sort order to append new items cleanly at the end
            let maxSortOrder = -1;
            for (const cam of currentActiveMedias) {
                if (cam.sort_order > maxSortOrder) {
                    maxSortOrder = cam.sort_order;
                }
            }

            // Attach new media items and update their sorting orders
            let attachedCount = 0;
            for (const mediaId of uniqueMediaIds) {
                const isAlreadyAttached = currentActiveMedias.some((cam) => cam.id === mediaId);
                if (!isAlreadyAttached) {
                    maxSortOrder++;
                    await tx
                        .update(Media)
                        .set({
                            post_id: postId,
                            sort_order: maxSortOrder,
                            update_time: nowDbTimestamp(),
                        })
                        .where(eq(Media.id, mediaId));
                    attachedCount++;
                }
            }

            // Recalculate total active media count for the post
            const totalActiveCount = await tx
                .select({ count: count() })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .then((rows) => rows[0].count);

            // Sync the media count back to the post metadata
            await tx
                .update(Post)
                .set({
                    media_count: totalActiveCount,
                    update_time: nowDbTimestamp(),
                })
                .where(eq(Post.id, postId));

            return { success: true, attached: attachedCount, total: totalActiveCount };
        });
    },

    /**
     * Reorders the media items associated with a post.
     * Uses a temporary negative ordering technique to bypass potential unique key constraint violations.
     *
     * @param postId - ID of the target post
     * @param mediaIds - Ordered list of media IDs representing the new order
     * @returns An object indicating success, or an error message
     */
    async reorderMedia(postId: string, mediaIds: string[]) {
        return db.transaction(async (tx) => {
            const uniqueMediaIds = Array.from(new Set(mediaIds));

            // Fetch currently active media items attached to the post
            const currentActiveMedias = await tx
                .select({ id: Media.id })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));

            const activeIdsSet = new Set(currentActiveMedias.map((m) => m.id));

            // Verify that the count matches
            if (uniqueMediaIds.length !== currentActiveMedias.length) {
                return { error: "Provided media list length does not match active post media list length" };
            }

            // Verify that all provided media IDs belong to this post
            for (const mediaId of uniqueMediaIds) {
                if (!activeIdsSet.has(mediaId)) {
                    return { error: `Media item ${mediaId} is not active or does not belong to this post` };
                }
            }

            // Phase 1: Move items to a temporary, conflicts-free sort index range (negative numbers).
            // This prevents unique key constraint violations (e.g. unique constraint on post_id + sort_order)
            // while shifting orders.
            for (let i = 0; i < uniqueMediaIds.length; i++) {
                await tx
                    .update(Media)
                    .set({ sort_order: -1000 - i })
                    .where(eq(Media.id, uniqueMediaIds[i]));
            }

            // Phase 2: Shift items to their final, target sort indexes.
            for (let i = 0; i < uniqueMediaIds.length; i++) {
                await tx
                    .update(Media)
                    .set({
                        sort_order: i,
                        update_time: nowDbTimestamp(),
                    })
                    .where(eq(Media.id, uniqueMediaIds[i]));
            }

            return { success: true };
        });
    },

    /**
     * Unbind a media item from a post
     * Resets the media item's post association, re-indexes the remaining media items
     * to keep sort order contiguous, and updates the post's cached media count.
     *
     * @param postId - ID of the post
     * @param mediaId - ID of the media item to remove
     * @returns An object indicating success and the new remaining media count, or an error message
     */
    async unbindMedia(postId: string, mediaId: string) {
        return db.transaction(async (tx) => {
            // Fetch target media item details
            const mediaRows = await tx
                .select({
                    id: Media.id,
                    post_id: Media.post_id,
                    library_id: Media.library_id,
                    delete_status: Media.delete_status,
                    recycle_time: Media.recycle_time,
                })
                .from(Media)
                .where(eq(Media.id, mediaId))
                .limit(1);

            const media = mediaRows[0];
            if (!media || media.delete_status !== DeleteStatus.ACTIVE || media.recycle_time !== null) {
                return { error: "Media item not found or is in recycle bin" };
            }

            if (media.post_id !== postId) {
                return { error: "Media item is not associated with this post" };
            }

            // Reset post association and sort order
            await tx
                .update(Media)
                .set({
                    post_id: null,
                    sort_order: 0,
                    update_time: nowDbTimestamp(),
                })
                .where(eq(Media.id, mediaId));

            // Fetch the remaining media items still associated with the post
            const remainingMedias = await tx
                .select({ id: Media.id, sort_order: Media.sort_order })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .orderBy(Media.sort_order);

            // Phase 1: Reorder remaining items to negative range to avoid database conflicts
            for (let i = 0; i < remainingMedias.length; i++) {
                await tx
                    .update(Media)
                    .set({ sort_order: -1000 - i })
                    .where(eq(Media.id, remainingMedias[i].id));
            }

            // Phase 2: Set final contiguous sort order starting from 0
            for (let i = 0; i < remainingMedias.length; i++) {
                await tx
                    .update(Media)
                    .set({
                        sort_order: i,
                        update_time: nowDbTimestamp(),
                    })
                    .where(eq(Media.id, remainingMedias[i].id));
            }

            // Recalculate total remaining active media count
            const totalActiveCount = await tx
                .select({ count: count() })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .then((rows) => rows[0].count);

            // Sync the updated count back to the post metadata
            await tx
                .update(Post)
                .set({
                    media_count: totalActiveCount,
                    update_time: nowDbTimestamp(),
                })
                .where(eq(Post.id, postId));

            return { success: true, remaining: totalActiveCount };
        });
    },
};
