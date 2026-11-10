<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { Music, FileText, FileImage, ShieldAlert } from "@lucide/vue";
import MediaVideoPlayer from "./MediaVideoPlayer.vue";
import LivePhotoPlayer from "./LivePhotoPlayer.vue";
import HeicImage from "./HeicImage.vue";
import { isHeic } from "@/utils/heic-decoder";
import { previewPosterUrl } from "@/utils/media";
import type { MediaViewerItem } from "@/types/post";

type MediaItem = MediaViewerItem;

const props = withDefaults(
    defineProps<{
        media: MediaItem | null;
        isLoading?: boolean;
        interactive?: boolean;
        hideBadge?: boolean;
        zoom?: number;
        rotation?: number;
        maxZoom?: number;
        autoplay?: boolean;
        /**
         * Static stand-in for a neighbouring item: its first frame only, with no player, quality upgrade or gestures.
         * Turning it off in place makes it the full viewer without repainting what it already shows.
         */
        preview?: boolean;
    }>(),
    {
        isLoading: false,
        interactive: false,
        hideBadge: false,
        zoom: 1,
        rotation: 0,
        maxZoom: 5,
        autoplay: true,
        preview: false,
    },
);

const emit = defineEmits<{
    (e: "click-media"): void;
    (e: "zoom-change", zoom: number): void;
    /** Rendered size of the fitted image relative to its natural pixels; null while unknown. */
    (e: "fit-scale-change", scale: number | null): void;
    (e: "play"): void;
    (e: "pause"): void;
}>();

// 1. Preview images
const defaultPosterUrl = computed(() => previewPosterUrl(props.media?.previews) ?? "");
/** The preview painted first under a full image: small enough to decode at once. */
const lowResPreviewUrl = computed(() => {
    const previews = props.media?.previews;
    return previews?.medium?.url ?? previews?.small?.url ?? previews?.large?.url ?? "";
});

// 2. LIVE PHOTO: the image is the main original, the motion is the video original it plays directly.
const livePhotoImageSrc = computed(() => {
    if (!props.media || props.media.type !== "LIVE_PHOTO") return "";
    return props.media.url || defaultPosterUrl.value;
});

const livePhotoVideoSrc = computed(() => {
    if (!props.media || props.media.type !== "LIVE_PHOTO") return "";
    return props.media.playback?.direct_url || "";
});

// 3. IMAGE
const imageSrcUrl = computed(() => {
    if (!props.media || props.media.type !== "IMAGE") return "";
    return props.media.url || defaultPosterUrl.value;
});

const contentAssetUrl = computed(() => props.media?.url || "");

/**
 * Progressive image layers: a low-res preview paints at once and higher-quality sources fade in above it.
 *
 * Each layer keeps one URL for its whole life, keyed by it, so the element showing an image never changes source and
 * never decodes it again (HEIC decodes in WASM outside Safari, and a full-size image takes a while to decode either
 * way). Once a layer has faded in, the layers under it are dropped; the layer itself stays as it is. The drop waits
 * for the fade's own transitionend, not a timer: a long main-thread task (a HEIC decode) can delay the start of the
 * fade, and a timer would then remove the layer below while the one above is still transparent.
 */
interface ImageLayer {
    url: string;
    loaded: boolean;
}
const LAYER_FADE_MS = 350;
const layers = ref<ImageLayer[]>([]);
/** The blurred backdrop keeps the preview: a full-size decode would only be blurred away. */
const backdropUrl = computed(() => lowResPreviewUrl.value || imageSrcUrl.value);
const showLoadingSpinner = ref(false);
let loadingTimer: ReturnType<typeof setTimeout> | null = null;

const clearLoadingTimer = () => {
    if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
    }
};

