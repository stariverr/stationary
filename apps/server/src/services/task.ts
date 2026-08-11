import type { Transaction } from "@/global/db";
import { db } from "@/global/db";
import { Post, Media, Track, SyncStatus } from "@/db/schema";
import { eq, and, lt, inArray } from "drizzle-orm";
import { Temporal } from "@js-temporal/polyfill";
import type { PostItemData } from "@/api/schemas/ingest";
import { saveIngestMetadata } from "./ingest/persistence";
import { processMediaById, processMedia, processAvatar } from "./ingest/downloader";

export const TaskService = {
    /**
     * Step 1: Save metadata to DB (Synchronization & Deduplication)
     */
    async saveMetadata(postData: PostItemData, targetLibraryId: string, workflowRunId: string, tx: Transaction) {
        return saveIngestMetadata(postData, targetLibraryId, workflowRunId, tx);
    },

    /**
     * Process individual media by media ID directly
     */
    async processMediaById(mediaId: string, signal?: AbortSignal) {
        return processMediaById(mediaId, signal);
    },

    /**
     * Step 2: Process individual media
     */
    async processMedia(mediaId: string, signal?: AbortSignal) {
        return processMedia(mediaId, signal);
    },

    /**
     * Step 3: Process author avatar
     */
    async processAvatar(authorId: string, avatarUrl: string, signal?: AbortSignal) {
        return processAvatar(authorId, avatarUrl, signal);
    },

    /**
     * Sweep entity sync statuses stuck in IN_PROGRESS
     */
    async sweepStuckTasks(thresholdMinutes = 30) {
        const cutoff = Temporal.Now.instant().subtract({ minutes: thresholdMinutes });
        const sweptPosts = await db
            .update(Post)
            .set({ sync_status: SyncStatus.FAILED, last_error: "Sync timed out (stuck IN_PROGRESS)" })
            .where(and(eq(Post.sync_status, SyncStatus.IN_PROGRESS), lt(Post.update_time, cutoff)))
            .returning({ id: Post.id });

        const sweptMedia = await db
            .update(Media)
            .set({ sync_status: SyncStatus.FAILED, last_error: "Sync timed out (stuck IN_PROGRESS)" })
            .where(and(eq(Media.sync_status, SyncStatus.IN_PROGRESS), lt(Media.update_time, cutoff)))
            .returning({ id: Media.id });

        const sweptTracks = await db
            .update(Track)
            .set({ sync_status: SyncStatus.FAILED, last_error: "Sync timed out (stuck IN_PROGRESS)" })
            .where(and(eq(Track.sync_status, SyncStatus.IN_PROGRESS), lt(Track.update_time, cutoff)))
            .returning({ id: Track.id });

        return { sweptCount: sweptPosts.length + sweptMedia.length + sweptTracks.length };
    },

    /**
     * Retry sync for failed or pending posts/media
     */
    async retrySync(options: { postIds?: string[]; mediaIds?: string[] }) {
        let retriedCount = 0;
        if (options.postIds?.length) {
            const posts = await db
                .update(Post)
                .set({ sync_status: SyncStatus.PENDING, last_error: null })
                .where(inArray(Post.id, options.postIds))
                .returning({ id: Post.id });
            retriedCount += posts.length;
        }
        if (options.mediaIds?.length) {
            const media = await db
                .update(Media)
                .set({ sync_status: SyncStatus.PENDING, last_error: null })
                .where(inArray(Media.id, options.mediaIds))
                .returning({ id: Media.id });
            retriedCount += media.length;
        }
        return { retriedCount };
    },
};
