import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaType, PreviewSize } from "@/db/schema";
import { PREVIEW_PROFILES, type PreviewProfile } from "@/lib/utils/preview_profiles";
import { readVvic } from "@/lib/utils/vvic";

const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_RENDER_TIMEOUT_MS = 45_000;
const FFPROBE_TIMEOUT_MS = 15_000;

/** What FFmpeg says when the bytes it read cannot be decoded, as opposed to a read that failed or a broken environment. */
const UNDECODABLE_SOURCE = /invalid data found|moov atom not found|could not find codec parameters|does not contain any stream/i;

/** FFmpeg cannot decode the source; rendering the same file again will not help. */
export class UndecodableSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UndecodableSourceError";
    }
}

export interface RenderedPreview {
    buffer: Uint8Array;
    width: number;
    height: number;
    size: number;
}

export type MediaFormatCategory = "HEIF_IMAGE" | "VVIC_IMAGE" | "STANDARD_IMAGE" | "VIDEO_CONTAINER" | "UNKNOWN";

export interface MediaFormatStrategy {
    category: MediaFormatCategory;
    extension: string;
    requiresLocalDownload: boolean;
    seekOptions: string[];
}

/**
 * Detects format category and returns format-specific rendering strategy.
 * Different formats require distinct FFmpeg input flags and network download behaviors:
 * - HEIF/HEIC (ISOBMFF): Requires local download to allow FFmpeg's mov/heif demuxer to seek into metadata atoms.
 * - VVIC_IMAGE (VVC picture in HEIF): Downloaded, then its picture is handed to FFmpeg as a raw VVC stream.
 * - STANDARD_IMAGE (JPEG, PNG, WEBP, AVIF, GIF): Direct image decoding without video seeking flags.
 * - VIDEO_CONTAINER (MP4, MOV, WEBM, MKV with AV1/HEVC/AVC): Fast video stream seeking (-ss 00:00:00.500) before -i.
 */
export function detectFormatStrategy(sourceUrl: string, mediaType: MediaType): MediaFormatStrategy {
    const ext = extractExtensionFromUrl(sourceUrl);

    if (ext === "heic" || ext === "heif") {
        return {
            category: "HEIF_IMAGE",
            extension: ext,
            requiresLocalDownload: true,
            seekOptions: [],
        };
    }

    if (ext === "vvic") {
        return {
            category: "VVIC_IMAGE",
            extension: ext,
            requiresLocalDownload: true,
            seekOptions: [],
        };
    }

    if (
        ["jpeg", "jpg", "png", "webp", "avif", "gif", "jxl"].includes(ext) ||
        (mediaType === MediaType.IMAGE && ext !== "mp4" && ext !== "mov")
    ) {
        return {
            category: "STANDARD_IMAGE",
            extension: ext,
            requiresLocalDownload: true,
            seekOptions: [],
        };
    }

    if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext) || mediaType === MediaType.VIDEO) {
        return {
            category: "VIDEO_CONTAINER",
            extension: ext,
            requiresLocalDownload: false,
            seekOptions: ["-ss", "00:00:00.500"],
        };
    }

    return {
        category: "UNKNOWN",
        extension: ext,
        requiresLocalDownload: mediaType === MediaType.IMAGE,
        seekOptions: [],
    };
}

export interface PreparedPreviewSource {
    render(size: PreviewSize, timeoutMs?: number): Promise<RenderedPreview>;
    dispose(): Promise<void>;
}

/**
 * Prepares a media source once so multiple preview sizes can be rendered without re-downloading or re-unpacking it.
 * Call `dispose()` in a `finally` block to remove any temporary source files.
 */
