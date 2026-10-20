import { and, desc, eq, exists, inArray, isNotNull, isNull, not, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
    AssetAiMetadata,
    AssetEmbedding,
    AssetSearchDocument,
    AsyncTask,
    AsyncTaskStatus,
    AsyncTaskType,
    DeleteStatus,
    EmbeddingRole,
    EmbeddingStatus,
    EntityType,
    File as DbFile,
    LibraryEmbeddingSpace,
    LibraryEmbeddingSpaceStatus,
    Media,
    ProcessingStatus,
    SyncStatus,
    Track,
    TrackPurpose,
    TrackType,
} from "@/db/schema";
import { db } from "@/global/db";
import { ofActiveMedia as ofActiveEmbeddingMedia } from "./embedding-queue";
import { getFailureCategory, INPUT_ERROR_KINDS, type AiFailureCategory } from "./errors";
import type { AiService } from "./service";

/**
 * How much of a library AI search covers, counted per media item. An item is covered once every
 * artifact that applies to it is ready: the text vector, and for items with an image, the
 * description (in the library's language; an older model or prompt version still counts) and
 * the image vector. Only vectors of the ACTIVE spaces count, since search reads those.
 */

/** What an item needs to be covered; null fields are roles that are off or cannot be used. */
export interface CoverageTargets {
    describeLanguage: string | null;
    textSpaceId: string | null;
    imageSpaceId: string | null;
}

export function getCoverageTargets(aiService: AiService | null): CoverageTargets | null {
    if (!aiService) return null;
    const targets = {
        describeLanguage: aiService.describeTarget?.language ?? null,
        textSpaceId: aiService.textEmbedding.active?.spaceId ?? null,
        imageSpaceId: aiService.imageEmbedding.active?.spaceId ?? null,
    };
    return targets.describeLanguage || targets.textSpaceId || targets.imageSpaceId ? targets : null;
}

const sourceTrack = alias(Track, "ai_source_track");
const sourceFile = alias(DbFile, "ai_source_file");
const contentTrack = alias(Track, "ai_content_track");
const one = { one: sql`1` };

