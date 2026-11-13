/**
 * Just-in-time packaging (docs/media_refactor.zh-Hans.md, 8.7): turns one track of a non-fragmented ISO BMFF file
 * (MP4, MOV, M4A) into fMP4 segments at request time. The original is never rewritten and nothing is stored: the
 * moov is parsed into a compact index, the init segment is rebuilt from the track's `trak`, and each media segment
 * is a generated `moof` followed by an `mdat` whose bytes are read from the original by range.
 *
 * mp4box.js parses the moov, expands the sample tables and writes the init segment; the `moof` is a fixed
 * structure written here, because mp4box.js only builds fragments from sample data it holds in memory.
 */
import { BoxParser, createFile, ISOFile, MP4BoxBuffer } from "mp4box";

import type { RangeReader } from "./mp4-layout";

/** Video is cut at the first sync sample at or after this duration; audio at the first sample after it. */
const TARGET_SEGMENT_SECONDS = 6;

const SAMPLE_FLAGS_SYNC = 0x0200_0000; // sample_depends_on = 2 (does not depend on others)
const SAMPLE_FLAGS_NON_SYNC = 0x0101_0000; // sample_depends_on = 1, sample_is_non_sync_sample = 1

export type PackagedTrackKind = "video" | "audio";

/** One packageable track: everything needed to write its init segment and any of its media segments. */
export interface PackagedTrack {
    /** The `track_ID` in the original. */
    trackId: number;
    /** The position of the `trak` in the moov, which is ffprobe's stream index. */
    trakIndex: number;
    kind: PackagedTrackKind;
    timescale: number;
    init: Uint8Array;
    /** Per sample. */
    offsets: Float64Array;
    sizes: Uint32Array;
    durations: Uint32Array;
    /** Composition offset with the edit list applied: presentation time = decode time + offset. */
    compositionOffsets: Int32Array;
    sync: Uint8Array;
    /** Per segment, plus a trailing entry: the first sample of each segment and its decode time. */
    segmentSamples: Uint32Array;
    segmentTimes: Float64Array;
}

export interface PackagedFile {
    tracks: PackagedTrack[];
}

/** A segment as manifests list it, in the track's timescale. */
export interface PackagedSegment {
    time: number;
    duration: number;
}

export const segmentCount = (track: PackagedTrack) => track.segmentSamples.length - 1;

export function packagedSegments(track: PackagedTrack): PackagedSegment[] {
    const segments: PackagedSegment[] = [];
    for (let i = 0; i < segmentCount(track); i++) {
        segments.push({ time: track.segmentTimes[i]!, duration: track.segmentTimes[i + 1]! - track.segmentTimes[i]! });
    }
    return segments;
}

type Trak = ISOFile["moov"]["traks"][number];

/**
 * How far the edit list moves the track: presentation time = composition time - shift, in the track's timescale.
 * An empty first edit delays the track; the first non-empty edit's media_time trims its start. Later edits are not
 * applied.
 */
function editShift(trak: Trak, movieTimescale: number, timescale: number): number {
    let shift = 0;
    for (const entry of trak.edts?.elst?.entries ?? []) {
        if (entry.media_time === -1) {
            shift -= Math.round((entry.segment_duration * timescale) / movieTimescale);
            continue;
        }
        return shift + entry.media_time;
    }
    return shift;
}

function trackKind(trak: Trak): PackagedTrackKind | null {
    const handler = trak.mdia.hdlr.handler;
    if (handler === "vide") return "video";
    if (handler === "soun") return "audio";
    return null;
}

/** Splits samples into segments: at sync samples for video, anywhere for audio. */
function segmentBoundaries(kind: PackagedTrackKind, timescale: number, durations: Uint32Array, sync: Uint8Array) {
    const target = TARGET_SEGMENT_SECONDS * timescale;
    const samples: number[] = [0];
    const times: number[] = [0];
    let time = 0;
    let segmentStart = 0;
    for (let i = 0; i < durations.length; i++) {
        if (i > 0 && time - segmentStart >= target && (kind === "audio" || sync[i] === 1)) {
            samples.push(i);
            times.push(time);
            segmentStart = time;
        }
        time += durations[i]!;
    }
    samples.push(durations.length);
    times.push(time);
    return { segmentSamples: Uint32Array.from(samples), segmentTimes: Float64Array.from(times) };
}

