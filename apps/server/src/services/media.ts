import { and, eq, isNull, inArray, notInArray } from "drizzle-orm";
import { db } from "@/global/db";
import { DeleteStatus, Media, Tag, MediaTag, TagStatus, TagSource } from "@/db/schema";
import { nowDbTimestamp } from "@/lib/utils/time";
import { normalizeTagName } from "@/lib/utils/tag_sanitizer";
import { Temporal } from "@js-temporal/polyfill";

export const MediaService = {
    async updateInfo(
        id: string,
        fields: {
            title?: string;
            description?: string;
            published_time?: Temporal.Instant | null;
        },
    ) {
        const updateFields: any = {
            update_time: nowDbTimestamp(),
        };
        if (fields.title !== undefined) updateFields.title = fields.title;
        if (fields.description !== undefined) updateFields.description = fields.description;
        if (fields.published_time !== undefined) updateFields.published_time = fields.published_time;

        const updated = await db.update(Media).set(updateFields).where(eq(Media.id, id)).returning();
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
                await tx.delete(MediaTag).where(and(eq(MediaTag.media_id, id), notInArray(MediaTag.tag_id, tagIds)));

                for (const tagId of tagIds) {
                    await tx
                        .insert(MediaTag)
                        .values({
                            media_id: id,
                            tag_id: tagId,
                        })
                        .onConflictDoNothing();
                }
            } else {
                await tx.delete(MediaTag).where(eq(MediaTag.media_id, id));
            }

            return tagIds;
        });
    },
};
