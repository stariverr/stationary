import { db } from "@/global/db";
import { Post, Tag, PostTag, TagStatus, TagSource, DeleteStatus } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { sanitizeTags } from "@/lib/utils/tag_sanitizer";

async function runMigration() {
    console.log("Starting relational tag backfill migration...");

    // Fetch all active posts that have tags
    const posts = await db
        .select({
            id: Post.id,
            library_id: Post.library_id,
            tags: Post.tags,
        })
        .from(Post)
        .where(eq(Post.delete_status, DeleteStatus.ACTIVE));

    console.log(`Found ${posts.length} active posts to scan.`);

    let tagsCreatedCount = 0;
    let postTagsLinkedCount = 0;

    // Cache to check library tags and avoid repeated inserts
    // Map: libraryId -> Map: normalizedTagName -> tagId
    const libraryTagsCache = new Map<string, Map<string, string>>();

    for (const post of posts) {
        if (!post.tags || post.tags.length === 0) {
            continue;
        }

        const sanitized = sanitizeTags(post.tags);
        if (sanitized.length === 0) {
            continue;
        }

        // Initialize library cache if not exists
        if (!libraryTagsCache.has(post.library_id)) {
            const cache = new Map<string, string>();
            const existing = await db.select().from(Tag).where(eq(Tag.library_id, post.library_id));
            for (const t of existing) {
                cache.set(t.normalized_name, t.id);
            }
            libraryTagsCache.set(post.library_id, cache);
        }

        const cache = libraryTagsCache.get(post.library_id)!;
        const targetTagIds: string[] = [];

        for (const item of sanitized) {
            let tagId = cache.get(item.normalized);
            if (!tagId) {
                // Insert new tag into the DB (historical tags default to ACTIVE status)
                const results = await db
                    .insert(Tag)
                    .values({
                        name: item.name,
                        normalized_name: item.normalized,
                        library_id: post.library_id,
                        status: TagStatus.ACTIVE,
                        source: TagSource.IMPORT,
                        source_field: "post.tags",
                    })
                    .returning({ id: Tag.id });

                if (results[0]) {
                    tagId = results[0].id;
                    cache.set(item.normalized, tagId);
                    tagsCreatedCount++;
                }
            }
            if (tagId) {
                targetTagIds.push(tagId);
            }
        }

        // Link post to the tags
        if (targetTagIds.length > 0) {
            // Find existing post_tag links
            const existingLinks = await db.select({ tag_id: PostTag.tag_id }).from(PostTag).where(eq(PostTag.post_id, post.id));
            const existingTagIds = existingLinks.map((l) => l.tag_id);

            const toAdd = targetTagIds.filter((id) => !existingTagIds.includes(id));
            if (toAdd.length > 0) {
                await db.insert(PostTag).values(
                    toAdd.map((tagId) => ({
                        post_id: post.id,
                        tag_id: tagId,
                    })),
                );
                postTagsLinkedCount += toAdd.length;
            }
        }
    }

    console.log("Migration complete!");
    console.log(`- Created ${tagsCreatedCount} new tags.`);
    console.log(`- Linked ${postTagsLinkedCount} post-tag associations.`);
    process.exit(0);
}

runMigration().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
