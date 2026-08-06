import { aliasedTable, and, count, eq, gt, isNull, isNotNull, lt, ne, notExists, or } from "drizzle-orm";
import { db, type Transaction } from "@/global/db";
import { DeleteStatus, File, Library, Media, MediaTag, Post, PostTag, Tag, Track } from "@/db/schema";

export interface MediaTrackIntegrityReport {
    scanned_at: string;
    counts: Record<string, number>;
}

type Executor = typeof db | Transaction;

async function getCount(query: any): Promise<number> {
    const [row] = await query;
    return Number(row?.val ?? 0);
}

export async function runMediaTrackIntegrityScan(executor: Executor = db): Promise<MediaTrackIntegrityReport> {
    const sourceTrack = aliasedTable(Track, "sourceTrack");

    const [
        media_blank_eid,
        media_attached_duplicate_eid,
        media_independent_duplicate_eid,
        media_missing_post,
        media_post_library_mismatch,
        media_missing_library,
        track_missing_media,
        track_missing_file,
        track_invalid_source,
        track_original_and_generated,
        track_invalid_numeric_values,
        file_negative_size,
        post_source_eid_duplicate,
        media_negative_sort_order,
        media_tag_cross_library,
        post_tag_cross_library,
    ] = await Promise.all([
        // 1. Media with blank eid
        getCount(
            executor
                .select({ val: count() })
                .from(Media)
                .where(or(eq(Media.eid, ""), eq(Media.eid, " "))),
        ),

        // 2. Attached Media duplicate (post_id, source, eid)
        getCount(
            executor.select({ val: count() }).from(
                executor
                    .select({ post_id: Media.post_id, source: Media.source, eid: Media.eid })
                    .from(Media)
                    .where(and(isNotNull(Media.post_id), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                    .groupBy(Media.post_id, Media.source, Media.eid)
                    .having(gt(count(), 1))
                    .as("duplicates"),
            ),
        ),

        // 3. Independent Media duplicate (library_id, source, eid)
        getCount(
            executor.select({ val: count() }).from(
                executor
                    .select({ library_id: Media.library_id, source: Media.source, eid: Media.eid })
                    .from(Media)
                    .where(and(isNull(Media.post_id), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                    .groupBy(Media.library_id, Media.source, Media.eid)
                    .having(gt(count(), 1))
                    .as("duplicates"),
            ),
        ),

        // 4. Media pointing to missing Post
        getCount(
            executor
                .select({ val: count() })
                .from(Media)
                .where(and(isNotNull(Media.post_id), notExists(executor.select().from(Post).where(eq(Post.id, Media.post_id))))),
        ),

        // 5. Media/Post library mismatch
        getCount(
            executor
                .select({ val: count() })
                .from(Media)
                .innerJoin(Post, eq(Post.id, Media.post_id))
                .where(and(isNotNull(Media.post_id), ne(Media.library_id, Post.library_id))),
        ),

        // 6. Media pointing to missing Library
        getCount(
            executor
                .select({ val: count() })
                .from(Media)
                .where(notExists(executor.select().from(Library).where(eq(Library.id, Media.library_id)))),
        ),

        // 7. Track pointing to missing Media
        getCount(
            executor
                .select({ val: count() })
                .from(Track)
                .where(notExists(executor.select().from(Media).where(eq(Media.id, Track.media_id)))),
        ),

        // 8. Track pointing to missing File
        getCount(
            executor
                .select({ val: count() })
                .from(Track)
                .where(and(isNotNull(Track.file_id), notExists(executor.select().from(File).where(eq(File.id, Track.file_id))))),
        ),

        // 9. Track pointing to invalid source_track_id
        getCount(
            executor
                .select({ val: count() })
                .from(Track)
                .where(
                    and(
                        isNotNull(Track.source_track_id),
                        notExists(
                            executor
                                .select()
                                .from(sourceTrack)
                                .where(
                                    and(
                                        eq(sourceTrack.id, Track.source_track_id),
                                        eq(sourceTrack.media_id, Track.media_id),
                                        eq(sourceTrack.delete_status, DeleteStatus.ACTIVE),
                                    ),
                                ),
                        ),
                    ),
                ),
        ),

        // 10. Track marked as both original and generated
        getCount(
            executor
                .select({ val: count() })
                .from(Track)
                .where(and(eq(Track.is_original, true), eq(Track.is_generated, true))),
        ),

        // 11. Track invalid numeric or variant_key values
        getCount(
            executor
                .select({ val: count() })
                .from(Track)
                .where(
                    or(
                        lt(Track.priority, 0),
                        lt(Track.width, 0),
                        lt(Track.height, 0),
                        lt(Track.duration, 0),
                        lt(Track.bandwidth, 0),
                        eq(Track.variant_key, ""),
                    ),
                ),
        ),

        // 12. File negative size
        getCount(executor.select({ val: count() }).from(File).where(lt(File.size, 0))),

        // 13. Post duplicate (source, eid)
        getCount(
            executor
                .select({ val: count() })
                .from(
                    executor
                        .select({ source: Post.source, eid: Post.eid })
                        .from(Post)
                        .groupBy(Post.source, Post.eid)
                        .having(gt(count(), 1))
                        .as("duplicates"),
                ),
        ),

        // 14. Media negative sort_order
        getCount(executor.select({ val: count() }).from(Media).where(lt(Media.sort_order, 0))),

        // 15. MediaTag cross-library reference
        getCount(
            executor
                .select({ val: count() })
                .from(MediaTag)
                .innerJoin(Media, eq(Media.id, MediaTag.media_id))
                .innerJoin(Tag, eq(Tag.id, MediaTag.tag_id))
                .where(ne(Media.library_id, Tag.library_id)),
        ),

        // 16. PostTag cross-library reference
        getCount(
            executor
                .select({ val: count() })
                .from(PostTag)
                .innerJoin(Post, eq(Post.id, PostTag.post_id))
                .innerJoin(Tag, eq(Tag.id, PostTag.tag_id))
                .where(ne(Post.library_id, Tag.library_id)),
        ),
    ]);

    return {
        scanned_at: Temporal.Now.instant().toString(),
        counts: {
            media_blank_eid,
            media_attached_duplicate_eid,
            media_independent_duplicate_eid,
            media_missing_post,
            media_post_library_mismatch,
            media_missing_library,
            track_missing_media,
            track_missing_file,
            track_invalid_source,
            track_original_and_generated,
            track_invalid_numeric_values,
            file_negative_size,
            post_source_eid_duplicate,
            media_negative_sort_order,
            media_tag_cross_library,
            post_tag_cross_library,
        },
    };
}
