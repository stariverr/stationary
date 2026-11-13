/**
 * Lyrics of audio and video media (docs/media_refactor.zh-Hans.md, 3.9), served as LRC. Only EMBEDDED lyrics exist so
 * far: the unsynced lyrics in an original's tags, written as LRC without timestamps.
 */
import { and, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { AssetOrigin, DeleteStatus, File as DbFile, LyricsTiming, MediaLyrics, SyncStatus } from "@/db/schema";
import type { DbClient } from "@/global/db";
import { env } from "@/global/env";
import { s3 } from "@/global/s3";
import type { EmbeddedLyrics } from "./probe";
import { mediaStoragePath } from "./storage";

/** Stores an LRC file of a media and returns its file. */
async function storeLrc(client: DbClient, media: { id: string; post_id: string | null }, lyricsId: string, lrc: string): Promise<string> {
    const bytes = new TextEncoder().encode(lrc);
    const path = mediaStoragePath(media, `lyrics_${lyricsId}.lrc`);
    // The charset matters: clients that decode by Content-Type would read UTF-8 as Latin-1 without it.
    await s3.write(path, bytes, { bucket: env.S3_BUCKET, type: "text/plain; charset=utf-8", contentLength: bytes.byteLength });
    const [file] = await client
        .insert(DbFile)
        .values({ path, bucket: env.S3_BUCKET, mime_type: "text/plain", extension: "lrc", size: bytes.byteLength })
        .onConflictDoUpdate({ target: DbFile.path, set: { size: bytes.byteLength, delete_status: DeleteStatus.ACTIVE, delete_time: null } })
        .returning({ id: DbFile.id });
    return file!.id;
}

/**
 * Records the lyrics read from an original's tags as EMBEDDED lyrics (6.2), each stored as an LRC file of plain lines.
 * The first becomes the default when the media has no default lyrics yet.
 */
export async function insertEmbeddedLyrics(
    client: DbClient,
    media: { id: string; post_id: string | null },
    originalId: string,
    lyrics: EmbeddedLyrics[],
): Promise<void> {
    if (lyrics.length === 0) return;
    const [existingDefault] = await client
        .select({ id: MediaLyrics.id })
        .from(MediaLyrics)
        .where(and(eq(MediaLyrics.media_id, media.id), eq(MediaLyrics.is_default, true)))
        .limit(1);
    for (const [index, item] of lyrics.entries()) {
        const id = uuidv7();
        const lrcFileId = await storeLrc(client, media, id, `${item.text}\n`);
        await client.insert(MediaLyrics).values({
            id,
            media_id: media.id,
            origin: AssetOrigin.EMBEDDED,
            language: item.language,
            label: item.label,
            is_default: !existingDefault && index === 0,
            timing: LyricsTiming.NONE,
            lrc_file_id: lrcFileId,
            original_id: originalId,
            status: SyncStatus.COMPLETED,
        });
    }
}

/** Deletes the lyrics read from the given originals; their files are marked deleted. */
export async function deleteEmbeddedLyrics(client: DbClient, originalIds: readonly string[]): Promise<void> {
    if (originalIds.length === 0) return;
    const lyrics = await client
        .delete(MediaLyrics)
        .where(inArray(MediaLyrics.original_id, [...originalIds]))
        .returning({ lrc: MediaLyrics.lrc_file_id });
    const fileIds = lyrics.flatMap((item) => (item.lrc ? [item.lrc] : []));
    if (fileIds.length === 0) return;
    await client
        .update(DbFile)
        .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
        .where(and(inArray(DbFile.id, fileIds), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));
}
