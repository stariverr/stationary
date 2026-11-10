/**
 * Moves media off the track table (docs/media_refactor.zh-Hans.md, 12). This covers phases 1 and 2 together.
 *
 *   1. `stash`: copies `public.track` into `legacy.track` as plain columns. `db:migrate` only manages the public
 *      schema, so the copy survives the push that drops the track table.
 *   2. `bun run db:migrate` creates the new tables and drops `track`.
 *   3. `apply` (dry run unless `--apply`): per media, read from `legacy.track`:
 *      - The best content track of each kind becomes a `media_original`: one image, one video, one audio per language
 *        (AUDIO media keep one audio). Completed files are probed now, filling `av_file`, `av_stream` and the media
 *        summary; tracks still waiting for a download stay PENDING for the download pipeline.
 *      - The best cover that was not generated becomes the `media_cover` of VIDEO, AUDIO and PDF media.
 *      - Subtitle tracks become FILE captions, converted to WebVTT.
 *      - Everything else (lower qualities, generated tracks, other covers) is not migrated; its files are marked
 *        DELETED. Storage is not touched.
 *      - AI descriptions and image vectors are re-keyed to the file the previews are now rendered from.
 *      - The old `cover` queues go; every library is scanned for downloads and previews.
 *      Imported sources get `legacy:` source keys. The next sync of a post does not know them, so it replaces them
 *      with the highest quality the platform offers.
 *      Media that already have originals are skipped, so `apply` can be run again after an interruption.
 *   4. `drop`: removes the `legacy` schema.
 *
 * Run `apply` while no worker runs: it needs ffprobe, ffmpeg and magick, and reads the files from storage.
 */
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import {
    AssetAiMetadata,
    AssetEmbedding,
    AssetOrigin,
    DeleteStatus,
    EmbeddingRole,
    EntityType,
    File as DbFile,
    Library,
    Media,
    MediaCaption,
    MediaCover,
    MediaOriginal,
    MediaType,
    SyncStatus,
} from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { aiSourceHash } from "@/features/ai/image-source";
import { convertToVtt, makeDefaultCaption, storeVtt } from "@/features/media/captions";
import { getMediaCompletionError } from "@/features/media/composition";
import { completeOriginal, loadOriginalStates } from "@/features/media/originals";
import { contentFiles, previewSourceOf } from "@/features/media/preview";
import { probeOriginal, ProbeRejectedError, type OriginalProbe } from "@/features/media/probe";
import { requestScan } from "@/infra/queue/changes";
import { deleteQueues } from "@/infra/queue/store";
import { getErrorMessage } from "@/lib/utils/error";
import { CAPTION_MEDIA_TYPES, COVER_MEDIA_TYPES } from "@/lib/validation/media-composition";

const command = process.argv[2];
const apply = process.argv.includes("--apply");
const BATCH_SIZE = 200;
const LOG = "[migrate_media_originals]";

/** A row of `legacy.track`, with the enum columns as text. */
interface LegacyTrack {
    id: string;
    media_id: string;
    file_id: string | null;
    type: "IMAGE" | "VIDEO" | "AUDIO" | "SUBTITLE" | "PDF";
    purpose: "CONTENT" | "COVER" | "THUMBNAIL" | "PREVIEW";
    is_generated: boolean;
    quality: "HIGH" | "MEDIUM" | "LOW";
    priority: number;
    source_url: string | null;
    sync_status: SyncStatus;
    variant_key: string;
    is_default: boolean;
    is_primary: boolean;
    language: string | null;
    display_name: string | null;
    create_time: string;
}

type FileRow = typeof DbFile.$inferSelect;
type MediaRow = typeof Media.$inferSelect;
interface Candidate {
    track: LegacyTrack;
    /** The track's file, when it completed and the file is still active. */
    file: FileRow | null;
}

const counts = {
    media: 0,
    skipped: 0,
    originals: 0,
    pendingOriginals: 0,
    failedMedia: 0,
    covers: 0,
    captions: 0,
    retiredFiles: 0,
    descriptions: 0,
    vectors: 0,
};

async function stash() {
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS legacy`);
    await db.execute(sql`DROP TABLE IF EXISTS legacy.track`);
    await db.execute(sql`
        CREATE TABLE legacy.track AS
        SELECT id, media_id, file_id, type::text AS type, purpose::text AS purpose, is_generated, quality::text AS quality,
               priority, NULLIF(source_url, '') AS source_url, sync_status::text AS sync_status, variant_key, is_default,
               is_primary, language, display_name, create_time
        FROM public.track
        WHERE delete_status = 'ACTIVE'`);
    const { rows } = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM legacy.track`);
    const row = rows[0];
    console.log(`${LOG} stashed ${row?.count ?? 0} active tracks into legacy.track`);
}

const QUALITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
const usable = (candidate: Candidate) => Boolean(candidate.file || candidate.track.source_url);

/** The track a kind keeps: completed first, then primary, default, quality and priority. */
function best(candidates: Candidate[]): Candidate | undefined {
    const rank = ({ track, file }: Candidate) => [
        file ? 0 : 1,
        track.is_primary ? 0 : 1,
        track.is_default ? 0 : 1,
        QUALITY_RANK[track.quality],
        track.priority,
    ];
    return candidates.filter(usable).sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
        return 0;
    })[0];
}

/** The best track per language, the default language first. */
function bestPerLanguage(candidates: Candidate[]): Candidate[] {
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
        const key = candidate.track.language?.toLowerCase() ?? "";
        groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
    return [...groups.values()]
        .flatMap((group) => best(group) ?? [])
        .sort((a, b) => Number(b.track.is_default) - Number(a.track.is_default));
}

/** The content tracks a media keeps as originals, by what its type is made of (section 4). */
function pickOriginals(type: MediaType, contents: Candidate[]): Candidate[] {
    const of = (kind: LegacyTrack["type"]) => contents.filter(({ track }) => track.type === kind);
    const one = (kind: LegacyTrack["type"]) => {
        const kept = best(of(kind));
        return kept ? [kept] : [];
    };
    switch (type) {
        case MediaType.IMAGE:
            return one("IMAGE");
        case MediaType.PDF:
            return one("PDF");
        case MediaType.LIVE_PHOTO:
            return [...one("IMAGE"), ...one("VIDEO")];
        case MediaType.AUDIO:
            return one("AUDIO");
        case MediaType.VIDEO:
            return [...one("VIDEO"), ...bestPerLanguage(of("AUDIO"))];
    }
}

const legacyKey = (track: LegacyTrack) => (track.source_url ? `legacy:${track.type.toLowerCase()}:${track.variant_key}` : null);

/** The work for one media, probed and converted outside any transaction. */
interface MediaPlan {
    media: MediaRow;
    originals: { candidate: Candidate; probe: OriginalProbe | null; error: string | null }[];
    cover: Candidate | null;
    captions: { candidate: Candidate; vtt: Uint8Array | null }[];
    /** Files of the media's tracks that nothing migrated keeps. */
    retiredFileIds: string[];
    /** AI hashes of all its old track files. */
    oldHashes: string[];
}

async function planMedia(media: MediaRow, tracks: LegacyTrack[], files: Map<string, FileRow>): Promise<MediaPlan> {
    const candidates = tracks.map((track) => {
        const file = track.file_id ? files.get(track.file_id) : undefined;
        const completed = track.sync_status === SyncStatus.COMPLETED && file?.delete_status === DeleteStatus.ACTIVE;
        return { track, file: completed ? file! : null };
    });
    const live = candidates.filter(({ track }) => !track.is_generated);
    const contents = live.filter(({ track }) => track.purpose === "CONTENT");

    const kept = pickOriginals(media.type, contents);
    const cover = COVER_MEDIA_TYPES.has(media.type) ? (best(live.filter(({ track }) => track.purpose === "COVER")) ?? null) : null;
    const captionTracks = CAPTION_MEDIA_TYPES.has(media.type) ? bestPerLanguage(contents.filter(({ track }) => track.type === "SUBTITLE")) : [];

    const originals: MediaPlan["originals"] = [];
    for (const candidate of kept) {
        if (!candidate.file || !apply) {
            originals.push({ candidate, probe: null, error: null });
            continue;
        }
        try {
            originals.push({ candidate, probe: await probeOriginal(candidate.file), error: null });
        } catch (error) {
            if (!(error instanceof ProbeRejectedError)) throw error;
            originals.push({ candidate, probe: null, error: error.message });
        }
    }
    const captions: MediaPlan["captions"] = [];
    for (const candidate of captionTracks) {
        let vtt: Uint8Array | null = null;
        if (candidate.file && apply) {
            try {
                vtt = await convertToVtt(candidate.file);
            } catch (error) {
                if (!(error instanceof ProbeRejectedError)) throw error;
                console.warn(`${LOG} media ${media.id}: caption ${candidate.track.id} not converted: ${error.message}`);
            }
        }
        captions.push({ candidate, vtt });
    }

    // A probed original whose file cannot be read keeps its file: the media is marked failed for someone to look at.
    const keptFileIds = new Set(
        [
            ...originals.map(({ candidate }) => candidate.file?.id),
            cover?.file?.id,
            ...captions.map(({ candidate, vtt }) => (vtt || !apply ? candidate.file?.id : undefined)),
        ].filter((id): id is string => Boolean(id)),
    );
    const allFiles = candidates.flatMap(({ track }) => (track.file_id && files.get(track.file_id) ? [files.get(track.file_id)!] : []));
    return {
        media,
        originals,
        cover,
        captions,
        retiredFileIds: [...new Set(allFiles.filter((file) => file.delete_status === DeleteStatus.ACTIVE && !keptFileIds.has(file.id)).map((file) => file.id))],
        oldHashes: [...new Set(allFiles.map(aiSourceHash))],
    };
}

