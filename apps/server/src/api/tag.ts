import { Hono } from "hono";
import { db } from "@/global/db";
import * as v from "valibot";
import { validate } from "@/lib/validation/validator";
import { error, success } from "@/lib/response";
import { Code } from "@/lib/code";
import { requireAuth } from "@/lib/auth/middleware";
import { Tag, PostTag, MediaTag, TagStatus, TagSource } from "@/db/schema";
import { and, eq, sql, inArray } from "drizzle-orm";
import { normalizeTagName } from "@/lib/utils/tag_sanitizer";
import { Temporal } from "@js-temporal/polyfill";
import { DeleteService } from "@/services/delete";

const router = new Hono();

const TagListQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    status: v.optional(v.enum(TagStatus)),
});

export const TagCreateBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    name: v.pipe(v.string(), v.nonEmpty()),
    color: v.optional(v.string()),
});

export const TagUpdateBodySchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.optional(v.pipe(v.string(), v.nonEmpty())),
    color: v.optional(v.nullable(v.string())),
    status: v.optional(v.enum(TagStatus)),
});

const TagMergeBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    source_tag_id: v.pipe(v.string(), v.uuid()),
    target_tag_id: v.pipe(v.string(), v.uuid()),
    retain_as_alias: v.optional(v.boolean(), true),
});

async function checkTagNameUniqueness(libraryId: string, name: string, excludeTagId?: string): Promise<boolean> {
    const normalized = normalizeTagName(name);
    const existing = await db
        .select()
        .from(Tag)
        .where(and(eq(Tag.library_id, libraryId), eq(Tag.normalized_name, normalized)))
        .limit(1)
        .then((rows) => rows[0]);

    if (existing && existing.id !== excludeTagId) {
        return false;
    }
    return true;
}

