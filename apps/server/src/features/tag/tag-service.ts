import { and, eq, inArray, sql } from "drizzle-orm";
import { MediaTag, PostTag, Tag, TagSource, TagStatus } from "@/db/schema";
import { db } from "@/global/db";
import { normalizeTagName } from "@/lib/utils/tag_sanitizer";
import { assertTagLibraryAccess, type TagAuth } from "./access";
import { TagError } from "./errors";
import type { TagCreateInput, TagListQuery, TagMergeInput, TagUpdateInput } from "./schema";

async function assertTagNameAvailable(libraryId: string, name: string, excludeTagId?: string) {
    const normalized = normalizeTagName(name);
    const [existing] = await db
        .select({ id: Tag.id })
        .from(Tag)
        .where(and(eq(Tag.library_id, libraryId), eq(Tag.normalized_name, normalized)))
        .limit(1);

    if (existing && existing.id !== excludeTagId) {
        throw new TagError("CONFLICT", "Tag name already exists in this library");
    }

    return normalized;
}

async function getAliases(tagId: string) {
    const aliases = await db.select({ name: Tag.name }).from(Tag).where(eq(Tag.canonical_tag_id, tagId));
    return aliases.map((alias) => alias.name);
}

export async function listTags(input: TagListQuery, auth: TagAuth) {
    await assertTagLibraryAccess(input.library_id, auth);

    const conditions = [eq(Tag.library_id, input.library_id)];
    if (input.status) {
        conditions.push(eq(Tag.status, input.status));
    }

    const allTags = await db
        .select({
            id: Tag.id,
            name: Tag.name,
            normalized_name: Tag.normalized_name,
            color: Tag.color,
            status: Tag.status,
            source: Tag.source,
            canonical_tag_id: Tag.canonical_tag_id,
            post_count: sql<number>`count(distinct ${PostTag.id})::int`,
            media_count: sql<number>`count(distinct ${MediaTag.id})::int`,
        })
        .from(Tag)
        .leftJoin(PostTag, eq(Tag.id, PostTag.tag_id))
        .leftJoin(MediaTag, eq(Tag.id, MediaTag.tag_id))
        .where(and(...conditions))
        .groupBy(Tag.id);

    const tagMap = new Map<string, (typeof allTags)[number] & { aliases: string[] }>();

    for (const tag of allTags) {
        if (!tag.canonical_tag_id) {
            tagMap.set(tag.id, {
                ...tag,
                aliases: [],
            });
        }
    }

    for (const tag of allTags) {
        if (tag.canonical_tag_id) {
            const canonical = tagMap.get(tag.canonical_tag_id);
            if (canonical) {
                canonical.aliases.push(tag.name);
                canonical.post_count += tag.post_count;
                canonical.media_count += tag.media_count;
            }
        }
    }

    return Array.from(tagMap.values()).sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export async function createTag(input: TagCreateInput, auth: TagAuth) {
    await assertTagLibraryAccess(input.library_id, auth);
    const normalized = await assertTagNameAvailable(input.library_id, input.name);

    const [tag] = await db
        .insert(Tag)
        .values({
            name: input.name,
            normalized_name: normalized,
            canonical_tag_id: null,
            library_id: input.library_id,
            status: TagStatus.ACTIVE,
            source: TagSource.USER,
            color: input.color || null,
        })
        .returning();

    return {
        ...tag,
        aliases: [],
    };
}

export async function updateTag(input: TagUpdateInput, auth: TagAuth) {
    const [targetTag] = await db.select().from(Tag).where(eq(Tag.id, input.id)).limit(1);
    if (!targetTag) {
        throw new TagError("NOT_FOUND", "Tag not found");
    }

    await assertTagLibraryAccess(targetTag.library_id, auth);

    let normalizedName: string | undefined;
    if (input.name !== undefined) {
        normalizedName = await assertTagNameAvailable(targetTag.library_id, input.name, input.id);
    }

    const updateFields: Partial<typeof Tag.$inferInsert> = {
        update_time: Temporal.Now.instant(),
    };
    if (input.name !== undefined) {
        updateFields.name = input.name;
        updateFields.normalized_name = normalizedName;
    }
    if (input.color !== undefined) {
        updateFields.color = input.color;
    }
    if (input.status !== undefined) {
        updateFields.status = input.status;
    }

    const [updated] = await db.transaction(async (tx) => {
        const result = await tx.update(Tag).set(updateFields).where(eq(Tag.id, input.id)).returning();

        if (input.status === TagStatus.IGNORED) {
            await tx.delete(PostTag).where(eq(PostTag.tag_id, input.id));
            await tx.delete(MediaTag).where(eq(MediaTag.tag_id, input.id));
        }

        return result;
    });

    return {
        ...updated,
        aliases: await getAliases(input.id),
    };
}

export async function deleteTag(tagId: string, auth: TagAuth) {
    const [tag] = await db.select({ library_id: Tag.library_id }).from(Tag).where(eq(Tag.id, tagId)).limit(1);
    if (!tag) {
        throw new TagError("NOT_FOUND", "Tag not found");
    }

    await assertTagLibraryAccess(tag.library_id, auth);

    return db.transaction(async (tx) => {
        const deleted = await tx.delete(Tag).where(eq(Tag.id, tagId)).returning({ id: Tag.id });
        if (deleted.length === 0) {
            return { tagDeleted: 0 };
        }

        await tx.delete(PostTag).where(eq(PostTag.tag_id, tagId));
        await tx.delete(MediaTag).where(eq(MediaTag.tag_id, tagId));
        await tx
            .update(Tag)
            .set({ canonical_tag_id: null, update_time: Temporal.Now.instant() })
            .where(eq(Tag.canonical_tag_id, tagId));

        return { tagDeleted: 1 };
    });
}

export async function mergeTags(input: TagMergeInput, auth: TagAuth) {
    if (input.source_tag_id === input.target_tag_id) {
        throw new TagError("INVALID_PARAMETER", "Source and target tag cannot be the same");
    }

    await assertTagLibraryAccess(input.library_id, auth);
    const now = Temporal.Now.instant();

    await db.transaction(async (tx) => {
        const tagIdsToLock = [input.source_tag_id, input.target_tag_id].sort();
        const lockedTags = await tx.select().from(Tag).where(inArray(Tag.id, tagIdsToLock)).for("update");
        const sourceTag = lockedTags.find((tag) => tag.id === input.source_tag_id);
        const targetTag = lockedTags.find((tag) => tag.id === input.target_tag_id);

        if (!sourceTag || !targetTag) {
            throw new TagError("NOT_FOUND", "Source or target tag not found");
        }
        if (sourceTag.library_id !== input.library_id || targetTag.library_id !== input.library_id) {
            throw new TagError("INVALID_PARAMETER", "Tags do not belong to the specified library");
        }
        if (sourceTag.canonical_tag_id !== null) {
            throw new TagError("INVALID_PARAMETER", "Source tag is already an alias tag");
        }
        if (targetTag.canonical_tag_id !== null) {
            throw new TagError("INVALID_PARAMETER", "Target tag is an alias tag and cannot be a master tag");
        }

        if (!input.retain_as_alias) {
            const targetPostLinks = await tx.select({ post_id: PostTag.post_id }).from(PostTag).where(eq(PostTag.tag_id, input.target_tag_id));
            const targetPostIds = targetPostLinks.map((link) => link.post_id);
            const targetMediaLinks = await tx.select({ media_id: MediaTag.media_id }).from(MediaTag).where(eq(MediaTag.tag_id, input.target_tag_id));
            const targetMediaIds = targetMediaLinks.map((link) => link.media_id);

            if (targetPostIds.length > 0) {
                await tx.delete(PostTag).where(and(eq(PostTag.tag_id, input.source_tag_id), inArray(PostTag.post_id, targetPostIds)));
            }
            await tx.update(PostTag).set({ tag_id: input.target_tag_id }).where(eq(PostTag.tag_id, input.source_tag_id));

            if (targetMediaIds.length > 0) {
                await tx.delete(MediaTag).where(and(eq(MediaTag.tag_id, input.source_tag_id), inArray(MediaTag.media_id, targetMediaIds)));
            }
            await tx.update(MediaTag).set({ tag_id: input.target_tag_id }).where(eq(MediaTag.tag_id, input.source_tag_id));
        }

        if (input.retain_as_alias) {
            await tx
                .update(Tag)
                .set({ canonical_tag_id: input.target_tag_id, status: TagStatus.ACTIVE, update_time: now })
                .where(eq(Tag.id, input.source_tag_id));
        }

        await tx
            .update(Tag)
            .set({ canonical_tag_id: input.target_tag_id, update_time: now })
            .where(eq(Tag.canonical_tag_id, input.source_tag_id));

        if (!input.retain_as_alias) {
            await tx.delete(Tag).where(eq(Tag.id, input.source_tag_id));
        }
    });
}
