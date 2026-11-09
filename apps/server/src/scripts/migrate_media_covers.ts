/**
 * Phase 1 of docs/media_refactor.zh-Hans.md: covers leave the track table.
 *
 * - The best original (not generated) COVER track of each VIDEO, AUDIO and PDF media becomes its `media_cover`.
 * - Every COVER track is retired, and its file marked deleted unless it is that cover's file. Storage is not touched.
 * - AI descriptions and image vectors made from one of the media's images are re-keyed to the file its previews are
 *   rendered from, so the change of AI input to previews does not describe or embed the media again.
 * - The queues of the removed `cover` pipeline go, and every library is scanned for previews.
 *
 * Run after `bun run db:migrate` created the new tables, while no worker runs. Dry run by default; `--apply` commits.
 */
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import {
    AssetAiMetadata,
    AssetEmbedding,
    DeleteStatus,
    EmbeddingRole,
    EntityType,
    File as DbFile,
    Library,
    Media,
    MediaCover,
    SyncStatus,
    Track,
    TrackPurpose,
} from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { aiSourceHash } from "@/features/ai/image-source";
import { previewSourceOf } from "@/features/media/preview";
import { COVER_MEDIA_TYPES } from "@/lib/validation/media-composition";
import { requestScan } from "@/infra/queue/changes";
import { deleteQueues } from "@/infra/queue/store";
import { Quality } from "@/lib/types";

const apply = process.argv.includes("--apply");
const BATCH_SIZE = 500;
const QUALITY_RANK: Record<Quality, number> = { [Quality.HIGH]: 0, [Quality.MEDIUM]: 1, [Quality.LOW]: 2 };

type TrackRow = typeof Track.$inferSelect;
type FileRow = typeof DbFile.$inferSelect;
type TrackWithFile = { track: TrackRow; file: FileRow | null };

class DryRun extends Error {}

const counts = { media: 0, coversCompleted: 0, coversPending: 0, retiredTracks: 0, retiredFiles: 0, descriptions: 0, vectors: 0 };

/** The cover track a media keeps: completed ones first, then by quality and priority. */
function pickCover(rows: TrackWithFile[]): TrackWithFile | undefined {
    const usable = rows.filter(
        ({ track, file }) =>
            !track.is_generated &&
            ((track.sync_status === SyncStatus.COMPLETED && file?.delete_status === DeleteStatus.ACTIVE) || Boolean(track.source_url)),
    );
    const completed = (row: TrackWithFile) => (row.track.sync_status === SyncStatus.COMPLETED && row.file ? 0 : 1);
    return usable.sort(
        (a, b) =>
            completed(a) - completed(b) ||
            QUALITY_RANK[a.track.quality] - QUALITY_RANK[b.track.quality] ||
            a.track.priority - b.track.priority,
    )[0];
}

