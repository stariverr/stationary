/**
 * Shared state rules of the imported sources of a media: originals, captions and the cover
 * (docs/failure_handling.zh-Hans.md, 4). An error on a row belongs to the URL it happened on.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { MediaCaption, MediaCover, MediaOriginal, SourceErrorKind, SyncStatus } from "@/db/schema";
import type { DbClient } from "@/global/db";

/** Clears the error of a source row. */
export const NO_SOURCE_ERROR = { last_error: null, error_kind: null, error_source_url: null } as const;

/**
 * What an import offering `url` for a source the media already has writes on its row, and whether the source needs a
 * download. A new URL voids the error of the old one, so a source not yet downloaded starts over on it; the same URL
 * leaves a FAILED source failed until a retry.
 */
export function refreshSource(current: { status: SyncStatus; source_url: string | null }, url: string) {
    const completed = current.status === SyncStatus.COMPLETED;
    if (current.source_url === url) {
        return { values: {}, pending: current.status === SyncStatus.PENDING || current.status === SyncStatus.IN_PROGRESS };
    }
    if (completed) return { values: { source_url: url }, pending: false };
    return { values: { source_url: url, status: SyncStatus.PENDING, ...NO_SOURCE_ERROR }, pending: true };
}

/** Error kinds a retry may get past; the others need a new URL or a fix to the source (5). */
const RETRYABLE_KINDS = [SourceErrorKind.NETWORK, SourceErrorKind.INTERNAL];

/**
 * Puts the imported sources of `mediaIds` that failed for a retryable reason back to PENDING, for the next download.
 * Returns the media that had one.
 */
export async function resetRetryableSources(client: DbClient, mediaIds: readonly string[]): Promise<string[]> {
    if (mediaIds.length === 0) return [];
    const reset = new Set<string>();
    for (const table of [MediaOriginal, MediaCaption, MediaCover]) {
        const rows = await client
            .update(table)
            .set({ status: SyncStatus.PENDING, ...NO_SOURCE_ERROR, update_time: Temporal.Now.instant() })
            .where(
                and(
                    inArray(table.media_id, [...mediaIds]),
                    isNotNull(table.source_url),
                    eq(table.status, SyncStatus.FAILED),
                    inArray(table.error_kind, RETRYABLE_KINDS),
                ),
            )
            .returning({ mediaId: table.media_id });
        for (const row of rows) reset.add(row.mediaId);
    }
    return [...reset];
}