// GET /api/tag/list
router.get("/list", requireAuth, validate("query", TagListQuerySchema), async (c) => {
    const { library_id, status } = c.req.valid("query");

    try {
        const conditions = [eq(Tag.library_id, library_id)];
        if (status) {
            conditions.push(eq(Tag.status, status));
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

        const tagMap = new Map<string, any>();

        // Initialize canonical/master tags
        for (const t of allTags) {
            if (!t.canonical_tag_id) {
                tagMap.set(t.id, {
                    ...t,
                    aliases: [] as string[],
                });
            }
        }

        // Aggregate aliases and sum up counts
        for (const t of allTags) {
            if (t.canonical_tag_id) {
                const canonical = tagMap.get(t.canonical_tag_id);
                if (canonical) {
                    canonical.aliases.push(t.name);
                    canonical.post_count += t.post_count;
                    canonical.media_count += t.media_count;
                }
            }
        }

        const resultList = Array.from(tagMap.values());
        resultList.sort((a, b) => a.name.localeCompare(b.name, "zh"));

        return c.json(success(Code.SUCCESS, resultList));
    } catch (e: any) {
        return c.json(error(Code.INTERNAL_SERVER_ERROR, e.message || String(e)), 500);
    }
});

// POST /api/tag/create
router.post("/create", requireAuth, validate("json", TagCreateBodySchema), async (c) => {
    const { library_id, name, color } = c.req.valid("json");
    const normalized = normalizeTagName(name);

    try {
        const isUniq = await checkTagNameUniqueness(library_id, name);
        if (!isUniq) {
            return c.json(error(Code.ALREADY_EXISTS, "Tag name already exists in this library"), 400);
        }

        // Check for duplicates
        const existing = await db
            .select()
            .from(Tag)
            .where(and(eq(Tag.library_id, library_id), eq(Tag.normalized_name, normalized)))
            .limit(1)
            .then((rows) => rows[0]);

        const tag = await db.transaction(async (tx) => {
            let resultTag;
            if (existing) {
                const updated = await tx
                    .update(Tag)
                    .set({
                        name: name, // use the casing provided by the user
                        status: TagStatus.ACTIVE,
                        color: color || existing.color,
                        canonical_tag_id: null,
                        update_time: sql`now()`,
                    })
                    .where(eq(Tag.id, existing.id))
                    .returning();
                resultTag = updated[0];
            } else {
                const inserted = await tx
                    .insert(Tag)
                    .values({
                        name: name,
                        normalized_name: normalized,
                        canonical_tag_id: null,
                        library_id: library_id,
                        status: TagStatus.ACTIVE,
                        source: TagSource.USER,
                        color: color || null,
                    })
                    .returning();
                resultTag = inserted[0];
            }

            return resultTag;
        });

        const finalTagList = await db.select().from(Tag).where(eq(Tag.id, tag.id)).limit(1);
        const finalTag = finalTagList[0];
        const finalAliases = await db.select({ name: Tag.name }).from(Tag).where(eq(Tag.canonical_tag_id, tag.id));

        return c.json(
            success(Code.SUCCESS, {
                ...finalTag,
                aliases: finalAliases.map((fa) => fa.name),
            }),
        );
    } catch (e: any) {
        return c.json(error(Code.INTERNAL_SERVER_ERROR, e.message || String(e)), 500);
    }
});

// POST /api/tag/update
router.post("/update", requireAuth, validate("json", TagUpdateBodySchema), async (c) => {
    const { id, name, color, status } = c.req.valid("json");

    try {
        const tagList = await db.select().from(Tag).where(eq(Tag.id, id)).limit(1);
        const targetTag = tagList[0];
        if (!targetTag) {
            return c.json(error(Code.NOT_FOUND, "Tag not found"), 404);
        }

        if (name !== undefined) {
            const isUniq = await checkTagNameUniqueness(targetTag.library_id, name, id);
            if (!isUniq) {
                return c.json(error(Code.ALREADY_EXISTS, "Tag name already exists in this library"), 400);
            }
        }

        const updateFields: any = {
            update_time: sql`now()`,
        };
        if (name !== undefined) {
            updateFields.name = name;
            updateFields.normalized_name = normalizeTagName(name);
        }
        if (color !== undefined) {
            updateFields.color = color;
        }
        if (status !== undefined) {
            updateFields.status = status;
        }

        const updated = await db.transaction(async (tx) => {
            const res = await tx.update(Tag).set(updateFields).where(eq(Tag.id, id)).returning();

            // If status is updated to IGNORED, delete associations
            if (status === TagStatus.IGNORED) {
                await tx.delete(PostTag).where(eq(PostTag.tag_id, id));
                await tx.delete(MediaTag).where(eq(MediaTag.tag_id, id));
            }

            return res[0];
        });

        const finalAliases = await db.select({ name: Tag.name }).from(Tag).where(eq(Tag.canonical_tag_id, id));

        return c.json(
            success(Code.SUCCESS, {
                ...updated,
                aliases: finalAliases.map((fa) => fa.name),
            }),
        );
    } catch (e: any) {
        return c.json(error(Code.INTERNAL_SERVER_ERROR, e.message || String(e)), 500);
    }
});

// POST /api/tag/delete/:id
router.post("/delete/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "Tag ID is required"), 400);
    }

    try {
        const result = await DeleteService.deleteTag(id);

        if (result.tagDeleted === 0) {
            return c.json(error(Code.NOT_FOUND, "Tag not found"), 404);
        }

        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        return c.json(error(Code.INTERNAL_SERVER_ERROR, e.message || String(e)), 500);
    }
});

class TagMergeError extends Error {
    constructor(
        public readonly code: Code,
        message: string,
        public readonly status: 400 | 404 | 500 = 400,
    ) {
        super(message);
        this.name = "TagMergeError";
    }
}