/** A single-track init segment: ftyp, then a moov holding only this trak (sample tables emptied) and an mvex. */
function writeInit(file: ISOFile, trak: Trak, fragmentDuration: number): Uint8Array {
    const ftyp = new BoxParser.box.ftyp();
    ftyp.major_brand = "iso6";
    ftyp.minor_version = 0;
    ftyp.compatible_brands = ["iso6", "mp41"];
    // Edits are applied to the composition offsets of every segment instead (see editShift).
    const edts = trak.edts;
    const boxes = trak.boxes;
    trak.boxes = (boxes ?? []).filter((box) => box.type !== "edts");
    trak.edts = undefined as unknown as Trak["edts"];
    try {
        const moov = new BoxParser.box.moov();
        moov.addBox(file.moov.mvhd);
        moov.addBox(trak);
        // QuickTime audio keeps its esds inside a wave box; MSE needs it directly in the sample entry.
        return new Uint8Array(ISOFile.writeInitializationSegment(ftyp, moov, fragmentDuration, new Set([trak.tkhd.track_id])));
    } finally {
        trak.edts = edts;
        trak.boxes = boxes;
    }
}

/** Parses a moov box (bytes as read from the file) into the packageable tracks it describes. */
export function indexMoov(moovBytes: Uint8Array): PackagedFile {
    const file = createFile();
    const buffer = MP4BoxBuffer.fromArrayBuffer(moovBytes.slice().buffer, 0);
    file.appendBuffer(buffer);
    file.flush();
    if (!file.moov) throw new Error("moov could not be parsed");
    if (file.moov.mvex) throw new Error("the file is fragmented");

    const movieTimescale = file.moov.mvhd.timescale;
    const candidates: { trak: Trak; kind: PackagedTrackKind; trakIndex: number }[] = [];
    for (const [trakIndex, trak] of file.moov.traks.entries()) {
        const kind = trackKind(trak);
        if (kind && trak.samples.length > 0) candidates.push({ trak, kind, trakIndex });
    }

    // Empty every sample table before writing init segments; the expanded `trak.samples` stay.
    file.resetTables();
    const fragmentDuration = file.initial_duration;

    const tracks = candidates.map(({ trak, kind, trakIndex }): PackagedTrack => {
        const samples = trak.samples;
        const timescale = trak.mdia.mdhd.timescale;
        const shift = editShift(trak, movieTimescale, timescale);
        const count = samples.length;
        const offsets = new Float64Array(count);
        const sizes = new Uint32Array(count);
        const durations = new Uint32Array(count);
        const compositionOffsets = new Int32Array(count);
        const sync = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            const sample = samples[i]!;
            offsets[i] = sample.offset;
            sizes[i] = sample.size;
            durations[i] = sample.duration;
            compositionOffsets[i] = sample.cts - sample.dts - shift;
            sync[i] = kind === "audio" || sample.is_sync ? 1 : 0;
        }
        return {
            trackId: trak.tkhd.track_id,
            trakIndex,
            kind,
            timescale,
            init: writeInit(file, trak, fragmentDuration),
            offsets,
            sizes,
            durations,
            compositionOffsets,
            sync,
            ...segmentBoundaries(kind, timescale, durations, sync),
        };
    });
    return { tracks };
}

/** The contiguous byte runs of samples [first, end), in order. */
function byteRuns(track: PackagedTrack, first: number, end: number) {
    const runs: { start: number; length: number }[] = [];
    for (let i = first; i < end; i++) {
        const last = runs[runs.length - 1];
        const offset = track.offsets[i]!;
        const size = track.sizes[i]!;
        if (last && last.start + last.length === offset) last.length += size;
        else runs.push({ start: offset, length: size });
    }
    return runs;
}

/** One range read of the original and the parts of it that go into the mdat, as [offset, length) within the read. */
interface PlannedRead {
    start: number;
    length: number;
    parts: { offset: number; length: number }[];
}

