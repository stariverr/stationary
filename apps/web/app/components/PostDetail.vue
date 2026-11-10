<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
    AlertTriangle,
    ChevronLeft,
    ChevronRight,
    Download,
    ExternalLink,
    FileImage,
    Film,
    Layers,
    Link as LinkIcon,
    ListFilter,
    Loader2,
    Maximize2,
    Minimize2,
    Music,
    User,
    X,
    RotateCw,
    ZoomIn,
    ZoomOut,
} from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/vue-query";
import { toast } from "vue-sonner";
import { usePostMediaQuery } from "@/composables/usePostMediaQuery";
import { SWIPE_GAP_PX } from "@/composables/useSwipeNavigation";
import { useApi } from "@/composables/useApi";
import type { ApiResponse } from "@/types/api";
import {
    MediaType,
    type AttachMediaResult,
    type MediaDetail,
    type PostMediaPage,
    type ReorderMediaResult,
    type TrashMediaResult,
    type UnbindMediaResult,
} from "@/types/post";
import OrphanMediaPickerDialog from "./OrphanMediaPickerDialog.vue";
import MediaEditorDialog from "./MediaEditorDialog.vue";

const { selectedPost, selectedPostId } = usePosts();
const { t } = useI18n();
const route = useRoute();
const queryClient = useQueryClient();

const {
    list: postMediaList,
    page: mediaPage,
    total: mediaTotal,
    totalPages: mediaTotalPages,
    isLoading: isLoadingMediaList,
    fetchPage,
} = usePostMediaQuery(selectedPostId, () => selectedPost.value);

const refreshPostData = async (postId: string) => {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["post", postId] }),
        queryClient.invalidateQueries({ queryKey: ["posts"] }),
    ]);
    await fetchPage();
};

const activeMediaId = ref<string | null>(null);
const currentIndex = ref(0);
const activeTab = ref<"details" | "management">("details");
const isMediaOnly = ref(false);
const isMobile = ref(false);
const isMounted = ref(false);

/**
 * Stage chrome (header, nav arrows, image toolbar) is always shown in the split view. In immersive mode it
 * auto-hides only while a video plays, matching the player's own controls; a tap on an image toggles it.
 */
const CHROME_IDLE_DELAY = 2500;
const isChromeHidden = ref(false);
const isVideoPlaying = ref(false);
const isChromeVisible = computed(() => !isMediaOnly.value || !isChromeHidden.value);

let idleTimer: ReturnType<typeof setTimeout> | null = null;

const clearIdleTimer = () => {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
};

const showChrome = () => {
    isChromeHidden.value = false;
    clearIdleTimer();
    if (isMediaOnly.value && isVideoPlaying.value) {
        idleTimer = setTimeout(() => {
            isChromeHidden.value = true;
        }, CHROME_IDLE_DELAY);
    }
};

const handleStageActivity = () => {
    if (isMediaOnly.value && isVideoPlaying.value) showChrome();
};

const handlePlayerPlay = () => {
    isVideoPlaying.value = true;
    showChrome();
};

const handlePlayerPause = () => {
    isVideoPlaying.value = false;
    showChrome();
};

const currentMedia = computed<MediaDetail | null>(() => {
    const activeMedia = postMediaList.value.find((media) => media.id === activeMediaId.value);
    return activeMedia ?? postMediaList.value[0] ?? null;
});
const currentPosition = computed(() => currentMedia.value?.position ?? 0);
const mediaCounter = computed(() => (mediaTotal.value > 0 ? `${currentPosition.value + 1} / ${mediaTotal.value}` : "0 / 0"));
const currentMediaTitle = computed(() => currentMedia.value?.title || t("post_detail.media_item", { number: currentPosition.value + 1 }));
const displayMediaTitle = computed(() => {
    const title = currentMedia.value?.title?.trim();
    if (!title) {
        return t("post_detail.media_item", { number: currentPosition.value + 1 });
    }
    // If title looks like an internal snowflake ID or long hex string
    if (/^\d{10,}$/.test(title) || /^[a-f0-9]{24,}$/i.test(title)) {
        return t("post_detail.media_item", { number: currentPosition.value + 1 });
    }
    return title;
});
// Navigation loops, so either way is open once there is more than one item.
const canPrevious = computed(() => mediaTotal.value > 1);
const canNext = computed(() => mediaTotal.value > 1);
const platformLabel = computed(() => t(`platforms.${selectedPost.value?.platform || "UNKNOWN"}`));
const isZoomableMedia = computed(() => currentMedia.value?.type === MediaType.IMAGE || currentMedia.value?.type === MediaType.LIVE_PHOTO);
const formatMediaType = (type?: MediaType | null) => getMediaTypeLabel(type, t);

const postMediaListWithPreview = computed(() =>
    postMediaList.value.map((item) => ({
        ...item,
        previewUrl: previewThumbnailUrl(item.previews),
    })),
);

const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "";
};

const currentOriginal = computed(() => (currentMedia.value ? mainOriginal(currentMedia.value) : undefined));
const isDownloading = ref(false);