export async function openPreviewSource(sourceUrl: string, mediaType: MediaType, signal?: AbortSignal): Promise<PreparedPreviewSource> {
    const strategy = detectFormatStrategy(sourceUrl, mediaType);
    const isRemoteUrl = sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://");
    let tempSourcePath: string | null = null;
    let tempVvcPath: string | null = null;
    let effectiveSource = sourceUrl;

    const dispose = async () => {
        if (tempSourcePath) {
            const path = tempSourcePath;
            tempSourcePath = null;
            await safeDeleteFile(path);
        }
        if (tempVvcPath) {
            const path = tempVvcPath;
            tempVvcPath = null;
            await safeDeleteFile(path);
        }
    };

    try {
        // Images are downloaded first: HEIC/HEIF need local random seeking, and ImageMagick in the release image cannot
        // fetch a URL, so every remote image would fall through to FFmpeg, which is much slower on a storage URL.
        if (isRemoteUrl && strategy.requiresLocalDownload) {
            tempSourcePath = await downloadRemoteToTempFile(sourceUrl, signal);
            effectiveSource = tempSourcePath;
        }

        // Only FFmpeg decodes VVC, and only as a raw stream: take the picture out of its HEIF container.
        if (strategy.category === "VVIC_IMAGE") {
            tempVvcPath = join(tmpdir(), `source-${crypto.randomUUID()}.vvc`);
            await Bun.write(tempVvcPath, readVvicPicture(await Bun.file(effectiveSource).bytes()));
            effectiveSource = tempVvcPath;
        }
    } catch (error) {
        await dispose();
        throw error;
    }

    return {
        async render(size: PreviewSize, timeoutMs = DEFAULT_RENDER_TIMEOUT_MS): Promise<RenderedPreview> {
            const profile = PREVIEW_PROFILES[size];
            const tempFilePath = join(tmpdir(), `preview-${size.toLowerCase()}-${crypto.randomUUID()}.avif`);

            try {
                // 1. Direct ImageMagick rendering for static image formats (HEIC, HEIF, JPEG, PNG, WEBP, AVIF, GIF)
                if (strategy.category === "HEIF_IMAGE" || strategy.category === "STANDARD_IMAGE") {
                    const ok = await tryImageMagickPreview(effectiveSource, profile, tempFilePath, timeoutMs, signal);
                    signal?.throwIfAborted();
                    if (ok) {
                        const buffer = await readAndValidateAvif(tempFilePath);
                        const { width, height } = await probeImageDimensions(tempFilePath);
                        return { buffer, width, height, size: buffer.length };
                    }
                }

                // 2. FFmpeg execution (for VIDEO_CONTAINER or fallback for images if ImageMagick fails or is missing)
                try {
                    const cmd = buildFFmpegCommand(effectiveSource, strategy, profile, tempFilePath);
                    await executeFFmpeg(cmd, timeoutMs, sourceUrl, signal);
                } catch (err) {
                    signal?.throwIfAborted();
                    if (isRemoteUrl && !tempSourcePath) {
                        console.warn(
                            `[PREVIEW_RENDERER] Direct remote FFmpeg execution failed for ${strategy.category} (${redactUrl(sourceUrl)}), downloading local temp file fallback...`,
                        );
                        tempSourcePath = await downloadRemoteToTempFile(sourceUrl, signal);
                        effectiveSource = tempSourcePath;
                        const cmd = buildFFmpegCommand(effectiveSource, strategy, profile, tempFilePath);
                        await executeFFmpeg(cmd, timeoutMs, sourceUrl, signal);
                    } else {
                        throw err;
                    }
                }

                const buffer = await readAndValidateAvif(tempFilePath);
                const { width, height } = await probeImageDimensions(tempFilePath);

                return {
                    buffer,
                    width,
                    height,
                    size: buffer.length,
                };
            } finally {
                await safeDeleteFile(tempFilePath);
            }
        },
        dispose,
    };
}

/**
 * Renders an AVIF preview of an image or of a video frame, scaled to the size's longest edge with the aspect ratio
 * kept. The output carries no metadata (EXIF, GPS, XMP), so a preview never leaks what the original holds.
 */
export async function renderPreview(
    sourceUrl: string,
    mediaType: MediaType,
    size: PreviewSize,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
): Promise<RenderedPreview> {
    const source = await openPreviewSource(sourceUrl, mediaType, signal);
    try {
        return await source.render(size, timeoutMs);
    } finally {
        await source.dispose();
    }
}

/**
 * Attempts to render a resized AVIF preview directly from a static image file (HEIC, JPEG, PNG, WEBP, etc.)
 * using ImageMagick. Applies the EXIF orientation, then strips all metadata. (`heif-enc` is not a fallback: it
 * copies EXIF, GPS included, into its output and ignores the orientation.)
 *
 * ImageMagick keeps 4-byte float channels (Q16-HDRI) and sizes its memory limit by the host's memory, not the
 * container's, so a 48 MP photo would take about 700 MiB. A JPEG is decoded at no more than twice the preview size
 * instead, and the pixel cache of other large images goes to disk past the limits below.
 */
