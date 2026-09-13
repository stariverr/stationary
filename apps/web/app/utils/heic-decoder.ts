interface HeifImage {
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
    HeifDecoder: {
        new (): HeifDecoder;
    };
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

let libheifModuleInstance: LibheifModule | null = null;
const decodedCache = new Map<string, string>();
const inFlightDecodePromises = new Map<string, Promise<string>>();

/**
 * Check whether a given URL or MIME type indicates a HEIC/HEIF image
 */
export const isHeic = (url?: string | null, mime?: string | null): boolean => {
    if (mime && (mime.includes("heic") || mime.includes("heif") || mime.includes("image/heic") || mime.includes("image/heif"))) {
        return true;
    }
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

/**
 * Dynamically load and initialize the libheif WASM bundle
 */
const getLibheifModule = async (): Promise<LibheifModule> => {
    if (libheifModuleInstance) return libheifModuleInstance;

    const libheif = await import("libheif-js/wasm-bundle");
    const mod = ((libheif as any).default || libheif) as any;

    // Workaround for libheif-js NPM package bug:
    // HeifImage.prototype.is_primary calls an undeclared global 'heif_image_handle_is_primary_image'
    if (typeof globalThis !== "undefined") {
        (globalThis as any).heif_image_handle_is_primary_image =
            mod.heif_image_handle_is_primary_image || mod._heif_image_handle_is_primary_image;
    }

    libheifModuleInstance = mod as unknown as LibheifModule;
    return libheifModuleInstance;
};

/**
 * Detect whether the HEIC image contains a Display P3 / DCI-P3 color profile (via ICC or NCLX)
 */
export const detectHeicColorSpace = (mod: LibheifModule, handle: unknown): "srgb" | "display-p3" => {
    try {
        if (!mod.heif_image_handle_get_color_profile_type) return "srgb";

        const profileType = mod.heif_image_handle_get_color_profile_type(handle);

        // 1. NCLX color profile ('nclx' = 0x6e636c78)
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
                const code = mod.HEAP32[errPtr >> 2];
                if (code === 0) {
                    const nclxPtr = mod.HEAPU32[nclxPtrPtr >> 2];
                    if (nclxPtr) {
                        try {
                            // struct heif_color_profile_nclx:
                            // uint8_t version (offset 0), 1 byte padding (offset 1)
                            // uint16_t color_primaries (offset 2)
                            const primaries = mod.HEAPU16[(nclxPtr + 2) >> 1];
                            // 11 = DCI-P3, 12 = Display P3
                            if (primaries === 11 || primaries === 12) {
                                return "display-p3";
                            }
                        } finally {
                            if (typeof mod.heif_nclx_color_profile_free === "function") {
                                mod.heif_nclx_color_profile_free(nclxPtr);
                            }
                        }
                    }
                }
            } finally {
                mod._free(errPtr);
                mod._free(nclxPtrPtr);
            }
        }

        // 2. Raw ICC profile ('rICC' = 0x72494343 or 'prof' = 0x70726f66)
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
                    const code = mod.HEAP32[errPtr >> 2];
                    if (code === 0) {
                        const bytes = mod.HEAPU8.subarray(dataPtr, dataPtr + rawSize);
                        const text = new TextDecoder("latin1").decode(bytes);
                        // Standard Apple & Display P3 profile descriptions contain "Display P3" or "DCI-P3"
                        if (/display[ -]?p3|dci[ -]?p3/i.test(text)) {
                            return "display-p3";
                        }
                    }
                } finally {
                    mod._free(errPtr);
                    mod._free(dataPtr);
                }
            }
        }
    } catch (e) {
        console.warn("HEIC color profile detection encountered error, defaulting to srgb:", e);
    }

    return "srgb";
};

/**
 * Decode a HEIC image URL to a local Blob URL via WebAssembly libheif.
 * Features in-memory caching and request deduplication.
 */