const downloadCurrentMedia = async () => {
    const media = currentMedia.value;
    const original = currentOriginal.value;
    if (!media || !original || isDownloading.value) return;

    isDownloading.value = true;
    try {
        const response = await useApi<ApiResponse<{ url: string }>>(`/media/${media.id}/originals/${original.id}/download-url`);
        if (!response.success || !response.data) {
            throw new Error(response.message || t("post_detail.toasts.download_failed"));
        }
        // The URL answers with Content-Disposition: attachment, so the browser saves it without leaving the page.
        const link = document.createElement("a");
        link.href = response.data.url;
        link.rel = "noopener";
        link.click();
    } catch (error: unknown) {
        toast.error(t("post_detail.toasts.download_failed"), { description: getErrorMessage(error) });
    } finally {
        isDownloading.value = false;
    }
};

const isEditingMedia = ref(false);
const editingMediaId = ref<string | undefined>(undefined);
const isOrphanPickerOpen = ref(false);
const isCreateMediaOpen = ref(false);

// Image Zoom & Rotation control state
const zoomLevel = ref(1);
const rotationAngle = ref(0);

const MIN_ZOOM = 0.1;
const MAX_FIT_ZOOM = 5;
const ZOOM_FACTOR = 1.25;

// Zoom is relative to the fitted image; fitScale converts it to the image's natural pixels.
const fitScale = ref<number | null>(null);
const actualSizeZoom = computed(() => (fitScale.value ? 1 / fitScale.value : null));
const maxZoom = computed(() => Math.max(MAX_FIT_ZOOM, actualSizeZoom.value ?? 0));
const zoomPercent = computed(() => Math.round(zoomLevel.value * (fitScale.value ?? 1) * 100));
const isFitZoom = computed(() => zoomLevel.value === 1);

const clampZoom = (level: number): number => {
    if (!Number.isFinite(level)) return 1;
    return Math.min(maxZoom.value, Math.max(MIN_ZOOM, Math.round(level * 100) / 100));
};

const zoomTo = (level: number) => {
    zoomLevel.value = clampZoom(level);
};

const zoomIn = () => zoomTo(zoomLevel.value * ZOOM_FACTOR);
const zoomOut = () => zoomTo(zoomLevel.value / ZOOM_FACTOR);

// The percentage button switches between fitting the stage and the image's natural pixels.
const toggleActualSize = () => {
    if (!isFitZoom.value || !actualSizeZoom.value) zoomTo(1);
    else zoomTo(actualSizeZoom.value);
};

const handleZoomChange = (level: number) => {
    zoomTo(level);
};

const rotateClockwise = () => {
    rotationAngle.value = (rotationAngle.value + 90) % 360;
};

const resetZoomRotate = () => {
    zoomLevel.value = 1;
    rotationAngle.value = 0;
};

// Reset state when active media changes
watch(
    () => activeMediaId.value,
    () => {
        isVideoPlaying.value = false;
        resetZoomRotate();
        showChrome();
    },
);

const openMediaEditor = (mediaId: string) => {
    editingMediaId.value = mediaId;
    isEditingMedia.value = true;
};

const handleDialogClose = async (open: boolean) => {
    isEditingMedia.value = open;
    const postId = selectedPost.value?.id;
    if (!open && postId) {
        await refreshPostData(postId);
    }
};

const resetViewState = () => {
    currentIndex.value = 0;
    activeMediaId.value = null;
    activeTab.value = "details";
    isMediaOnly.value = false;
};

watch(
    selectedPostId,
    (newId) => {
        if (newId) resetViewState();
    },
    { immediate: true },
);

watch(isMediaOnly, showChrome);

watch(postMediaList, (newList) => {
    if (newList.length === 0) {
        activeMediaId.value = null;
        currentIndex.value = 0;
        return;
    }

    const activeIndex = newList.findIndex((media) => media.id === activeMediaId.value);
    if (activeIndex === -1) {
        activeMediaId.value = newList[0]?.id || null;
        currentIndex.value = 0;
    } else {
        currentIndex.value = activeIndex;
    }
});

const selectMedia = (mediaId: string) => {
    const index = postMediaList.value.findIndex((media) => media.id === mediaId);
    const media = postMediaList.value[index];
    if (!media) return;

    currentIndex.value = index;
    activeMediaId.value = media.id;
};

const previousMedia = async () => {
    if (isLoadingMediaList.value) return;
    const index = postMediaList.value.findIndex((media) => media.id === activeMediaId.value);
    if (index > 0) {
        const previous = postMediaList.value[index - 1];
        if (previous) selectMedia(previous.id);
        return;
    }

    if (mediaPage.value > 1) {
        await fetchPage({ page: mediaPage.value - 1 });
        const last = postMediaList.value[postMediaList.value.length - 1];
        if (last) selectMedia(last.id);
        return;
    }

    // Before the first item: loop to the last one.
    if (mediaTotal.value > 1) {
        if (mediaPage.value !== mediaTotalPages.value) await fetchPage({ page: mediaTotalPages.value });
        const last = postMediaList.value[postMediaList.value.length - 1];
        if (last) selectMedia(last.id);
    }
};

const nextMedia = async () => {
    if (isLoadingMediaList.value) return;
    const index = postMediaList.value.findIndex((media) => media.id === activeMediaId.value);
    if (index >= 0 && index < postMediaList.value.length - 1) {
        const next = postMediaList.value[index + 1];
        if (next) selectMedia(next.id);
        return;
    }

    if (mediaPage.value < mediaTotalPages.value) {
        await fetchPage({ page: mediaPage.value + 1 });
        const first = postMediaList.value[0];
        if (first) selectMedia(first.id);
        return;
    }

    // Past the last item: loop to the first one.
    if (mediaTotal.value > 1) {
        if (mediaPage.value !== 1) await fetchPage({ page: 1 });
        const first = postMediaList.value[0];
        if (first) selectMedia(first.id);
    }
};

