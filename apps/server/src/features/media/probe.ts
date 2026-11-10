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

export interface AvProbe {
    container: string;
    duration: number | null;
    bitrate: number | null;
    segmentIndex: Mp4SegmentIndex | null;
    streams: StreamProbe[];
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

interface FfprobeOutput {
    format?: { format_name?: string; duration?: string; bit_rate?: string };
    streams?: FfprobeStream[];
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
    const codecStrings = new Map<number, string | null>();
    if (/\bmp4\b|\bmov\b/.test(container) && file.size) {
        const read = (start: number, end: number) => s3.read(file.path, { bucket: file.bucket, maxBytes: end - start + 1, range: { start, end } });
        const layout = await readMp4Layout(read, file.size);
        segmentIndex = layout.segmentIndex;
        if (layout.moov) for (const track of readMp4TrackCodecs(layout.moov)) codecStrings.set(track.track_id, track.codec_string);
    }

    const streams = (output.streams ?? []).flatMap((stream) => toStreamProbe(stream, codecStrings) ?? []);
    if (!streams.some((stream) => stream.type !== AvStreamType.SUBTITLE)) throw new ProbeRejectedError("The file has no audio or video stream");
    return {
        container,
        duration: numberOrNull(output.format?.duration),
        bitrate: positiveIntOrNull(output.format?.bit_rate),
        segmentIndex,
        streams,
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
