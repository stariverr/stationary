import { eq, and, inArray } from "drizzle-orm";
import { db, type DbClient } from "@/global/db";
import { Tag, PostTag, MediaTag, TagStatus, TagSource } from "@/db/schema";
import { sanitizeTags } from "@/lib/utils/tag_sanitizer";

export type TagRecord = typeof Tag.$inferSelect;
export type TagLookup = Map<string, TagRecord>;

export async function loadTagLookup(libraryId: string, client: DbClient = db): Promise<TagLookup> {
    const existingTags = await client.select().from(Tag).where(eq(Tag.library_id, libraryId));
    return new Map(existingTags.map((tag) => [tag.normalized_name, tag]));
}

export async function syncEntityTags(
    libraryId: string,
    entityType: "post" | "media",
    entityId: string,
    rawTags: string[],
    source: TagSource,
    sourceField: string,
    tagLookup?: TagLookup,
    client: DbClient = db,
) {
    const sanitized = sanitizeTags(rawTags);
    if (sanitized.length === 0) {
        if (entityType === "post") {
            await client.delete(PostTag).where(eq(PostTag.post_id, entityId));
        } else {
            await client.delete(MediaTag).where(eq(MediaTag.media_id, entityId));
        }
        return;
    }

    const normalizedLookup = tagLookup ?? (await loadTagLookup(libraryId, client));

    const targetTagIds: string[] = [];
    const missingItems: typeof sanitized = [];

    for (const item of sanitized) {
        const matched = normalizedLookup.get(item.normalized);
        if (matched) {
            if (matched.status !== TagStatus.IGNORED) {
                targetTagIds.push(matched.id);
            }
        } else {
            missingItems.push(item);
        }
    }

    if (missingItems.length > 0) {
        const insertedTags = await client
            .insert(Tag)
            .values(
                missingItems.map((item) => ({
                    name: item.name,
                    normalized_name: item.normalized,
                    canonical_tag_id: null,
                    library_id: libraryId,
                    status: TagStatus.CANDIDATE,
                    source: source,
                    source_field: sourceField,
                })),
            )
            .onConflictDoNothing({ target: [Tag.library_id, Tag.normalized_name] })
            .returning();

        for (const inserted of insertedTags) {
            targetTagIds.push(inserted.id);
            normalizedLookup.set(inserted.normalized_name, inserted);
        }

        if (insertedTags.length < missingItems.length) {
            const reFetched = await client
                .select()
                .from(Tag)
                .where(and(eq(Tag.library_id, libraryId), inArray(Tag.normalized_name, missingItems.map((i) => i.normalized))));

            for (const tag of reFetched) {
                if (!targetTagIds.includes(tag.id) && tag.status !== TagStatus.IGNORED) {
                    targetTagIds.push(tag.id);
                }
                normalizedLookup.set(tag.normalized_name, tag);
            }
        }
    }

    if (entityType === "post") {
        const existingLinks = await client.select({ tag_id: PostTag.tag_id }).from(PostTag).where(eq(PostTag.post_id, entityId));
        const existingTagIds = existingLinks.map((l) => l.tag_id);

        const toAdd = targetTagIds.filter((id: string) => !existingTagIds.includes(id));
        const toDelete = existingTagIds.filter((id: string) => !targetTagIds.includes(id));

        if (toAdd.length > 0) {
            await client
                .insert(PostTag)
                .values(
                    toAdd.map((tagId) => ({
                        post_id: entityId,
                        tag_id: tagId,
                    })),
                )
                .onConflictDoNothing();
        }
        if (toDelete.length > 0) {
            await client.delete(PostTag).where(and(eq(PostTag.post_id, entityId), inArray(PostTag.tag_id, toDelete)));
        }
    } else {
        const existingLinks = await client.select({ tag_id: MediaTag.tag_id }).from(MediaTag).where(eq(MediaTag.media_id, entityId));
        const existingTagIds = existingLinks.map((l) => l.tag_id);

        const toAdd = targetTagIds.filter((id: string) => !existingTagIds.includes(id));
        const toDelete = existingTagIds.filter((id: string) => !targetTagIds.includes(id));

        if (toAdd.length > 0) {
            await client
                .insert(MediaTag)
                .values(
                    toAdd.map((tagId) => ({
                        media_id: entityId,
                        tag_id: tagId,
                    })),
                )
                .onConflictDoNothing();
        }
        if (toDelete.length > 0) {
            await client.delete(MediaTag).where(and(eq(MediaTag.media_id, entityId), inArray(MediaTag.tag_id, toDelete)));
        }
    }
}