/**
 * The swipe strip: the current item with its neighbours beside it. Slots are keyed by media, so after a swipe the
 * neighbour that slid in becomes the current viewer in place and keeps what it already painted. Within one page the
 * strip wraps around like the navigation; across a page boundary it shows the gap until that page loads.
 */
const stripSlots = computed(() => {
    const list = postMediaList.value;
    const current = currentMedia.value;
    const index = list.findIndex((media) => media.id === current?.id);
    // No item yet: a single current slot shows the loading or empty state.
    if (!current || index < 0) return [{ key: "current", media: current, position: 0 }];

    const wraps = mediaTotalPages.value === 1;
    const at = (i: number) => (wraps ? list[(i + list.length) % list.length] : list[i]);
    const previous = at(index - 1);
    const next = at(index + 1);
    const slots = [{ key: current.id, media: current, position: 0 }];
    if (previous && previous.id === next?.id) {
        // Two items: the other one waits on whichever side the swipe pulls from.
        if (previous.id !== current.id) {
            slots.push({ key: previous.id, media: previous, position: swipeDirection.value === "previous" ? -1 : 1 });
        }
        return slots;
    }
    if (previous && previous.id !== current.id) slots.unshift({ key: previous.id, media: previous, position: -1 });
    if (next && next.id !== current.id) slots.push({ key: next.id, media: next, position: 1 });
    return slots;
});

const swipeAreaRef = ref<HTMLElement | null>(null);
const {
    style: swipeStyle,
    isDragging: isSwiping,
    direction: swipeDirection,
} = useSwipeNavigation(swipeAreaRef, {
    // A zoomed-in image pans under drags instead.
    enabled: () => zoomLevel.value <= 1 && !isLoadingMediaList.value,
    canPrevious: () => canPrevious.value,
    canNext: () => canNext.value,
    navigate: (direction) => (direction === "next" ? nextMedia() : previousMedia()),
});

const enterMediaOnly = () => {
    if (currentMedia.value) isMediaOnly.value = true;
};

// Only images and live photos emit this; a tap on a video belongs to the player (play / pause).
const handleMediaClick = () => {
    if (!isMediaOnly.value) {
        isMediaOnly.value = true;
        return;
    }
    clearIdleTimer();
    isChromeHidden.value = !isChromeHidden.value;
};

const leaveMediaOnly = () => {
    isMediaOnly.value = false;
};

const closeDetail = () => {
    if (typeof document !== "undefined" && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    }
    selectedPostId.value = null;
    isMediaOnly.value = false;
    resetZoomRotate();
    if ("id" in route.params) navigateTo("/");
};

const handleResize = () => {
    isMobile.value = window.innerWidth < 768;
};

const handleKeydown = (event: KeyboardEvent) => {
    handleStageActivity();
    if (event.defaultPrevented || isEditingMedia.value || isOrphanPickerOpen.value || isCreateMediaOpen.value) return;
    const target = event.target;
    if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement
    ) {
        return;
    }

    if (event.key === "Escape") {
        if (isMediaOnly.value) leaveMediaOnly();
        else closeDetail();
    } else if (event.key === "ArrowLeft") {
        previousMedia();
    } else if (event.key === "ArrowRight") {
        nextMedia();
    }
};

onMounted(() => {
    isMounted.value = true;
    handleResize();
    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("keydown", handleKeydown);
    clearIdleTimer();
});

const copyLink = async () => {
    const postId = selectedPost.value?.id;
    if (!postId) return;

    try {
        await navigator.clipboard.writeText(`${window.location.origin}/posts/${postId}`);
        toast.success(t("post_detail.toasts.copy_success"));
    } catch {
        toast.error(t("post_detail.toasts.copy_failed"));
    }
};

async function attachMediaIds(mediaIds: string[]) {
    const postId = selectedPost.value?.id;
    if (!postId || mediaIds.length === 0) return false;

    try {
        const response = await useApi<ApiResponse<AttachMediaResult>>(`/post/${postId}/bind_media`, {
            method: "POST",
            body: { media_ids: mediaIds },
        });

        if (!response.success || !response.data?.success) {
            throw new Error(response.message || t("post_detail.toasts.attach_failed"));
        }

        await refreshPostData(postId);
        return true;
    } catch (error: unknown) {
        toast.error(t("post_detail.toasts.attach_failed"), { description: getErrorMessage(error) });
    }
    return false;
}

const handleAttachOrphans = async (mediaIds: string[]) => {
    if (await attachMediaIds(mediaIds)) {
        toast.success(t("post_detail.toasts.attach_success"));
        isOrphanPickerOpen.value = false;
    }
};

const handleUploadMediaCreated = async (media: { id: string; title: string }) => {
    isCreateMediaOpen.value = false;
    if (await attachMediaIds([media.id])) {
        toast.success(t("post_detail.toasts.create_attach_success", { title: media.title }));
    }
};

