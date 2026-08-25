import { and, eq, isNull } from "drizzle-orm";
import { DeleteStatus, Media } from "@/db/schema";
import { db } from "@/global/db";

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

    const [updated] = await db
        .update(Media)
        .set(updateFields)
        .where(and(eq(Media.id, id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
        .returning();
    return updated;
}
