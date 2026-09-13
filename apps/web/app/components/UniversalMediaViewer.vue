<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { Music, FileText, FileImage, ShieldAlert } from "@lucide/vue";
import VideoPlayer from "./VideoPlayer.vue";
import LivePhotoPlayer from "./LivePhotoPlayer.vue";
import HeicImage from "./HeicImage.vue";
import { isHeic } from "@/utils/heic-decoder";
import type { MediaViewerItem, MediaViewerTrack } from "@/types/post";

type MediaTrack = MediaViewerTrack;
type MediaItem = MediaViewerItem;

const props = withDefaults(
    defineProps<{
        media: MediaItem | null;
        isLoading?: boolean;
        interactive?: boolean;
        hideBadge?: boolean;
        zoom?: number;
        rotation?: number;
        autoplay?: boolean;
        hideTopControls?: boolean;
    }>(),
    {
        isLoading: false,
        interactive: false,
        hideBadge: false,
        zoom: 1,
        rotation: 0,
        autoplay: true,
        hideTopControls: false,
    },
);

const emit = defineEmits<{
    (e: "click-media"): void;
    (e: "zoom-change", zoom: number): void;
    (e: "controls-change", visible: boolean): void;
    (e: "user-activity"): void;
    (e: "play"): void;
    (e: "pause"): void;
}>();

const qualityOrder: Record<string, number> = {
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
};

function sortTracks<T extends { priority?: number; quality?: string }>(tracks: T[]): T[] {
    return [...tracks].sort((a, b) => {
        const priorityA = a.priority ?? 999;
        const priorityB = b.priority ?? 999;
        if (priorityA !== priorityB) return priorityA - priorityB;
        const qualA = qualityOrder[a.quality || ""] || 0;
        const qualB = qualityOrder[b.quality || ""] || 0;
        return qualB - qualA;
    });
}

function selectContentTrack(tracks: MediaTrack[] | undefined, type: string): MediaTrack | undefined {
    const candidates = sortTracks(
        (tracks || []).filter((track) => track.type.toUpperCase() === type && track.purpose.toUpperCase() !== "COVER"),
    );
    return (
        candidates.find((track) => track.is_default) ||
        candidates.find((track) => track.purpose.toUpperCase() === "CONTENT") ||
        candidates[0]
    );
}

// 1. Cover / Poster Track
const defaultPosterUrl = computed(() => {
    if (!props.media) return "";
    if (props.media.cover_url) return props.media.cover_url;
    if ((props.media as any).poster) return (props.media as any).poster;
    if ((props.media as any).thumbnail) return (props.media as any).thumbnail;

    const coverTracks = (props.media.tracks || []).filter((track) => track.purpose.toUpperCase() === "COVER");
    const sorted = sortTracks(coverTracks);
    return sorted[0]?.url || "";
});

// 2. VIDEO
const defaultVideoSrc = computed(() => {
    if (!props.media || props.media.type !== "VIDEO") return "";
    if (props.media.url) return props.media.url;
    return selectContentTrack(props.media.tracks, "VIDEO")?.url || "";
});

// 3. LIVE PHOTO
const livePhotoImageSrc = computed(() => {
    if (!props.media || props.media.type !== "LIVE_PHOTO") return "";
    const bestImage = selectContentTrack(props.media.tracks, "IMAGE");
    if (bestImage?.url) return bestImage.url;
    if (props.media.url) return props.media.url;
    return defaultPosterUrl.value;
});

const livePhotoVideoSrc = computed(() => {
    if (!props.media || props.media.type !== "LIVE_PHOTO") return "";
    if (props.media.live_url) return props.media.live_url;
    return selectContentTrack(props.media.tracks, "VIDEO")?.url || "";
});

// 4. IMAGE
const imageSrcUrl = computed(() => {
    if (!props.media || props.media.type !== "IMAGE") return "";
    const bestImage = selectContentTrack(props.media.tracks, "IMAGE");
    if (bestImage?.url) return bestImage.url;
    if (props.media.url) return props.media.url;
    return defaultPosterUrl.value;
});

const contentAssetUrl = computed(() => {
    if (!props.media) return "";
    if (props.media.url) return props.media.url;
    return selectContentTrack(props.media.tracks, props.media.type)?.url || "";
});

