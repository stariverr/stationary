import { and, count, eq, isNull, inArray, notInArray } from "drizzle-orm";
import { db } from "@/global/db";
import { DeleteStatus, Media, Post, Tag, PostTag, TagStatus, TagSource } from "@/db/schema";
import { nowDbTimestamp } from "@/lib/utils/time";
import { normalizeTagName } from "@/lib/utils/tag_sanitizer";
import { Temporal } from "@js-temporal/polyfill";

export const PostService = {
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

    async replaceTags(id: string, libraryId: string, tags: string[]) {
        return db.transaction(async (tx) => {
            const tagIds: string[] = [];
            const uniqueTags = Array.from(new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)));

            for (const tagName of uniqueTags) {
                const normalized = normalizeTagName(tagName);
                let tagRecord = await tx
                    .select()
                    .from(Tag)
                    .where(and(eq(Tag.library_id, libraryId), eq(Tag.normalized_name, normalized)))
                    .limit(1)
                    .then((rows) => rows[0]);

                if (tagRecord) {
                    if (tagRecord.status !== TagStatus.ACTIVE) {
                        await tx
                            .update(Tag)
                            .set({ status: TagStatus.ACTIVE, update_time: nowDbTimestamp() })
                            .where(eq(Tag.id, tagRecord.id));
                    }
                } else {
                    const inserted = await tx
                        .insert(Tag)
                        .values({
                            name: tagName,
                            normalized_name: normalized,
                            library_id: libraryId,
                            status: TagStatus.ACTIVE,
                            source: TagSource.USER,
                        })
                        .returning();
                    tagRecord = inserted[0];
                }

                if (tagRecord) {
                    tagIds.push(tagRecord.id);
                }
            }

            if (tagIds.length > 0) {
                await tx.delete(PostTag).where(eq(PostTag.post_id, id));

                for (const tagId of tagIds) {
                    await tx
                        .insert(PostTag)
                        .values({
                            post_id: id,
                            tag_id: tagId,
                        });
                }
            } else {
                await tx.delete(PostTag).where(eq(PostTag.post_id, id));
            }

            await tx
                .update(Post)
                .set({
                    tags: uniqueTags,
                    update_time: nowDbTimestamp(),
                })
                .where(eq(Post.id, id));

            return tagIds;
        });
    },

    async attachMedia(postId: string, libraryId: string, mediaIds: string[]) {
        return db.transaction(async (tx) => {
            const uniqueMediaIds = Array.from(new Set(mediaIds));

            const targetMedias = await tx
                .select({
                    id: Media.id,
                    post_id: Media.post_id,
                    library_id: Media.library_id,
                    delete_status: Media.delete_status,
                    recycle_time: Media.recycle_time,
                })
                .from(Media)
                .where(and(inArray(Media.id, uniqueMediaIds), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));

            if (targetMedias.length !== uniqueMediaIds.length) {
                return { error: "Some media items do not exist or are in the recycle bin" };
            }

            for (const media of targetMedias) {
                if (media.library_id !== libraryId) {
                    return { error: `Media item ${media.id} belongs to a different library` };
                }
                if (media.post_id !== null && media.post_id !== postId) {
                    return { error: `Media item ${media.id} is already attached to another post` };
                }
            }

            const currentActiveMedias = await tx
                .select({
                    id: Media.id,
                    sort_order: Media.sort_order,
                })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .orderBy(Media.sort_order);

            let maxSortOrder = -1;
            for (const cam of currentActiveMedias) {
                if (cam.sort_order > maxSortOrder) {
                    maxSortOrder = cam.sort_order;
                }
            }

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

            const totalActiveCount = await tx
                .select({ count: count() })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .then((rows) => rows[0].count);

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

    async reorderMedia(postId: string, mediaIds: string[]) {
        return db.transaction(async (tx) => {
            const uniqueMediaIds = Array.from(new Set(mediaIds));

            const currentActiveMedias = await tx
                .select({ id: Media.id })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));

            const activeIdsSet = new Set(currentActiveMedias.map((m) => m.id));

            if (uniqueMediaIds.length !== currentActiveMedias.length) {
                return { error: "Provided media list length does not match active post media list length" };
            }

            for (const mediaId of uniqueMediaIds) {
                if (!activeIdsSet.has(mediaId)) {
                    return { error: `Media item ${mediaId} is not active or does not belong to this post` };
                }
            }

            for (let i = 0; i < uniqueMediaIds.length; i++) {
                await tx
                    .update(Media)
                    .set({ sort_order: -1000 - i })
                    .where(eq(Media.id, uniqueMediaIds[i]));
            }

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

    async removeMedia(postId: string, mediaId: string) {
        return db.transaction(async (tx) => {
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

            await tx
                .update(Media)
                .set({
                    post_id: null,
                    sort_order: 0,
                    update_time: nowDbTimestamp(),
                })
                .where(eq(Media.id, mediaId));

            const remainingMedias = await tx
                .select({ id: Media.id, sort_order: Media.sort_order })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .orderBy(Media.sort_order);

            for (let i = 0; i < remainingMedias.length; i++) {
                await tx
                    .update(Media)
                    .set({ sort_order: -1000 - i })
                    .where(eq(Media.id, remainingMedias[i].id));
            }

            for (let i = 0; i < remainingMedias.length; i++) {
                await tx
                    .update(Media)
                    .set({
                        sort_order: i,
                        update_time: nowDbTimestamp(),
                    })
                    .where(eq(Media.id, remainingMedias[i].id));
            }

            const totalActiveCount = await tx
                .select({ count: count() })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .then((rows) => rows[0].count);

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
