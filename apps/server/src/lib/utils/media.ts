import ky from "ky";
import { s3 } from "@/global/s3";
import { v7 as createUuidV7 } from "uuid";

const uuidv7 = { generate: createUuidV7 };

/**
 * Resolves appropriate Referer and User-Agent headers to bypass anti-hotlinking.
 */
function getRefererHeaders(url: string): Record<string, string> {
    const headers: Record<string, string> = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (url.includes("zjcdn.com") || url.includes("douyin.com")) {
        headers["Referer"] = "https://www.douyin.com/";
    } else if (url.includes("tiktok.com")) {
        headers["Referer"] = "https://www.tiktok.com/";
    } else if (url.includes("xhslink.com") || url.includes("xiaohongshu.com")) {
        headers["Referer"] = "https://www.xiaohongshu.com/";
    }
    return headers;
}

/**
 * Creates a resumable standard Web ReadableStream that automatically resumes
 * using Range requests if the stream connection drops mid-consumption.
 */
function createResumableStream(
    url: string,
    initialRes: Response,
    requestHeaders: Record<string, string>,
    timeout: number | false,
): ReadableStream<Uint8Array> {
    let offset = 0;
    let reader: any = initialRes.body!.getReader();
    let attempt = 0;
    const maxRetries = 3;
    const readTimeoutMs = 30_000; // 30 seconds idle read timeout

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            while (true) {
                if (!reader) {
                    try {
                        attempt++;
                        if (attempt > maxRetries) {
                            throw new Error(`Max retries reached during stream download resume`);
                        }

                        console.warn(
                            `[ResumableStream] Connection lost at offset ${offset}. Retrying attempt ${attempt}/${maxRetries} for ${url}...`,
                        );

                        const retryHeaders = {
                            ...requestHeaders,
                            Range: `bytes=${offset}-`,
                        };

                        let res: Response;
                        if (timeout !== false) {
                            const retryController = new AbortController();
                            const retryTimeoutId = setTimeout(
                                () => retryController.abort(),
                                timeout,
                            );

                            res = await ky(url, {
                                headers: retryHeaders,
                                timeout: false,
                                signal: retryController.signal,
                                throwHttpErrors: false,
                            });
                            clearTimeout(retryTimeoutId);
                        } else {
                            res = await ky(url, {
                                headers: retryHeaders,
                                timeout: false,
                                throwHttpErrors: false,
                            });
                        }

                        if (res.status !== 206) {
                            throw new Error(
                                `Server did not return 206 Partial Content (Status: ${res.status})`,
                            );
                        }

                        if (!res.body) {
                            throw new Error(`Retry response body is empty`);
                        }

                        reader = res.body.getReader();
                    } catch (err: any) {
                        console.error(
                            `[ResumableStream] Failed to resume stream at attempt ${attempt}:`,
                            err,
                        );
                        controller.error(err);
                        return;
                    }
                }

                try {
                    const activeReader = reader;
                    if (!activeReader) {
                        throw new Error("Reader is null unexpectedly");
                    }

                    // Race activeReader.read() against a 30s idle timeout
                    let timeoutId: any;
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(() => {
                            reject(
                                new Error(
                                    `Read timeout: No data received for ${readTimeoutMs / 1000}s`,
                                ),
                            );
                        }, readTimeoutMs);
                    });

                    const readPromise = activeReader.read();
                    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
                    clearTimeout(timeoutId);

                    if (done) {
                        controller.close();
                        return;
                    }
                    offset += value.length;
                    attempt = 0; // Reset retry counter on successful read
                    controller.enqueue(value);
                    return;
                } catch (err: any) {
                    console.warn(
                        `[ResumableStream] Stream read interrupted/timeout at offset ${offset}:`,
                        err.message || err,
                    );

                    if (reader) {
                        try {
                            reader.cancel().catch(() => {});
                        } catch {}
                    }
                    reader = null;
                    // Exponential backoff
                    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
                }
            }
        },
        cancel() {
            const activeReader = reader;
            if (activeReader) {
                activeReader.cancel().catch(() => {});
            }
        },
    });
}

/**
 * Downloads media and returns the Response for streaming.
 */