const handleShiftMedia = async (mediaId: string, direction: "left" | "right") => {
    const postId = selectedPost.value?.id;
    if (!postId || mediaTotal.value <= 0) return;

    try {
        const response = await useApi<ApiResponse<PostMediaPage>>(`/post/${postId}/media`, {
            query: { limit: mediaTotal.value },
        });

        if (!response.success || !response.data) {
            throw new Error(response.message || t("post_detail.toasts.reorder_failed"));
        }

        const allMedia = [...response.data.list];
        const index = allMedia.findIndex((media) => media.id === mediaId);
        const targetIndex = direction === "left" ? index - 1 : index + 1;
        if (index < 0 || targetIndex < 0 || targetIndex >= allMedia.length) return;

        const current = allMedia[index];
        const target = allMedia[targetIndex];
        if (!current || !target) return;

        allMedia[index] = target;
        allMedia[targetIndex] = current;

        const reorderResponse = await useApi<ApiResponse<ReorderMediaResult>>(`/post/${postId}/media/reorder`, {
            method: "POST",
            body: { media_ids: allMedia.map((media) => media.id) },
        });

        if (!reorderResponse.success || !reorderResponse.data?.success) {
            throw new Error(reorderResponse.message || t("post_detail.toasts.reorder_failed"));
        }

        toast.success(t("post_detail.toasts.reorder_success"));
        await refreshPostData(postId);
    } catch (error: unknown) {
        toast.error(t("post_detail.toasts.reorder_failed"), { description: getErrorMessage(error) });
    }
};

const handleUnlinkMedia = async (mediaId: string) => {
    const postId = selectedPost.value?.id;
    if (!postId) return;

    try {
        const response = await useApi<ApiResponse<UnbindMediaResult>>(`/post/${postId}/media/${mediaId}/remove`, { method: "POST" });
        if (!response.success || !response.data?.success) {
            throw new Error(response.message || t("post_detail.toasts.unlink_failed"));
        }

        toast.success(t("post_detail.toasts.unlink_success"));
        if (activeMediaId.value === mediaId) activeMediaId.value = null;
        await refreshPostData(postId);
    } catch (error: unknown) {
        toast.error(t("post_detail.toasts.unlink_failed"), { description: getErrorMessage(error) });
    }
};

const handleTrashMedia = async (mediaId: string) => {
    const postId = selectedPost.value?.id;
    if (!postId) return;

    try {
        const response = await useApi<ApiResponse<TrashMediaResult>>(`/media/trash/${mediaId}`, { method: "POST" });
        if (!response.success || !response.data || response.data.mediaUpdated < 1) {
            throw new Error(response.message || t("post_detail.toasts.trash_failed"));
        }

        toast.success(t("post_detail.toasts.trash_success"));
        if (activeMediaId.value === mediaId) activeMediaId.value = null;
        await refreshPostData(postId);
    } catch (error: unknown) {
        toast.error(t("post_detail.toasts.trash_failed"), { description: getErrorMessage(error) });
    }
};

const pendingUnlinkMediaId = ref<string | null>(null);
const pendingTrashMediaId = ref<string | null>(null);
const isUnlinking = ref(false);
const isTrashing = ref(false);

const requestUnlinkMedia = (mediaId: string) => {
    pendingUnlinkMediaId.value = mediaId;
};

const requestTrashMedia = (mediaId: string) => {
    pendingTrashMediaId.value = mediaId;
};

const confirmUnlinkMedia = async () => {
    if (!pendingUnlinkMediaId.value) return;
    isUnlinking.value = true;
    try {
        await handleUnlinkMedia(pendingUnlinkMediaId.value);
    } finally {
        isUnlinking.value = false;
        pendingUnlinkMediaId.value = null;
    }
};

const confirmTrashMedia = async () => {
    if (!pendingTrashMediaId.value) return;
    isTrashing.value = true;
    try {
        await handleTrashMedia(pendingTrashMediaId.value);
    } finally {
        isTrashing.value = false;
        pendingTrashMediaId.value = null;
    }
};
</script>

