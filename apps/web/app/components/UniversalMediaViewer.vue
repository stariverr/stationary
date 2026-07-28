<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { Music, FileText, FileImage, ShieldAlert } from "@lucide/vue";
import VideoPlayer from "./VideoPlayer.vue";
import LivePhotoPlayer from "./LivePhotoPlayer.vue";

interface Subtitle {
    url: string;
    language: string;
    label: string;
    format: string;
}

interface MediaItem {
    id: string;
    type: "IMAGE" | "VIDEO" | "LIVE_PHOTO" | "AUDIO" | "PDF";
    title?: string | null;
    url?: string | null;
    cover_url?: string | null;
    thumbnail_url?: string | null;
    preview_url?: string | null;
    live_url?: string | null;
    tracks?: Array<{
        id?: string;
        url: string;
        type: string;
        purpose: string;
        is_default?: boolean;
        metadata?: Record<string, any>;
    }>;
    width?: number;
    height?: number;
    subtitles?: Subtitle[];
}

const props = withDefaults(
    defineProps<{
        media: MediaItem | null;
        isLoading?: boolean;
        interactive?: boolean;
        hideBadge?: boolean;
        zoom?: number;
        rotation?: number;
    }>(),
    {
        isLoading: false,
        interactive: false,
        hideBadge: false,
        zoom: 1,
        rotation: 0,
    },
);

const emit = defineEmits<{
    (e: "click-media"): void;
    (e: "zoom-change", zoom: number): void;
}>();

const absolutePreviewUrl = computed(() => {
    if (!props.media) return "";
    if (props.media.url) return props.media.url;
    if (props.media.preview_url) return props.media.preview_url;
    const imageContentTrack =
        props.media.tracks?.find((t) => t.type === "IMAGE" && t.purpose === "CONTENT" && t.is_default) ||
        props.media.tracks?.find((t) => t.type === "IMAGE" && t.purpose === "CONTENT");
    if (imageContentTrack?.url) return imageContentTrack.url;
    return props.media.cover_url || props.media.thumbnail_url || "";
});

const absoluteLiveUrl = computed(() => {
    if (!props.media) return "";
    if (props.media.live_url) return props.media.live_url;
    const liveVideoTrack = props.media.tracks?.find((t) => t.type === "VIDEO" && t.purpose === "CONTENT");
    if (liveVideoTrack?.url) return liveVideoTrack.url;
    return "";
});

const absoluteThumbnailUrl = computed(() => {
    if (!props.media) return "";
    if (props.media.cover_url) return props.media.cover_url;
    if (props.media.thumbnail_url) return props.media.thumbnail_url;
    const coverTrack = props.media.tracks?.find((t) => t.purpose === "COVER");
    if (coverTrack?.url) return coverTrack.url;
    return absolutePreviewUrl.value;
});

// Image Loading State (with 200ms delay to prevent flicker on fast loads)
const isImageLoading = ref(false);
const showLoadingSpinner = ref(false);
let loadingTimer: ReturnType<typeof setTimeout> | null = null;

const clearLoadingTimer = () => {
    if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
    }
};

watch(
    () => [props.media?.id, absolutePreviewUrl.value, absoluteThumbnailUrl.value],
    ([newId, newPreview, newThumb]) => {
        clearLoadingTimer();
        if (
            newId &&
            (newPreview || newThumb) &&
            (props.media?.type === "IMAGE" || props.media?.type === "VIDEO" || props.media?.type === "LIVE_PHOTO")
        ) {
            isImageLoading.value = true;
            loadingTimer = setTimeout(() => {
                if (isImageLoading.value) {
                    showLoadingSpinner.value = true;
                }
            }, 200);
        } else {
            isImageLoading.value = false;
            showLoadingSpinner.value = false;
        }
    },
    { immediate: true },
);

const handleImageLoaded = () => {
    clearLoadingTimer();
    isImageLoading.value = false;
    showLoadingSpinner.value = false;
};

const handleImageError = () => {
    clearLoadingTimer();
    isImageLoading.value = false;
    showLoadingSpinner.value = false;
};

onUnmounted(() => {
    clearLoadingTimer();
});

