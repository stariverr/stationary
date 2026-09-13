<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
    AlertTriangle,
    ChevronLeft,
    ChevronRight,
    FileImage,
    Film,
    Layers,
    Link as LinkIcon,
    ListFilter,
    Maximize2,
    Music,
    User,
    X,
    RotateCcw,
    RotateCw,
    ZoomIn,
    ZoomOut,
    Maximize,
    CircleDotDashed,
} from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/vue-query";
import { toast } from "vue-sonner";
import { usePostMediaQuery } from "@/composables/usePostMediaQuery";
import { useApi } from "@/composables/useApi";
import type { ApiResponse } from "@/types/api";
import {
    MediaType,
    TrackPurpose,
    type AttachMediaResult,
    type PostMediaPage,
    type PostMediaSummary,
    type ReorderMediaResult,
    type TrashMediaResult,
    type UnbindMediaResult,
} from "@/types/post";
import OrphanMediaPickerDialog from "./OrphanMediaPickerDialog.vue";
import ManageTracksDialog from "./ManageTracksDialog.vue";

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
const isControlsVisible = ref(true);
const isMobile = ref(false);
const isMounted = ref(false);

let idleTimer: ReturnType<typeof setTimeout> | null = null;

const resetIdleTimer = () => {
    isControlsVisible.value = true;
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    if (isMediaOnly.value) {
        idleTimer = setTimeout(() => {
            isControlsVisible.value = false;
        }, 3500);
    }
};

const handlePointerActivity = () => {
    if (isMediaOnly.value && isControlsVisible.value) {
        resetIdleTimer();
    }
};

const isVideoPlaying = ref(false);

const handlePlayerControlsChange = (visible: boolean) => {
    if (!isMediaOnly.value) return;
    isControlsVisible.value = visible;
    if (visible) {
        resetIdleTimer();
    } else if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
};

const handlePlayerPlay = () => {
    isVideoPlaying.value = true;
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    // Auto-immerse cleanly shortly after video starts playing
    idleTimer = setTimeout(() => {
        isControlsVisible.value = false;
    }, 1500);
};

const handlePlayerPause = () => {
    isVideoPlaying.value = false;
    isControlsVisible.value = true;
    resetIdleTimer();
};

// Mobile Touch Swipe Gesture for switching media
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;

const handleStageTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (touch) {
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        touchStartTime = performance.now();
    }
};

const handleStageTouchEnd = (e: TouchEvent) => {
    const touch = e.changedTouches[0];
    if (touch) {
        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;
        const elapsed = performance.now() - touchStartTime;

        if (zoomLevel.value <= 1 && Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4 && elapsed < 450) {
            if (deltaX < 0 && canNext.value) {
                nextMedia();
            } else if (deltaX > 0 && canPrevious.value) {
                previousMedia();
            }
        }
    }
};

const currentMedia = computed<PostMediaSummary | null>(() => {
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
const canPrevious = computed(() => postMediaList.value.length > 1 || currentIndex.value > 0 || mediaPage.value > 1);
const canNext = computed(
    () => postMediaList.value.length > 1 || currentIndex.value < postMediaList.value.length - 1 || mediaPage.value < mediaTotalPages.value,
);
const platformLabel = computed(() => t(`platforms.${selectedPost.value?.platform || "UNKNOWN"}`));
const isZoomableMedia = computed(() => currentMedia.value?.type === MediaType.IMAGE || currentMedia.value?.type === MediaType.LIVE_PHOTO);
const formatMediaType = (type?: MediaType | null) => getMediaTypeLabel(type, t);

const postMediaListWithPreview = computed(() =>
    postMediaList.value.map((item) => ({
        ...item,
        previewUrl: getMediaPreviewUrl(item),
    })),
);

const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "";
};

const isEditingTracks = ref(false);
const trackEditMediaId = ref<string | undefined>(undefined);
const isOrphanPickerOpen = ref(false);
const isCreateMediaOpen = ref(false);

// Image Zoom & Rotation control state
const zoomLevel = ref(1);
const rotationAngle = ref(0);

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;

const clampZoom = (level: number): number => {
    if (!Number.isFinite(level)) return 1;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(level * 100) / 100));
};

