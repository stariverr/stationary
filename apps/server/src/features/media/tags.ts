import { and, eq, inArray } from "drizzle-orm";
import { Media, MediaTag, Tag, DeleteStatus } from "@/db/schema";
import { db, type Transaction } from "@/global/db";

export async function replaceMediaTagsTx(tx: Transaction, mediaId: string, libraryId: string, tagIds: string[]) {
    const [media] = await tx
        .select({ id: Media.id, library_id: Media.library_id, delete_status: Media.delete_status })
        .from(Media)
        .where(eq(Media.id, mediaId))
        .limit(1);
    if (!media || media.delete_status !== DeleteStatus.ACTIVE || media.library_id !== libraryId) {
        throw new Error("Media does not belong to the supplied active library");
    }

    const newIds = new Set(tagIds);
    if (newIds.size > 0) {
        const validTags = await tx
            .select({ id: Tag.id })
            .from(Tag)
            .where(and(eq(Tag.library_id, libraryId), inArray(Tag.id, [...newIds])));
        if (validTags.length !== newIds.size) {
            throw new Error("One or more tags do not belong to the media library");
        }
    }

    const existing = await tx.select({ tag_id: MediaTag.tag_id }).from(MediaTag).where(eq(MediaTag.media_id, mediaId));
    const existingIds = new Set(existing.map((row) => row.tag_id));
    const toDelete = Array.from(existingIds).filter((id) => !newIds.has(id));
    const toInsert = Array.from(newIds).filter((id) => !existingIds.has(id));

    if (toDelete.length > 0) {
        await tx.delete(MediaTag).where(and(eq(MediaTag.media_id, mediaId), inArray(MediaTag.tag_id, toDelete)));
    }
    if (toInsert.length > 0) {
        await tx.insert(MediaTag).values(toInsert.map((tagId) => ({ media_id: mediaId, tag_id: tagId })));
    }
}

export async function replaceMediaTags(mediaId: string, libraryId: string, tagIds: string[]) {
    return db.transaction(async (tx) => {
        await replaceMediaTagsTx(tx, mediaId, libraryId, tagIds);
        return tagIds;
    });
}
