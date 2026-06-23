import { db } from "@/global/db";
import { Tag, PostTag, MediaTag, TagStatus } from "@/db/schema";
import { and, eq, inArray, notInArray, exists, sql } from "drizzle-orm";

export async function sweepOrphanTags() {
    console.log("Starting orphan tags sweep...");

    // Find tags that:
    // 1. Are status = ACTIVE or CANDIDATE
    // 2. Do not have any links in PostTag
    // 3. Do not have any links in MediaTag
    // We select them in chunks of 500
    const orphanTags = await db
        .select({
            id: Tag.id,
            name: Tag.name,
        })
        .from(Tag)
        .where(
            and(
                inArray(Tag.status, [TagStatus.ACTIVE, TagStatus.CANDIDATE]),
                sql`not exists (select 1 from ${PostTag} where ${PostTag.tag_id} = ${Tag.id})`,
                sql`not exists (select 1 from ${MediaTag} where ${MediaTag.tag_id} = ${Tag.id})`,
            ),
        )
        .limit(500);

    if (orphanTags.length === 0) {
        console.log("No orphan tags found.");
        return { sweptCount: 0 };
    }

    const tagIds = orphanTags.map((t) => t.id);
    console.log(`Found ${orphanTags.length} orphan tags to sweep: ${orphanTags.map((t) => t.name).join(", ")}`);

    // Perform chunk delete as per rules:centralized, chunked deletion
    const deleted = await db.delete(Tag).where(inArray(Tag.id, tagIds));
    console.log(`Successfully swept ${tagIds.length} orphan tags.`);
    return { sweptCount: tagIds.length };
}

// If run directly as a script
if (require.main === module || process.argv[1] === import.meta.filename) {
    sweepOrphanTags()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error("Orphan sweep failed:", err);
            process.exit(1);
        });
}