/**
 * Persistent 2-Layer Image Quality Cross-Fade Architecture (LQIP / Progressive Loading Best Practice)
 *
 * 1. Base Layer (activeSrcUrl): Always rendered 100% visible (opacity-100) and mounted in DOM.
 *    It NEVER unmounts, resets to opacity-0, or flushes its bitmap when higher-resolution sources arrive.
 * 2. Upgrade Layer (pendingSrcUrl): Preloads incoming high-res image (1440p/4K) in the background
 *    at opacity-0. When native @load event fires, it smoothly cross-fades into view via CSS
 *    transition-opacity duration-350 ease-out over the base layer with ZERO black/blank frames.
 */
const activeSrcUrl = ref<string>("");
const pendingSrcUrl = ref<string>("");
const isPendingLoaded = ref<boolean>(false);
const isCurrentHeic = computed(() => {
    return isHeic(activeSrcUrl.value) || isHeic(pendingSrcUrl.value) || isHeic(props.media?.url);
});
const showLoadingSpinner = ref(false);
let loadingTimer: ReturnType<typeof setTimeout> | null = null;
let fadeTimeout: ReturnType<typeof setTimeout> | null = null;

const clearLoadingTimer = () => {
    if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
    }
};

watch(
    () => [props.media?.id, imageSrcUrl.value, livePhotoImageSrc.value, defaultPosterUrl.value],
    (newValues, oldValues) => {
        const newId = newValues[0];
        const oldId = oldValues?.[0];
        clearLoadingTimer();
        if (fadeTimeout) {
            clearTimeout(fadeTimeout);
            fadeTimeout = null;
        }

        const lowResCoverUrl =
            defaultPosterUrl.value ||
            (props.media as any)?.poster ||
            (props.media as any)?.thumbnail ||
            (props.media as any)?.cover_url ||
            "";
        const highResUrl = imageSrcUrl.value || livePhotoImageSrc.value || "";

        const baseLayerUrl = lowResCoverUrl || highResUrl;

        if (!newId || !baseLayerUrl) {
            activeSrcUrl.value = "";
            pendingSrcUrl.value = "";
            isPendingLoaded.value = false;
            showLoadingSpinner.value = false;
            return;
        }

        if (newId !== oldId || !activeSrcUrl.value) {
            // Switched to a different media item or re-entering:
            // ALWAYS initialize base layer with lowResCoverUrl for instant 0ms painting!
            activeSrcUrl.value = baseLayerUrl;

            // If highResUrl is present and different from baseLayerUrl, queue highResUrl in pending layer for background loading
            if (highResUrl && highResUrl !== baseLayerUrl) {
                pendingSrcUrl.value = highResUrl;
                isPendingLoaded.value = false;
            } else {
                pendingSrcUrl.value = "";
                isPendingLoaded.value = false;
            }
        } else if (highResUrl && activeSrcUrl.value !== highResUrl && pendingSrcUrl.value !== highResUrl) {
            // Quality upgrade or track URL change while staying on same media
            pendingSrcUrl.value = highResUrl;
            isPendingLoaded.value = false;
        }

        if (newId && (props.media?.type === "IMAGE" || props.media?.type === "LIVE_PHOTO")) {
            if (!activeSrcUrl.value) {
                loadingTimer = setTimeout(() => {
                    if (!activeSrcUrl.value) {
                        showLoadingSpinner.value = true;
                    }
                }, 200);
            } else {
                clearLoadingTimer();
                showLoadingSpinner.value = false;
            }
        } else {
            clearLoadingTimer();
            showLoadingSpinner.value = false;
        }
    },
    { immediate: true },
);

const handleBaseLoaded = () => {
    clearLoadingTimer();
    showLoadingSpinner.value = false;
};

const handleBaseError = () => {
    clearLoadingTimer();
    showLoadingSpinner.value = false;
};

const handlePendingLoaded = () => {
    clearLoadingTimer();
    showLoadingSpinner.value = false;
    if (pendingSrcUrl.value) {
        isPendingLoaded.value = true;
        fadeTimeout = setTimeout(() => {
            if (pendingSrcUrl.value) {
                activeSrcUrl.value = pendingSrcUrl.value;
                pendingSrcUrl.value = "";
                isPendingLoaded.value = false;
            }
        }, 350);
    }
};

const handlePendingError = () => {
    clearLoadingTimer();
    showLoadingSpinner.value = false;
    pendingSrcUrl.value = "";
    isPendingLoaded.value = false;
};

