import { inArray } from "drizzle-orm";
import { Media, Post, SyncStatus } from "@/db/schema";
import { canReachItems, type LibraryAuth } from "@/features/library/access";
import { db } from "@/global/db";
import { RetrySyncError } from "./errors";
import type { RetrySyncInput } from "./schema";

export async function retrySync(input: RetrySyncInput, auth: LibraryAuth) {
    if (!(await canReachItems(input.post_ids ?? [], input.media_ids ?? [], auth))) {
        throw new RetrySyncError("One or more items were not found");
    }

    let retriedCount = 0;
    if (input.post_ids?.length) {
        const posts = await db
            .update(Post)
            .set({ sync_status: SyncStatus.PENDING, last_error: null })
            .where(inArray(Post.id, input.post_ids))
            .returning({ id: Post.id });
        retriedCount += posts.length;
    }
    if (input.media_ids?.length) {
        const media = await db
            .update(Media)
            .set({ sync_status: SyncStatus.PENDING, last_error: null })
            .where(inArray(Media.id, input.media_ids))
            .returning({ id: Media.id });
        retriedCount += media.length;
    }

    return { retriedCount };
}
