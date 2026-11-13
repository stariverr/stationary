import { and, eq, inArray, sql } from "drizzle-orm";
import { DeleteStatus, File as DbFile, MediaCaption, MediaCover, MediaLyrics, MediaOriginal, MediaPreview } from "@/db/schema";
import type { DbClient } from "@/global/db";
import { deleteMediaCaptions } from "./captions";
import { deleteMediaImages } from "./cover";
import { deleteOriginals } from "./originals";

/**
 * Releases everything a deleted media owns: originals with their stream rows and lyrics, captions, cover and
 * previews. The rows go and their files are marked deleted for the purge. Returns how many files were released.
 */
export async function releaseMediaAssets(client: DbClient, mediaIds: readonly string[]): Promise<number> {
    if (mediaIds.length === 0) return 0;
    const ids = [...mediaIds];
    const owned = sql`(
        SELECT ${MediaOriginal.file_id} FROM ${MediaOriginal} WHERE ${inArray(MediaOriginal.media_id, ids)}
        UNION SELECT ${MediaCaption.vtt_file_id} FROM ${MediaCaption} WHERE ${inArray(MediaCaption.media_id, ids)}
        UNION SELECT ${MediaCaption.source_file_id} FROM ${MediaCaption} WHERE ${inArray(MediaCaption.media_id, ids)}
        UNION SELECT ${MediaLyrics.lrc_file_id} FROM ${MediaLyrics} WHERE ${inArray(MediaLyrics.media_id, ids)}
        UNION SELECT ${MediaCover.file_id} FROM ${MediaCover} WHERE ${inArray(MediaCover.media_id, ids)}
        UNION SELECT ${MediaPreview.file_id} FROM ${MediaPreview} WHERE ${inArray(MediaPreview.media_id, ids)}
    )`;
    const [{ count }] = await client
        .select({ count: sql<number>`count(*)::int` })
        .from(DbFile)
        .where(and(sql`${DbFile.id} IN ${owned}`, eq(DbFile.delete_status, DeleteStatus.ACTIVE)));
    await deleteOriginals(client, { mediaIds: ids });
    await deleteMediaCaptions(client, ids);
    await deleteMediaImages(client, ids);
    return count ?? 0;
}