/** The item has an image to describe and embed; mirrors selectAiImageSource over usable tracks. */
const hasImageSource = exists(
    db
        .select(one)
        .from(sourceTrack)
        .innerJoin(sourceFile, and(eq(sourceFile.id, sourceTrack.file_id), eq(sourceFile.delete_status, DeleteStatus.ACTIVE)))
        .where(
            and(
                eq(sourceTrack.media_id, Media.id),
                eq(sourceTrack.delete_status, DeleteStatus.ACTIVE),
                eq(sourceTrack.sync_status, SyncStatus.COMPLETED),
                eq(sourceTrack.type, TrackType.IMAGE),
                eq(sourceTrack.is_stale, false),
                or(
                    eq(sourceTrack.purpose, TrackPurpose.CONTENT),
                    and(
                        eq(sourceTrack.purpose, TrackPurpose.COVER),
                        or(
                            eq(sourceTrack.is_generated, false),
                            // A generated cover counts only while the content it was made from is current.
                            exists(
                                db
                                    .select(one)
                                    .from(contentTrack)
                                    .where(
                                        and(
                                            eq(contentTrack.media_id, Media.id),
                                            eq(contentTrack.delete_status, DeleteStatus.ACTIVE),
                                            eq(contentTrack.sync_status, SyncStatus.COMPLETED),
                                            eq(contentTrack.purpose, TrackPurpose.CONTENT),
                                            sql`${contentTrack.file_id}::text = ${sourceTrack.metadata}->>'source_file_id'`,
                                        ),
                                    ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
);

const ofItemMetadata = and(eq(AssetAiMetadata.entity_type, EntityType.MEDIA), eq(AssetAiMetadata.entity_id, Media.id));
const ofItemEmbedding = and(eq(AssetEmbedding.entity_type, EntityType.MEDIA), eq(AssetEmbedding.entity_id, Media.id));

const metadataExists = (...conditions: SQL[]) =>
    exists(
        db
            .select(one)
            .from(AssetAiMetadata)
            .where(and(ofItemMetadata, ...conditions)),
    );
const embeddingExists = (...conditions: SQL[]) =>
    exists(
        db
            .select(one)
            .from(AssetEmbedding)
            .where(and(ofItemEmbedding, ...conditions)),
    );

function vectorReady(spaceId: string, role: EmbeddingRole): SQL {
    return embeddingExists(
        eq(AssetEmbedding.embedding_space_id, spaceId),
        eq(AssetEmbedding.embedding_role, role),
        eq(AssetEmbedding.embedding_status, EmbeddingStatus.READY),
    );
}

/** The item was indexed and has no text to embed. */
const hasNoText = exists(
    db
        .select(one)
        .from(AssetSearchDocument)
        .where(
            and(
                eq(AssetSearchDocument.entity_type, EntityType.MEDIA),
                eq(AssetSearchDocument.entity_id, Media.id),
                eq(AssetSearchDocument.content, ""),
            ),
        ),
);

function isCovered(targets: CoverageTargets): SQL {
    const imageWork = [
        ...(targets.describeLanguage
            ? [metadataExists(isNotNull(AssetAiMetadata.input_hash), eq(AssetAiMetadata.language, targets.describeLanguage))]
            : []),
        ...(targets.imageSpaceId ? [vectorReady(targets.imageSpaceId, EmbeddingRole.IMAGE_PRIMARY)] : []),
    ];
    return (
        and(
            targets.textSpaceId ? or(vectorReady(targets.textSpaceId, EmbeddingRole.AI_CAPTION), hasNoText) : undefined,
            imageWork.length > 0 ? or(not(hasImageSource), and(...imageWork)) : undefined,
        ) ?? sql`true`
    );
}

function spaceIds(targets: CoverageTargets): string[] {
    return [targets.textSpaceId, targets.imageSpaceId].filter((id) => id !== null);
}

/** Matches failures of the item itself (`input`), or the other, retryable ones. */
function ofFailureKind(kind: typeof AssetAiMetadata.error_kind | typeof AssetEmbedding.error_kind, input: boolean): SQL {
    return input ? inArray(kind, INPUT_ERROR_KINDS) : not(inArray(sql`coalesce(${kind}, '')`, INPUT_ERROR_KINDS))!;
}

/** Failed describe or vector rows of the item, limited to input failures or to the others. */
function hasFailure(targets: CoverageTargets, input: boolean): SQL {
    const ids = spaceIds(targets);
    return (
        or(
            targets.describeLanguage
                ? metadataExists(
                      eq(AssetAiMetadata.processing_status, ProcessingStatus.FAILED),
                      ofFailureKind(AssetAiMetadata.error_kind, input),
                  )
                : undefined,
            ids.length > 0
                ? embeddingExists(
                      inArray(AssetEmbedding.embedding_space_id, ids),
                      eq(AssetEmbedding.embedding_status, EmbeddingStatus.FAILED),
                      ofFailureKind(AssetEmbedding.error_kind, input),
                  )
                : undefined,
        ) ?? sql`false`
    );
}

/** Item states for counting and filtering; each item is in exactly one of covered, unprocessable, failed or missing. */
function coverageStates(targets: CoverageTargets) {
    const covered = isCovered(targets);
    const unprocessable = and(not(covered), hasFailure(targets, true))!;
    const failed = and(not(covered), not(hasFailure(targets, true)), hasFailure(targets, false))!;
    return { covered, unprocessable, failed };
}

const ofLibraryMedia = (libraryId: string) =>
    and(eq(Media.library_id, libraryId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time))!;

/** Media list filter: items AI search does not cover yet (`incomplete`), or cannot (`unprocessable`). */
export type CoverageFilter = "incomplete" | "unprocessable";

export function coverageFilter(targets: CoverageTargets, filter: CoverageFilter): SQL {
    const states = coverageStates(targets);
    return filter === "unprocessable" ? states.unprocessable : and(not(states.covered), not(states.unprocessable))!;
}

export interface CoverageFailureView {
    category: AiFailureCategory;
    message: string;
    at: string;
}

export interface LibraryCoverage {
    /** Active media of the library. */
    eligible: number;
    covered: number;
    /** Not covered: failed with a problem of the item itself, which retrying does not fix. */
    unprocessable: number;
    /** Not covered: failed for a reason a retry can fix (provider, key, quota). */
    failed: number;
    /** Not covered and not failed: never processed, or still queued. */
    missing: number;
    /** Latest failure of the `failed` items. */
    lastFailure: CoverageFailureView | null;
}

/** Latest retryable failure among the item states counted as `failed`. */
async function latestFailure(libraryId: string, targets: CoverageTargets): Promise<CoverageFailureView | null> {
    const ids = spaceIds(targets);
    const candidates = await Promise.all([
        targets.describeLanguage
            ? db
                  .select({ message: AssetAiMetadata.last_error, kind: AssetAiMetadata.error_kind, at: AssetAiMetadata.update_time })
                  .from(AssetAiMetadata)
                  .where(
                      and(
                          eq(AssetAiMetadata.library_id, libraryId),
                          eq(AssetAiMetadata.processing_status, ProcessingStatus.FAILED),
                          ofFailureKind(AssetAiMetadata.error_kind, false),
                      ),
                  )
                  .orderBy(desc(AssetAiMetadata.update_time))
                  .limit(1)
            : [],
        ids.length > 0
            ? db
                  .select({ message: AssetEmbedding.last_error, kind: AssetEmbedding.error_kind, at: AssetEmbedding.update_time })
                  .from(AssetEmbedding)
                  .where(
                      and(
                          eq(AssetEmbedding.library_id, libraryId),
                          inArray(AssetEmbedding.embedding_space_id, ids),
                          eq(AssetEmbedding.embedding_status, EmbeddingStatus.FAILED),
                          ofFailureKind(AssetEmbedding.error_kind, false),
                          ofActiveEmbeddingMedia,
                      ),
                  )
                  .orderBy(desc(AssetEmbedding.update_time))
                  .limit(1)
            : [],
    ]);
    const latest = candidates
        .flat()
        .filter((row) => row.message && row.at)
        .sort((a, b) => b.at!.toString().localeCompare(a.at!.toString()))[0];
    return latest ? { category: getFailureCategory(latest.kind), message: latest.message!, at: latest.at!.toString() } : null;
}

/** Coverage of a library; reads every item, so it is computed on demand rather than polled. */
export async function getLibraryCoverage(libraryId: string, targets: CoverageTargets): Promise<LibraryCoverage> {
    const states = coverageStates(targets);
    const [[counts], lastFailure] = await Promise.all([
        db
            .select({
                eligible: sql<number>`count(*)::int`,
                covered: sql<number>`(count(*) filter (where ${states.covered}))::int`,
                unprocessable: sql<number>`(count(*) filter (where ${states.unprocessable}))::int`,
                failed: sql<number>`(count(*) filter (where ${states.failed}))::int`,
            })
            .from(Media)
            .where(ofLibraryMedia(libraryId)),
        latestFailure(libraryId, targets),
    ]);
    const { eligible, covered, unprocessable, failed } = counts!;
    return { eligible, covered, unprocessable, failed, missing: eligible - covered - unprocessable - failed, lastFailure };
}

export interface LibraryAiProgress {
    /** The running library-wide enrichment: items handled so far, out of the items discovered so far. */
    task: { done: number; total: number } | null;
    /** Vectors waiting in the queue for the spaces the library writes. */
    queuedVectors: number;
}

/** Cheap progress of AI work in a library, for polling while it runs. */
export async function getLibraryAiProgress(libraryId: string): Promise<LibraryAiProgress> {
    const writtenSpaceIds = db
        .select({ space_id: LibraryEmbeddingSpace.space_id })
        .from(LibraryEmbeddingSpace)
        .where(
            and(
                eq(LibraryEmbeddingSpace.library_id, libraryId),
                inArray(LibraryEmbeddingSpace.status, [LibraryEmbeddingSpaceStatus.ACTIVE, LibraryEmbeddingSpaceStatus.BUILDING]),
            ),
        );
    const [[task], [queue]] = await Promise.all([
        db
            .select({ succeeded: AsyncTask.succeeded_units, failed: AsyncTask.failed_units, total: AsyncTask.total_units })
            .from(AsyncTask)
            .where(
                and(
                    eq(AsyncTask.library_id, libraryId),
                    eq(AsyncTask.type, AsyncTaskType.AI_ENRICH),
                    inArray(AsyncTask.status, [AsyncTaskStatus.DISCOVERING, AsyncTaskStatus.RUNNING]),
                ),
            )
            .orderBy(desc(AsyncTask.create_time))
            .limit(1),
        db
            .select({ count: sql<number>`count(*)::int` })
            .from(AssetEmbedding)
            .where(
                and(
                    eq(AssetEmbedding.library_id, libraryId),
                    eq(AssetEmbedding.embedding_status, EmbeddingStatus.PENDING),
                    inArray(AssetEmbedding.embedding_space_id, writtenSpaceIds),
                    ofActiveEmbeddingMedia,
                ),
            ),
    ]);
    return {
        task: task ? { done: task.succeeded + task.failed, total: task.total } : null,
        queuedVectors: queue!.count,
    };
}
