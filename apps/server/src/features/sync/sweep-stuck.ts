import { and, eq, inArray, lt } from "drizzle-orm";
import { Media, Post, SyncStatus, Track } from "@/db/schema";
import { db } from "@/global/db";

/** Sweeps every library unless `libraryId` narrows it to one. */
export async function sweepStuckEntities(thresholdMinutes = 30, libraryId?: string) {
    const cutoff = Temporal.Now.instant().subtract({ minutes: thresholdMinutes });
    const sweptPosts = await db
        .update(Post)
        .set({ sync_status: SyncStatus.FAILED, last_error: "Sync timed out (stuck IN_PROGRESS)" })
        .where(
            and(
                eq(Post.sync_status, SyncStatus.IN_PROGRESS),
                lt(Post.update_time, cutoff),
                libraryId ? eq(Post.library_id, libraryId) : undefined,
            ),
        )
        .returning({ id: Post.id });

    const sweptMedia = await db
        .update(Media)
        .set({ sync_status: SyncStatus.FAILED, last_error: "Sync timed out (stuck IN_PROGRESS)" })
        .where(
            and(
                eq(Media.sync_status, SyncStatus.IN_PROGRESS),
                lt(Media.update_time, cutoff),
                libraryId ? eq(Media.library_id, libraryId) : undefined,
            ),
        )
        .returning({ id: Media.id });

    const sweptTracks = await db
        .update(Track)
        .set({ sync_status: SyncStatus.FAILED, last_error: "Sync timed out (stuck IN_PROGRESS)" })
        .where(
            and(
                eq(Track.sync_status, SyncStatus.IN_PROGRESS),
                lt(Track.update_time, cutoff),
                libraryId
                    ? inArray(Track.media_id, db.select({ id: Media.id }).from(Media).where(eq(Media.library_id, libraryId)))
                    : undefined,
            ),
        )
        .returning({ id: Track.id });

    return { sweptCount: sweptPosts.length + sweptMedia.length + sweptTracks.length };
}
