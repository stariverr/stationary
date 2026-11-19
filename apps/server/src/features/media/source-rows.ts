/**
 * Shared state rules of the imported sources of a media: originals, captions and the cover
 * (docs/failure_handling.zh-Hans.md, 4). An error on a row belongs to the URL it happened on.
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { DeleteStatus, Media, MediaCaption, MediaCover, MediaOriginal, SourceErrorKind, SyncStatus } from "@/db/schema";
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

/** Whether a retry may get an imported source past its failure: it failed, for a retryable reason. */
export function isRetryable(row: { source_url: string | null; status: SyncStatus; error_kind: SourceErrorKind | null }): boolean {
    return (
        row.source_url !== null && row.status === SyncStatus.FAILED && row.error_kind !== null && RETRYABLE_KINDS.includes(row.error_kind)
    );
}

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

/**
 * Error kinds from the one that most needs the user to the one most likely to pass on its own (9.2). A final kind comes
 * first, as no retry gets past it; sharing the post again refreshes every URL of the post, so SOURCE_UNAVAILABLE leads.
 * Hence the main kind of a media is retryable only when every error on it is.
 */
const ERROR_KIND_PRIORITY = [
    SourceErrorKind.SOURCE_UNAVAILABLE,
    SourceErrorKind.KIND_MISMATCH,
    SourceErrorKind.UNREADABLE,
    SourceErrorKind.INTERNAL,
    SourceErrorKind.NETWORK,
];

/** The kind that sums up several errors, by ERROR_KIND_PRIORITY; null when there are none. */
export function mainErrorKind(kinds: Iterable<SourceErrorKind>): SourceErrorKind | null {
    const present = new Set(kinds);
    return ERROR_KIND_PRIORITY.find((kind) => present.has(kind)) ?? null;
}

/**
 * The main error kind of each of `mediaIds` that has an error on an imported source, failed or being retried. Read when
 * needed and never stored: the failure stays on its source row (4.4).
 */
export async function loadMainErrorKinds(client: DbClient, mediaIds: readonly string[]): Promise<Map<string, SourceErrorKind>> {
    if (mediaIds.length === 0) return new Map();
    const kinds = new Map<string, SourceErrorKind[]>();
    for (const table of [MediaOriginal, MediaCaption, MediaCover]) {
        const rows = await client
            .select({ mediaId: table.media_id, kind: table.error_kind })
            .from(table)
            .where(and(inArray(table.media_id, [...mediaIds]), isNotNull(table.source_url), isNotNull(table.error_kind)));
        for (const row of rows) kinds.set(row.mediaId, [...(kinds.get(row.mediaId) ?? []), row.kind!]);
    }
    return new Map([...kinds].map(([mediaId, list]) => [mediaId, mainErrorKind(list)!]));
}

/** The main error kind of each of `postIds` over its active media, by the same rule as a media's. */
export async function loadPostErrorKinds(client: DbClient, postIds: readonly string[]): Promise<Map<string, SourceErrorKind>> {
    if (postIds.length === 0) return new Map();
    const medias = await client
        .select({ id: Media.id, postId: Media.post_id })
        .from(Media)
        .where(and(inArray(Media.post_id, [...postIds]), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
    const byMedia = await loadMainErrorKinds(
        client,
        medias.map((media) => media.id),
    );
    const kinds = new Map<string, SourceErrorKind[]>();
    for (const media of medias) {
        const kind = byMedia.get(media.id);
        if (kind) kinds.set(media.postId!, [...(kinds.get(media.postId!) ?? []), kind]);
    }
    return new Map([...kinds].map(([postId, list]) => [postId, mainErrorKind(list)!]));
}