export const decodeHeicToBlobUrl = async (url: string): Promise<string> => {
    if (!url) throw new Error("Empty URL passed to decodeHeicToBlobUrl");

    // 1. Check in-memory decoded cache
    const cached = decodedCache.get(url);
    if (cached) return cached;

    // 2. Check in-flight deduplication
    const inFlight = inFlightDecodePromises.get(url);
    if (inFlight) return inFlight;

    const decodePromise = (async () => {
        // Fetch raw image binary
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch HEIC image (${res.status} ${res.statusText})`);
        }
        const buffer = await res.arrayBuffer();

        // Initialize WASM
        const mod = await getLibheifModule();
        const decoder = new mod.HeifDecoder();

        let images: HeifImage[] = [];
        try {
            images = decoder.decode(buffer);
        } finally {
            // Free the context if available
            try {
                if (decoder.decoder) {
                    if (typeof (decoder.decoder as any).delete === "function") {
                        (decoder.decoder as any).delete();
                    } else if (typeof mod.heif_context_free === "function") {
                        mod.heif_context_free(decoder.decoder);
                    }
                }
            } catch (_) {}
            if (typeof decoder.free === "function") {
                decoder.free();
            }
        }

        const firstImg = images[0];
        if (!firstImg) {
            throw new Error("No images found in HEIC file");
        }

        // Safely determine primary image without throwing ReferenceError
        let primaryImage: HeifImage = firstImg;
        for (const img of images) {
            try {
                if (typeof img.is_primary === "function" && img.is_primary()) {
                    primaryImage = img;
                    break;
                }
            } catch (_) {
                // Fallback to first image on error
            }
        }

        // Immediately free all non-primary images from WASM heap
        for (const img of images) {
            if (img !== primaryImage) {
                try {
                    img.free();
                } catch (_) {}
            }
        }

        // Detect color space from ICC or NCLX
        const detectedColorSpace = detectHeicColorSpace(mod, (primaryImage as any).handle);

        const width = primaryImage.get_width();
        const height = primaryImage.get_height();

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        let ctx: CanvasRenderingContext2D | null = null;
        let activeColorSpace: "srgb" | "display-p3" = "srgb";

        if (detectedColorSpace === "display-p3") {
            try {
                ctx = canvas.getContext("2d", { colorSpace: "display-p3" }) as CanvasRenderingContext2D | null;
                if (ctx && ctx.getContextAttributes?.().colorSpace === "display-p3") {
                    activeColorSpace = "display-p3";
                }
            } catch (_) {}
        }

        if (!ctx) {
            ctx = (canvas.getContext("2d", { colorSpace: "srgb" }) || canvas.getContext("2d")) as CanvasRenderingContext2D | null;
            activeColorSpace = "srgb";
        }

        if (!ctx) {
            try {
                primaryImage.free();
            } catch (_) {}
            throw new Error("Failed to get 2D canvas context for HEIC decoding");
        }

        let imageData: ImageData;
        try {
            imageData = ctx.createImageData(width, height, { colorSpace: activeColorSpace });
        } catch (_) {
            imageData = ctx.createImageData(width, height);
        }

        await new Promise<void>((resolve, reject) => {
            primaryImage.display(imageData, (displayData) => {
                if (!displayData) {
                    reject(new Error("Failed to extract HEIC image display data"));
                    return;
                }
                ctx.putImageData(displayData, 0, 0);
                resolve();
            });
        });

        // Free primary image from WASM heap
        try {
            primaryImage.free();
        } catch (_) {}

        // Convert canvas contents to JPEG blob URL (0.95 quality)
        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95);
        });

        if (!blob) {
            throw new Error("Failed to create blob from decoded HEIC canvas");
        }

        const blobUrl = URL.createObjectURL(blob);
        decodedCache.set(url, blobUrl);
        return blobUrl;
    })();

    inFlightDecodePromises.set(url, decodePromise);

    try {
        return await decodePromise;
    } finally {
        inFlightDecodePromises.delete(url);
    }
};