// Panning State
const translateX = ref(0);
const translateY = ref(0);
const isDragging = ref(false);
const draggedDistance = ref(0);

let startX = 0;
let startY = 0;
let initialTranslateX = 0;
let initialTranslateY = 0;

let isInternalZoom = false;

// Reset offsets when zoom is reset
watch(
    () => props.zoom,
    (newZoom, oldZoom) => {
        if (newZoom <= 1) {
            translateX.value = 0;
            translateY.value = 0;
            isInternalZoom = false;
            return;
        }

        if (isInternalZoom) {
            isInternalZoom = false;
            return;
        }

        if (oldZoom && oldZoom > 1) {
            // Zoom modified from outside (e.g., toolbar range slider) - scale from center
            translateX.value = translateX.value * (newZoom / oldZoom);
            translateY.value = translateY.value * (newZoom / oldZoom);
        }
    },
);

// Drag to Pan Handlers
const handlePointerDown = (e: PointerEvent) => {
    if (!props.interactive || props.zoom <= 1) return;
    if (e.button !== 0) return; // Left click only

    isDragging.value = true;
    startX = e.clientX;
    startY = e.clientY;
    initialTranslateX = translateX.value;
    initialTranslateY = translateY.value;
    draggedDistance.value = 0;

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    e.preventDefault();
};

const handlePointerMove = (e: PointerEvent) => {
    if (!isDragging.value) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    draggedDistance.value = Math.sqrt(dx * dx + dy * dy);

    // Adjust dx and dy based on rotation angle to keep pan direction aligned with screen
    const angleRad = (props.rotation * Math.PI) / 180;
    const cos = Math.cos(-angleRad);
    const sin = Math.sin(-angleRad);

    const adjustedDx = dx * cos - dy * sin;
    const adjustedDy = dx * sin + dy * cos;

    translateX.value = initialTranslateX + adjustedDx;
    translateY.value = initialTranslateY + adjustedDy;
};

const handlePointerUp = (e: PointerEvent) => {
    if (!isDragging.value) return;
    isDragging.value = false;
    const target = e.currentTarget as HTMLElement;
    try {
        target.releasePointerCapture(e.pointerId);
    } catch (err) {
        // ignore
    }
};

// macOS trackpad pinch gesture zoom & two-finger scroll pan
const handleWheel = (e: WheelEvent) => {
    if (!props.interactive) return;

    if (e.ctrlKey) {
        e.preventDefault();
        const zoomFactor = 1 - e.deltaY * 0.01;
        let nextZoom = props.zoom * zoomFactor;
        nextZoom = Math.min(5, Math.max(0.1, nextZoom));

        // Zoom towards mouse pointer location
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const rx = mx - cx;
        const ry = my - cy;

        isInternalZoom = true;
        translateX.value = rx - (rx - translateX.value) * (nextZoom / props.zoom);
        translateY.value = ry - (ry - translateY.value) * (nextZoom / props.zoom);

        emit("zoom-change", parseFloat(nextZoom.toFixed(2)));
    } else if (props.zoom > 1) {
        // Two-finger trackpad panning when zoomed in
        e.preventDefault();

        const dx = -e.deltaX;
        const dy = -e.deltaY;

        // Adjust deltas for rotation angle to keep panning relative to screen coordinates
        const angleRad = (props.rotation * Math.PI) / 180;
        const cos = Math.cos(-angleRad);
        const sin = Math.sin(-angleRad);

        const adjustedDx = dx * cos - dy * sin;
        const adjustedDy = dx * sin + dy * cos;

        translateX.value += adjustedDx;
        translateY.value += adjustedDy;
    }
};

// Double click to toggle zoom
const handleDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!props.interactive) return;
    e.preventDefault();

    const nextZoom = props.zoom > 1 ? 1 : 2;

    if (nextZoom > 1) {
        // Zoom towards double click point
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const rx = mx - cx;
        const ry = my - cy;

        isInternalZoom = true;
        translateX.value = rx - (rx - translateX.value) * (nextZoom / props.zoom);
        translateY.value = ry - (ry - translateY.value) * (nextZoom / props.zoom);
    }

    emit("zoom-change", nextZoom);
};

