import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { s3 } from "@/global/s3";
import { env } from "@/global/env";
import { MediaType } from "@/db/schema";
import { Quality } from "@/lib/types";
import { renderCoverFrame, detectFormatStrategy, type MediaFormatCategory } from "@/lib/utils/cover_renderer";

const SAMPLE_HEIC = "/Users/kazuha/sec/30143692e0e1844a7eeb371f0e674813393378d204e96dbd4260b313a8223612.heic";
const SAMPLE_WEBP = "/Users/kazuha/sec/1040g2sg30ujge6cala005pc26jj6dmioftbemho.webp";
const SAMPLE_JPG = "/Users/kazuha/sec/twitter-downloader/videoes_2/1978789952071839744.jpg";
const SAMPLE_MP4 = "/Users/kazuha/sec/twitter-downloader/videoes_2/1797913221044801536.mp4";

interface FormatTestCase {
    name: string;
    ext: string;
    mediaType: MediaType;
    expectedCategory: MediaFormatCategory;
    generateLocalFile: () => Promise<string>;
}

describe("All Cover Media Formats End-to-End S3 Presigned URL Test Suite", () => {
    const tempDir = join(tmpdir(), `cover-format-tests-${crypto.randomUUID()}`);
    const createdTempFiles: string[] = [];
    const uploadedS3Keys: string[] = [];

    beforeAll(async () => {
        await Bun.spawn(["mkdir", "-p", tempDir]).exited;
    });

    afterAll(async () => {
        for (const key of uploadedS3Keys) {
            try {
                await s3.delete(key, { bucket: env.S3_BUCKET });
            } catch (e) {
                console.warn(`Failed to clean up S3 key ${key}:`, e);
            }
        }
        for (const file of createdTempFiles) {
            try {
                const bfile = Bun.file(file);
                if (await bfile.exists()) {
                    await bfile.delete();
                }
            } catch {}
        }
    });

    async function generateConvertedFile(cmd: string[], outputPath: string): Promise<string> {
        const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`FFmpeg format prep failed (${cmd.join(" ")}): ${stderr}`);
        }
        createdTempFiles.push(outputPath);
        return outputPath;
    }

    const testCases: FormatTestCase[] = [
        {
            name: "HEIC Image (Apple ISOBMFF)",
            ext: "heic",
            mediaType: MediaType.IMAGE,
            expectedCategory: "HEIF_IMAGE",
            generateLocalFile: async () => SAMPLE_HEIC,
        },
        {
            name: "JPEG Image (Standard)",
            ext: "jpg",
            mediaType: MediaType.IMAGE,
            expectedCategory: "STANDARD_IMAGE",
            generateLocalFile: async () => SAMPLE_JPG,
        },
        {
            name: "PNG Image (Standard)",
            ext: "png",
            mediaType: MediaType.IMAGE,
            expectedCategory: "STANDARD_IMAGE",
            generateLocalFile: async () => {
                const out = join(tempDir, "sample.png");
                return generateConvertedFile(["ffmpeg", "-y", "-i", SAMPLE_JPG, out], out);
            },
        },
        {
            name: "WebP Image (Standard)",
            ext: "webp",
            mediaType: MediaType.IMAGE,
            expectedCategory: "STANDARD_IMAGE",
            generateLocalFile: async () => SAMPLE_WEBP,
        },
        {
            name: "AVIF Image (Standard)",
            ext: "avif",
            mediaType: MediaType.IMAGE,
            expectedCategory: "STANDARD_IMAGE",
            generateLocalFile: async () => {
                const out = join(tempDir, "sample.avif");
                return generateConvertedFile(["ffmpeg", "-y", "-i", SAMPLE_JPG, "-c:v", "libsvtav1", out], out);
            },
        },
        {
            name: "MP4 Video (AVC / H.264)",
            ext: "mp4",
            mediaType: MediaType.VIDEO,
            expectedCategory: "VIDEO_CONTAINER",
            generateLocalFile: async () => SAMPLE_MP4,
        },
        {
            name: "MP4 Video (HEVC / H.265)",
            ext: "mp4",
            mediaType: MediaType.VIDEO,
            expectedCategory: "VIDEO_CONTAINER",
            generateLocalFile: async () => {
                const out = join(tempDir, "sample_hevc.mp4");
                return generateConvertedFile(
                    ["ffmpeg", "-y", "-ss", "0", "-t", "2", "-i", SAMPLE_MP4, "-c:v", "libx265", "-tag:v", "hvc1", out],
                    out,
                );
            },
        },
        {
            name: "MP4 Video (AV1)",
            ext: "mp4",
            mediaType: MediaType.VIDEO,
            expectedCategory: "VIDEO_CONTAINER",
            generateLocalFile: async () => {
                const out = join(tempDir, "sample_av1.mp4");
                return generateConvertedFile(["ffmpeg", "-y", "-ss", "0", "-t", "2", "-i", SAMPLE_MP4, "-c:v", "libsvtav1", out], out);
            },
        },
        {
            name: "MOV Video (QuickTime / LivePhoto MOV)",
            ext: "mov",
            mediaType: MediaType.VIDEO,
            expectedCategory: "VIDEO_CONTAINER",
            generateLocalFile: async () => {
                const out = join(tempDir, "sample.mov");
                return generateConvertedFile(["ffmpeg", "-y", "-ss", "0", "-t", "2", "-i", SAMPLE_MP4, "-c:v", "copy", out], out);
            },
        },
    ];

    for (const tc of testCases) {
        test(`Renders cover successfully from S3 presigned URL for ${tc.name}`, async () => {
            // 1. Prepare local format file
            const localFilePath = await tc.generateLocalFile();
            const localFile = Bun.file(localFilePath);
            expect(await localFile.exists()).toBe(true);

            // 2. Upload to S3
            const s3Key = `test-cover-formats/${crypto.randomUUID()}/source.${tc.ext}`;
            const fileBytes = await localFile.bytes();
            await s3.write(s3Key, fileBytes, { type: "application/octet-stream", bucket: env.S3_BUCKET });
            uploadedS3Keys.push(s3Key);

            // 3. Obtain S3 Presigned URL
            const presignedUrl = await s3.getPresignedUrl(s3Key, { bucket: env.S3_BUCKET, expiresInSeconds: 900 });
            expect(presignedUrl).toContain("https://");

            // 4. Verify Format Strategy Classification
            const strategy = detectFormatStrategy(presignedUrl, tc.mediaType);
            expect(strategy.category).toBe(tc.expectedCategory);

            // 5. Render Cover Frame via S3 Presigned URL
            const result = await renderCoverFrame(presignedUrl, tc.mediaType, Quality.MEDIUM);

            // 6. Assert result validity
            expect(result.buffer).toBeDefined();
            expect(result.buffer.length).toBeGreaterThan(0);
            expect(result.width).toBeGreaterThan(0);
            expect(result.height).toBeGreaterThan(0);
        }, 60000);
    }
});
