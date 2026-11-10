/**
 * Captions of audio and video media (docs/media_refactor.zh-Hans.md, 3.8). A FILE caption keeps the uploaded or
 * imported file and its WebVTT conversion; clients only ever get the WebVTT.
 */
import { and, eq, inArray, ne, type SQL } from "drizzle-orm";
import { AssetOrigin, DeleteStatus, File as DbFile, MediaCaption, SyncStatus } from "@/db/schema";
import type { DbClient } from "@/global/db";
import { env } from "@/global/env";
import { s3 } from "@/global/s3";
import { ProbeRejectedError } from "./probe";
import { mediaStoragePath } from "./storage";

const CONVERT_TIMEOUT_MS = 120_000;

export interface CaptionDeclaration {
    language?: string | null;
    label?: string | null;
    is_default?: boolean | null;
}

/** Converts a subtitle file (SRT, ASS, WebVTT...) in storage to WebVTT. A file ffmpeg cannot read is rejected. */
export async function convertToVtt(file: { bucket: string; path: string }): Promise<Uint8Array> {
    const url = await s3.getPresignedUrl(file.path, { bucket: file.bucket, expiresInSeconds: 3600 });
    const process = Bun.spawn(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", url, "-map", "0:s:0", "-f", "webvtt", "pipe:1"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: CONVERT_TIMEOUT_MS,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).bytes(), new Response(process.stderr).text(), process.exited]);
    if (process.signalCode) throw new Error("Caption conversion timed out");
    if (code !== 0 || stdout.byteLength === 0) {
        throw new ProbeRejectedError(`The caption could not be converted to WebVTT: ${stderr.trim().slice(0, 500) || `exit ${code}`}`);
    }
    return stdout;
}

/** Stores the WebVTT of a caption and returns its file. */
export async function storeVtt(
    client: DbClient,
    media: { id: string; post_id: string | null },
    captionKey: string,
    vtt: Uint8Array,
): Promise<string> {
    const path = mediaStoragePath(media, `caption_${captionKey}.vtt`);
    await s3.write(path, vtt, { bucket: env.S3_BUCKET, type: "text/vtt", contentLength: vtt.byteLength });
    const [file] = await client
        .insert(DbFile)
        .values({ path, bucket: env.S3_BUCKET, mime_type: "text/vtt", extension: "vtt", size: vtt.byteLength })
        .onConflictDoUpdate({ target: DbFile.path, set: { size: vtt.byteLength, delete_status: DeleteStatus.ACTIVE, delete_time: null } })
        .returning({ id: DbFile.id });
    return file!.id;
}

/** Makes `captionId` the only default caption of its media. */
export async function makeDefaultCaption(client: DbClient, mediaId: string, captionId: string): Promise<void> {
    await client
        .update(MediaCaption)
        .set({ is_default: false })
        .where(and(eq(MediaCaption.media_id, mediaId), ne(MediaCaption.id, captionId), eq(MediaCaption.is_default, true)));
    await client.update(MediaCaption).set({ is_default: true }).where(eq(MediaCaption.id, captionId));
}

/** Inserts a caption the user uploaded, already converted. */
export async function insertUploadedCaption(
    client: DbClient,
    mediaId: string,
    files: { sourceFileId: string; vttFileId: string },
    declared: CaptionDeclaration,
): Promise<string> {
    const [caption] = await client
        .insert(MediaCaption)
        .values({
            media_id: mediaId,
            origin: AssetOrigin.FILE,
            language: declared.language ?? null,
            label: declared.label ?? null,
            source_file_id: files.sourceFileId,
            vtt_file_id: files.vttFileId,
            status: SyncStatus.COMPLETED,
        })
        .returning({ id: MediaCaption.id });
    if (declared.is_default) await makeDefaultCaption(client, mediaId, caption!.id);
    return caption!.id;
}

/** Deletes captions with their files, which are marked deleted. Returns the deleted caption ids. */
async function deleteCaptionsWhere(client: DbClient, condition: SQL): Promise<string[]> {
    const captions = await client
        .delete(MediaCaption)
        .where(condition)
        .returning({ id: MediaCaption.id, vtt: MediaCaption.vtt_file_id, source: MediaCaption.source_file_id });
    const fileIds = captions.flatMap((caption) => [caption.vtt, caption.source]).filter((id): id is string => Boolean(id));
    if (fileIds.length > 0) {
        await client
            .update(DbFile)
            .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
            .where(and(inArray(DbFile.id, fileIds), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));
    }
    return captions.map((caption) => caption.id);
}

/** Deletes captions of one media by id. */
export async function deleteCaptions(client: DbClient, mediaId: string, captionIds: readonly string[]): Promise<string[]> {
    if (captionIds.length === 0) return [];
    return deleteCaptionsWhere(client, and(eq(MediaCaption.media_id, mediaId), inArray(MediaCaption.id, [...captionIds]))!);
}

/** Deletes the captions of media being deleted. */
export async function deleteMediaCaptions(client: DbClient, mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await deleteCaptionsWhere(client, inArray(MediaCaption.media_id, [...mediaIds]));
}
