import { and, eq, inArray } from "drizzle-orm";
import { db, Transaction } from "@/global/db";
import { Media, MediaTag } from "@/db/schema";
import { nowDbTimestamp } from "@/lib/utils/time";
import { Temporal } from "@js-temporal/polyfill";

export async function replaceMediaTagsTx(tx: Transaction, mediaId: string, libraryId: string, tagIds: string[]) {
    const existing = await tx.select({ tag_id: MediaTag.tag_id }).from(MediaTag).where(eq(MediaTag.media_id, mediaId));
    const existingIds = new Set(existing.map((r) => r.tag_id));
    const newIds = new Set(tagIds);

    const toDelete = Array.from(existingIds).filter((id) => !newIds.has(id));
    const toInsert = Array.from(newIds).filter((id) => !existingIds.has(id));

    if (toDelete.length > 0) {
        await tx.delete(MediaTag).where(and(eq(MediaTag.media_id, mediaId), inArray(MediaTag.tag_id, toDelete)));
    }
    if (toInsert.length > 0) {
        await tx.insert(MediaTag).values(
            toInsert.map((tagId) => ({
                media_id: mediaId,
                tag_id: tagId,
            })),
        );
    }
}

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

    async replaceTags(id: string, libraryId: string, tagIds: string[]) {
        return db.transaction(async (tx) => {
            await replaceMediaTagsTx(tx, id, libraryId, tagIds);
            return tagIds;
        });
    },
};