export async function downloadStream(
    url: string,
    options: {
        timeout?: number | false;
        headers?: Record<string, string>;
    } = {},
): Promise<Response | null> {
    try {
        const targetUrl = url.startsWith("//") ? `https:${url}` : url;
        const refererHeaders = getRefererHeaders(targetUrl);
        const requestHeaders = {
            ...refererHeaders,
            ...options.headers,
        };

        // Default to 30s handshake timeout if not specified
        const handshakeTimeout = options.timeout !== undefined ? options.timeout : 30_000;

        let initialRes: Response;
        if (handshakeTimeout !== false) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), handshakeTimeout);

            initialRes = await ky(targetUrl, {
                headers: requestHeaders,
                timeout: false,
                signal: controller.signal,
                throwHttpErrors: false,
                retry: {
                    limit: 3,
                    methods: ["get"],
                    statusCodes: [408, 413, 429, 500, 502, 503, 504],
                },
            });
            clearTimeout(timeoutId);
        } else {
            initialRes = await ky(targetUrl, {
                headers: requestHeaders,
                timeout: false,
                throwHttpErrors: false,
                retry: {
                    limit: 3,
                    methods: ["get"],
                    statusCodes: [408, 413, 429, 500, 502, 503, 504],
                },
            });
        }

        if (!initialRes.ok) {
            const errorMsg = `Failed to download media from ${url}: ${initialRes.status}`;
            console.error(errorMsg);
            throw new Error(errorMsg);
        }

        if (!initialRes.body) {
            throw new Error(`Response body is empty`);
        }

        // 2. Wrap body in custom resumable stream
        const resumableStream = createResumableStream(
            targetUrl,
            initialRes,
            requestHeaders,
            handshakeTimeout,
        );

        // 3. Return a standard Web Response containing our custom stream
        return new Response(resumableStream, {
            status: initialRes.status,
            statusText: initialRes.statusText,
            headers: initialRes.headers,
        });
    } catch (error) {
        console.error(`Error downloading media stream from ${url}:`, error);
        throw error;
    }
}

/**
 * Downloads media from a URL with retry logic.
 */
export async function downloadMedia(
    url: string,
    options: {
        timeout?: number;
        retry?: number;
        headers?: Record<string, string>;
    } = {},
): Promise<{ buffer: Buffer; contentType: string } | null> {
    const { timeout = 240_000, retry = 3, headers = {} } = options;

    try {
        const targetUrl = url.startsWith("//") ? `https:${url}` : url;
        const refererHeaders = getRefererHeaders(targetUrl);
        const response = await ky(targetUrl, {
            method: "GET",
            retry: {
                limit: retry,
                retryOnTimeout: true,
            },
            timeout: timeout,
            throwHttpErrors: false,
            headers: {
                ...refererHeaders,
                ...headers,
            },
        });

        if (!response.ok) {
            console.error(`Failed to download media from ${url}: ${response.status}`);
            return null;
        }

        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const arrayBuffer = await response.arrayBuffer();

        return {
            buffer: Buffer.from(arrayBuffer),
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
export function getExtensionFromContentType(contentType: string | null, url?: string): string {
    if (!contentType) return getExtensionFromUrl(url) || "bin";
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
    let ext = mimeMap[type] || type.split("/")[1] || "bin";

    if ((ext === "plain" || ext === "bin") && url) {
        const urlExt = getExtensionFromUrl(url);
        if (urlExt) {
            ext = urlExt;
        }
    }
    return ext;
}

function getExtensionFromUrl(url?: string): string | null {
    if (!url) return null;
    try {
        const urlObj = new URL(url.startsWith("//") ? `https:${url}` : url);
        const pathname = urlObj.pathname;
        const lastDot = pathname.lastIndexOf(".");
        if (lastDot !== -1) {
            const ext = pathname.slice(lastDot + 1).toLowerCase();
            if (/^[a-z0-9]{2,5}$/.test(ext)) {
                return ext;
            }
        }
    } catch {}
    return null;
}

/**
 * Uploads media to S3 using Web API streams.
 */
export async function uploadToS3(
    path: string,
    data: ReadableStream | Uint8Array | Blob,
    contentType: string,
    bucket: string,
    contentLength?: number,
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