// POST /api/tag/merge
router.post("/merge", requireAuth, validate("json", TagMergeBodySchema), async (c) => {
    const { library_id, source_tag_id, target_tag_id, retain_as_alias } = c.req.valid("json");

    if (source_tag_id === target_tag_id) {
        return c.json(error(Code.INVALID_PARAMETER, "Source and target tag cannot be the same"), 400);
    }

    try {
        const now = Temporal.Now.instant();

        await db.transaction(async (tx) => {
            // Lock both tags in deterministic order to prevent deadlocks (e.g. A->B vs B->A)
            const tagIdsToLock = [source_tag_id, target_tag_id].sort();
            const lockedTags = await tx.select().from(Tag).where(inArray(Tag.id, tagIdsToLock)).for("update");

            const sourceTag = lockedTags.find((t) => t.id === source_tag_id);
            const targetTag = lockedTags.find((t) => t.id === target_tag_id);

            if (!sourceTag || !targetTag) {
                throw new TagMergeError(Code.NOT_FOUND, "Source or target tag not found", 404);
            }

            if (sourceTag.library_id !== library_id || targetTag.library_id !== library_id) {
                throw new TagMergeError(Code.INVALID_PARAMETER, "Tags do not belong to the specified library", 400);
            }

            if (sourceTag.canonical_tag_id !== null) {
                throw new TagMergeError(Code.INVALID_PARAMETER, "Source tag is already an alias tag", 400);
            }
            if (targetTag.canonical_tag_id !== null) {
                throw new TagMergeError(Code.INVALID_PARAMETER, "Target tag is an alias tag and cannot be a master tag", 400);
            }

            if (!retain_as_alias) {
                // Find existing target links to prevent unique key constraint violations
                const targetPostLinks = await tx
                    .select({ post_id: PostTag.post_id })
                    .from(PostTag)
                    .where(eq(PostTag.tag_id, target_tag_id));
                const targetPostIds = targetPostLinks.map((l) => l.post_id);

                const targetMediaLinks = await tx
                    .select({ media_id: MediaTag.media_id })
                    .from(MediaTag)
                    .where(eq(MediaTag.tag_id, target_tag_id));
                const targetMediaIds = targetMediaLinks.map((l) => l.media_id);

                // De-duplicate: if post has both tags, delete link to source tag
                if (targetPostIds.length > 0) {
                    await tx.delete(PostTag).where(and(eq(PostTag.tag_id, source_tag_id), inArray(PostTag.post_id, targetPostIds)));
                }
                // Update other links to target_tag_id
                await tx.update(PostTag).set({ tag_id: target_tag_id }).where(eq(PostTag.tag_id, source_tag_id));

                // De-duplicate for media
                if (targetMediaIds.length > 0) {
                    await tx.delete(MediaTag).where(and(eq(MediaTag.tag_id, source_tag_id), inArray(MediaTag.media_id, targetMediaIds)));
                }
                await tx.update(MediaTag).set({ tag_id: target_tag_id }).where(eq(MediaTag.tag_id, source_tag_id));
            }

            if (retain_as_alias) {
                // Set as Alias mode: Keep source tag and turn it into target tag's alias
                await tx
                    .update(Tag)
                    .set({
                        canonical_tag_id: target_tag_id,
                        status: TagStatus.ACTIVE,
                        update_time: now,
                    })
                    .where(eq(Tag.id, source_tag_id));

                // Reparent any existing child aliases of source tag directly to target tag (maintain flat hierarchy)
                await tx
                    .update(Tag)
                    .set({
                        canonical_tag_id: target_tag_id,
                        update_time: now,
                    })
                    .where(eq(Tag.canonical_tag_id, source_tag_id));
            } else {
                // Merge & Delete mode:
                // 1. Reparent any existing child aliases of source tag directly to target tag to maintain flat hierarchy
                await tx
                    .update(Tag)
                    .set({
                        canonical_tag_id: target_tag_id,
                        update_time: now,
                    })
                    .where(eq(Tag.canonical_tag_id, source_tag_id));

                // 2. Physical delete of the source tag
                await tx.delete(Tag).where(eq(Tag.id, source_tag_id));
            }
        });

        return c.json(success(Code.SUCCESS, null, "Tags merged successfully"));
    } catch (e: unknown) {
        if (e instanceof TagMergeError) {
            return c.json(error(e.code, e.message), e.status);
        }
        const message = e instanceof Error ? e.message : String(e);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, message), 500);
    }
});

export default router;