<template>
    <div
        v-if="selectedPost"
        class="fixed inset-0 z-[150] flex flex-col md:flex-row bg-zinc-950 text-zinc-100 pointer-events-auto"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('post_detail.title')"
    >
        <!-- Mobile Top Bar (< 768px): Sits at the top on narrow screens -->
        <header
            v-if="!isMediaOnly"
            class="flex md:hidden shrink-0 items-center justify-between border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-4 pt-[env(safe-area-inset-top)] h-[calc(3.5rem+env(safe-area-inset-top))] text-zinc-900 dark:text-zinc-100"
        >
            <div class="flex min-w-0 items-center gap-3">
                <button
                    type="button"
                    class="-ml-1.5 flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
                    :title="$t('post_detail.close')"
                    :aria-label="$t('post_detail.close')"
                    @click="closeDetail"
                >
                    <ChevronLeft class="h-5 w-5" />
                </button>
                <div
                    class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400"
                >
                    <img
                        v-if="selectedPost.author_avatar_url"
                        :src="selectedPost.author_avatar_url"
                        :alt="selectedPost.author"
                        class="h-full w-full object-cover"
                    />
                    <User v-else class="h-4 w-4" />
                </div>
                <div class="min-w-0">
                    <h2 class="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {{ $t("common.post_info") }}
                    </h2>
                    <p class="truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {{ selectedPost.author }} <span class="text-zinc-300 dark:text-zinc-700">·</span> {{ platformLabel }}
                    </p>
                </div>
            </div>
            <div class="flex items-center gap-1">
                <button
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
                    :title="$t('common.copy_link')"
                    :aria-label="$t('common.copy_link')"
                    @click="copyLink"
                >
                    <LinkIcon class="h-4 w-4" />
                </button>
                <button
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
                    :title="$t('post_detail.media_fullscreen')"
                    :aria-label="$t('post_detail.media_fullscreen')"
                    @click="enterMediaOnly"
                >
                    <Maximize2 class="h-4 w-4" />
                </button>
            </div>
        </header>

        <!-- Media stage: split view, or immersive when the details inspector is hidden -->
        <section
            class="relative flex min-w-0 flex-1 flex-col bg-zinc-950 group/stage overflow-hidden select-none"
            :class="[!isMediaOnly ? 'h-[42vh] shrink-0 md:h-full md:flex-1' : 'h-full flex-1']"
            @pointermove="handleStageActivity"
            @pointerdown="handleStageActivity"
        >
            <!-- The swipe surface stays put while only the content inside it slides, so it keeps every event of a gesture -->
            <div
                ref="swipeAreaRef"
                class="relative flex min-h-0 flex-1 overflow-hidden touch-pan-y"
                :class="{ 'cursor-grabbing **:cursor-grabbing': isSwiping }"
            >
                <div class="absolute inset-0" :style="swipeStyle">
                    <!-- Each slot positions its own wrapper: the viewer's root is relative and would win over a passed class -->
                    <div
                        v-for="slot in stripSlots"
                        :key="slot.key"
                        class="absolute inset-0"
                        :style="
                            slot.position
                                ? { transform: `translateX(calc(${slot.position * 100}% + ${slot.position * SWIPE_GAP_PX}px))` }
                                : undefined
                        "
                        :inert="slot.position !== 0"
                        :aria-hidden="slot.position !== 0 || undefined"
                    >
                        <!-- Previews emit nothing: they have no player, no gestures, and report their fit scale once current -->
                        <UniversalMediaViewer
                            :media="slot.media"
                            :preview="slot.position !== 0"
                            :is-loading="slot.position === 0 && isLoadingMediaList"
                            :interactive="slot.position === 0 && isZoomableMedia"
                            :hide-badge="false"
                            :zoom="slot.position === 0 ? zoomLevel : 1"
                            :rotation="slot.position === 0 ? rotationAngle : 0"
                            :max-zoom="maxZoom"
                            @zoom-change="handleZoomChange"
                            @fit-scale-change="fitScale = $event"
                            @click-media="handleMediaClick"
                            @play="handlePlayerPlay"
                            @pause="handlePlayerPause"
                        />
                    </div>
                </div>
            </div>

            <!-- Item navigation sits above every media type, so it never depends on the current viewer's state -->
            <button
                v-if="canPrevious"
                type="button"
                class="absolute top-1/2 z-30 flex h-9 w-9 md:h-10 md:w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-md shadow-lg transition-[opacity,background-color,scale] duration-200 hover:bg-black/70 hover:text-white active:scale-95 cursor-pointer left-3 md:left-4 pointer-coarse:hidden"
                :class="isChromeVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'"
                :title="$t('post_detail.previous_media')"
                :aria-label="$t('post_detail.previous_media')"
                @click="previousMedia"
            >
                <ChevronLeft class="h-5 w-5 -translate-x-px" />
            </button>
            <button
                v-if="canNext"
                type="button"
                class="absolute top-1/2 z-30 flex h-9 w-9 md:h-10 md:w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-md shadow-lg transition-[opacity,background-color,scale] duration-200 hover:bg-black/70 hover:text-white active:scale-95 cursor-pointer right-3 md:right-4 pointer-coarse:hidden"
                :class="isChromeVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'"
                :title="$t('post_detail.next_media')"
                :aria-label="$t('post_detail.next_media')"
                @click="nextMedia"
            >
                <ChevronRight class="h-5 w-5 translate-x-px" />
            </button>

            <!-- Stage title bar, shared by every media type. Type-specific tools live at the bottom. -->
            <header
                class="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-between gap-3 px-3 md:px-4 pt-[max(12px,env(safe-area-inset-top))] transition-all duration-300 ease-out"
                :class="isChromeVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3'"
            >
                <!-- The split view already shows the post beside the stage, so the title only appears when immersive -->
                <div v-if="isMediaOnly" class="flex min-w-0 items-center gap-2">
                    <button
                        type="button"
                        class="pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-md transition hover:bg-black/70 hover:text-white active:scale-95 cursor-pointer"
                        :title="$t('post_detail.exit_fullscreen')"
                        :aria-label="$t('post_detail.exit_fullscreen')"
                        @click="leaveMediaOnly"
                    >
                        <Minimize2 class="h-4 w-4" />
                    </button>
                    <div
                        v-if="currentMedia"
                        class="flex h-9 min-w-0 items-center gap-2 rounded-full bg-black/45 px-3.5 text-xs text-white/90 backdrop-blur-md"
                    >
                        <span class="truncate font-medium">{{ displayMediaTitle }}</span>
                        <span class="shrink-0 text-white/55">{{ formatMediaType(currentMedia.type) }}</span>
                    </div>
                </div>
                <span v-else />

                <div
                    v-if="mediaTotal > 1 || currentOriginal"
                    class="pointer-events-auto flex h-9 shrink-0 items-center rounded-full bg-black/45 px-1 text-white/90 backdrop-blur-md"
                >
                    <span v-if="mediaTotal > 1" class="px-2.5 font-mono text-xs font-medium tabular-nums">{{ mediaCounter }}</span>
                    <template v-if="currentOriginal">
                        <span v-if="mediaTotal > 1" class="h-4 w-px bg-white/20" />
                        <a
                            :href="currentOriginal.url ?? undefined"
                            target="_blank"
                            rel="noopener"
                            class="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/15 hover:text-white"
                            :title="$t('post_detail.viewer.open_original')"
                            :aria-label="$t('post_detail.viewer.open_original')"
                        >
                            <ExternalLink class="h-4 w-4" />
                        </a>
                        <button
                            type="button"
                            class="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/15 hover:text-white disabled:opacity-50 cursor-pointer disabled:cursor-default"
                            :disabled="isDownloading"
                            :title="$t('post_detail.viewer.download')"
                            :aria-label="$t('post_detail.viewer.download')"
                            @click="downloadCurrentMedia"
                        >
                            <Loader2 v-if="isDownloading" class="h-4 w-4 animate-spin" />
                            <Download v-else class="h-4 w-4" />
                        </button>
                    </template>
                </div>
            </header>

            <!-- Bottom Action Toolbar (Desktop only; mobile uses native pinch & double-tap gestures) -->
            <footer
                v-if="isZoomableMedia"
                class="absolute bottom-0 inset-x-0 z-40 pb-[max(20px,env(safe-area-inset-bottom))] hidden md:flex items-center justify-center pointer-events-none select-none transition-all duration-300 ease-out"
                :class="
                    isMediaOnly
                        ? isChromeVisible
                            ? 'opacity-100 translate-y-0'
                            : 'opacity-0 translate-y-4'
                        : 'opacity-0 group-hover/stage:opacity-100 translate-y-0'
                "
            >
                <div
                    class="flex h-10 items-center gap-1 rounded-full border border-white/15 bg-zinc-950/80 px-3 backdrop-blur-xl shadow-2xl pointer-events-auto"
                >
                    <button
                        type="button"
                        @click="zoomOut"
                        :disabled="zoomLevel <= MIN_ZOOM"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/75 hover:bg-white/15 hover:text-white disabled:opacity-20 disabled:cursor-default disabled:hover:bg-transparent transition-all cursor-pointer active:scale-95"
                        :title="$t('post_detail.viewer.zoom_out')"
                        :aria-label="$t('post_detail.viewer.zoom_out')"
                    >
                        <ZoomOut class="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        @click="toggleActualSize"
                        class="h-8 min-w-14 px-2 flex items-center justify-center rounded-full font-mono text-xs font-semibold tabular-nums text-white/85 hover:bg-white/15 hover:text-white transition-all cursor-pointer active:scale-95"
                        :title="
                            isFitZoom && actualSizeZoom
                                ? $t('post_detail.viewer.zoom_reset_original')
                                : $t('post_detail.viewer.zoom_reset_fit')
                        "
                    >
                        {{ zoomPercent }}%
                    </button>
                    <button
                        type="button"
                        @click="zoomIn"
                        :disabled="zoomLevel >= maxZoom"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/75 hover:bg-white/15 hover:text-white disabled:opacity-20 disabled:cursor-default disabled:hover:bg-transparent transition-all cursor-pointer active:scale-95"
                        :title="$t('post_detail.viewer.zoom_in')"
                        :aria-label="$t('post_detail.viewer.zoom_in')"
                    >
                        <ZoomIn class="h-4 w-4" />
                    </button>

                    <span class="h-4 w-px bg-white/15 mx-1"></span>

                    <button
                        type="button"
                        @click="rotateClockwise"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/75 hover:bg-white/15 hover:text-white transition-all cursor-pointer active:scale-95"
                        :title="$t('post_detail.viewer.rotate_right')"
                        :aria-label="$t('post_detail.viewer.rotate_right')"
                    >
                        <RotateCw class="h-4 w-4" />
                    </button>
                </div>
            </footer>
        </section>

        <!-- Details inspector. It is the right rail in full-screen mode, or bottom panel on mobile. -->
        <section
            v-if="!isMediaOnly"
            class="flex h-full w-full shrink-0 flex-col border-t md:border-t-0 md:border-l border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex-1 min-h-0 md:flex-none md:w-[480px] xl:w-[520px]"
        >
            <header
                class="hidden md:flex h-16 shrink-0 items-center justify-between border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-4 md:px-5"
            >
                <div class="flex min-w-0 items-center gap-3">
                    <div
                        class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400"
                    >
                        <img
                            v-if="selectedPost.author_avatar_url"
                            :src="selectedPost.author_avatar_url"
                            :alt="selectedPost.author"
                            class="h-full w-full object-cover"
                        />
                        <User v-else class="h-4 w-4" />
                    </div>
                    <div class="min-w-0">
                        <h2 class="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {{ $t("common.post_info") }}
                        </h2>
                        <p class="truncate text-xs text-zinc-500 dark:text-zinc-400">
                            {{ selectedPost.author }} <span class="text-zinc-300 dark:text-zinc-700">·</span> {{ platformLabel }}
                        </p>
                    </div>
                </div>
                <div class="flex items-center gap-1">
                    <button
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
                        :title="$t('common.copy_link')"
                        :aria-label="$t('common.copy_link')"
                        @click="copyLink"
                    >
                        <LinkIcon class="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
                        :title="$t('post_detail.media_fullscreen')"
                        :aria-label="$t('post_detail.media_fullscreen')"
                        @click="enterMediaOnly"
                    >
                        <Maximize2 class="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
                        :title="$t('post_detail.close')"
                        :aria-label="$t('post_detail.close')"
                        @click="closeDetail"
                    >
                        <X class="h-4 w-4" />
                    </button>
                </div>
            </header>

            <!-- Segmented Tabs Switcher (Vercel / Linear style) -->
            <div class="px-5 py-2.5 shrink-0 select-none border-b border-zinc-200/60 dark:border-zinc-800/60 bg-white dark:bg-zinc-950">
                <div
                    class="bg-zinc-100/70 dark:bg-zinc-900/80 p-0.5 rounded-lg flex items-center border border-zinc-200/50 dark:border-zinc-800/60"
                >
                    <button
                        type="button"
                        @click="activeTab = 'details'"
                        class="flex-1 py-1 text-xs font-medium rounded-md transition-all duration-150 cursor-pointer text-center"
                        :class="[
                            activeTab === 'details'
                                ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-2xs'
                                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100',
                        ]"
                    >
                        {{ $t("common.post_info") }}
                    </button>
                    <button
                        type="button"
                        @click="activeTab = 'management'"
                        class="flex-1 py-1 text-xs font-medium rounded-md transition-all duration-150 cursor-pointer text-center"
                        :class="[
                            activeTab === 'management'
                                ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-2xs'
                                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100',
                        ]"
                    >
                        {{ $t("post_detail.show_media_browser") }}
                    </button>
                </div>
            </div>

            <!-- Tab 1: Embedded details flow -->
            <div
                v-show="activeTab === 'details'"
                class="min-h-0 flex-1 overflow-y-auto px-5 py-6 scrollbar-thin md:px-6 space-y-6 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100"
            >
                <!-- Playlist Swiper (Linear / Apple style inspector row) -->
                <section v-if="postMediaList.length" class="space-y-3" aria-labelledby="post-media-heading">
                    <div class="flex items-center justify-between gap-3">
                        <div class="flex min-w-0 items-center gap-2">
                            <Layers class="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" />
                            <h3
                                id="post-media-heading"
                                class="text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-300"
                            >
                                {{ $t("common.media_assets") }}
                            </h3>
                            <span class="font-mono text-xs tabular-nums font-semibold text-zinc-600 dark:text-zinc-300">
                                {{ currentPosition + 1 }}<span class="mx-0.5 text-zinc-400 dark:text-zinc-600">/</span>{{ mediaTotal }}
                            </span>
                        </div>
                        <button
                            type="button"
                            class="inline-flex shrink-0 items-center gap-1 text-xs font-semibold transition cursor-pointer text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
                            @click="activeTab = 'management'"
                        >
                            <ListFilter class="h-3.5 w-3.5" />
                            <span>{{ $t("post_detail.show_media_browser") }}</span>
                        </button>
                    </div>

                    <!-- Sleek Horizontal Swiper Cards -->
                    <div class="flex gap-2.5 overflow-x-auto pb-1 scrollbar-none select-none -mx-1 px-1">
                        <button
                            v-for="item in postMediaListWithPreview"
                            :key="item.id"
                            type="button"
                            class="w-34 shrink-0 text-left rounded-lg border p-1.5 flex flex-col gap-1.5 transition-all duration-150 cursor-pointer relative group/media-card"
                            :class="[
                                activeMediaId === item.id
                                    ? 'border-blue-500/80 dark:border-blue-500/80 bg-blue-50/20 dark:bg-blue-950/20 ring-1 ring-blue-500/20'
                                    : 'border-zinc-200/70 dark:border-zinc-800/70 bg-white dark:bg-zinc-900/40 hover:bg-zinc-50 dark:hover:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-700',
                            ]"
                            @click="selectMedia(item.id)"
                        >
                            <!-- Card Thumbnail -->
                            <div
                                class="w-full aspect-video bg-zinc-950 rounded overflow-hidden relative border border-zinc-200 dark:border-zinc-800/80"
                            >
                                <img
                                    v-if="item.previewUrl"
                                    :src="item.previewUrl"
                                    class="w-full h-full object-cover transition-transform duration-200 group-hover/media-card:scale-105"
                                    loading="lazy"
                                />
                                <div
                                    v-else
                                    class="w-full h-full flex items-center justify-center text-zinc-400 bg-zinc-100 dark:bg-zinc-900"
                                >
                                    <component
                                        :is="item.type === 'VIDEO' ? Film : item.type === 'AUDIO' ? Music : FileImage"
                                        class="w-3.5 h-3.5"
                                    />
                                </div>
                            </div>

                            <!-- Card Metadata Text -->
                            <div class="min-w-0 space-y-0.5 pl-0.5">
                                <h5
                                    class="text-xs font-semibold truncate leading-tight tracking-tight"
                                    :class="[
                                        activeMediaId === item.id ? 'text-blue-700 dark:text-blue-400' : 'text-zinc-900 dark:text-zinc-100',
                                    ]"
                                >
                                    {{ item.title || $t("post_detail.media_item", { number: item.position + 1 }) }}
                                </h5>
                                <div
                                    class="flex items-center justify-between text-xs font-mono text-zinc-500 dark:text-zinc-400 font-medium"
                                >
                                    <span>#{{ item.position + 1 }}</span>
                                    <span class="text-xs font-bold text-zinc-600 dark:text-zinc-400">
                                        {{ formatMediaType(item.type) }}
                                    </span>
                                </div>
                            </div>
                        </button>
                    </div>
                </section>
                <div
                    v-else
                    class="border border-dashed border-zinc-200 dark:border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500 dark:text-zinc-400"
                >
                    {{ $t("post_detail.manage.no_media_attached") }}
                </div>

                <div v-if="postMediaList.length" class="h-[1px] bg-zinc-200/50 dark:bg-zinc-800" />

                <!-- Post Info Cards -->
                <PostDetailInfo :post="selectedPost" />
            </div>

            <!-- Tab 2: Advanced Media Browser Management -->
            <div
                v-show="activeTab === 'management'"
                class="flex-1 min-h-0 p-5 flex flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100"
            >
                <PostMediaBrowser
                    :list="postMediaList"
                    :active-media-id="activeMediaId"
                    :is-loading="isLoadingMediaList"
                    :total="mediaTotal"
                    :page="mediaPage"
                    :total-pages="mediaTotalPages"
                    @select-media="selectMedia"
                    @prev-page="fetchPage({ page: mediaPage - 1 })"
                    @next-page="fetchPage({ page: mediaPage + 1 })"
                    @search-change="(value) => fetchPage({ keyword: value, page: 1 })"
                    @type-change="(value) => fetchPage({ type: value, page: 1 })"
                    @upload-media="isCreateMediaOpen = true"
                    @link-orphan="isOrphanPickerOpen = true"
                    @shift-media="handleShiftMedia"
                    @unlink-media="requestUnlinkMedia"
                    @trash-media="requestTrashMedia"
                    @edit-media="openMediaEditor"
                />
            </div>
        </section>
    </div>

    <MediaEditorDialog
        :open="isEditingMedia"
        :media-list="postMediaList"
        :initial-media-id="editingMediaId"
        @update:open="handleDialogClose"
    />

    <OrphanMediaPickerDialog
        :open="isOrphanPickerOpen"
        :library-id="selectedPost?.library_id"
        @update:open="isOrphanPickerOpen = $event"
        @attach="handleAttachOrphans"
    />

    <CreateMediaDialog
        v-if="selectedPost"
        :open="isCreateMediaOpen"
        :library-id="selectedPost.library_id"
        @update:open="isCreateMediaOpen = $event"
        @created="handleUploadMediaCreated"
    />

    <!-- Unlink Media Confirmation Dialog -->
    <Dialog
        :open="!!pendingUnlinkMediaId"
        @update:open="
            (val) => {
                if (!val) pendingUnlinkMediaId = null;
            }
        "
    >
        <DialogContent class="sm:max-w-md p-6 bg-white dark:bg-zinc-900 rounded-lg">
            <DialogHeader class="gap-2">
                <DialogTitle class="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <AlertTriangle class="w-5 h-5 text-amber-500 shrink-0" />
                    {{ $t("post_detail.manage.unlink_confirm_title") }}
                </DialogTitle>
                <DialogDescription class="text-xs text-zinc-600 dark:text-zinc-400">
                    {{ $t("post_detail.manage.unlink_confirm_desc") }}
                </DialogDescription>
            </DialogHeader>
            <div class="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800">
                <button
                    type="button"
                    class="px-4 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer transition-colors"
                    @click="pendingUnlinkMediaId = null"
                >
                    {{ $t("common.cancel") }}
                </button>
                <button
                    type="button"
                    :disabled="isUnlinking"
                    class="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer transition-colors shadow-xs"
                    @click="confirmUnlinkMedia"
                >
                    {{ $t("post_detail.manage.unlink_button") }}
                </button>
            </div>
        </DialogContent>
    </Dialog>

    <!-- Trash Media Confirmation Dialog -->
    <Dialog
        :open="!!pendingTrashMediaId"
        @update:open="
            (val) => {
                if (!val) pendingTrashMediaId = null;
            }
        "
    >
        <DialogContent class="sm:max-w-md p-6 bg-white dark:bg-zinc-900 rounded-lg">
            <DialogHeader class="gap-2">
                <DialogTitle class="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <AlertTriangle class="w-5 h-5 text-red-500 shrink-0" />
                    {{ $t("post_detail.manage.trash_confirm_title") }}
                </DialogTitle>
                <DialogDescription class="text-xs text-zinc-600 dark:text-zinc-400">
                    {{ $t("post_detail.manage.trash_confirm_desc") }}
                </DialogDescription>
            </DialogHeader>
            <div class="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800">
                <button
                    type="button"
                    class="px-4 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer transition-colors"
                    @click="pendingTrashMediaId = null"
                >
                    {{ $t("common.cancel") }}
                </button>
                <button
                    type="button"
                    :disabled="isTrashing"
                    class="px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer transition-colors shadow-xs"
                    @click="confirmTrashMedia"
                >
                    {{ $t("post_detail.manage.trash_button") }}
                </button>
            </div>
        </DialogContent>
    </Dialog>
</template>