watch(
    // A preview that becomes the current item keeps its painted layer and starts the upgrade from there.
    () => [props.media?.id, imageSrcUrl.value, livePhotoImageSrc.value, lowResPreviewUrl.value, props.preview],
    (newValues, oldValues) => {
        const newId = newValues[0];
        const oldId = oldValues?.[0];
        clearLoadingTimer();

        const highResUrl = imageSrcUrl.value || livePhotoImageSrc.value || "";
        const baseLayerUrl = lowResPreviewUrl.value || highResUrl;

        if (!newId || !baseLayerUrl) {
            layers.value = [];
            showLoadingSpinner.value = false;
            return;
        }

        if (newId !== oldId || !layers.value.length) {
            // A different item: paint the preview at once and queue the full image above it.
            layers.value = [{ url: baseLayerUrl, loaded: false }];
            if (highResUrl && highResUrl !== baseLayerUrl && !props.preview) layers.value.push({ url: highResUrl, loaded: false });
        } else if (!props.preview && highResUrl && !layers.value.some((layer) => layer.url === highResUrl)) {
            // A quality upgrade or a new track URL for the same item: keep what is shown and fade the new source in.
            const shown = Math.max(
                0,
                layers.value.findLastIndex((layer) => layer.loaded),
            );
            layers.value = [...layers.value.slice(0, shown + 1), { url: highResUrl, loaded: false }];
        }

        showLoadingSpinner.value = false;
    },
    { immediate: true },
);

const handleLayerLoaded = async (layer: ImageLayer, event: Event) => {
    clearLoadingTimer();
    showLoadingSpinner.value = false;
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    // Fade in only once the bitmap is ready, so the fade never starts on an undecoded image.
    await image.decode().catch(() => {});
    const index = layers.value.indexOf(layer);
    if (index < 0) return;
    layer.loaded = true;
    // Below the top layer sits only a lower-quality source, whose size is not the image's.
    if (index === layers.value.length - 1) recordNaturalSize(image);
};

/** A layer has faded in over the ones below it, which it now covers for good. */
const handleLayerShown = (layer: ImageLayer, event: TransitionEvent) => {
    if (event.propertyName !== "opacity" || !layer.loaded) return;
    const index = layers.value.indexOf(layer);
    if (index > 0) layers.value = layers.value.slice(index);
};

const handleLayerError = (layer: ImageLayer) => {
    clearLoadingTimer();
    showLoadingSpinner.value = false;
    // Keep showing what loaded before; the base layer stays even if it failed, so the item is never left empty.
    const index = layers.value.indexOf(layer);
    if (index > 0) layers.value = layers.value.filter((item) => item !== layer);
};

// Fit scale: how large the contained (zoom = 1) image renders relative to its natural pixel size.
const imageContainerRef = ref<HTMLElement | null>(null);
const loadedNaturalSize = ref<{ width: number; height: number } | null>(null);
const containerSize = ref({ width: 0, height: 0 });

watch(
    () => props.media?.id,
    () => {
        loadedNaturalSize.value = null;
    },
);

useResizeObserver(imageContainerRef, ([entry]) => {
    if (!entry) return;
    containerSize.value = { width: entry.contentRect.width, height: entry.contentRect.height };
});

const fitScale = computed(() => {
    const media = props.media;
    if (!media || (media.type !== "IMAGE" && media.type !== "LIVE_PHOTO")) return null;
    const natural = media.width && media.height ? { width: media.width, height: media.height } : loadedNaturalSize.value;
    const { width, height } = containerSize.value;
    if (!natural || !width || !height) return null;
    return Math.min(width / natural.width, height / natural.height);
});

// A preview that becomes the current item reports its scale then.
watch(
    [fitScale, () => props.preview],
    ([scale, preview]) => {
        if (!preview) emit("fit-scale-change", scale);
    },
    { immediate: true },
);

const recordNaturalSize = (image: HTMLImageElement) => {
    if (image.naturalWidth && image.naturalHeight) {
        loadedNaturalSize.value = { width: image.naturalWidth, height: image.naturalHeight };
    }
};

onUnmounted(clearLoadingTimer);

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

// Unified Pointer Gesture Controller (Mouse + Touch + Pen)

