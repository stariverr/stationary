import { db } from "@/global/db";
import { Tag, PostTag, MediaTag, TagStatus, Post, Media } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

async function main() {
    const args = process.argv.slice(2);
    const action = args[0];

    if (!action || !["list", "accept", "ignore", "delete"].includes(action)) {
        console.log("Usage:");
        console.log("  bun run src/scripts/manage_candidates.ts list");
        console.log("  bun run src/scripts/manage_candidates.ts accept <tagId>");
        console.log("  bun run src/scripts/manage_candidates.ts ignore <tagId>");
        console.log("  bun run src/scripts/manage_candidates.ts delete <tagId>");
        process.exit(1);
    }

    if (action === "list") {
        const candidates = await db.select().from(Tag).where(eq(Tag.status, TagStatus.CANDIDATE));

        if (candidates.length === 0) {
            console.log("No pending candidate tags found.");
            process.exit(0);
        }

        console.log(`Found ${candidates.length} pending candidate tags:`);
        console.log("--------------------------------------------------------------------------------");
        console.log(`ID                                   | Name        | Normalized  | Count | Source`);
        console.log("--------------------------------------------------------------------------------");
        for (const c of candidates) {
            // Count actual references
            const [pCount] = await db.select({ count: drizzleCount() }).from(PostTag).where(eq(PostTag.tag_id, c.id));
            const [mCount] = await db.select({ count: drizzleCount() }).from(MediaTag).where(eq(MediaTag.tag_id, c.id));
            const refCount = (pCount?.count ?? 0) + (mCount?.count ?? 0);

            console.log(`${c.id} | ${c.name.padEnd(11)} | ${c.normalized_name.padEnd(11)} | ${String(refCount).padEnd(5)} | ${c.source}`);
        }
        console.log("--------------------------------------------------------------------------------");
        process.exit(0);
    }

    const tagId = args[1];
    if (!tagId) {
        console.error("Error: Missing <tagId> parameter.");
        process.exit(1);
    }

    // Verify tag exists and is a candidate
    const tagList = await db.select().from(Tag).where(eq(Tag.id, tagId)).limit(1);
    const targetTag = tagList[0];
    if (!targetTag) {
        console.error(`Error: Tag with ID ${tagId} not found.`);
        process.exit(1);
    }

    if (action === "accept") {
        await db.update(Tag).set({ status: TagStatus.ACTIVE, update_time: nowTimestamp() }).where(eq(Tag.id, tagId));
        console.log(`Successfully accepted/promoted tag "${targetTag.name}" (${tagId}) to ACTIVE.`);
    } else if (action === "ignore") {
        await db.transaction(async (tx) => {
            // Set status to IGNORED
            await tx.update(Tag).set({ status: TagStatus.IGNORED, update_time: nowTimestamp() }).where(eq(Tag.id, tagId));

            // Delete post and media linkages to ignored tags
            const ptDel = await tx.delete(PostTag).where(eq(PostTag.tag_id, tagId));
            const mtDel = await tx.delete(MediaTag).where(eq(MediaTag.tag_id, tagId));
            console.log(`Successfully ignored tag "${targetTag.name}" (${tagId}).`);
            console.log(`- Cleaned up ${ptDel.rowCount || 0} post tag links.`);
            console.log(`- Cleaned up ${mtDel.rowCount || 0} media tag links.`);
        });
    } else if (action === "delete") {
        await db.transaction(async (tx) => {
            // Delete completely
            await tx.delete(Tag).where(eq(Tag.id, tagId));
            await tx.delete(PostTag).where(eq(PostTag.tag_id, tagId));
            await tx.delete(MediaTag).where(eq(MediaTag.tag_id, tagId));
            console.log(`Successfully hard-deleted tag "${targetTag.name}" (${tagId}) and all its linkages.`);
        });
    }

    process.exit(0);
}

// Helpers
import { sql } from "drizzle-orm";
function drizzleCount() {
    return sql<number>`count(*)`;
}
import { Temporal } from "@js-temporal/polyfill";
import { customType } from "drizzle-orm/pg-core";
function nowTimestamp() {
    return Temporal.Instant.from(new Date().toISOString());
}

main().catch((err) => {
    console.error("Command failed:", err);
    process.exit(1);
});
