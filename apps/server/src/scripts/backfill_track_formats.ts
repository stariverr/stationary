import { and, asc, eq, gt } from "drizzle-orm";
import { DeleteStatus, File, Track } from "@/db/schema";
import { db } from "@/global/db";
import { cleanTrackMetadata, deriveTrackFormat, normalizeTrackStreams } from "@/lib/utils/track-format";

type BackfillTrack = Pick<
    typeof Track.$inferSelect,
    "id" | "type" | "metadata" | "container" | "is_fragmented" | "stream_layout" | "has_video" | "has_audio" | "streams"
>;

type BackfillFile = Pick<typeof File.$inferSelect, "mime_type" | "extension"> | null;

const readString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export function deriveBackfilledTrackFormat(track: BackfillTrack, file: BackfillFile, purgeLegacy = false) {
    const rawMetadata = (track.metadata ?? {}) as Record<string, unknown>;
    const metadataStreams = Array.isArray(rawMetadata.streams) ? normalizeTrackStreams(rawMetadata.streams) : undefined;
    const streams = track.streams.length > 0 ? track.streams : metadataStreams;

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

    const derived = deriveTrackFormat({
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
        container: derived.container ?? track.container,
        is_fragmented: derived.is_fragmented ?? track.is_fragmented,
        stream_layout: derived.stream_layout,
        has_video: derived.has_video,
        has_audio: derived.has_audio,
        streams: derived.streams,
        metadata,
    };
}

const formatChanged = (track: BackfillTrack, format: ReturnType<typeof deriveBackfilledTrackFormat>) =>
    track.container !== format.container ||
    track.is_fragmented !== format.is_fragmented ||
    track.stream_layout !== format.stream_layout ||
    track.has_video !== format.has_video ||
    track.has_audio !== format.has_audio ||
    JSON.stringify(track.streams) !== JSON.stringify(format.streams) ||
    JSON.stringify(track.metadata) !== JSON.stringify(format.metadata);

export interface BackfillTrackFormatsOptions {
    apply?: boolean;
    purgeLegacy?: boolean;
    batchSize?: number;
}

export async function backfillTrackFormats(options: BackfillTrackFormatsOptions = {}) {
    const apply = options.apply ?? false;
    const purgeLegacy = options.purgeLegacy ?? false;
    const batchSize = options.batchSize ?? 250;
    let cursor: string | undefined;
    let scanned = 0;
    let changed = 0;
    let unresolved = 0;

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
            const format = deriveBackfilledTrackFormat(track, file, purgeLegacy);
            if (!format.stream_layout || !format.container) unresolved += 1;
            return formatChanged(track, format) ? [{ id: track.id, format }] : [];
        });

        scanned += rows.length;
        changed += updates.length;
        cursor = rows.at(-1)?.track.id;

        if (apply && updates.length > 0) {
            await db.transaction(async (tx) => {
                for (const update of updates) {
                    await tx.update(Track).set(update.format).where(eq(Track.id, update.id));
                }
            });
        }
    }

    return { mode: apply ? "apply" : "dry-run", scanned, changed, unresolved } as const;
}

const isDirectRun =
    typeof process !== "undefined" &&
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("backfill_track_formats.ts") || process.argv[1].endsWith("backfill_track_formats.js"));

if (isDirectRun) {
    backfillTrackFormats({ apply: process.argv.includes("--apply") })
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
            process.exit(result.unresolved > 0 ? 2 : 0);
        })
        .catch((error) => {
            console.error("Track format backfill failed:", error);
            process.exit(1);
        });
}
