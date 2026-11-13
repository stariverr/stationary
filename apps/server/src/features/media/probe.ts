/**
 * Probes an original (docs/media_refactor.zh-Hans.md, 6.2): the stream facts of an audio or video file, or the
 * displayed size of an image. A file the tools cannot read is rejected, which ends the original FAILED.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AvStreamType } from "@/db/schema";
import { s3 } from "@/global/s3";
import { readMp4TrackCodecs } from "@/lib/utils/mp4-codec-string";
import { readMp4Layout, type Mp4SegmentIndex } from "@/lib/utils/mp4-layout";

/** The file cannot be probed: the input is rejected, so retrying will not help. */
export class ProbeRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProbeRejectedError";
    }
}

export interface ProbedFile {
    bucket: string;
    path: string;
    size: number | null;
    mime_type: string;
    extension: string | null;
}

export interface StreamProbe {
    stream_index: number;
    type: AvStreamType;
    codec: string;
    codec_string: string | null;
    bitrate: number | null;
    language: string | null;
    label: string | null;
    is_default: boolean;
    width: number | null;
    height: number | null;
    rotation: 0 | 90 | 180 | 270 | null;
    frame_rate: number | null;
    channels: number | null;
    sample_rate: number | null;
}

/** A text subtitle stream extracted as WebVTT, or why it could not be. */
export type EmbeddedCaption = { stream_index: number; vtt: Uint8Array } | { stream_index: number; error: string };

/**
 * Unsynced lyrics read from a tag (6.2): ID3 USLT, M4A ©lyr, Vorbis LYRICS. Synced ID3 SYLT is not read; ffmpeg does
 * not expose it.
 */
export interface EmbeddedLyrics {
    language: string | null;
    /** The USLT content descriptor, when there is one. */
    label: string | null;
    text: string;
}

export interface AvProbe {
    container: string;
    duration: number | null;
    bitrate: number | null;
    /** An fMP4: its samples are in movie fragments, so it cannot be packaged just in time (8.7). */
    fragmented: boolean;
    segmentIndex: Mp4SegmentIndex | null;
    streams: StreamProbe[];
    /** One per text subtitle stream; image subtitles (PGS, VobSub) are not extracted (16). */
    captions: EmbeddedCaption[];
    lyrics: EmbeddedLyrics[];
}

export type OriginalProbe =
    | { kind: "AV"; av: AvProbe }
    | { kind: "IMAGE"; width: number; height: number }
    | { kind: "PDF" };

const PROBE_TIMEOUT_MS = 120_000;
/** Images are read whole to find their orientation; anything larger is not an image we accept. */
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "jxl", "bmp", "tif", "tiff"]);

export function isImageFile(file: { mime_type: string; extension: string | null }): boolean {
    return file.mime_type.startsWith("image/") || IMAGE_EXTENSIONS.has((file.extension ?? "").toLowerCase());
}

export function isPdfFile(file: { mime_type: string; extension: string | null }): boolean {
    return file.mime_type === "application/pdf" || (file.extension ?? "").toLowerCase() === "pdf";
}

async function run(command: string[], label: string): Promise<string> {
    const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (process.signalCode) throw new Error(`${label} timed out`);
    if (code !== 0) throw new ProbeRejectedError(`${label} could not read the file: ${stderr.trim().slice(0, 500) || `exit ${code}`}`);
    return stdout;
}

const numberOrNull = (value: unknown): number | null => {
    const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
    return Number.isFinite(n) ? n : null;
};
const positiveIntOrNull = (value: unknown): number | null => {
    const n = numberOrNull(value);
    return n !== null && n > 0 ? Math.round(n) : null;
};

function frameRate(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const [num, den] = value.split("/").map(Number);
    if (!num || !den) return null;
    return Math.round((num / den) * 1000) / 1000;
}

/** ffprobe reports the display matrix as a counter-clockwise angle; we store the clockwise turn to display it. */
function rotation(stream: FfprobeStream): 0 | 90 | 180 | 270 {
    const matrix = stream.side_data_list?.find((data) => typeof data.rotation === "number");
    const raw = matrix?.rotation ?? numberOrNull(stream.tags?.rotate) ?? 0;
    const turn = ((Math.round(-raw / 90) * 90) % 360 + 360) % 360;
    return turn as 0 | 90 | 180 | 270;
}

interface FfprobeStream {
    index: number;
    id?: string;
    codec_type?: string;
    codec_name?: string;
    bit_rate?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    channels?: number;
    sample_rate?: string;
    disposition?: { default?: number; attached_pic?: number };
    tags?: Record<string, string>;
    side_data_list?: { rotation?: number }[];
}