onUnmounted(() => {
    clearLoadingTimer();
    if (fadeTimeout) {
        clearTimeout(fadeTimeout);
        fadeTimeout = null;
    }
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

// Unified Pointer Gesture Controller (Mouse + Touch + Pen)
const imageContainerRef = ref<HTMLElement | null>(null);

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
                let nextZoom = Math.min(5, Math.max(0.1, initialPinchZoom * scaleFactor));
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

    const target = e.currentTarget as HTMLElement;
    try {
        target.releasePointerCapture(e.pointerId);
    } catch {}

    const wasPinching = isPinching;
    activePointers.delete(e.pointerId);

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

const handlePointerCancel = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
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

onUnmounted(() => {
    clearLoadingTimer();
    if (fadeTimeout) {
        clearTimeout(fadeTimeout);
        fadeTimeout = null;
    }
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
            v-if="(isLoading && !activeSrcUrl) || showLoadingSpinner"
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
                    <VideoPlayer
                        v-if="defaultVideoSrc"
                        :src="defaultVideoSrc"
                        :poster="defaultPosterUrl"
                        :tracks="media.tracks"
                        :playback="media.playback"
                        :subtitles="media.subtitles?.length ? media.subtitles : media.playback?.subtitle_tracks || []"
                        :width="media.width ?? undefined"
                        :height="media.height ?? undefined"
                        :autoplay="props.autoplay"
                        :hide-top-controls="props.hideTopControls"
                        @click-player="emit('click-media')"
                        @controls-change="emit('controls-change', $event)"
                        @user-activity="emit('user-activity')"
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
                        :live-src="livePhotoVideoSrc"
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
                    @wheel="handleWheel"
                >
                    <!-- Ambient Blur Backdrop -->
                    <template v-if="activeSrcUrl || pendingSrcUrl">
                        <HeicImage
                            v-if="isCurrentHeic"
                            :src="(pendingSrcUrl || activeSrcUrl)!"
                            no-spinner
                            class="absolute inset-0 w-full h-full object-cover filter blur-3xl opacity-25 scale-110 pointer-events-none select-none"
                            aria-hidden="true"
                        />
                        <img
                            v-else
                            :src="(pendingSrcUrl || activeSrcUrl)!"
                            class="absolute inset-0 w-full h-full object-cover filter blur-3xl opacity-25 scale-110 pointer-events-none select-none"
                            aria-hidden="true"
                        />
                    </template>
                    <!-- Base Image Layer (Always 100% visible, never unmounts, never becomes opacity-0) -->
                    <template v-if="activeSrcUrl">
                        <HeicImage
                            v-if="isCurrentHeic"
                            :src="activeSrcUrl"
                            no-spinner
                            :alt="media.title || $t('post_detail.viewer.preview')"
                            class="relative z-10 w-full h-full max-w-full max-h-full object-contain select-none pointer-events-none"
                            :style="{
                                transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                                transformOrigin: 'center center',
                                transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                            }"
                            @load="handleBaseLoaded"
                            @error="handleBaseError"
                            draggable="false"
                        />
                        <img
                            v-else
                            :src="activeSrcUrl"
                            :alt="media.title || $t('post_detail.viewer.preview')"
                            class="relative z-10 w-full h-full max-w-full max-h-full object-contain select-none pointer-events-none"
                            :style="{
                                transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                                transformOrigin: 'center center',
                                transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                            }"
                            @load="handleBaseLoaded"
                            @error="handleBaseError"
                            draggable="false"
                        />
                    </template>
                    <!-- High-Res Upgrade Layer (Smoothly fades in over base layer when loaded) -->
                    <template v-if="pendingSrcUrl">
                        <HeicImage
                            v-if="isCurrentHeic"
                            :src="pendingSrcUrl"
                            no-spinner
                            class="absolute z-20 w-full h-full max-w-full max-h-full object-contain select-none pointer-events-none transition-opacity duration-350 ease-out"
                            :class="isPendingLoaded ? 'opacity-100' : 'opacity-0'"
                            :style="{
                                transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                                transformOrigin: 'center center',
                                transition: isDragging ? 'none' : 'transform 0.15s ease-out, opacity 0.35s ease-out',
                            }"
                            @load="handlePendingLoaded"
                            @error="handlePendingError"
                            aria-hidden="true"
                        />
                        <img
                            v-else
                            :src="pendingSrcUrl"
                            class="absolute z-20 w-full h-full max-w-full max-h-full object-contain select-none pointer-events-none transition-opacity duration-350 ease-out"
                            :class="isPendingLoaded ? 'opacity-100' : 'opacity-0'"
                            :style="{
                                transform: `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${rotation}deg)`,
                                transformOrigin: 'center center',
                                transition: isDragging ? 'none' : 'transform 0.15s ease-out, opacity 0.35s ease-out',
                            }"
                            @load="handlePendingLoaded"
                            @error="handlePendingError"
                            aria-hidden="true"
                        />
                    </template>
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