async function tryImageMagickPreview(
    inputPath: string,
    profile: PreviewProfile,
    outputPath: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<boolean> {
    const maxDim = `${profile.maxEdge}x${profile.maxEdge}>`;
    const decodeSize = `${profile.maxEdge * 2}x${profile.maxEdge * 2}`;
    const cmd = [
        "magick",
        "-limit",
        "memory",
        "256MiB",
        "-limit",
        "map",
        "512MiB",
        "-define",
        `jpeg:size=${decodeSize}`,
        // [0] takes only the first frame so animated GIF/WebP inputs do not render into multi-frame AVIFs.
        `${inputPath}[0]`,
        "-auto-orient",
        "-strip",
        "-resize",
        maxDim,
        "-quality",
        String(profile.quality),
        outputPath,
    ];

    let process: Bun.Subprocess;
    try {
        process = Bun.spawn({
            cmd,
            stdout: "ignore",
            stderr: "pipe",
            timeout: timeoutMs,
            signal,
        });
    } catch (e: unknown) {
        console.error("[Magick]: failed to spawn ImageMagick:", e instanceof Error ? e.message : String(e));
        return false;
    }

    const [stderr, exitCode] = await Promise.all([
        process.stderr && typeof process.stderr !== "number" ? new Response(process.stderr).text() : Promise.resolve(""),
        process.exited,
    ]);
    signal?.throwIfAborted();

    if (process.signalCode !== null) {
        throw new Error(`ImageMagick preview rendering timed out after ${timeoutMs}ms`);
    }

    if (exitCode === 0 && (await Bun.file(outputPath).exists())) {
        const bytes = await Bun.file(outputPath).bytes();
        if (bytes.byteLength > 0 && isValidAvifSignature(bytes)) {
            return true;
        }
    }

    if (stderr.trim()) {
        console.warn(`[Magick]: failed with exit ${exitCode}: ${stderr.trim().slice(0, 300)}`);
    }

    return false;
}

/** The raw VVC stream of a `.vvic` image. A container that cannot be read will not read on a retry either. */
function readVvicPicture(bytes: Uint8Array): Uint8Array {
    try {
        return readVvic(bytes).annexB;
    } catch (error) {
        throw new UndecodableSourceError(`The .vvic image could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Downloads a remote file to a temporary file on disk using a Web API stream and Bun's FileSink.
 */
async function downloadRemoteToTempFile(url: string, signal?: AbortSignal, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<string> {
    const ext = extractExtensionFromUrl(url);
    const tempPath = join(tmpdir(), `source-${crypto.randomUUID()}.${ext}`);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const downloadSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const response = await fetch(url, {
        headers: {
            "User-Agent": DEFAULT_USER_AGENT,
        },
        signal: downloadSignal,
    });
    if (!response.ok) {
        throw new Error(`Failed to download remote media for preview rendering: HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
        await Bun.write(tempPath, new Uint8Array());
        return tempPath;
    }

    const writer = Bun.file(tempPath).writer();
    try {
        for await (const chunk of response.body) {
            writer.write(chunk);
        }
        await writer.end();
        return tempPath;
    } catch (error) {
        try {
            await writer.end();
        } catch {}
        await safeDeleteFile(tempPath);
        throw error;
    }
}

/**
 * Extracts sanitized file extension from a URL path.
 */
function extractExtensionFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname;
        const lastDot = pathname.lastIndexOf(".");
        if (lastDot !== -1) {
            const ext = pathname.slice(lastDot + 1).toLowerCase();
            if (/^[a-z0-9]+$/.test(ext)) {
                return ext;
            }
        }
    } catch {}
    return "tmp";
}

/**
 * Constructs structured FFmpeg command-line arguments grouped by format strategy logic.
 */
function buildFFmpegCommand(sourcePath: string, strategy: MediaFormatStrategy, profile: PreviewProfile, outputPath: string): string[] {
    const isRemoteUrl = sourcePath.startsWith("http://") || sourcePath.startsWith("https://");

    // 1. Global options: Executable name, suppress banners, log errors only, disable stdin interaction
    const globalOptions = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"];

    // 2. Network resilience: Disguise User-Agent and enable auto-reconnect for remote S3/R2 presigned URLs.
    // NOTE: -reconnect_streamed 1 marks HTTP streams non-seekable (breaking ISOBMFF/MP4 demuxing), and
    // -reconnect_at_eof 1 causes FFmpeg to treat normal S3/R2 EOF as a disconnect and hang/fail with I/O errors.
    const networkOptions = isRemoteUrl ? ["-user_agent", DEFAULT_USER_AGENT, "-reconnect", "1", "-reconnect_delay_max", "5"] : [];

    // 3. Format-specific seek options (e.g. -ss 00:00:00.500 for VIDEO_CONTAINER)
    const seekOptions = strategy.seekOptions;

    // 4. Input file source
    const inputOptions = ["-i", sourcePath];

    // 5. Video filter: Uses -filter_complex instead of -vf with explicit stream map for tile decoding and auto-rotation
    const filterOptions = ["-filter_complex", `[0:v]${buildScaleFilter(profile.maxEdge)}[outv]`, "-map", "[outv]"];

    // 6. Encoder settings: Capture a single frame using SVT-AV1 still-picture mode
    const encoderOptions = ["-frames:v", "1", "-map_metadata", "-1", "-c:v", "libsvtav1", "-crf", String(profile.crf), "-f", "avif"];

    // 7. Output file target: Overwrite output path
    const outputOptions = ["-y", outputPath];

    return [...globalOptions, ...networkOptions, ...seekOptions, ...inputOptions, ...filterOptions, ...encoderOptions, ...outputOptions];
}

