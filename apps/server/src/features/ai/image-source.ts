import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DeleteStatus, File as DbFile, MediaPreview, PreviewSize } from "@/db/schema";
import { db } from "@/global/db";
import { isQueued } from "@/infra/queue/store";
import { s3, S3ObjectTooLargeError } from "@/global/s3";
import { AiProviderError } from "./errors";
import { supportsImageFormat, withinImageLimits } from "./image-format";
import type { EmbedImageParams, VisualEmbeddingProvider } from "./types";

const SOURCE_READ_TIMEOUT_MS = 60_000;
const SOURCE_MAX_BYTES = 50 * 1024 * 1024;
/** Lifetime of a source URL handed to a model server; it also covers waiting for a rate-limit slot. */
const SOURCE_URL_TTL_SECONDS = 60 * 60;

/** The largest preview is what AI reads; a smaller one stands in while it is missing. */
const PREVIEW_PREFERENCE: readonly PreviewSize[] = [PreviewSize.LARGE, PreviewSize.MEDIUM, PreviewSize.SMALL];

/**
 * The image AI work on a media reads: a rendered preview. `hash` identifies what the preview was rendered from, not the
 * preview itself, so rendering previews again with a new recipe does not describe or embed the media again.
 */
export interface AiImageSource {
    file: typeof DbFile.$inferSelect;
    width: number;
    height: number;
    sourceFileId: string;
    hash: string;
}

const sourceFile = alias(DbFile, "ai_preview_source_file");

/** The preview AI reads among a media's rendered previews: the largest one. */
export function selectAiPreview<T extends { preview: Pick<typeof MediaPreview.$inferSelect, "size"> }>(rows: readonly T[]): T | null {
    for (const size of PREVIEW_PREFERENCE) {
        const row = rows.find((candidate) => candidate.preview.size === size);
        if (row) return row;
    }
    return null;
}

/** The AI image source of each media (missing for media without a preview). */
export async function loadAiImageSources(mediaIds: readonly string[]): Promise<Map<string, AiImageSource>> {
    if (mediaIds.length === 0) return new Map();
    const rows = await db
        .select({ preview: MediaPreview, file: DbFile, source: { id: sourceFile.id, hash: sourceFile.hash } })
        .from(MediaPreview)
        .innerJoin(DbFile, and(eq(DbFile.id, MediaPreview.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
        .innerJoin(sourceFile, eq(sourceFile.id, MediaPreview.source_file_id))
        .where(and(inArray(MediaPreview.media_id, [...mediaIds]), isNotNull(MediaPreview.width), isNotNull(MediaPreview.height)));

    const sources = new Map<string, AiImageSource>();
    for (const mediaId of new Set(rows.map((row) => row.preview.media_id))) {
        const row = selectAiPreview(rows.filter((candidate) => candidate.preview.media_id === mediaId))!;
        sources.set(mediaId, {
            file: row.file,
            width: row.preview.width!,
            height: row.preview.height!,
            sourceFileId: row.source.id,
            hash: aiSourceHash(row.source),
        });
    }
    return sources;
}

/**
 * The image AI work on a media starts from. `waiting` is set while the preview pipeline has the media queued: the work
 * waits, and the preview run reports its change when it ends, which queues the work again.
 */
export async function resolveAiImageSource(mediaId: string): Promise<{ source: AiImageSource | null; waiting: boolean }> {
    if (await isQueued("preview", mediaId)) return { source: null, waiting: true };
    return { source: (await loadAiImageSources([mediaId])).get(mediaId) ?? null, waiting: false };
}

/** What identifies a source image's content: its file hash, or the file itself when it has no hash. */
export function aiSourceHash(file: Pick<typeof DbFile.$inferSelect, "id" | "hash">): string {
    return file.hash || `file:${file.id}`;
}

/**
 * Reads a source image for a model that receives image bytes. It goes through the S3 SDK, so the
 * server reaches storage over the configured (possibly private) endpoint rather than a public URL.
 */
export async function readAiSourceImage(
    file: Pick<typeof DbFile.$inferSelect, "id" | "path" | "bucket">,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(SOURCE_READ_TIMEOUT_MS);
    try {
        return await s3.read(file.path, {
            bucket: file.bucket,
            maxBytes: SOURCE_MAX_BYTES,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
    } catch (error) {
        // The SDK reports every abort as AbortError, so tell our timeout apart from cancellation here.
        if (timeout.aborted && !signal?.aborted) {
            throw new AiProviderError("TIMEOUT", `Reading source file ${file.id} timed out after ${SOURCE_READ_TIMEOUT_MS / 1000}s`);
        }
        if (error instanceof S3ObjectTooLargeError) {
            throw new AiProviderError(
                "UNSUPPORTED",
                `Source file ${file.id} is ${error.size} bytes, over the ${error.maxBytes} byte limit`,
            );
        }
        throw error;
    }
}

/**
 * Loads a source image for an embedding model. A model server that downloads images itself gets a
 * presigned URL when the stored file is already in a format the model accepts and within the size
 * limits, so this server neither reads nor converts it. Anything else is read as bytes, which
 * `AiService.embedImages` converts as needed.
 */
export async function loadAiEmbeddingImage(
    file: Pick<typeof DbFile.$inferSelect, "id" | "path" | "bucket" | "mime_type" | "size">,
    dimensions: { width: number; height: number } | undefined,
    provider: VisualEmbeddingProvider,
    signal?: AbortSignal,
): Promise<EmbedImageParams> {
    if (
        provider.fetchesImageUrls &&
        supportsImageFormat(file.mime_type, provider.capabilities.imageFormats) &&
        dimensions &&
        file.size !== null &&
        withinImageLimits(dimensions.width, dimensions.height, file.size)
    ) {
        const url = await s3.getPresignedUrl(file.path, { bucket: file.bucket, expiresInSeconds: SOURCE_URL_TTL_SECONDS });
        return { url, mimeType: file.mime_type };
    }
    return { imageBuffer: await readAiSourceImage(file, signal), mimeType: file.mime_type };
}