async function migrateMedia(tx: Transaction, media: Pick<typeof Media.$inferSelect, "id" | "type">[]): Promise<void> {
    const ids = media.map((row) => row.id);
    const rows = await tx
        .select({ track: Track, file: DbFile })
        .from(Track)
        .leftJoin(DbFile, eq(DbFile.id, Track.file_id))
        .where(and(inArray(Track.media_id, ids), eq(Track.delete_status, DeleteStatus.ACTIVE)));
    const now = Temporal.Now.instant();

    for (const { id: mediaId, type } of media) {
        const own = rows.filter(({ track }) => track.media_id === mediaId);
        const covers = own.filter(({ track }) => track.purpose === TrackPurpose.COVER);

        const kept = COVER_MEDIA_TYPES.has(type) ? pickCover(covers) : undefined;
        const keptFile = kept && kept.track.sync_status === SyncStatus.COMPLETED && kept.file ? kept.file : null;
        if (kept) {
            await tx.insert(MediaCover).values({
                media_id: mediaId,
                file_id: keptFile?.id ?? null,
                source_url: kept.track.source_url || null,
                status: keptFile ? SyncStatus.COMPLETED : SyncStatus.PENDING,
            });
            if (keptFile) counts.coversCompleted++;
            else counts.coversPending++;
        }

        if (covers.length > 0) {
            await tx
                .update(Track)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: now, update_time: now })
                .where(
                    inArray(
                        Track.id,
                        covers.map(({ track }) => track.id),
                    ),
                );
            counts.retiredTracks += covers.length;
            const retiredFileIds = covers.flatMap(({ file }) =>
                file && file.delete_status === DeleteStatus.ACTIVE && file.id !== keptFile?.id ? [file.id] : [],
            );
            if (retiredFileIds.length > 0) {
                await tx.update(DbFile).set({ delete_status: DeleteStatus.DELETED, delete_time: now }).where(inArray(DbFile.id, retiredFileIds));
                counts.retiredFiles += retiredFileIds.length;
            }
        }

        // AI read the best cover or image content; it now reads previews, keyed by what they are rendered from.
        const contents = own.flatMap(({ track, file }) =>
            track.purpose === TrackPurpose.CONTENT &&
            track.sync_status === SyncStatus.COMPLETED &&
            file?.delete_status === DeleteStatus.ACTIVE
                ? [{ track, file }]
                : [],
        );
        const source = previewSourceOf(type, keptFile, contents);
        if (!source) continue;
        const sourceFile = source.fileId === keptFile?.id ? keptFile : contents.find(({ file }) => file.id === source.fileId)!.file;
        const hash = aiSourceHash(sourceFile);
        const oldHashes = [...new Set(own.flatMap(({ file }) => (file ? [aiSourceHash(file)] : [])))].filter((old) => old !== hash);
        if (oldHashes.length === 0) continue;

        const descriptions = await tx
            .update(AssetAiMetadata)
            .set({ input_hash: hash })
            .where(
                and(
                    eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
                    eq(AssetAiMetadata.entity_id, mediaId),
                    inArray(AssetAiMetadata.input_hash, oldHashes),
                ),
            )
            .returning({ id: AssetAiMetadata.id });
        const vectors = await tx
            .update(AssetEmbedding)
            .set({ content_hash: hash, source_file_id: sourceFile.id })
            .where(
                and(
                    eq(AssetEmbedding.entity_type, EntityType.MEDIA),
                    eq(AssetEmbedding.entity_id, mediaId),
                    eq(AssetEmbedding.embedding_role, EmbeddingRole.IMAGE_PRIMARY),
                    inArray(AssetEmbedding.content_hash, oldHashes),
                ),
            )
            .returning({ id: AssetEmbedding.id });
        counts.descriptions += descriptions.length;
        counts.vectors += vectors.length;
    }
}

async function run() {
    try {
        await db.transaction(async (tx) => {
            let cursor: string | null = null;
            for (;;) {
                const batch: Pick<typeof Media.$inferSelect, "id" | "type">[] = await tx
                    .select({ id: Media.id, type: Media.type })
                    .from(Media)
                    .where(and(ne(Media.delete_status, DeleteStatus.DELETED), cursor ? gt(Media.id, cursor) : undefined))
                    .orderBy(asc(Media.id))
                    .limit(BATCH_SIZE);
                if (batch.length === 0) break;
                await migrateMedia(tx, batch);
                counts.media += batch.length;
                cursor = batch[batch.length - 1]!.id;
                console.log(`[migrate_media_covers] ${counts.media} media`);
            }

            await deleteQueues(tx, ["cover", "scan:cover"]);
            const libraries = await tx.select({ id: Library.id }).from(Library).where(eq(Library.delete_status, DeleteStatus.ACTIVE));
            await requestScan(
                tx,
                "preview",
                libraries.map((library) => library.id),
            );

            console.log("[migrate_media_covers]", counts);
            if (!apply) throw new DryRun();
        });
        console.log("[migrate_media_covers] applied");
    } catch (error) {
        if (!(error instanceof DryRun)) throw error;
        console.log("[migrate_media_covers] dry run rolled back; pass --apply to commit");
    }
    process.exit(0);
}

run().catch((error) => {
    console.error("[migrate_media_covers] failed:", error);
    process.exit(1);
});