/**
 * Groups byte runs into range reads. Muxers interleave tracks, often sample by sample, so the runs of one track sit
 * between the other tracks' samples: a read spans the gaps up to `MAX_READ_GAP_BYTES` (reading the skipped bytes is
 * cheaper than another request) and is cut at `READ_PIECE_BYTES`, so the first bytes go out before the rest is read.
 */
export function planReads(runs: readonly { start: number; length: number }[]): PlannedRead[] {
    const reads: PlannedRead[] = [];
    for (const run of runs) {
        for (let done = 0; done < run.length; ) {
            const start = run.start + done;
            const last = reads[reads.length - 1];
            const lastEnd = last ? last.start + last.length : 0;
            const room = last && start >= lastEnd && start - lastEnd <= MAX_READ_GAP_BYTES ? READ_PIECE_BYTES - (start - last.start) : 0;
            if (last && room > 0) {
                const length = Math.min(room, run.length - done);
                last.parts.push({ offset: start - last.start, length });
                last.length = start - last.start + length;
                done += length;
            } else {
                const length = Math.min(READ_PIECE_BYTES, run.length - done);
                reads.push({ start, length, parts: [{ offset: 0, length }] });
                done += length;
            }
        }
    }
    return reads;
}

/** Writes `moof` (mfhd, traf: tfhd, tfdt, trun) for samples [first, end) of a track. */
function writeMoof(track: PackagedTrack, sequence: number, first: number, end: number, decodeTime: number): Uint8Array {
    const count = end - first;
    const trunSize = 12 + 4 + 4 + count * 16;
    const trafSize = 8 + 16 + 20 + trunSize;
    const moofSize = 8 + 16 + trafSize;
    const bytes = new Uint8Array(moofSize);
    const view = new DataView(bytes.buffer);
    let at = 0;
    const box = (size: number, type: string) => {
        view.setUint32(at, size);
        for (let i = 0; i < 4; i++) bytes[at + 4 + i] = type.charCodeAt(i);
        at += 8;
    };
    const u32 = (value: number) => {
        view.setUint32(at, value);
        at += 4;
    };

    box(moofSize, "moof");
    box(16, "mfhd");
    u32(0); // version, flags
    u32(sequence);
    box(trafSize, "traf");
    box(16, "tfhd");
    u32(0x02_0000); // default-base-is-moof
    u32(track.trackId);
    box(20, "tfdt");
    u32(0x0100_0000); // version 1
    view.setBigUint64(at, BigInt(decodeTime));
    at += 8;
    box(trunSize, "trun");
    u32(0x0100_0f01); // version 1 (signed composition offsets); data offset, duration, size, flags, composition offset
    u32(count);
    u32(moofSize + 8); // data starts after the mdat header
    for (let i = first; i < end; i++) {
        u32(track.durations[i]!);
        u32(track.sizes[i]!);
        u32(track.sync[i] ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NON_SYNC);
        view.setInt32(at, track.compositionOffsets[i]!);
        at += 4;
    }
    return bytes;
}

/** A read covers at most this many bytes, so the first bytes go out before the whole segment is read. */
const READ_PIECE_BYTES = 1024 * 1024;
/** Gaps between a track's runs up to this size are read through rather than split into another request. */
const MAX_READ_GAP_BYTES = 32 * 1024;
/** Reads in flight ahead of the one being sent: many small ones for a track whose runs stay apart, few large ones. */
const MAX_READS_AHEAD = 32;
const MAX_BYTES_AHEAD = 4 * READ_PIECE_BYTES;

/**
 * A media segment (moof + mdat) of a track: its size and a stream of its bytes. The moof goes out at once, then the
 * samples' bytes, read from the original in ranges ahead of the one being sent; cancelling the stream stops the reads.
 */