async function writeMedia(tx: Transaction, plan: MediaPlan): Promise<void> {
    const { media } = plan;
    const now = Temporal.Now.instant();
    const errors: string[] = [];

    for (const { candidate, probe, error } of plan.originals) {
        const { track, file } = candidate;
        const sourceKey = legacyKey(track);
        if (file && !probe) {
            errors.push(`${track.type} original could not be probed: ${error}`);
            continue;
        }
        if (!file && !sourceKey) continue;
        const [original] = await tx
            .insert(MediaOriginal)
            .values({
                media_id: media.id,
                source_url: track.source_url,
                source_key: sourceKey,
                declared_language: track.type === "AUDIO" ? track.language : null,
                declared_label: track.type === "AUDIO" ? track.display_name : null,
                declared_default: track.type === "AUDIO" && track.is_default,
                // A probed file is complete at once; completeOriginal below stores what the probe found.
                file_id: probe ? file!.id : null,
                status: probe ? SyncStatus.COMPLETED : SyncStatus.PENDING,
                create_time: Temporal.Instant.from(new Date(track.create_time).toISOString()),
            })
            .returning({ id: MediaOriginal.id });
        if (file && probe) {
            await completeOriginal(tx, media, original!.id, file.id, probe);
            counts.originals++;
        } else counts.pendingOriginals++;
    }

    if (plan.cover) {
        const { track, file } = plan.cover;
        await tx.insert(MediaCover).values({
            media_id: media.id,
            file_id: file?.id ?? null,
            source_url: track.source_url,
            // The scraper names an imported cover `cover`, so the next sync keeps this one.
            source_key: track.source_url ? "cover" : null,
            status: file ? SyncStatus.COMPLETED : SyncStatus.PENDING,
        });
        counts.covers++;
    }

    for (const { candidate, vtt } of plan.captions) {
        const { track, file } = candidate;
        const sourceKey = track.source_url ? `legacy:caption:${track.variant_key}` : null;
        if (!vtt && !sourceKey) continue;
        const vttFileId = vtt ? await storeVtt(tx, media, track.id, vtt) : null;
        const [caption] = await tx
            .insert(MediaCaption)
            .values({
                media_id: media.id,
                origin: AssetOrigin.FILE,
                language: track.language,
                label: track.display_name,
                source_file_id: vtt ? file!.id : null,
                vtt_file_id: vttFileId,
                source_url: track.source_url,
                source_key: sourceKey,
                status: vtt ? SyncStatus.COMPLETED : SyncStatus.PENDING,
            })
            .returning({ id: MediaCaption.id });
        if (track.is_default) await makeDefaultCaption(tx, media.id, caption!.id);
        counts.captions++;
    }

    if (plan.retiredFileIds.length > 0) {
        await tx.update(DbFile).set({ delete_status: DeleteStatus.DELETED, delete_time: now }).where(inArray(DbFile.id, plan.retiredFileIds));
        counts.retiredFiles += plan.retiredFileIds.length;
    }

    const pending = plan.originals.some(({ candidate }) => !candidate.file && candidate.track.source_url);
    if (errors.length > 0) {
        await tx.update(Media).set({ sync_status: SyncStatus.FAILED, last_error: errors.join("; "), update_time: now }).where(eq(Media.id, media.id));
        counts.failedMedia++;
    } else if (pending) {
        await tx.update(Media).set({ sync_status: SyncStatus.PENDING, update_time: now }).where(eq(Media.id, media.id));
    } else {
        // Old tracks did not always make up their media type; such media are marked failed for someone to fix.
        const completionError = await getMediaCompletionError(tx, media);
        if (completionError) {
            await tx.update(Media).set({ sync_status: SyncStatus.FAILED, last_error: completionError, update_time: now }).where(eq(Media.id, media.id));
            counts.failedMedia++;
        }
    }

    await rekeyAi(tx, plan);
}

