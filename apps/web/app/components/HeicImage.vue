<script setup lang="ts">
import { ref, computed, watch, useAttrs } from "vue";
import { isHeic, supportsHeicNatively, decodeHeicToBlobUrl } from "@/utils/heic-decoder";

const props = defineProps<{
    src: string;
    alt?: string;
    srcset?: string;
    sizes?: string;
    mimeType?: string;
    noSpinner?: boolean;
}>();

const emit = defineEmits<{
    (e: "load", event: Event): void;
    (e: "error", error: unknown): void;
}>();

const attrs = useAttrs();

const decodedUrl = ref<string | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);
const nativeFailed = ref(false);

const displaySrc = computed(() => {
    if (decodedUrl.value) return decodedUrl.value;
    if (isHeic(props.src, props.mimeType) && !supportsHeicNatively()) {
        // While decoding in non-Safari, show transparent placeholder to prevent broken-image icon
        return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    }
    return props.src;
});

const performDecode = async (url: string) => {
    isLoading.value = true;
    error.value = null;

    try {
        const blobUrl = await decodeHeicToBlobUrl(url);
        decodedUrl.value = blobUrl;
    } catch (err: unknown) {
        console.error("HEIC WASM decode error:", err);
        error.value = err instanceof Error ? err.message : "Decode failed";
        emit("error", err);
    } finally {
        isLoading.value = false;
    }
};

watch(
    [() => props.src, () => props.mimeType],
    ([newSrc, newMime]) => {
        if (!import.meta.client) return; // Prevent SSR decode attempts
        nativeFailed.value = false;
        error.value = null;

        if (isHeic(newSrc, newMime)) {
            if (supportsHeicNatively()) {
                // Safari prefers native hardware-accelerated HEIC decoding
                decodedUrl.value = null;
                isLoading.value = false;
            } else {
                // Non-Safari browsers (Chrome, Edge, Firefox) decode via libheif-js WASM
                performDecode(newSrc);
            }
        } else {
            // Standard image format
            decodedUrl.value = null;
            isLoading.value = false;
        }
    },
    { immediate: true },
);

const handleImgLoad = (event: Event) => {
    if (displaySrc.value.startsWith("data:image/gif;base64")) return;
    emit("load", event);
};

const handleImgError = (event: Event) => {
    // If native Safari HEIC rendering fails (e.g. S3 missing image/heic content-type),
    // silently fallback to WASM libheif-js decoding
    if (isHeic(props.src, props.mimeType) && supportsHeicNatively() && !nativeFailed.value && !decodedUrl.value) {
        console.warn("Safari native HEIC rendering failed; silently falling back to libheif-js WASM:", props.src);
        nativeFailed.value = true;
        performDecode(props.src);
        return;
    }

    emit("error", event);
};
</script>

<template>
    <div v-if="isLoading && !props.noSpinner" class="flex items-center justify-center w-full h-full min-h-[100px]">
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
        v-else-if="error && !props.noSpinner"
        class="flex flex-col items-center justify-center w-full h-full min-h-[100px] bg-red-50 text-red-500 p-4 border border-red-100 rounded-lg"
    >
        <slot name="error" :message="error">
            <span class="text-xs font-medium">{{ error }}</span>
        </slot>
    </div>
    <img
        v-else
        v-bind="attrs"
        :src="displaySrc"
        :alt="props.alt"
        :srcset="decodedUrl ? undefined : props.srcset"
        :sizes="decodedUrl ? undefined : props.sizes"
        @load="handleImgLoad"
        @error="handleImgError"
    />
</template>