export function packageSegment(track: PackagedTrack, index: number, read: RangeReader): { size: number; body: ReadableStream<Uint8Array> } {
    if (!Number.isInteger(index) || index < 0 || index >= segmentCount(track)) throw new RangeError(`no segment ${index}`);
    const first = track.segmentSamples[index]!;
    const end = track.segmentSamples[index + 1]!;
    const moof = writeMoof(track, index + 1, first, end, track.segmentTimes[index]!);
    const plan = planReads(byteRuns(track, first, end));
    const payload = plan.reduce((total, piece) => total + piece.parts.reduce((sum, part) => sum + part.length, 0), 0);

    const head = new Uint8Array(moof.byteLength + 8);
    head.set(moof, 0);
    new DataView(head.buffer).setUint32(moof.byteLength, 8 + payload);
    head.set([0x6d, 0x64, 0x61, 0x74], moof.byteLength + 4); // "mdat"

    const reads: Promise<Uint8Array>[] = [];
    let next = 0;
    const readAhead = () => {
        let bytes = 0;
        for (let i = next; i < reads.length; i++) bytes += plan[i]!.length;
        while (reads.length < plan.length && reads.length - next < MAX_READS_AHEAD && bytes < MAX_BYTES_AHEAD) {
            const piece = plan[reads.length]!;
            const pending = read(piece.start, piece.start + piece.length - 1);
            pending.catch(() => {}); // surfaced when the piece is sent
            reads.push(pending);
            bytes += piece.length;
        }
    };
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(head);
            readAhead();
        },
        async pull(controller) {
            if (next === plan.length) return controller.close();
            const piece = plan[next]!;
            const chunk = await reads[next]!;
            if (chunk.byteLength !== piece.length) throw new Error(`read ${chunk.byteLength} of ${piece.length} bytes`);
            next++;
            readAhead();
            for (const part of piece.parts) controller.enqueue(chunk.subarray(part.offset, part.offset + part.length));
        },
    });
    return { size: head.byteLength + payload, body };
}

/** Per-track arrays in the order they are serialized. */
const ARRAYS = [
    ["offsets", Float64Array],
    ["sizes", Uint32Array],
    ["durations", Uint32Array],
    ["compositionOffsets", Int32Array],
    ["sync", Uint8Array],
    ["segmentSamples", Uint32Array],
    ["segmentTimes", Float64Array],
] as const;

type TrackHeader = Pick<PackagedTrack, "trackId" | "trakIndex" | "kind" | "timescale"> & { init: number; samples: number; segments: number };

/** A compact binary form of a packaged file, for caching: a JSON header, then every track's bytes. */
export function encodePackagedFile(file: PackagedFile): Uint8Array {
    const headers: TrackHeader[] = file.tracks.map((track) => ({
        trackId: track.trackId,
        trakIndex: track.trakIndex,
        kind: track.kind,
        timescale: track.timescale,
        init: track.init.byteLength,
        samples: track.sizes.length,
        segments: track.segmentSamples.length,
    }));
    const header = new TextEncoder().encode(JSON.stringify(headers));
    const blocks: Uint8Array[] = [header];
    for (const track of file.tracks) {
        blocks.push(track.init);
        for (const [name] of ARRAYS) {
            const array = track[name];
            blocks.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        }
    }
    const out = new Uint8Array(4 + blocks.reduce((total, block) => total + block.byteLength, 0));
    new DataView(out.buffer).setUint32(0, header.byteLength);
    let at = 4;
    for (const block of blocks) {
        out.set(block, at);
        at += block.byteLength;
    }
    return out;
}

export function decodePackagedFile(bytes: Uint8Array): PackagedFile {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(0);
    const headers = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as TrackHeader[];
    let at = 4 + headerLength;
    const take = (length: number) => {
        // Copy so that every typed array is aligned and owns its buffer.
        const block = bytes.slice(at, at + length);
        at += length;
        return block;
    };
    const tracks = headers.map((header) => {
        const init = take(header.init);
        const arrays = Object.fromEntries(
            ARRAYS.map(([name, Type]) => {
                const count = name.startsWith("segment") ? header.segments : header.samples;
                return [name, new Type(take(count * Type.BYTES_PER_ELEMENT).buffer)];
            }),
        ) as Pick<PackagedTrack, (typeof ARRAYS)[number][0]>;
        return { trackId: header.trackId, trakIndex: header.trakIndex, kind: header.kind, timescale: header.timescale, init, ...arrays };
    });
    if (at !== bytes.byteLength) throw new Error("packaged file has trailing bytes");
    return { tracks };
}