/** AI read the best cover or image content; it now reads previews, keyed by the file they are rendered from. */
async function rekeyAi(tx: Transaction, plan: MediaPlan): Promise<void> {
    const { media } = plan;
    const states = (await loadOriginalStates(tx, [media.id])).get(media.id) ?? [];
    const coverFile = plan.cover?.file ?? null;
    const source = previewSourceOf(media.type, coverFile, contentFiles(states));
    if (!source) return;
    const sourceFile = source.fileId === coverFile?.id ? coverFile : states.find((state) => state.file?.id === source.fileId)!.file!;
    const hash = aiSourceHash(sourceFile);
    const oldHashes = plan.oldHashes.filter((old) => old !== hash);
    if (oldHashes.length === 0) return;

    const descriptions = await tx
        .update(AssetAiMetadata)
        .set({ input_hash: hash })
        .where(
            and(
                eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
                eq(AssetAiMetadata.entity_id, media.id),
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
                eq(AssetEmbedding.entity_id, media.id),
                eq(AssetEmbedding.embedding_role, EmbeddingRole.IMAGE_PRIMARY),
                inArray(AssetEmbedding.content_hash, oldHashes),
            ),
        )
        .returning({ id: AssetEmbedding.id });
    counts.descriptions += descriptions.length;
    counts.vectors += vectors.length;
}

function report(plan: MediaPlan) {
    const kinds = plan.originals.map(({ candidate }) => `${candidate.track.type}${candidate.file ? "" : "(pending)"}`);
    counts.originals += plan.originals.filter(({ candidate }) => candidate.file).length;
    counts.pendingOriginals += plan.originals.filter(({ candidate }) => !candidate.file && candidate.track.source_url).length;
    counts.covers += plan.cover ? 1 : 0;
    counts.captions += plan.captions.length;
    counts.retiredFiles += plan.retiredFileIds.length;
    if (plan.originals.length === 0) console.warn(`${LOG} media ${plan.media.id} (${plan.media.type}) keeps no original`);
    else if (process.argv.includes("--verbose")) console.log(`${LOG} media ${plan.media.id} (${plan.media.type}): ${kinds.join(", ")}`);
}

async function migrate() {
    let cursor: string | null = null;
    for (;;) {
        const batch: MediaRow[] = await db
            .select()
            .from(Media)
            .where(and(ne(Media.delete_status, DeleteStatus.DELETED), cursor ? gt(Media.id, cursor) : undefined))
            .orderBy(asc(Media.id))
            .limit(BATCH_SIZE);
        if (batch.length === 0) break;
        cursor = batch[batch.length - 1]!.id;

        const ids = batch.map((media) => media.id);
        const migrated = new Set(
            (await db.select({ id: MediaOriginal.media_id }).from(MediaOriginal).where(inArray(MediaOriginal.media_id, ids))).map((row) => row.id),
        );
        const { rows: tracks } = await db.execute<LegacyTrack & Record<string, unknown>>(
            sql`SELECT * FROM legacy.track WHERE media_id IN ${ids} ORDER BY create_time, id`,
        );
        const fileIds = [...new Set(tracks.flatMap((track) => (track.file_id ? [track.file_id] : [])))];
        const files = new Map(
            (fileIds.length > 0 ? await db.select().from(DbFile).where(inArray(DbFile.id, fileIds)) : []).map((file) => [file.id, file]),
        );

        for (const media of batch) {
            counts.media++;
            if (migrated.has(media.id)) {
                counts.skipped++;
                continue;
            }
            try {
                const plan = await planMedia(
                    media,
                    tracks.filter((track) => track.media_id === media.id),
                    files,
                );
                if (!apply) {
                    report(plan);
                    continue;
                }
                await db.transaction((tx) => writeMedia(tx, plan));
            } catch (error) {
                console.error(`${LOG} media ${media.id} failed: ${getErrorMessage(error)}`);
                throw error;
            }
        }
        console.log(`${LOG} ${counts.media} media`);
    }

    if (apply) {
        await db.transaction(async (tx) => {
            await deleteQueues(tx, ["cover", "scan:cover"]);
            const libraries = await tx.select({ id: Library.id }).from(Library).where(eq(Library.delete_status, DeleteStatus.ACTIVE));
            const libraryIds = libraries.map((library) => library.id);
            await requestScan(tx, "download", libraryIds);
            await requestScan(tx, "preview", libraryIds);
        });
    }
    console.log(LOG, apply ? "applied" : "dry run, nothing written; pass --apply to migrate", counts);
}

async function drop() {
    await db.execute(sql`DROP SCHEMA IF EXISTS legacy CASCADE`);
    console.log(`${LOG} dropped the legacy schema`);
}

const commands: Record<string, () => Promise<void>> = { stash, apply: migrate, drop };
const run = commands[command ?? ""];
if (!run) {
    console.error(`usage: bun run src/scripts/migrate_media_originals.ts stash | apply [--apply] [--verbose] | drop`);
    process.exit(1);
}
run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(`${LOG} failed:`, error);
        process.exit(1);
    });