const activePointers = new Map<number, { x: number; y: number }>();
let pointerDownTime = 0;
let pointerDownX = 0;
let pointerDownY = 0;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
let singleTapTimeout: ReturnType<typeof setTimeout> | null = null;

let initialPinchDistance = 0;
let initialPinchZoom = 1;
let isPinching = false;

const viewerCursorClass = computed(() => {
    if (!props.interactive) return "";
    if (props.zoom > 1) {
        return isDragging.value ? "cursor-grabbing" : "cursor-grab";
    }
    return "cursor-pointer";
});

const handlePointerDown = (e: PointerEvent) => {
    if (!props.interactive) return;
    if (e.pointerType === "mouse" && e.button !== 0) return; // Left click only

    const target = e.currentTarget as HTMLElement;
    try {
        target.setPointerCapture(e.pointerId);
    } catch {}

    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
        pointerDownTime = performance.now();
        pointerDownX = e.clientX;
        pointerDownY = e.clientY;
        startX = e.clientX;
        startY = e.clientY;
        initialTranslateX = translateX.value;
        initialTranslateY = translateY.value;
        draggedDistance.value = 0;
        isDragging.value = props.zoom > 1;
        isPinching = false;
    } else if (activePointers.size === 2) {
        // Two fingers down: pinch-to-zoom
        isPinching = true;
        isDragging.value = false;
        if (singleTapTimeout) {
            clearTimeout(singleTapTimeout);
            singleTapTimeout = null;
        }
        const pts = Array.from(activePointers.values());
        if (pts[0] && pts[1]) {
            initialPinchDistance = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            initialPinchZoom = props.zoom;
        }
    }
};

const handlePointerMove = (e: PointerEvent) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (isPinching && activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        if (pts[0] && pts[1]) {
            const currentDistance = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            if (initialPinchDistance > 10) {
                const scaleFactor = currentDistance / initialPinchDistance;
                let nextZoom = Math.min(props.maxZoom, Math.max(0.1, initialPinchZoom * scaleFactor));
                emit("zoom-change", parseFloat(nextZoom.toFixed(2)));
            }
        }
        return;
    }

    if (activePointers.size === 1) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        draggedDistance.value = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);

        if (props.zoom > 1 && isDragging.value) {
            // Adjust dx and dy based on rotation angle to keep pan direction aligned with screen
            const angleRad = (props.rotation * Math.PI) / 180;
            const cos = Math.cos(-angleRad);
            const sin = Math.sin(-angleRad);

            const adjustedDx = dx * cos - dy * sin;
            const adjustedDy = dx * sin + dy * cos;

            translateX.value = initialTranslateX + adjustedDx;
            translateY.value = initialTranslateY + adjustedDy;
        }
    }
};

const handleDoubleTap = (clientX: number, clientY: number) => {
    if (!props.interactive) return;
    const nextZoom = props.zoom > 1 ? 1 : 2;

    if (nextZoom > 1) {
        const el = imageContainerRef.value;
        if (el) {
            const rect = el.getBoundingClientRect();
            const mx = clientX - rect.left;
            const my = clientY - rect.top;
            const cx = rect.width / 2;
            const cy = rect.height / 2;
            const rx = mx - cx;
            const ry = my - cy;

            isInternalZoom = true;
            translateX.value = rx - (rx - translateX.value) * (nextZoom / props.zoom);
            translateY.value = ry - (ry - translateY.value) * (nextZoom / props.zoom);
        }
    }

    emit("zoom-change", nextZoom);
};

