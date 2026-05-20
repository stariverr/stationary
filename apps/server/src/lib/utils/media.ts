import ky from "ky";
import { Readable } from "node:stream";
import { s3 } from "@/global/s3";
import { v7 as createUuidV7 } from "uuid";

const uuidv7 = { generate: createUuidV7 };

/**
 * Downloads media and returns the Response for streaming.
 */
export async function downloadStream(url: string, options: {
    timeout?: number | false;
    headers?: Record<string, string>;
} = {}): Promise<Response | null> {

    try {
        const targetUrl = url.startsWith("//") ? `https:${url}` : url;
        const timeout = options.timeout !== undefined ? options.timeout : false;
        const response = await ky(targetUrl, {
            timeout: timeout,
            throwHttpErrors: false,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                "Accept-Language": "en,zh-CN;q=0.9,zh;q=0.8",
                "Accept-Encoding": "zstd, br, gzip",
                ...options.headers,
            },
            retry: {
        limit: 3,
        methods: ['get'],
        statusCodes: [408, 413, 429, 500, 502, 503, 504]
    }
        });

        if (!response.ok || !response.body) {
            const errorMsg = `Failed to download media from ${url}: ${response.status}`;
            console.error(errorMsg);
            throw new Error(errorMsg);
        }

        return response;
    } catch (error) {
        if (error instanceof Error && error.message.includes("Failed to download media")) {
            throw error;
        }
        console.error(`Error downloading media from ${url}:`, error);
        throw new Error(`Error downloading media from ${url}: ${error}`);
    }
}

/**
 * Downloads media from a URL with retry logic.
 */
export async function downloadMedia(url: string, options: {
    timeout?: number;
    retry?: number;
    headers?: Record<string, string>;
} = {}): Promise<{ buffer: Buffer; contentType: string } | null> {
    const { timeout = 240_000, retry = 3, headers = {} } = options;

    try {
        const targetUrl = url.startsWith("//") ? `https:${url}` : url;
        const response = await ky(targetUrl, {
            method: "GET",
            retry: {
                limit: retry,
                retryOnTimeout: true,
            },
            timeout: timeout,
            throwHttpErrors: false,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                ...headers,
            }
        });

        if (!response.ok) {
            console.error(`Failed to download media from ${url}: ${response.status}`);
            return null;
        }

        const contentType = response.headers.get("Content-Type") || "application/octet-stream";
        const buffer = await response.arrayBuffer();

        return {
            buffer: Buffer.from(buffer),
            contentType,
        };
    } catch (error) {
        console.error(`Error downloading media from ${url}:`, error);
        return null;
    }
}

/**
 * Obfuscates an ID using a simple random string for Cloudflare Workers.
 */
export function obfuscateId(id: number | string): string {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * Gets a file extension from a mime type.
 */
export function getExtensionFromContentType(contentType: string | null): string {
    if (!contentType) return "bin";
    const mimeMap: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/avif": "avif",
        "image/jxl": "jxl",
        "image/heic": "heic",
        "image/heif": "heif",
        "image/gif": "gif",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/x-matroska": "mkv",
        "video/webm": "webm",
        "audio/mpeg": "mp3",
        "application/octet-stream": "bin",
    };

    const type = contentType.split(";")[0].toLowerCase().trim();
    return mimeMap[type] || type.split("/")[1] || "bin";
}

/**
 * Uploads media to S3 using Web API streams.
 */
export async function uploadToS3(
    path: string,
    data: ReadableStream | Uint8Array | Blob,
    contentType: string,
    bucket: string,
    contentLength?: number
): Promise<boolean> {
    try {

        await s3.write(path, data, {
            bucket,
            type: contentType,
            contentLength,
        });
        return true;
    } catch (error) {
        console.error(`Failed to upload to S3 at ${path}:`, error);
        throw error;
    }
}

/**
 * Moves an object in S3 to a trash path.
 */
export async function moveToTrash(
    sourcePath: string,
    platform: string,
    postId: string,
    bucket: string,
): Promise<string | null> {
    try {
        const ext = sourcePath.split(".").pop() || "bin";
        const filename = `${uuidv7.generate()}.${ext}`;
        const trashPath = `trash/${platform.toLowerCase()}/${postId}/${filename}`;

        console.log(`Moving ${sourcePath} to ${trashPath}...`);

        await s3.copy(sourcePath, trashPath, {
            bucket,
        });

        await s3.delete(sourcePath, {
            bucket,
        });

        return trashPath;
    } catch (error) {
        console.error(`Failed to move ${sourcePath} to trash:`, error);
        return null;
    }
}
