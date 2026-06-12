import { db } from "@/global/db";
import { Post, DeleteStatus } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AiEnrichmentService } from "@/services/ai/enrich";

async function runBackfill() {
    console.log("[BACKFILL] Starting batch AI enrichment backfill for all active posts...");

    try {
        // Fetch all active posts
        const activePosts = await db
            .select({ id: Post.id, title: Post.title })
            .from(Post)
            .where(eq(Post.delete_status, DeleteStatus.ACTIVE));

        console.log(`[BACKFILL] Found ${activePosts.length} active posts to process.`);

        let processedCount = 0;
        let successCount = 0;
        let errorCount = 0;

        for (const post of activePosts) {
            processedCount++;
            console.log(`\n------------------------------------------------------------`);
            console.log(
                `[BACKFILL] [${processedCount}/${activePosts.length}] Processing Post: "${post.title || "Untitled"}" (ID: ${post.id})...`,
            );

            try {
                await AiEnrichmentService.enrichPost(post.id);
                successCount++;
                console.log(`[BACKFILL] Successfully processed Post: ${post.id}`);
            } catch (err) {
                errorCount++;
                console.error(`[BACKFILL ERROR] Failed to enrich Post ${post.id}:`, err);
            }
        }

        console.log(`\n============================================================`);
        console.log(`[BACKFILL COMPLETED]`);
        console.log(`- Total Posts scanned: ${activePosts.length}`);
        console.log(`- Successes: ${successCount}`);
        console.log(`- Failures: ${errorCount}`);
        console.log(`============================================================`);
    } catch (err) {
        console.error("[BACKFILL CRITICAL ERROR] Pipeline failed:", err);
        process.exit(1);
    } finally {
        process.exit(0);
    }
}

runBackfill();
