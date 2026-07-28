import { db } from "@/global/db";
import { Track, DeleteStatus, TrackPurpose } from "@/db/schema";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

async function run() {
    console.log("Starting migration for is_primary on existing tracks...");

    // 1. Find all active media_ids that ALREADY have an is_primary track
    const existingPrimaryMediaIds = await db
        .selectDistinct({ media_id: Track.media_id })
        .from(Track)
        .where(and(eq(Track.is_primary, true), eq(Track.delete_status, DeleteStatus.ACTIVE)));

    const mediaIdsWithPrimary = new Set(existingPrimaryMediaIds.map((m) => m.media_id).filter((id): id is string => !!id));

    // 2. Fetch all active CONTENT tracks for media that do not have an is_primary track yet
    const candidateTracks = await db
        .select()
        .from(Track)
        .where(and(eq(Track.purpose, TrackPurpose.CONTENT), eq(Track.delete_status, DeleteStatus.ACTIVE)))
        .orderBy(Track.media_id, Track.priority, Track.create_time);

    // Group by media_id and pick the first default/highest priority content track
    const tracksToMarkPrimary: string[] = [];

    const tracksByMedia = new Map<string, typeof candidateTracks>();
    for (const track of candidateTracks) {
        if (!track.media_id || mediaIdsWithPrimary.has(track.media_id)) continue;
        const list = tracksByMedia.get(track.media_id) || [];
        list.push(track);
        tracksByMedia.set(track.media_id, list);
    }

    for (const [mediaId, tracks] of tracksByMedia.entries()) {
        const primaryTrack = tracks.find((t) => t.is_default) || tracks[0];
        if (primaryTrack) {
            tracksToMarkPrimary.push(primaryTrack.id);
        }
    }

    if (tracksToMarkPrimary.length === 0) {
        console.log("No existing tracks need is_primary migration. All up to date!");
        process.exit(0);
    }

    console.log(`Marking ${tracksToMarkPrimary.length} tracks as is_primary = true...`);

    // Batch update in chunks of 500
    const chunkSize = 500;
    for (let i = 0; i < tracksToMarkPrimary.length; i += chunkSize) {
        const chunk = tracksToMarkPrimary.slice(i, i + chunkSize);
        await db.update(Track).set({ is_primary: true }).where(inArray(Track.id, chunk));
    }

    console.log("Migration completed successfully!");
    process.exit(0);
}

run().catch((err) => {
    // Catch block handles process termination directly
    console.error("Migration failed:", err);
    process.exit(1);
});
