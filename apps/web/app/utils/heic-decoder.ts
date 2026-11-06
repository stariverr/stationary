import type { HeicDecodeRequest, HeicDecodeResponse } from "../workers/heic-decode.worker";

const decodedCache = new Map<string, string>();
const inFlightDecodePromises = new Map<string, Promise<string>>();

/**
 * Check whether a given URL or MIME type indicates a HEIC/HEIF image
 */
export const isHeic = (url?: string | null, mime?: string | null): boolean => {
    if (mime && (mime.includes("heic") || mime.includes("heif"))) return true;
    if (!url) return false;
    const firstPart = url.split("?")[0] ?? "";
    const cleanUrl = firstPart.split("#")[0] ?? "";
    return /\.(heic|heif)$/i.test(cleanUrl);
};

/**
 * Check if the current browser natively supports HEIC rendering (Safari on macOS/iOS)
 */
export const supportsHeicNatively = (): boolean => {
    if (typeof window === "undefined") return false;
    const ua = navigator.userAgent;
    // Safari on macOS / iOS (excluding Chrome on Android/Desktop)
    return /^((?!chrome|android).)*safari/i.test(ua) || /iPad|iPhone|iPod/.test(ua);
};

// One worker decodes every image in turn; its WASM module stays warm between decodes.
let worker: Worker | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>();

const getWorker = () => {
    if (worker) return worker;
    worker = new Worker(new URL("../workers/heic-decode.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<HeicDecodeResponse>) => {
        const response = event.data;
        const request = pendingRequests.get(response.id);
        if (!request) return;
        pendingRequests.delete(response.id);
        if ("blob" in response) request.resolve(response.blob);
        else request.reject(new Error(response.error));
    });
    // The worker failed to load or crashed: fail what it held and start a fresh one on the next decode.
    worker.addEventListener("error", (event) => {
        const error = new Error(event.message || "HEIC decode worker failed");
        for (const request of pendingRequests.values()) request.reject(error);
        pendingRequests.clear();
        worker?.terminate();
        worker = null;
    });
    return worker;
};

const decodeInWorker = (url: string) =>
    new Promise<Blob>((resolve, reject) => {
        const id = nextRequestId++;
        pendingRequests.set(id, { resolve, reject });
        getWorker().postMessage({ id, url } satisfies HeicDecodeRequest);
    });

/**
 * Decode a HEIC image URL to a local JPEG Blob URL, off the main thread.
 * Features in-memory caching and request deduplication.
 */
export const decodeHeicToBlobUrl = async (url: string): Promise<string> => {
    if (!url) throw new Error("Empty URL passed to decodeHeicToBlobUrl");

    const cached = decodedCache.get(url);
    if (cached) return cached;

    const inFlight = inFlightDecodePromises.get(url);
    if (inFlight) return inFlight;

    const decodePromise = decodeInWorker(url).then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        decodedCache.set(url, blobUrl);
        return blobUrl;
    });
    inFlightDecodePromises.set(url, decodePromise);

    try {
        return await decodePromise;
    } finally {
        inFlightDecodePromises.delete(url);
    }
};