/**
 * Generates an FFmpeg scale filter expression for aspect-ratio-preserving scaling.
 * Calculates exact even pixel dimensions for both landscape and portrait orientations,
 * avoiding negative dimension macro issues inside FFmpeg filter evaluation expressions.
 *
 * Variable Key:
 * - `iw` (Input Width), `ih` (Input Height)
 * - `trunc(.../2)*2` ensures both dimensions are even numbers (required by video/image encoders)
 */
function buildScaleFilter(maxEdge: number): string {
    const isLandscape = "gt(iw,ih)";
    const targetW = `if(${isLandscape},min(${maxEdge},iw),iw*min(${maxEdge},ih)/ih)`;
    const targetH = `if(${isLandscape},ih*min(${maxEdge},iw)/iw,min(${maxEdge},ih))`;
    const evenW = `trunc(${targetW}/2)*2`;
    const evenH = `trunc(${targetH}/2)*2`;
    return `scale='${evenW}':'${evenH}'`;
}

/**
 * Spawns an FFmpeg subprocess, awaits completion, and handles timeouts or non-zero exit codes.
 */
async function executeFFmpeg(cmd: string[], timeoutMs: number, sourceUrl: string, signal?: AbortSignal): Promise<void> {
    let process: Bun.Subprocess;
    try {
        process = Bun.spawn({
            cmd,
            stdout: "ignore",
            stderr: "pipe",
            timeout: timeoutMs,
            signal,
        });
    } catch (spawnErr) {
        throw new Error(
            `Failed to spawn FFmpeg process for preview rendering. Error: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
        );
    }

    const [stderrRaw, exitCode] = await Promise.all([
        process.stderr && typeof process.stderr !== "number" ? new Response(process.stderr).text() : Promise.resolve(""),
        process.exited,
    ]);
    signal?.throwIfAborted();

    if (process.signalCode !== null) {
        throw new Error(`FFmpeg preview rendering timed out after ${timeoutMs}ms for URL: ${redactUrl(sourceUrl)}`);
    }

    if (exitCode !== 0) {
        const stderr = stderrRaw.trim();
        const message = `FFmpeg failed with exit status ${exitCode}. Stderr: ${stderr}`;
        throw UNDECODABLE_SOURCE.test(stderr) ? new UndecodableSourceError(message) : new Error(message);
    }
}

/**
 * Reads the generated AVIF file and validates its existence, non-zero size, and header signature.
 */
async function readAndValidateAvif(filePath: string): Promise<Uint8Array> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
        throw new Error("FFmpeg completed successfully but output AVIF preview file was missing.");
    }

    const bytes = await file.bytes();
    if (bytes.byteLength === 0) {
        throw new Error("FFmpeg generated an empty AVIF preview file.");
    }

    if (!isValidAvifSignature(bytes)) {
        throw new Error("FFmpeg output data lacks a valid AVIF signature.");
    }

    return bytes;
}

/**
 * Probes the width and height of the generated preview file via ffprobe.
 */
async function probeImageDimensions(filePath: string): Promise<{ width: number; height: number }> {
    try {
        const process = Bun.spawn({
            cmd: [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=s=x:p=0",
                filePath,
            ],
            stdout: "pipe",
            stderr: "ignore",
            timeout: FFPROBE_TIMEOUT_MS,
        });

        const [output] = await Promise.all([new Response(process.stdout).text(), process.exited]);
        const [wStr, hStr] = output.trim().split("x");
        const width = Number.parseInt(wStr ?? "", 10);
        const height = Number.parseInt(hStr ?? "", 10);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return { width, height };
        }
    } catch (e) {
        console.warn(`[PREVIEW_RENDERER] Could not probe dimensions via ffprobe:`, e);
    }
    return { width: 0, height: 0 };
}

/**
 * Safely removes a file from disk, catching and logging cleanup errors without throwing.
 */
async function safeDeleteFile(filePath: string): Promise<void> {
    try {
        const file = Bun.file(filePath);
        if (await file.exists()) {
            await file.delete();
        }
    } catch (err) {
        console.error(`[PREVIEW_RENDERER] Failed to clean up temp file ${filePath}:`, err);
    }
}

/**
 * Checks for the AVIF format signature ("avif" magic bytes: 0x61, 0x76, 0x69, 0x66).
 */
function isValidAvifSignature(bytes: Uint8Array): boolean {
    if (bytes.length < 16) return false;
    for (let i = 0; i <= 12; i++) {
        if (bytes[i] === 0x61 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66) {
            return true;
        }
    }
    return false;
}

/**
 * Redacts query string parameters from a URL for safe error logging.
 */
function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.search = "";
        return parsed.toString();
    } catch {
        return url;
    }
}