const zoomIn = () => {
    zoomLevel.value = clampZoom(zoomLevel.value + ZOOM_STEP);
};

const zoomOut = () => {
    zoomLevel.value = clampZoom(zoomLevel.value - ZOOM_STEP);
};

const zoomTo = (level: number) => {
    zoomLevel.value = clampZoom(level);
};

const handleZoomChange = (level: number) => {
    zoomTo(level);
};

const rotateLeft = () => {
    rotationAngle.value = (rotationAngle.value - 90) % 360;
};

const rotateRight = () => {
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
    },
);

const openTrackEditor = (mediaId: string) => {
    trackEditMediaId.value = mediaId;
    isEditingTracks.value = true;
};

const handleDialogClose = async (open: boolean) => {
    isEditingTracks.value = open;
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
    isControlsVisible.value = true;
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
};

watch(
    selectedPostId,
    (newId) => {
        if (newId) resetViewState();
    },
    { immediate: true },
);

watch(isMediaOnly, (val) => {
    if (val) {
        resetIdleTimer();
    } else {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        isControlsVisible.value = true;
    }
});

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

    // Loop back to the last item
    if (postMediaList.value.length > 1) {
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

    // Loop back to the first item
    if (postMediaList.value.length > 1) {
        const first = postMediaList.value[0];
        if (first) selectMedia(first.id);
    }
};

const enterMediaOnly = () => {
    if (currentMedia.value) isMediaOnly.value = true;
};

const handleMediaClick = () => {
    if (!isMediaOnly.value) {
        isMediaOnly.value = true;
    } else {
        if (currentMedia.value?.type === "VIDEO") {
            resetIdleTimer();
        } else {
            isControlsVisible.value = !isControlsVisible.value;
            if (isControlsVisible.value) {
                resetIdleTimer();
            } else if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        }
    }
};

const leaveMediaOnly = () => {
    isMediaOnly.value = false;
    isControlsVisible.value = true;
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
};

const closeDetail = () => {
    if (typeof document !== "undefined" && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    }
    selectedPostId.value = null;
    isMediaOnly.value = false;
    isControlsVisible.value = true;
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    resetZoomRotate();
    if (route.params.id) navigateTo("/");
};

const handleResize = () => {
    isMobile.value = window.innerWidth < 768;
};

const handleKeydown = (event: KeyboardEvent) => {
    resetIdleTimer();
    if (event.defaultPrevented || isEditingTracks.value || isOrphanPickerOpen.value || isCreateMediaOpen.value) return;
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
    window.addEventListener("mousemove", handlePointerActivity);
});

