import { and, eq, isNull } from "drizzle-orm";
import { DeleteStatus, Media, MEDIA_EDITABLE_FIELDS } from "@/db/schema";
import { db } from "@/global/db";
import { markMediaMetaChanged } from "./meta-changes";
import { changedFields, withValues } from "./ownership";

export type UpdateMediaInfoInput = {
    title?: string;
    description?: string;
    published_time?: Temporal.Instant | null;
};

export async function updateMediaInfo(id: string, fields: UpdateMediaInfoInput) {
    const updateFields: Partial<typeof Media.$inferSelect> = {
        update_time: Temporal.Now.instant(),
    };
    if (fields.title !== undefined) updateFields.title = fields.title;
    if (fields.description !== undefined) updateFields.description = fields.description;
    if (fields.published_time !== undefined) updateFields.published_time = fields.published_time;

    return db.transaction(async (tx) => {
        const active = and(eq(Media.id, id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));
        const [current] = await tx.select().from(Media).where(active).for("update");
        if (!current) return undefined;
        // What the edit changes is the user's from now on: imports leave it (docs/failure_handling.zh-Hans.md, 8.2).
        const edited = changedFields(current, fields, MEDIA_EDITABLE_FIELDS);
        const [updated] = await tx
            .update(Media)
            .set({ ...updateFields, user_edited_fields: withValues(Media.user_edited_fields, edited) })
            .where(active)
            .returning();
        await markMediaMetaChanged(tx, [id]);
        return updated;
    });
}