export interface FfprobeOutput {
    format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> };
    streams?: FfprobeStream[];
}

/** Subtitle codecs that carry text, which ffmpeg converts to WebVTT (ASS loses its styling). */
const TEXT_SUBTITLE_CODECS = new Set([
    "subrip",
    "srt",
    "ass",
    "ssa",
    "mov_text",
    "webvtt",
    "text",
    "microdvd",
    "subviewer",
    "subviewer1",
    "sami",
    "realtext",
    "jacosub",
    "mpl2",
    "pjs",
    "vplayer",
    "stl",
]);

export const isTextSubtitleCodec = (codec: string) => TEXT_SUBTITLE_CODECS.has(codec);

/**
 * Extracts every text subtitle stream to WebVTT in one pass over the file. A stream ffmpeg cannot convert is
 * reported with its error; it does not reject the original.
 */
async function extractTextCaptions(url: string, streams: StreamProbe[]): Promise<EmbeddedCaption[]> {
    const indexes = streams.filter((stream) => stream.type === AvStreamType.SUBTITLE && isTextSubtitleCodec(stream.codec)).map((stream) => stream.stream_index);
    if (indexes.length === 0) return [];
    const dir = await mkdtemp(join(tmpdir(), "captions-"));
    try {
        const outputs = indexes.flatMap((index) => ["-map", `0:${index}`, "-f", "webvtt", join(dir, `${index}.vtt`)]);
        const process = Bun.spawn(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", url, ...outputs], {
            stdout: "ignore",
            stderr: "pipe",
            timeout: PROBE_TIMEOUT_MS,
        });
        const [stderr, code] = await Promise.all([new Response(process.stderr).text(), process.exited]);
        const failure = process.signalCode ? "caption extraction timed out" : code !== 0 ? stderr.trim().slice(0, 500) || `exit ${code}` : null;
        return Promise.all(
            indexes.map(async (index): Promise<EmbeddedCaption> => {
                const file = Bun.file(join(dir, `${index}.vtt`));
                if (failure || !(await file.exists())) return { stream_index: index, error: failure ?? "ffmpeg wrote no WebVTT" };
                return { stream_index: index, vtt: await file.bytes() };
            }),
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * How ffprobe names lyric tags: ID3 USLT as `lyrics-<lang>` or `lyrics-<descriptor>-<lang>` (TXXX frames written by
 * ffmpeg read back the same way), M4A ©lyr as `lyrics`, Vorbis comments as `LYRICS` or `UNSYNCEDLYRICS`.
 */
const LYRICS_TAG = /^(?:unsynced)?lyrics(?:-(.*))?$/i;
/** ID3 placeholders for "no language". */
const NO_LANGUAGE = new Set(["xxx", "und", "zxx"]);

function lyricsTagParts(suffix: string | undefined): { language: string | null; label: string | null } {
    if (!suffix) return { language: null, label: null };
    const cut = suffix.lastIndexOf("-");
    const language = (cut < 0 ? suffix : suffix.slice(cut + 1)).toLowerCase();
    const label = cut < 0 ? null : suffix.slice(0, cut) || null;
    return { language: /^[a-z]{3}$/.test(language) && !NO_LANGUAGE.has(language) ? language : null, label };
}

/**
 * The lyrics in a file's tags. They sit in the format tags, or in the stream tags for Ogg; the same text found twice
 * is kept once. Line breaks become `\n`, and blank lyrics are skipped.
 */
export function readTagLyrics(output: FfprobeOutput): EmbeddedLyrics[] {
    const tags = [output.format?.tags, ...(output.streams ?? []).map((stream) => stream.tags)];
    const lyrics: EmbeddedLyrics[] = [];
    for (const [key, value] of tags.flatMap((list) => Object.entries(list ?? {}))) {
        const match = LYRICS_TAG.exec(key);
        if (!match) continue;
        const text = value.replace(/\r\n?/g, "\n").trim();
        if (!text || lyrics.some((item) => item.text === text)) continue;
        lyrics.push({ ...lyricsTagParts(match[1]), text });
    }
    return lyrics;
}

const STREAM_TYPES: Record<string, AvStreamType> = { video: AvStreamType.VIDEO, audio: AvStreamType.AUDIO, subtitle: AvStreamType.SUBTITLE };

function toStreamProbe(stream: FfprobeStream, codecStrings: Map<number, string | null>): StreamProbe | null {
    const type = STREAM_TYPES[stream.codec_type ?? ""];
    if (!type || !stream.codec_name) return null;
    // Album art is a video stream in ffprobe; it is a cover, not a stream.
    if (type === AvStreamType.VIDEO && stream.disposition?.attached_pic) return null;
    const trackId = stream.id ? Number.parseInt(stream.id, 16) : NaN;
    const isVideo = type === AvStreamType.VIDEO;
    const isAudio = type === AvStreamType.AUDIO;
    if (isVideo && !(stream.width && stream.height)) return null;
    return {
        stream_index: stream.index,
        type,
        codec: stream.codec_name,
        codec_string: type === AvStreamType.SUBTITLE ? null : (codecStrings.get(trackId) ?? null),
        bitrate: positiveIntOrNull(stream.bit_rate),
        language: stream.tags?.language && stream.tags.language !== "und" ? stream.tags.language : null,
        label: stream.tags?.title || null,
        is_default: stream.disposition?.default === 1,
        width: isVideo ? stream.width! : null,
        height: isVideo ? stream.height! : null,
        rotation: isVideo ? rotation(stream) : null,
        frame_rate: isVideo ? (frameRate(stream.avg_frame_rate) ?? frameRate(stream.r_frame_rate)) : null,
        channels: isAudio ? (stream.channels ?? 2) : null,
        sample_rate: isAudio ? positiveIntOrNull(stream.sample_rate) : null,
    };
}

async function probeAv(file: ProbedFile): Promise<AvProbe> {
    const url = await s3.getPresignedUrl(file.path, { bucket: file.bucket, expiresInSeconds: 3600 });
    const output = JSON.parse(
        await run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", url], "ffprobe"),
    ) as FfprobeOutput;
    const container = output.format?.format_name;
    if (!container) throw new ProbeRejectedError("ffprobe found no container");

    let segmentIndex: Mp4SegmentIndex | null = null;
    let fragmented = false;
    const codecStrings = new Map<number, string | null>();
    if (/\bmp4\b|\bmov\b/.test(container) && file.size) {
        const read = (start: number, end: number) => s3.read(file.path, { bucket: file.bucket, maxBytes: end - start + 1, range: { start, end } });
        const layout = await readMp4Layout(read, file.size);
        segmentIndex = layout.segmentIndex;
        fragmented = layout.fragmented;
        if (layout.moov) for (const track of readMp4TrackCodecs(layout.moov)) codecStrings.set(track.track_id, track.codec_string);
    }

    const streams = (output.streams ?? []).flatMap((stream) => toStreamProbe(stream, codecStrings) ?? []);
    if (!streams.some((stream) => stream.type !== AvStreamType.SUBTITLE)) throw new ProbeRejectedError("The file has no audio or video stream");
    return {
        container,
        duration: numberOrNull(output.format?.duration),
        bitrate: positiveIntOrNull(output.format?.bit_rate),
        fragmented,
        segmentIndex,
        streams,
        captions: await extractTextCaptions(url, streams),
        lyrics: readTagLyrics(output),
    };
}

/** EXIF orientations 5 to 8 turn the image a quarter, which swaps its displayed width and height. */
const QUARTER_TURN_ORIENTATIONS = new Set(["LeftTop", "RightTop", "RightBottom", "LeftBottom"]);

async function probeImage(file: ProbedFile): Promise<{ width: number; height: number }> {
    const bytes = await s3.read(file.path, { bucket: file.bucket, maxBytes: MAX_IMAGE_BYTES });
    const dir = await mkdtemp(join(tmpdir(), "probe-"));
    try {
        const path = join(dir, `image.${file.extension || "bin"}`);
        await writeFile(path, bytes);
        const [w, h, orientation] = (await run(["magick", "identify", "-ping", "-format", "%w %h %[orientation]", `${path}[0]`], "magick")).trim().split(" ");
        const width = positiveIntOrNull(w);
        const height = positiveIntOrNull(h);
        if (!width || !height) throw new ProbeRejectedError("The image has no size");
        return QUARTER_TURN_ORIENTATIONS.has(orientation ?? "") ? { width: height, height: width } : { width, height };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

export async function probeOriginal(file: ProbedFile): Promise<OriginalProbe> {
    if (isPdfFile(file)) return { kind: "PDF" };
    if (isImageFile(file)) return { kind: "IMAGE", ...(await probeImage(file)) };
    return { kind: "AV", av: await probeAv(file) };
}

/** The displayed size of a video stream: the coded size turned by its rotation. */
export function displaySize(stream: { width: number; height: number; rotation: number | null }): { width: number; height: number } {
    return stream.rotation === 90 || stream.rotation === 270 ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
}
