/**
 * Just-in-time packaging of originals (docs/media_refactor.zh-Hans.md, 8.7): the segment index of a file is built
 * from its moov on first use, cached in Redis by file (an original's bytes never change, so the cache never goes
 * stale) and in memory in front of it; segments are generated per request from byte ranges of the original.
 */
import { and, eq } from "drizzle-orm";
import { AvFile, AvStream, DeleteStatus, File as DbFile, MediaOriginal, SyncStatus } from "@/db/schema";
import { db } from "@/global/db";
import { kv } from "@/global/kv";
import { s3 } from "@/global/s3";
import { createPromiseCache } from "@/features/ai/promise-cache";
import { readMp4Layout } from "@/lib/utils/mp4-layout";
import {
    decodePackagedFile,
    encodePackagedFile,
    indexMoov,
    packageSegment,
    type PackagedFile,
    type PackagedTrack,
} from "@/lib/utils/mp4-packager";

type FileRow = typeof DbFile.$inferSelect;

/** Bump when the cached form or the segmenting changes; old entries then expire on their own. */
const CACHE_KEY_PREFIX = "playback:packaged:v1:";
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A playing file asks for its index on every segment; keep the few files being watched in memory. */
const memoryCache = createPromiseCache<PackagedFile>(30 * 60 * 1000, 16);

/** ISO BMFF that is not an fMP4 with a sidx: the inputs of just-in-time packaging (7, step 4). */
export const isPackageableContainer = (container: string) => /\b(mov|mp4)\b/.test(container);

const rangeReader = (file: Pick<FileRow, "bucket" | "path">) => (start: number, end: number) =>
    s3.read(file.path, { bucket: file.bucket, maxBytes: end - start + 1, range: { start, end } });

async function buildIndex(file: FileRow): Promise<PackagedFile> {
    if (!file.size) throw new Error(`file ${file.id} has no size`);
    const { moov } = await readMp4Layout(rangeReader(file), file.size);
    if (!moov) throw new Error(`file ${file.id} has no readable moov`);
    return indexMoov(moov);
}

async function loadIndex(file: FileRow): Promise<PackagedFile> {
    const key = CACHE_KEY_PREFIX + file.id;
    const cached = await kv.get(key).catch((e) => {
        console.warn(`[packaging] reading ${key} failed`, e);
        return null;
    });
    if (typeof cached === "string") return decodePackagedFile(Bun.gunzipSync(new Uint8Array(Buffer.from(cached, "base64"))));

    const index = await buildIndex(file);
    const encoded = Buffer.from(Bun.gzipSync(encodePackagedFile(index) as Uint8Array<ArrayBuffer>)).toString("base64");
    await kv.put(key, encoded, { expirationTtl: CACHE_TTL_SECONDS }).catch((e) => console.warn(`[packaging] caching ${key} failed`, e));
    return index;
}

export const packagedFile = (file: FileRow) => memoryCache.getOrCreate(file.id, () => loadIndex(file));

/** The packaged track of a stream; null when the file has no packageable track at that stream index. */
export async function packagedTrack(file: FileRow, streamIndex: number): Promise<PackagedTrack | null> {
    return (await packagedFile(file)).tracks.find((track) => track.trakIndex === streamIndex) ?? null;
}

/** A stream of a completed original of the media, with its active file. */
async function streamOfMedia(mediaId: string, streamId: string) {
    const [row] = await db
        .select({ file: DbFile, streamIndex: AvStream.stream_index, container: AvFile.container })
        .from(AvStream)
        .innerJoin(AvFile, eq(AvFile.id, AvStream.av_file_id))
        .innerJoin(MediaOriginal, and(eq(MediaOriginal.file_id, AvFile.file_id), eq(MediaOriginal.status, SyncStatus.COMPLETED)))
        .innerJoin(DbFile, and(eq(DbFile.id, AvFile.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
        .where(and(eq(AvStream.id, streamId), eq(MediaOriginal.media_id, mediaId)))
        .limit(1);
    return row && isPackageableContainer(row.container) ? row : null;
}

export type PackagedPart = { kind: "init" } | { kind: "segment"; index: number };

/** An init or media segment of a stream, or null when the media has no such stream or segment. */
export async function readPackagedPart(mediaId: string, streamId: string, part: PackagedPart) {
    const stream = await streamOfMedia(mediaId, streamId);
    if (!stream) return null;
    const track = await packagedTrack(stream.file, stream.streamIndex);
    if (!track) return null;
    const contentType = track.kind === "video" ? "video/mp4" : "audio/mp4";
    if (part.kind === "init") return { contentType, size: track.init.byteLength, body: track.init };
    if (part.index >= track.segmentSamples.length - 1) return null;
    return { contentType, ...packageSegment(track, part.index, rangeReader(stream.file)) };
}
