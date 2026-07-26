import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaType } from "@/db/schema";
import { Quality } from "@/lib/types";
import { COVER_PROFILES, type CoverProfile } from "@/lib/utils/cover_profiles";

const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface RenderedCoverResult {
    buffer: Uint8Array;
    width: number;
    height: number;
    size: number;
}

/**
 * Renders an AVIF cover image for an IMAGE, LIVE_PHOTO, or VIDEO media item,
 * enforcing aspect-ratio-preserving max-edge bounds for both landscape and portrait orientations.
 */
export async function renderCoverFrame(
    sourceUrl: string,
    mediaType: MediaType,
    targetQuality: Quality,
    timeoutMs = 45000,
): Promise<RenderedCoverResult> {
    const profile = COVER_PROFILES[targetQuality];
    if (!profile) {
        throw new Error(`Unsupported cover quality: ${targetQuality}`);
    }

    const tempFilePath = join(tmpdir(), `cover-${targetQuality.toLowerCase()}-${crypto.randomUUID()}.avif`);

    try {
        const cmd = buildFFmpegCommand(sourceUrl, mediaType, profile, tempFilePath);
        await executeFFmpeg(cmd, timeoutMs, sourceUrl);

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
}

/**
 * Constructs structured FFmpeg command-line arguments grouped by domain logic.
 */
function buildFFmpegCommand(sourceUrl: string, mediaType: MediaType, profile: CoverProfile, outputPath: string): string[] {
    const isRemoteUrl = sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://");

    // 1. Global options: Executable name, suppress banners, log errors only, disable stdin interaction
    const globalOptions = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"];

    // 2. Network resilience: Disguise User-Agent and enable auto-reconnect for remote S3/R2 presigned URLs
    const networkOptions = isRemoteUrl
        ? ["-user_agent", DEFAULT_USER_AGENT, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
        : [];

    // 3. Fast video seeking: Placed before `-i` to perform HTTP Range requests (samples frame at 0.5s without full download)
    const seekOptions = mediaType === MediaType.VIDEO ? ["-ss", "00:00:00.500"] : [];

    // 4. Input file source
    const inputOptions = ["-i", sourceUrl];

    // 5. Video filter: Uses `-filter_complex` instead of `-vf` (simple filtergraph) with an explicit stream map.
    // RATIONALE:
    // For HEIC, HEIF, Live Photo MOV, or videos with EXIF/DisplayMatrix rotation metadata, FFmpeg's internal
    // decoders automatically construct an internal complex filtergraph for tile decoding and auto-rotation.
    // FFmpeg 7+ / 8+ strictly forbids combining simple `-vf` and complex filtergraphs on the same stream,
    // throwing exit status 234: "Simple and complex filtering cannot be used together for the same stream."
    // Using `-filter_complex "[0:v]<scale_filter>[outv]" -map "[outv]"` ensures full compatibility across all media formats.
    const filterOptions = ["-filter_complex", `[0:v]${buildScaleFilter(profile.maxEdge)}[outv]`, "-map", "[outv]"];

    // 6. Encoder settings: Capture a single frame using SVT-AV1 still-picture mode
    const encoderOptions = ["-frames:v", "1", "-c:v", "libsvtav1", "-crf", String(profile.crf), "-f", "avif"];

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
async function executeFFmpeg(cmd: string[], timeoutMs: number, sourceUrl: string): Promise<void> {
    let process: Bun.Subprocess;
    try {
        process = Bun.spawn({
            cmd,
            stdout: "pipe",
            stderr: "pipe",
            timeout: timeoutMs,
        });
    } catch (spawnErr) {
        throw new Error(
            `Failed to spawn FFmpeg process for cover rendering. Error: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
        );
    }

    const exitCode = await process.exited;

    if (process.signalCode !== null) {
        throw new Error(`FFmpeg cover rendering timed out after ${timeoutMs}ms for URL: ${redactUrl(sourceUrl)}`);
    }

    if (exitCode !== 0) {
        let stderr = "";
        if (process.stderr && typeof process.stderr !== "number") {
            stderr = (await new Response(process.stderr).text()).trim();
        }
        throw new Error(`FFmpeg failed with exit status ${exitCode}. Stderr: ${stderr}`);
    }
}

/**
 * Reads the generated AVIF file and validates its existence, non-zero size, and header signature.
 */
async function readAndValidateAvif(filePath: string): Promise<Uint8Array> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
        throw new Error("FFmpeg completed successfully but output AVIF cover file was missing.");
    }

    const bytes = await file.bytes();
    if (bytes.byteLength === 0) {
        throw new Error("FFmpeg generated an empty AVIF cover file.");
    }

    if (!isValidAvifSignature(bytes)) {
        throw new Error("FFmpeg output data lacks a valid AVIF signature.");
    }

    return bytes;
}

/**
 * Probes the width and height of the generated cover file via ffprobe.
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
            stderr: "pipe",
        });

        const output = await new Response(process.stdout).text();
        const [wStr, hStr] = output.trim().split("x");
        const width = Number.parseInt(wStr ?? "", 10);
        const height = Number.parseInt(hStr ?? "", 10);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return { width, height };
        }
    } catch (e) {
        console.warn(`[COVER_RENDERER] Could not probe dimensions via ffprobe:`, e);
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
        console.error(`[COVER_RENDERER] Failed to clean up temp file ${filePath}:`, err);
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