const handlePointerUp = (e: PointerEvent) => {
    if (!activePointers.has(e.pointerId)) return;

    const wasPinching = isPinching;
    activePointers.delete(e.pointerId);
    // After the delete, so the lostpointercapture this fires is a no-op.
    try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    if (activePointers.size === 0) {
        isDragging.value = false;
        isPinching = false;

        const elapsedTime = performance.now() - pointerDownTime;
        const isCleanTap = !wasPinching && draggedDistance.value < 10 && elapsedTime < 350;

        if (isCleanTap) {
            const now = performance.now();
            const timeSinceLastTap = now - lastTapTime;
            const distFromLastTap = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY);

            if (timeSinceLastTap < 300 && distFromLastTap < 30) {
                // Double Tap / Double Click detected
                if (singleTapTimeout) {
                    clearTimeout(singleTapTimeout);
                    singleTapTimeout = null;
                }
                lastTapTime = 0;
                handleDoubleTap(e.clientX, e.clientY);
                return;
            }

            lastTapTime = now;
            lastTapX = e.clientX;
            lastTapY = e.clientY;

            if (singleTapTimeout) clearTimeout(singleTapTimeout);
            singleTapTimeout = setTimeout(() => {
                singleTapTimeout = null;
                if (props.interactive) {
                    emit("click-media");
                }
            }, 250);
        }
    }
};

// Also bound to lostpointercapture: when the stage claims a swipe, the release never reaches this element.
const handlePointerCancel = (e: PointerEvent) => {
    if (!activePointers.delete(e.pointerId)) return;
    if (activePointers.size === 0) {
        isDragging.value = false;
        isPinching = false;
        if (singleTapTimeout) {
            clearTimeout(singleTapTimeout);
            singleTapTimeout = null;
        }
    }
};