// Handle clicks and prevent detail panel toggle during panning
const handleImageClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (props.zoom > 1) {
        // Zoomed in: ignore click if dragged, otherwise do nothing
        return;
    }
    emit("click-media");
};
</script>

<template>
    <div
        class="relative flex h-full w-full items-center justify-center bg-black select-none"
        :class="{ 'cursor-zoom-in': props.interactive }"
        @click="props.interactive && emit('click-media')"
    >
        <!-- Floating Glassmorphism Loading Indicator (Only shown after 200ms delay for slow loads) -->
        <div
            v-if="isLoading || showLoadingSpinner"
            class="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-xs z-30 pointer-events-none transition-opacity duration-300"
        >
            <div class="flex items-center gap-2.5 px-4 py-2 rounded-full bg-zinc-950/85 border border-white/15 shadow-2xl backdrop-blur-xl">
                <div class="w-4 h-4 rounded-full border-2 border-emerald-400/30 border-t-emerald-400 animate-spin shrink-0"></div>
                <span class="text-xs font-semibold text-white/90">{{ $t("post_detail.viewer.loading") }}</span>
            </div>
        </div>

        <!-- No Media Selected / Empty State -->
        <div v-if="!media" class="text-zinc-500 flex flex-col items-center gap-2 p-8">
            <FileImage class="w-12 h-12 text-zinc-700" />
            <p class="text-sm font-medium">{{ $t("post_detail.viewer.empty") }}</p>
        </div>

        <!-- Content Players (Rendered whenever media exists so <img> tags mount & trigger @load) -->
        <div v-else :key="media.id" class="w-full h-full flex items-center justify-center overflow-hidden">
            <!-- 1. VIDEO (Cover Only) -->
            <template v-if="media.type === 'VIDEO'">
                <div
                    class="w-full h-full flex items-center justify-center relative overflow-hidden touch-none"
                    @pointerdown="handlePointerDown"
                    @pointermove="handlePointerMove"
                    @pointerup="handlePointerUp"
                    @pointercancel="handlePointerUp"
                    @wheel="handleWheel"
                    @dblclick="handleDoubleClick"
                    @click="handleImageClick"
                >
                    <!-- Ambient Blur Backdrop -->
                    <img
                        v-if="absoluteThumbnailUrl || absolutePreviewUrl"
                        :src="absoluteThumbnailUrl || absolutePreviewUrl"
                        class="absolute inset-0 w-full h-full object-cover filter blur-3xl opacity-25 scale-110 pointer-events-none select-none"
                        aria-hidden="true"
                    />
                    <img
                        v-if="absoluteThumbnailUrl || absolutePreviewUrl"
                        :src="absoluteThumbnailUrl || absolutePreviewUrl"
                        :alt="media.title || $t('post_detail.viewer.preview')"
                        class="relative z-10 max-w-full max-h-full object-contain shadow-2xl select-none pointer-events-none"
                        :style="{
                            transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                            transformOrigin: 'center center',
                            transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                        }"
                        @load="handleImageLoaded"
                        @error="handleImageError"
                        draggable="false"
                    />
                    <div v-else class="text-zinc-500 flex flex-col items-center gap-2">
                        <FileImage class="w-10 h-10 text-zinc-600" />
                        <p class="text-xs">{{ $t("post_detail.viewer.empty") }}</p>
                    </div>
                </div>
            </template>

            <!-- 2. LIVE PHOTO -->
            <template v-else-if="media.type === 'LIVE_PHOTO'">
                <div
                    class="w-full h-full flex items-center justify-center relative overflow-hidden touch-none"
                    @pointerdown="handlePointerDown"
                    @pointermove="handlePointerMove"
                    @pointerup="handlePointerUp"
                    @pointercancel="handlePointerUp"
                    @wheel="handleWheel"
                    @dblclick="handleDoubleClick"
                    @click="handleImageClick"
                >
                    <!-- Ambient Blur Backdrop -->
                    <img
                        v-if="absoluteThumbnailUrl || absolutePreviewUrl"
                        :src="absoluteThumbnailUrl || absolutePreviewUrl"
                        class="absolute inset-0 w-full h-full object-cover filter blur-3xl opacity-25 scale-110 pointer-events-none select-none"
                        aria-hidden="true"
                    />
                    <LivePhotoPlayer
                        :src="absolutePreviewUrl || absoluteThumbnailUrl"
                        :live-src="absoluteLiveUrl"
                        :hide-badge="props.hideBadge"
                        class="relative z-10 max-w-full max-h-full object-contain shadow-2xl"
                        :style="{
                            transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                            transformOrigin: 'center center',
                            transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                        }"
                        @load="handleImageLoaded"
                        @error="handleImageError"
                    />
                </div>
            </template>

            <!-- 3. IMAGE -->
            <template v-else-if="media.type === 'IMAGE'">
                <div
                    class="w-full h-full flex items-center justify-center relative overflow-hidden touch-none"
                    @pointerdown="handlePointerDown"
                    @pointermove="handlePointerMove"
                    @pointerup="handlePointerUp"
                    @pointercancel="handlePointerUp"
                    @wheel="handleWheel"
                    @dblclick="handleDoubleClick"
                    @click="handleImageClick"
                >
                    <!-- Ambient Blur Backdrop -->
                    <img
                        v-if="absolutePreviewUrl || absoluteThumbnailUrl"
                        :src="absolutePreviewUrl || absoluteThumbnailUrl"
                        class="absolute inset-0 w-full h-full object-cover filter blur-3xl opacity-25 scale-110 pointer-events-none select-none"
                        aria-hidden="true"
                    />
                    <img
                        :src="absolutePreviewUrl || absoluteThumbnailUrl"
                        :alt="media.title || $t('post_detail.viewer.preview')"
                        class="relative z-10 max-w-full max-h-full object-contain shadow-2xl select-none pointer-events-none"
                        :style="{
                            transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                            transformOrigin: 'center center',
                            transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                        }"
                        @load="handleImageLoaded"
                        @error="handleImageError"
                        draggable="false"
                    />
                </div>
            </template>

            <!-- 4. AUDIO -->
            <template v-else-if="media.type === 'AUDIO'">
                <div
                    class="flex flex-col items-center justify-center p-8 bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md gap-4 shadow-2xl mx-4"
                >
                    <div class="w-16 h-16 rounded-full bg-indigo-950 flex items-center justify-center text-indigo-400">
                        <Music class="w-8 h-8" />
                    </div>
                    <div class="text-center">
                        <h3 class="max-w-xs truncate text-sm font-semibold text-white">
                            {{ media.title || $t("post_detail.viewer.untitled_audio") }}
                        </h3>
                        <p class="mt-0.5 text-[10px] uppercase tracking-wider text-zinc-500">{{ $t("post_detail.viewer.audio_asset") }}</p>
                    </div>
                    <audio
                        v-if="absolutePreviewUrl"
                        :src="absolutePreviewUrl"
                        controls
                        class="w-full mt-2 accent-indigo-600 outline-none"
                    />
                </div>
            </template>

            <!-- 5. PDF -->
            <template v-else-if="media.type === 'PDF'">
                <div
                    class="flex flex-col items-center justify-center p-8 bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md gap-4 shadow-2xl mx-4"
                >
                    <div class="w-16 h-16 rounded-full bg-red-950 flex items-center justify-center text-red-400">
                        <FileText class="w-8 h-8" />
                    </div>
                    <div class="text-center">
                        <h3 class="max-w-xs truncate text-sm font-semibold text-white">
                            {{ media.title || $t("post_detail.viewer.untitled_pdf") }}
                        </h3>
                        <p class="mt-0.5 text-[10px] uppercase tracking-wider text-zinc-500">{{ $t("post_detail.viewer.pdf_document") }}</p>
                    </div>
                    <a
                        v-if="absolutePreviewUrl"
                        :href="absolutePreviewUrl"
                        target="_blank"
                        class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 transition-colors text-white font-medium text-xs rounded-lg shadow-sm"
                    >
                        {{ $t("post_detail.viewer.open_pdf") }}
                    </a>
                </div>
            </template>
        </div>
    </div>
</template>
