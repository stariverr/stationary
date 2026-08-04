import { and, asc, eq, gt, sql } from "drizzle-orm";
import { DeleteStatus, File, Track, TrackType } from "@/db/schema";
import { db } from "@/global/db";
import { cleanTrackMetadata, deriveTrackFormat, normalizeTrackStreams } from "@/lib/utils/track-format";

type BackfillTrack = Pick<
    typeof Track.$inferSelect,
    | "id"
    | "type"
    | "metadata"
    | "container"
    | "is_fragmented"
    | "stream_layout"
    | "has_video"
    | "has_audio"
    | "streams"
    | "width"
    | "height"
    | "duration"
    | "language"
    | "codec"
    | "bandwidth"
>;

type BackfillFile = Pick<typeof File.$inferSelect, "mime_type" | "extension"> & Record<string, unknown>;

const readString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

const readNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export async function ensureDbColumnsExist() {
    await db.execute(sql`
        DO $$ BEGIN
            CREATE TYPE "track_stream_layout" AS ENUM('SINGLE', 'MUXED', 'VIDEO_ONLY', 'AUDIO_ONLY', 'TEXT_ONLY');
        EXCEPTION WHEN duplicate_object THEN null;
        END $$;
    `);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "container" text;`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "is_fragmented" boolean;`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "stream_layout" "track_stream_layout";`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "has_video" boolean DEFAULT false NOT NULL;`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "has_audio" boolean DEFAULT false NOT NULL;`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "streams" jsonb DEFAULT '[]' NOT NULL;`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "duration" real;`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "width" integer;`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "height" integer;`);
    await db.execute(sql`ALTER TABLE "track" ADD COLUMN IF NOT EXISTS "bandwidth" integer;`);
}

async function getLegacyFileMap() {
    const map = new Map<string, { width?: number; height?: number; duration?: number }>();
    try {
        const result: any = await db.execute(sql`SELECT id, width, height, duration FROM "file";`);
        const rows = result.rows ?? result;
        if (Array.isArray(rows)) {
            for (const r of rows) {
                map.set(r.id, {
                    width: readNumber(r.width) ?? undefined,
                    height: readNumber(r.height) ?? undefined,
                    duration: readNumber(r.duration) ?? undefined,
                });
            }
        }
    } catch {
        // Old file columns might not exist or already dropped
    }
    return map;
}

export function deriveMigratedTrackFields(
    track: BackfillTrack,
    file: BackfillFile | null,
    legacyFileExtra?: { width?: number; height?: number; duration?: number },
    purgeLegacy = false,
) {
    const rawMetadata = (track.metadata ?? {}) as Record<string, unknown>;
    const metadataStreams = Array.isArray(rawMetadata.streams) ? normalizeTrackStreams(rawMetadata.streams) : undefined;
    const streams = track.streams.length > 0 ? track.streams : (metadataStreams ?? []);

    const firstVideoStream = streams.find((s) => s.type === TrackType.VIDEO);
    const firstAudioStream = streams.find((s) => s.type === TrackType.AUDIO);
    const firstStream = streams[0];

    // 1. Extract canonical dimensions & media metrics
    const width =
        track.width ??
        readNumber(rawMetadata.width) ??
        readNumber(rawMetadata.generated_width) ??
        readNumber(file?.width) ??
        legacyFileExtra?.width ??
        firstVideoStream?.width ??
        null;

    const height =
        track.height ??
        readNumber(rawMetadata.height) ??
        readNumber(rawMetadata.generated_height) ??
        readNumber(file?.height) ??
        legacyFileExtra?.height ??
        firstVideoStream?.height ??
        null;

    const duration =
        track.duration ??
        readNumber(rawMetadata.duration) ??
        readNumber(rawMetadata.duration_seconds) ??
        readNumber(file?.duration) ??
        legacyFileExtra?.duration ??
        null;

    const language = track.language ?? readString(rawMetadata.language) ?? firstStream?.language ?? null;

    const codec =
        track.codec ??
        readString(rawMetadata.codec) ??
        readString(rawMetadata.codecs) ??
        firstVideoStream?.codec ??
        firstAudioStream?.codec ??
        firstStream?.codec ??
        null;

    const bandwidth = track.bandwidth ?? readNumber(rawMetadata.bandwidth) ?? firstStream?.bandwidth ?? null;

    // 2. Derive format fields
    const metadataFormat = readString(rawMetadata.type) ?? readString(rawMetadata.format);
    const container =
        track.container ??
        (typeof rawMetadata.container === "string" ? rawMetadata.container : undefined) ??
        metadataFormat;

    const is_fragmented =
        track.is_fragmented ??
        (typeof rawMetadata.is_fragmented === "boolean"
            ? rawMetadata.is_fragmented
            : typeof rawMetadata.fragmented === "boolean"
              ? rawMetadata.fragmented
              : metadataFormat?.toLowerCase() === "fmp4"
                ? true
                : undefined);

    const stream_layout =
        track.stream_layout ??
        (typeof rawMetadata.stream_layout === "string"
            ? (rawMetadata.stream_layout as any)
            : typeof rawMetadata.layout === "string"
              ? (rawMetadata.layout as any)
              : undefined);

    const derivedFormat = deriveTrackFormat({
        type: track.type,
        metadata: rawMetadata,
        container,
        is_fragmented,
        stream_layout,
        has_video: track.has_video ? true : undefined,
        has_audio: track.has_audio ? true : undefined,
        streams,
        file,
    });

    const metadata = purgeLegacy ? cleanTrackMetadata(rawMetadata) : rawMetadata;

    return {
        width,
        height,
        duration,
        language,
        codec,
        bandwidth,
        container: derivedFormat.container ?? track.container,
        is_fragmented: derivedFormat.is_fragmented ?? track.is_fragmented,
        stream_layout: derivedFormat.stream_layout,
        has_video: derivedFormat.has_video,
        has_audio: derivedFormat.has_audio,
        streams: derivedFormat.streams,
        metadata,
    };
}

const fieldsChanged = (track: BackfillTrack, proposed: ReturnType<typeof deriveMigratedTrackFields>) =>
    track.width !== proposed.width ||
    track.height !== proposed.height ||
    track.duration !== proposed.duration ||
    track.language !== proposed.language ||
    track.codec !== proposed.codec ||
    track.bandwidth !== proposed.bandwidth ||
    track.container !== proposed.container ||
    track.is_fragmented !== proposed.is_fragmented ||
    track.stream_layout !== proposed.stream_layout ||
    track.has_video !== proposed.has_video ||
    track.has_audio !== proposed.has_audio ||
    JSON.stringify(track.streams) !== JSON.stringify(proposed.streams) ||
    JSON.stringify(track.metadata) !== JSON.stringify(proposed.metadata);

export interface MigrateTrackFieldsOptions {
    apply?: boolean;
    purgeLegacy?: boolean;
    batchSize?: number;
}

export async function migrateTrackFields(options: MigrateTrackFieldsOptions = {}) {
    const apply = options.apply ?? false;
    const purgeLegacy = options.purgeLegacy ?? false;
    const batchSize = options.batchSize ?? 250;
    let cursor: string | undefined;
    let scanned = 0;
    let changed = 0;
    let unresolved = 0;

    await ensureDbColumnsExist();
    const legacyFileMap = await getLegacyFileMap();

    console.log(`Starting track fields migration [mode=${apply ? "apply" : "dry-run"}, purgeLegacy=${purgeLegacy}]...`);

    while (true) {
        const rows = await db
            .select({ track: Track, file: File })
            .from(Track)
            .leftJoin(File, eq(Track.file_id, File.id))
            .where(
                cursor
                    ? and(eq(Track.delete_status, DeleteStatus.ACTIVE), gt(Track.id, cursor))
                    : eq(Track.delete_status, DeleteStatus.ACTIVE),
            )
            .orderBy(asc(Track.id))
            .limit(batchSize);

        if (rows.length === 0) break;

        const updates = rows.flatMap(({ track, file }) => {
            const legacyExtra = track.file_id ? legacyFileMap.get(track.file_id) : undefined;
            const proposed = deriveMigratedTrackFields(track, file as BackfillFile | null, legacyExtra, purgeLegacy);
            if (!proposed.stream_layout || !proposed.container) unresolved += 1;
            return fieldsChanged(track, proposed) ? [{ id: track.id, fields: proposed }] : [];
        });

        scanned += rows.length;
        changed += updates.length;
        cursor = rows.at(-1)?.track.id;

        if (apply && updates.length > 0) {
            await db.transaction(async (tx) => {
                for (const update of updates) {
                    await tx.update(Track).set(update.fields).where(eq(Track.id, update.id));
                }
            });
        }
    }

    if (apply && purgeLegacy) {
        try {
            await db.execute(sql`ALTER TABLE "file" DROP COLUMN IF EXISTS "width";`);
            await db.execute(sql`ALTER TABLE "file" DROP COLUMN IF EXISTS "height";`);
            await db.execute(sql`ALTER TABLE "file" DROP COLUMN IF EXISTS "duration";`);
            console.log("Legacy file table columns (width, height, duration) purged.");
        } catch {
            // Ignore if already dropped
        }
    }

    return { mode: apply ? "apply" : "dry-run", scanned, changed, unresolved } as const;
}

const isDirectRun =
    typeof process !== "undefined" &&
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("migrate_track_fields.ts") || process.argv[1].endsWith("migrate_track_fields.js"));

if (isDirectRun) {
    const apply = process.argv.includes("--apply");
    const purgeLegacy = process.argv.includes("--purge-legacy");
    const batchSizeArg = process.argv.find((arg) => arg.startsWith("--batch-size="));
    const batchSize = batchSizeArg ? parseInt(batchSizeArg.split("=")[1], 10) : 250;

    migrateTrackFields({ apply, purgeLegacy, batchSize })
        .then((result) => {
            console.log("Track fields migration completed:");
            console.log(JSON.stringify(result, null, 2));
            process.exit(result.unresolved > 0 ? 2 : 0);
        })
        .catch((error) => {
            console.error("Track fields migration failed:", error);
            process.exit(1);
        });
}