// macOS trackpad pinch gesture zoom & two-finger scroll pan
const handleWheel = (e: WheelEvent) => {
    if (!props.interactive) return;

    if (e.ctrlKey) {
        e.preventDefault();
        const zoomFactor = 1 - e.deltaY * 0.01;
        let nextZoom = props.zoom * zoomFactor;
        nextZoom = Math.min(props.maxZoom, Math.max(0.1, nextZoom));

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

onUnmounted(() => {
    if (singleTapTimeout) {
        clearTimeout(singleTapTimeout);
        singleTapTimeout = null;
    }
});
</script>

<template>
    <div class="relative flex h-full w-full items-center justify-center bg-black select-none" :class="viewerCursorClass">
        <!-- Floating Glassmorphism Loading Indicator (Only shown after 200ms delay for slow loads when no image is visible) -->
        <div
            v-if="(isLoading && !layers.length) || showLoadingSpinner"
            class="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-xs z-30 pointer-events-none transition-opacity duration-300"
        >
            <div class="flex items-center gap-2.5 px-4 py-2 rounded-full bg-zinc-950/85 border border-white/15 shadow-2xl backdrop-blur-xl">
                <div class="w-4 h-4 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin shrink-0"></div>
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
            <!-- 1. VIDEO -->
            <template v-if="media.type === 'VIDEO'">
                <div class="w-full h-full max-w-full max-h-full flex items-center justify-center p-0">
                    <!-- Until its playback arrives (a seeded list item) a video shows its poster -->
                    <img
                        v-if="preview || (!media.playback && defaultPosterUrl)"
                        :src="defaultPosterUrl || undefined"
                        class="h-full w-full object-contain select-none pointer-events-none"
                        draggable="false"
                        alt=""
                    />
                    <MediaVideoPlayer
                        v-else-if="media.playback"
                        :poster="defaultPosterUrl"
                        :playback="media.playback"
                        :width="media.width ?? undefined"
                        :height="media.height ?? undefined"
                        :autoplay="props.autoplay"
                        @play="emit('play')"
                        @pause="emit('pause')"
                        class="w-full h-full"
                    />
                    <div v-else class="text-zinc-500 flex flex-col items-center gap-2">
                        <ShieldAlert class="w-10 h-10 text-red-500" />
                        <p class="text-xs">{{ $t("post_detail.viewer.video_missing") }}</p>
                    </div>
                </div>
            </template>

            <!-- 2. LIVE PHOTO -->
            <template v-else-if="media.type === 'LIVE_PHOTO'">
                <div
                    ref="imageContainerRef"
                    class="w-full h-full flex items-center justify-center relative overflow-hidden touch-none"
                    @pointerdown="handlePointerDown"
                    @pointermove="handlePointerMove"
                    @pointerup="handlePointerUp"
                    @pointercancel="handlePointerCancel"
                    @lostpointercapture="handlePointerCancel"
                    @wheel="handleWheel"
                >
                    <!-- Ambient Blur Backdrop -->
                    <template v-if="defaultPosterUrl || livePhotoImageSrc">
                        <HeicImage
                            v-if="isHeic(defaultPosterUrl || livePhotoImageSrc)"
                            :src="(defaultPosterUrl || livePhotoImageSrc)!"
                            no-spinner
                            class="absolute inset-0 w-full h-full object-cover filter blur-3xl opacity-25 scale-110 pointer-events-none select-none"
                            aria-hidden="true"
                        />
                        <img
                            v-else
                            :src="(defaultPosterUrl || livePhotoImageSrc)!"
                            class="absolute inset-0 w-full h-full object-cover filter blur-3xl opacity-25 scale-110 pointer-events-none select-none"
                            aria-hidden="true"
                        />
                    </template>
                    <LivePhotoPlayer
                        :src="livePhotoImageSrc || defaultPosterUrl"
                        :placeholder="defaultPosterUrl"
                        :live-src="preview ? '' : livePhotoVideoSrc"
                        :hide-badge="props.hideBadge"
                        badge-position="top-left-below-header"
                        :width="media.width ?? undefined"
                        :height="media.height ?? undefined"
                        class="relative z-10 w-full h-full max-w-full max-h-full object-contain"
                        :style="{
                            transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                            transformOrigin: 'center center',
                            transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                        }"
                    />
                </div>
            </template>

            <!-- 3. IMAGE -->
            <template v-else-if="media.type === 'IMAGE'">
                <div
                    ref="imageContainerRef"
                    class="w-full h-full flex items-center justify-center relative overflow-hidden touch-none"
                    @pointerdown="handlePointerDown"
                    @pointermove="handlePointerMove"
                    @pointerup="handlePointerUp"
                    @pointercancel="handlePointerCancel"
                    @lostpointercapture="handlePointerCancel"
                    @wheel="handleWheel"
                >
                    <!-- Ambient Blur Backdrop -->
                    <HeicImage
                        v-if="backdropUrl"
                        :src="backdropUrl"
                        no-spinner
                        class="absolute inset-0 w-full h-full object-cover filter blur-3xl opacity-25 scale-110 pointer-events-none select-none"
                        aria-hidden="true"
                    />
                    <!-- Image layers, lowest quality first; HeicImage passes other formats straight to <img> -->
                    <HeicImage
                        v-for="(layer, index) in layers"
                        :key="layer.url"
                        :src="layer.url"
                        no-spinner
                        :alt="index === 0 ? media.title || $t('post_detail.viewer.preview') : ''"
                        :aria-hidden="index > 0 || undefined"
                        class="absolute inset-0 z-10 w-full h-full object-contain select-none pointer-events-none"
                        :class="index === 0 || layer.loaded ? 'opacity-100' : 'opacity-0'"
                        :style="{
                            transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                            transformOrigin: 'center center',
                            transition: isDragging ? 'none' : `transform 0.15s ease-out, opacity ${LAYER_FADE_MS}ms ease-out`,
                        }"
                        @load="handleLayerLoaded(layer, $event)"
                        @transitionend="handleLayerShown(layer, $event)"
                        @error="handleLayerError(layer)"
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
                        <p class="mt-0.5 text-xs uppercase tracking-wider text-zinc-500">{{ $t("post_detail.viewer.audio_asset") }}</p>
                    </div>
                    <audio v-if="contentAssetUrl" :src="contentAssetUrl" controls class="w-full mt-2 accent-indigo-600 outline-none" />
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
                        <p class="mt-0.5 text-xs uppercase tracking-wider text-zinc-500">{{ $t("post_detail.viewer.pdf_document") }}</p>
                    </div>
                    <a
                        v-if="contentAssetUrl"
                        :href="contentAssetUrl"
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
