<script setup lang="ts">
import { ref, watch, onUnmounted, useAttrs } from "vue";

const props = defineProps<{
    src: string;
    alt?: string;
    srcset?: string;
    sizes?: string;
    mimeType?: string;
}>();

const attrs = useAttrs();

const decodedUrl = ref<string | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);

// Determine if the URL or mime type points to a HEIC/HEIF file
const isHeic = (url: string | null | undefined, mime: string | null | undefined): boolean => {
    if (mime && (mime.includes("heic") || mime.includes("heif") || mime.includes("image/heic") || mime.includes("image/heif"))) {
        return true;
    }
    if (!url) return false;
    const path = url.split("?")[0] || "";
    return /\.(heic|heif)$/i.test(path);
};

// Check if browser natively supports HEIC (Safari)
const supportsHeicNatively = (): boolean => {
    if (typeof window === "undefined") return false;
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
};

interface HeifImage {
    is_primary: () => boolean;
    get_width: () => number;
    get_height: () => number;
    display: (imageData: ImageData, callback: (displayData: ImageData | null) => void) => void;
    free: () => void;
}

interface HeifDecoder {
    decode: (buffer: ArrayBuffer) => HeifImage[];
    free: () => void;
}

interface LibheifModule {
    HeifDecoder: {
        new (): HeifDecoder;
    };
}

let libheifModuleInstance: LibheifModule | null = null;

const getLibheifModule = async (): Promise<LibheifModule> => {
    if (libheifModuleInstance) return libheifModuleInstance;
    const libheif = await import("libheif-js/wasm-bundle");
    const mod = (libheif.default || libheif) as any;

    // Workaround for a bug in libheif-js NPM package:
    // Its HeifImage.prototype.is_primary() calls the global function 'heif_image_handle_is_primary_image'
    // without prefixing it with the module instance 'a.', resulting in a ReferenceError.
    if (typeof window !== "undefined") {
        (window as any).heif_image_handle_is_primary_image =
            mod.heif_image_handle_is_primary_image || mod._heif_image_handle_is_primary_image;
    }

    libheifModuleInstance = mod as unknown as LibheifModule;
    return libheifModuleInstance;
};

// Decode function
const decodeHeic = async (url: string) => {
    if (decodedUrl.value) {
        URL.revokeObjectURL(decodedUrl.value);
        decodedUrl.value = null;
    }

    isLoading.value = true;
    error.value = null;

    try {
        // 1. Fetch the image file as ArrayBuffer
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
        const buffer = await res.arrayBuffer();

        // 2. Initialize WASM module
        const libheifModule = await getLibheifModule();

        // 3. Decode buffer
        const decoder = new libheifModule.HeifDecoder();
        let images: HeifImage[];
        try {
            images = decoder.decode(buffer);
        } finally {
            if (typeof (decoder as any).free === "function") {
                (decoder as any).free();
            }
        }

        if (!images || images.length === 0) {
            throw new Error("No images found in HEIC file");
        }

        const primaryImage = images.find((x) => x.is_primary()) || images[0];
        if (!primaryImage) {
            throw new Error("No primary image in HEIC file");
        }
        const width = primaryImage.get_width();
        const height = primaryImage.get_height();

        // 4. Create canvas to draw the image data
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Failed to get 2D context");

        const imageData = ctx.createImageData(width, height);

        // Convert the decoded image into raw pixel data
        await new Promise<void>((resolve, reject) => {
            primaryImage.display(imageData, (displayData) => {
                if (!displayData) {
                    reject(new Error("Failed to extract image display data"));
                    return;
                }
                ctx.putImageData(displayData, 0, 0);
                resolve();
            });
        });

        // Free primary image memory on the WASM heap
        primaryImage.free();

        // 5. Convert canvas contents to a Blob URL
        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92);
        });

        if (!blob) throw new Error("Failed to create blob from canvas");
        decodedUrl.value = URL.createObjectURL(blob);
    } catch (err: unknown) {
        console.error("HEIC decode error:", err);
        error.value = err instanceof Error ? err.message : "Decode failed";
    } finally {
        isLoading.value = false;
    }
};

watch(
    [() => props.src, () => props.mimeType],
    ([newSrc, newMime]) => {
        if (!import.meta.client) return; // Prevent any SSR decode attempt/fetch
        if (isHeic(newSrc, newMime) && !supportsHeicNatively()) {
            decodeHeic(newSrc);
        } else {
            // Standard image or native support, no decoding needed
            if (decodedUrl.value) {
                URL.revokeObjectURL(decodedUrl.value);
                decodedUrl.value = null;
            }
        }
    },
    { immediate: true },
);

onUnmounted(() => {
    if (decodedUrl.value) {
        URL.revokeObjectURL(decodedUrl.value);
    }
});
</script>

<template>
    <div v-if="isLoading" class="flex items-center justify-center w-full h-full min-h-[100px]">
        <slot name="loading">
            <div class="flex flex-col items-center gap-2 text-gray-400">
                <svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path
                        class="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                </svg>
                <span class="text-xs">Decoding HEIC...</span>
            </div>
        </slot>
    </div>
    <div
        v-else-if="error"
        class="flex flex-col items-center justify-center w-full h-full min-h-[100px] bg-red-50 text-red-500 p-4 border border-red-100 rounded-lg"
    >
        <slot name="error" :message="error">
            <span class="text-xs font-medium">{{ error }}</span>
        </slot>
    </div>
    <img
        v-else
        v-bind="attrs"
        :src="decodedUrl || props.src"
        :alt="props.alt"
        :srcset="decodedUrl ? undefined : props.srcset"
        :sizes="decodedUrl ? undefined : props.sizes"
    />
</template>