onUnmounted(() => {
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("keydown", handleKeydown);
    window.removeEventListener("mousemove", handlePointerActivity);
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
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

        <!-- Full-screen / Split-view media stage -->
        <section
            class="relative flex min-w-0 flex-1 flex-col bg-zinc-950 group/fullscreen overflow-hidden select-none"
            :class="[!isMediaOnly ? 'h-[42vh] shrink-0 md:h-full md:flex-1' : 'h-full flex-1']"
        >
            <!-- Media Viewport: Truly full-screen, p-0, zero black bars reserved -->
            <div
                class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-0"
                @touchstart="handleStageTouchStart"
                @touchend="handleStageTouchEnd"
            >
                <!-- Floating Nav Arrows (Visible on both mobile & desktop when multiple media exist) -->
                <button
                    v-if="postMediaList.length > 1 && canPrevious && !isVideoPlaying"
                    type="button"
                    @pointerdown.stop="resetIdleTimer"
                    @click.stop="previousMedia"
                    class="absolute left-2 md:left-5 top-1/2 -translate-y-1/2 flex h-8 w-8 md:h-11 md:w-11 items-center justify-center rounded-full bg-black/50 text-white/90 hover:text-white border border-white/15 backdrop-blur-md hover:bg-black/75 hover:scale-105 active:scale-95 transition-all duration-200 z-30 cursor-pointer shadow-lg"
                    :class="[!isControlsVisible ? 'opacity-0 pointer-events-none' : 'opacity-80 md:opacity-70 hover:opacity-100']"
                    :title="$t('post_detail.previous_media')"
                >
                    <ChevronLeft class="h-4 w-4 md:h-5 md:w-5" />
                </button>
                <button
                    v-if="postMediaList.length > 1 && canNext && !isVideoPlaying"
                    type="button"
                    @pointerdown.stop="resetIdleTimer"
                    @click.stop="nextMedia"
                    class="absolute right-2 md:right-5 top-1/2 -translate-y-1/2 flex h-8 w-8 md:h-11 md:w-11 items-center justify-center rounded-full bg-black/50 text-white/90 hover:text-white border border-white/15 backdrop-blur-md hover:bg-black/75 hover:scale-105 active:scale-95 transition-all duration-200 z-30 cursor-pointer shadow-lg"
                    :class="[!isControlsVisible ? 'opacity-0 pointer-events-none' : 'opacity-80 md:opacity-70 hover:opacity-100']"
                    :title="$t('post_detail.next_media')"
                >
                    <ChevronRight class="h-4 w-4 md:h-5 md:w-5" />
                </button>

                <!-- Floating Media Counter Pill (When not in fullscreen media-only, centered) -->
                <div
                    v-if="!isMediaOnly && mediaTotal > 1"
                    class="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-xs font-mono font-medium text-white/90 backdrop-blur-md border border-white/10 pointer-events-none select-none shadow-md"
                >
                    <span>{{ currentPosition + 1 }}</span>
                    <span class="opacity-40">/</span>
                    <span>{{ mediaTotal }}</span>
                </div>

                <UniversalMediaViewer
                    :media="currentMedia"
                    :is-loading="isLoadingMediaList"
                    :interactive="isZoomableMedia"
                    :hide-badge="false"
                    :zoom="zoomLevel"
                    :rotation="rotationAngle"
                    @zoom-change="handleZoomChange"
                    @click-media="handleMediaClick"
                    @controls-change="handlePlayerControlsChange"
                    @user-activity="resetIdleTimer"
                    @play="handlePlayerPlay"
                    @pause="handlePlayerPause"
                    class="h-full w-full"
                />
            </div>

            <!-- Fullscreen Top Header (Left-aligned </X, Centered Counter, Clean Canvas) -->
            <header
                v-if="isMediaOnly"
                class="absolute top-0 inset-x-0 z-40 flex items-center justify-between pointer-events-none select-none transition-all duration-300 ease-out pt-[max(16px,env(safe-area-inset-top))] px-4 md:px-6"
                :class="isControlsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'"
                @mouseenter="resetIdleTimer"
                @pointerdown.stop="resetIdleTimer"
            >
                <!-- Left: Exit Fullscreen / Back button (</X) -->
                <div class="flex items-center pointer-events-auto">
                    <button
                        type="button"
                        class="flex h-9 w-9 md:h-10 md:w-10 items-center justify-center rounded-full bg-zinc-950/80 hover:bg-white/20 border border-white/15 text-white/80 hover:text-white backdrop-blur-xl shadow-2xl transition-all duration-150 cursor-pointer active:scale-95"
                        :title="$t('post_detail.exit_fullscreen')"
                        :aria-label="$t('post_detail.exit_fullscreen')"
                        @click="leaveMediaOnly"
                    >
                        <ChevronLeft class="h-5 w-5 -translate-x-px" />
                    </button>
                </div>

                <!-- Center: Counter Pill (Title removed for pure content immersion) -->
                <div
                    v-if="mediaTotal > 1"
                    class="pointer-events-auto flex h-8 md:h-9 items-center justify-center rounded-full border border-white/15 bg-zinc-950/80 px-3 md:px-3.5 backdrop-blur-xl shadow-2xl font-mono text-xs font-bold tabular-nums text-white/90 select-none"
                >
                    {{ mediaCounter }}
                </div>
                <div v-else class="w-9 md:w-10 pointer-events-none"></div>

                <!-- Right: Balanced spacer so center counter stays optically centered -->
                <div class="w-9 md:w-10 pointer-events-none"></div>
            </header>

            <!-- Bottom Action Toolbar (Desktop only; mobile uses native pinch & double-tap gestures) -->
            <footer
                v-if="isZoomableMedia"
                class="absolute bottom-0 inset-x-0 z-40 pb-[max(20px,env(safe-area-inset-bottom))] hidden md:flex items-center justify-center pointer-events-none select-none transition-all duration-300 ease-out"
                :class="
                    isMediaOnly
                        ? isControlsVisible
                            ? 'opacity-100 translate-y-0'
                            : 'opacity-0 translate-y-4'
                        : 'opacity-0 group-hover/fullscreen:opacity-100 translate-y-0'
                "
                @mouseenter="resetIdleTimer"
                @pointerdown.stop="resetIdleTimer"
            >
                <div
                    class="flex h-10 items-center gap-1 rounded-full border border-white/15 bg-zinc-950/80 px-3 backdrop-blur-xl shadow-2xl pointer-events-auto"
                >
                    <!-- Rotate Left -->
                    <button
                        type="button"
                        @click="rotateLeft"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/75 hover:bg-white/15 hover:text-white transition-all cursor-pointer active:scale-95"
                        :title="$t('post_detail.viewer.rotate_left')"
                        :aria-label="$t('post_detail.viewer.rotate_left')"
                    >
                        <RotateCcw class="h-4 w-4" />
                    </button>
                    <!-- Rotate Right -->
                    <button
                        type="button"
                        @click="rotateRight"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/75 hover:bg-white/15 hover:text-white transition-all cursor-pointer active:scale-95"
                        :title="$t('post_detail.viewer.rotate_right')"
                        :aria-label="$t('post_detail.viewer.rotate_right')"
                    >
                        <RotateCw class="h-4 w-4" />
                    </button>

                    <span class="h-4 w-px bg-white/15 mx-1"></span>

                    <!-- Zoom Out -->
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

                    <!-- Zoom Slider -->
                    <input
                        type="range"
                        :min="MIN_ZOOM"
                        :max="MAX_ZOOM"
                        step="0.05"
                        v-model.number="zoomLevel"
                        class="w-20 md:w-28 h-1 rounded-full appearance-none cursor-pointer focus:outline-none mx-1.5 bg-white/20 hover:bg-white/30 transition-colors [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:shadow-md"
                    />

                    <!-- Zoom In -->
                    <button
                        type="button"
                        @click="zoomIn"
                        :disabled="zoomLevel >= MAX_ZOOM"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/75 hover:bg-white/15 hover:text-white disabled:opacity-20 disabled:cursor-default disabled:hover:bg-transparent transition-all cursor-pointer active:scale-95"
                        :title="$t('post_detail.viewer.zoom_in')"
                        :aria-label="$t('post_detail.viewer.zoom_in')"
                    >
                        <ZoomIn class="h-4 w-4" />
                    </button>

                    <span class="h-4 w-px bg-white/15 mx-1"></span>

                    <!-- 1:1 Size -->
                    <button
                        type="button"
                        @click="zoomTo(1)"
                        class="h-8 px-2.5 flex items-center justify-center rounded-full text-xs font-mono font-bold text-white/75 hover:bg-white/15 hover:text-white transition-all cursor-pointer active:scale-95"
                        :title="$t('post_detail.viewer.zoom_reset_original')"
                    >
                        1:1
                    </button>
                    <!-- Fit Size -->
                    <button
                        type="button"
                        @click="resetZoomRotate"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/75 hover:bg-white/15 hover:text-white transition-all cursor-pointer active:scale-95"
                        :title="$t('post_detail.viewer.zoom_reset_fit')"
                        :aria-label="$t('post_detail.viewer.zoom_reset_fit')"
                    >
                        <Maximize class="h-4 w-4" />
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
                    @manage-tracks="openTrackEditor"
                />
            </div>
        </section>
    </div>

    <ManageTracksDialog
        :open="isEditingTracks"
        :media-list="postMediaList"
        :initial-media-id="trackEditMediaId"
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
