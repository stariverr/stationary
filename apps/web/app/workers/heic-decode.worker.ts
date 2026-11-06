/**
 * Decodes HEIC images off the main thread: fetch, libheif WASM decode and JPEG encode all run here, so a full-size
 * photo no longer freezes the page (and any animation on it) for the half second a decode takes.
 */

import libheif from "libheif-js/wasm-bundle";

interface HeifImage {
    handle?: unknown;
    is_primary: () => boolean;
    get_width: () => number;
    get_height: () => number;
    display: (imageData: ImageData, callback: (displayData: ImageData | null) => void) => void;
    free: () => void;
}

interface HeifDecoder {
    decoder?: unknown;
    decode: (buffer: ArrayBuffer) => HeifImage[];
    free?: () => void;
}

interface LibheifModule {
    HeifDecoder: new () => HeifDecoder;
    heif_image_handle_is_primary_image?: (handle: unknown) => number;
    _heif_image_handle_is_primary_image?: (handle: unknown) => number;
    heif_context_free?: (ctx: unknown) => void;
    heif_image_handle_get_color_profile_type?: (handle: unknown) => number;
    heif_image_handle_get_raw_color_profile_size?: (handle: unknown) => number;
    heif_image_handle_get_raw_color_profile?: (errPtr: number, handle: unknown, dataPtr: number) => void;
    heif_image_handle_get_nclx_color_profile?: (errPtr: number, handle: unknown, nclxPtrPtr: number) => void;
    heif_nclx_color_profile_free?: (nclxPtr: number) => void;
    _malloc?: (size: number) => number;
    _free?: (ptr: number) => void;
    HEAP32?: Int32Array;
    HEAPU32?: Uint32Array;
    HEAPU16?: Uint16Array;
    HEAPU8?: Uint8Array;
}

export interface HeicDecodeRequest {
    id: number;
    url: string;
}

export type HeicDecodeResponse = { id: number; blob: Blob } | { id: number; error: string };

const mod = libheif as LibheifModule;
// Workaround for a libheif-js bug: HeifImage.prototype.is_primary calls an undeclared global.
(globalThis as any).heif_image_handle_is_primary_image =
    mod.heif_image_handle_is_primary_image || mod._heif_image_handle_is_primary_image;

/** Whether the image carries a Display P3 / DCI-P3 colour profile (ICC or NCLX). */
const detectColorSpace = (handle: unknown): PredefinedColorSpace => {
    try {
        if (!mod.heif_image_handle_get_color_profile_type) return "srgb";
        const profileType = mod.heif_image_handle_get_color_profile_type(handle);

        // NCLX colour profile ('nclx' = 0x6e636c78)
        if (
            profileType === 0x6e636c78 &&
            mod.heif_image_handle_get_nclx_color_profile &&
            mod._malloc &&
            mod._free &&
            mod.HEAP32 &&
            mod.HEAPU32 &&
            mod.HEAPU16
        ) {
            const errPtr = mod._malloc(12);
            const nclxPtrPtr = mod._malloc(4);
            try {
                mod.heif_image_handle_get_nclx_color_profile(errPtr, handle, nclxPtrPtr);
                if (mod.HEAP32[errPtr >> 2] === 0) {
                    const nclxPtr = mod.HEAPU32[nclxPtrPtr >> 2];
                    if (nclxPtr) {
                        try {
                            // struct heif_color_profile_nclx: uint8 version, 1 byte padding, uint16 color_primaries
                            const primaries = mod.HEAPU16[(nclxPtr + 2) >> 1];
                            // 11 = DCI-P3, 12 = Display P3
                            if (primaries === 11 || primaries === 12) return "display-p3";
                        } finally {
                            mod.heif_nclx_color_profile_free?.(nclxPtr);
                        }
                    }
                }
            } finally {
                mod._free(errPtr);
                mod._free(nclxPtrPtr);
            }
        }

        // Raw ICC profile ('rICC' = 0x72494343 or 'prof' = 0x70726f66)
        if (
            (profileType === 0x72494343 || profileType === 0x70726f66) &&
            mod.heif_image_handle_get_raw_color_profile_size &&
            mod.heif_image_handle_get_raw_color_profile &&
            mod._malloc &&
            mod._free &&
            mod.HEAP32 &&
            mod.HEAPU8
        ) {
            const rawSize = mod.heif_image_handle_get_raw_color_profile_size(handle);
            if (rawSize > 0) {
                const errPtr = mod._malloc(12);
                const dataPtr = mod._malloc(rawSize);
                try {
                    mod.heif_image_handle_get_raw_color_profile(errPtr, handle, dataPtr);
                    if (mod.HEAP32[errPtr >> 2] === 0) {
                        const text = new TextDecoder("latin1").decode(mod.HEAPU8.subarray(dataPtr, dataPtr + rawSize));
                        // Apple and Display P3 profile descriptions contain "Display P3" or "DCI-P3"
                        if (/display[ -]?p3|dci[ -]?p3/i.test(text)) return "display-p3";
                    }
                } finally {
                    mod._free(errPtr);
                    mod._free(dataPtr);
                }
            }
        }
    } catch (e) {
        console.warn("HEIC color profile detection failed, defaulting to srgb:", e);
    }
    return "srgb";
};

const decode = async (url: string): Promise<Blob> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch HEIC image (${res.status} ${res.statusText})`);
    const buffer = await res.arrayBuffer();

    const decoder = new mod.HeifDecoder();
    let images: HeifImage[];
    try {
        images = decoder.decode(buffer);
    } finally {
        try {
            const context = decoder.decoder as { delete?: () => void } | undefined;
            if (typeof context?.delete === "function") context.delete();
            else if (context) mod.heif_context_free?.(context);
        } catch {}
        decoder.free?.();
    }

    const primary = images.find((image) => {
        try {
            return image.is_primary();
        } catch {
            return false;
        }
    }) ?? images[0];
    if (!primary) throw new Error("No images found in HEIC file");
    for (const image of images) {
        if (image !== primary) {
            try {
                image.free();
            } catch {}
        }
    }

    try {
        const width = primary.get_width();
        const height = primary.get_height();
        const canvas = new OffscreenCanvas(width, height);
        const colorSpace = detectColorSpace(primary.handle);
        const ctx = canvas.getContext("2d", { colorSpace });
        if (!ctx) throw new Error("Failed to get a 2D canvas context for HEIC decoding");

        const imageData = ctx.createImageData(width, height, { colorSpace });
        const displayData = await new Promise<ImageData>((resolve, reject) => {
            primary.display(imageData, (data) => (data ? resolve(data) : reject(new Error("Failed to extract HEIC image data"))));
        });
        ctx.putImageData(displayData, 0, 0);
        return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
    } finally {
        try {
            primary.free();
        } catch {}
    }
};

self.addEventListener("message", async (event: MessageEvent<HeicDecodeRequest>) => {
    const { id, url } = event.data;
    let response: HeicDecodeResponse;
    try {
        response = { id, blob: await decode(url) };
    } catch (error) {
        response = { id, error: error instanceof Error ? error.message : String(error) };
    }
    self.postMessage(response);
});
