import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Helper function to strip sensitive query parameters from a URL for safe logging.
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

/**
 * Verifies if the given bytes represent a valid AVIF image by scanning
 * the first 16 bytes for the "avif" signature (hex 61 76 69 66).
 */
function isValidAvifSignature(bytes: Uint8Array): boolean {
    if (bytes.length < 16) return false;

    // Search for "avif" (0x61, 0x76, 0x69, 0x66) in the first 16 bytes
    for (let i = 0; i <= 12; i++) {
        if (
            bytes[i] === 0x61 &&
            bytes[i + 1] === 0x76 &&
            bytes[i + 2] === 0x69 &&
            bytes[i + 3] === 0x66
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Extracts a single frame from a video URL using FFmpeg, encoding it into AVIF format.
 *
 * @param videoUrl The URL of the video (external or S3 pre-signed URL).
 * @param timeoutMs Maximum duration in milliseconds to allow the extraction to run. Defaults to 30 seconds.
 * @returns Promise resolving to a Uint8Array of the resulting AVIF image bytes.
 */
export async function extractVideoFrame(
    videoUrl: string,
    timeoutMs: number = 30000,
): Promise<Uint8Array> {
    const tempFilePath = join(tmpdir(), `cover-${crypto.randomUUID()}.avif`);

    // Explicitly configure Bun.spawn with standard streams and native timeout option.
    // Wrap spawn in try-catch to provide actionable error messages when FFmpeg is not found.
    let process: Bun.Subprocess;
    try {
        process = Bun.spawn({
            cmd: [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-ss",
                "00:00:01", // seek to 1 second to avoid potential black frames at 00:00:00
                "-i",
                videoUrl,
                "-frames:v",
                "1",
                "-vf",
                "scale='min(1280,iw)':-2", // scale width up to 1280 max, maintaining aspect ratio
                "-c:v",
                "libsvtav1", // use SVT-AV1 encoder
                "-svtav1-params",
                "still-picture=1", // optimize SVT-AV1 for single still picture
                "-f",
                "avif", // output container format
                "-y", // overwrite output files
                tempFilePath,
            ],
            stdout: "pipe",
            stderr: "pipe",
            timeout: timeoutMs, // Native Bun timeout terminates process automatically
        });
    } catch (spawnErr) {
        throw new Error(
            `Failed to spawn FFmpeg process. Is FFmpeg installed and configured in your PATH? ` +
                `Error: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
        );
    }

    try {
        const exitCode = await process.exited;

        // Check if the process timed out or was terminated via signal.
        if (process.signalCode !== null) {
            throw new Error(
                `FFmpeg extraction timed out after ${timeoutMs}ms for URL: ${redactUrl(videoUrl)}`,
            );
        }

        if (exitCode !== 0) {
            let stderr = "";
            if (process.stderr && typeof process.stderr !== "number") {
                stderr = await new Response(process.stderr).text();
            }
            throw new Error(`FFmpeg failed with exit status ${exitCode}. Stderr: ${stderr.trim()}`);
        }

        const file = Bun.file(tempFilePath);
        const exists = await file.exists();
        if (!exists) {
            throw new Error(
                "FFmpeg execution completed successfully but the output AVIF file was not created.",
            );
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length === 0) {
            throw new Error("FFmpeg created an empty AVIF file.");
        }

        if (!isValidAvifSignature(bytes)) {
            throw new Error("FFmpeg returned data that does not have a valid AVIF signature.");
        }

        return bytes;
    } finally {
        // Guarantee clean up of temporary AVIF file.
        try {
            const file = Bun.file(tempFilePath);
            if (await file.exists()) {
                await file.delete();
            }
        } catch (cleanupErr) {
            console.error(
                `[FFMPEG AVIF] Failed to clean up temp file ${tempFilePath}:`,
                cleanupErr,
            );
        }
    }
}
