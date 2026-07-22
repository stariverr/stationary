<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    FileImage,
    Film,
    Layers,
    Link as LinkIcon,
    ListFilter,
    Maximize2,
    Minimize2,
    Music,
    User,
    X,
    RotateCcw,
    RotateCw,
    ZoomIn,
    ZoomOut,
    Maximize,
    PanelRight,
} from "@lucide/vue";
import { storeToRefs } from "pinia";
import { useQueryClient } from "@tanstack/vue-query";
import { toast } from "vue-sonner";
import { useUserStore } from "@/stores/user";
import { usePostMediaQuery } from "@/composables/usePostMediaQuery";
import { useApi } from "@/composables/useApi";
import type { PostMediaSummary } from "@/types/post";
import OrphanMediaPickerDialog from "./OrphanMediaPickerDialog.vue";
import ManageTracksDialog from "./ManageTracksDialog.vue";

const { selectedPost, selectedPostId } = usePosts();
const userStore = useUserStore();
const { expandDetailByDefault } = storeToRefs(userStore);
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
} = usePostMediaQuery(selectedPostId);

const activeMediaId = ref<string | null>(null);
const currentIndex = ref(0);
const activeTab = ref<"details" | "management">("details");
const isImmersiveView = ref(false);
const isMediaOnly = ref(false);
const isUiHidden = ref(false);
const isMobile = ref(false);

const isOverlay = computed(() => isImmersiveView.value || isMediaOnly.value);
const currentMedia = computed<PostMediaSummary | null>(() => {
    if (postMediaList.value.length === 0) return null;
    return postMediaList.value.find((media) => media.id === activeMediaId.value) ?? postMediaList.value[0] ?? null;
});
const currentPosition = computed(() => currentMedia.value?.position ?? 0);
const mediaCounter = computed(() => (mediaTotal.value > 0 ? `${currentPosition.value + 1} / ${mediaTotal.value}` : "0 / 0"));
const currentMediaTitle = computed(() => currentMedia.value?.title || t("post_detail.media_item", { number: currentPosition.value + 1 }));
const canPrevious = computed(() => postMediaList.value.length > 1 || currentIndex.value > 0 || mediaPage.value > 1);
const canNext = computed(
    () => postMediaList.value.length > 1 || currentIndex.value < postMediaList.value.length - 1 || mediaPage.value < mediaTotalPages.value,
);
const platformLabel = computed(() => t(`platforms.${selectedPost.value?.platform || "UNKNOWN"}`));

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

const zoomIn = () => {
    zoomLevel.value = Math.min(MAX_ZOOM, parseFloat((zoomLevel.value + ZOOM_STEP).toFixed(2)));
};

const zoomOut = () => {
    zoomLevel.value = Math.max(MIN_ZOOM, parseFloat((zoomLevel.value - ZOOM_STEP).toFixed(2)));
};

const zoomTo = (level: number) => {
    zoomLevel.value = level;
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
        resetZoomRotate();
    },
);

const openTrackEditor = (mediaId: string) => {
    trackEditMediaId.value = mediaId;
    isEditingTracks.value = true;
};

const handleDialogClose = (open: boolean) => {
    isEditingTracks.value = open;
    if (!open && selectedPost.value?.id) {
        queryClient.invalidateQueries({ queryKey: ["post", selectedPost.value.id] });
        queryClient.invalidateQueries({ queryKey: ["posts"] });
        fetchPage();
    }
};

const resetViewState = () => {
    currentIndex.value = 0;
    activeMediaId.value = null;
    activeTab.value = "details";
    isMediaOnly.value = false;
    isUiHidden.value = false;
    isImmersiveView.value = !isMobile.value && expandDetailByDefault.value;
};

watch(
    selectedPostId,
    (newId) => {
        if (newId) resetViewState();
    },
    { immediate: true },
);

watch(expandDetailByDefault, (newValue) => {
    if (!isMobile.value && selectedPost.value && !isMediaOnly.value) {
        isImmersiveView.value = newValue;
    }
});

watch(isOverlay, (newValue) => {
    if (!newValue) {
        resetZoomRotate();
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
    if (index >= 0) currentIndex.value = index;
    activeMediaId.value = mediaId;
};

const previousMedia = async () => {
    if (isLoadingMediaList.value) return;
    const index = postMediaList.value.findIndex((media) => media.id === activeMediaId.value);
    if (index > 0) {
        selectMedia(postMediaList.value[index - 1]!.id);
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
        selectMedia(postMediaList.value[postMediaList.value.length - 1]!.id);
    }
};

const nextMedia = async () => {
    if (isLoadingMediaList.value) return;
    const index = postMediaList.value.findIndex((media) => media.id === activeMediaId.value);
    if (index >= 0 && index < postMediaList.value.length - 1) {
        selectMedia(postMediaList.value[index + 1]!.id);
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
        selectMedia(postMediaList.value[0]!.id);
    }
};

const enterImmersiveView = () => {
    if (!isMobile.value) isImmersiveView.value = true;
};

const leaveImmersiveView = () => {
    isMediaOnly.value = false;
    isImmersiveView.value = false;
    isUiHidden.value = false;
};

const enterMediaOnly = () => {
    if (currentMedia.value) isMediaOnly.value = true;
};

const handleMediaClick = () => {
    if (isOverlay.value) {
        if (isImmersiveView.value) {
            isMediaOnly.value = !isMediaOnly.value;
        } else {
            isUiHidden.value = !isUiHidden.value;
        }
    } else {
        isMediaOnly.value = true;
        isUiHidden.value = false;
    }
};

const leaveMediaOnly = () => {
    isMediaOnly.value = false;
};

const closeDetail = () => {
    selectedPostId.value = null;
    isMediaOnly.value = false;
    isImmersiveView.value = false;
    isUiHidden.value = false;
    if (route.params.id) navigateTo("/");
};

const handleResize = () => {
    const nextIsMobile = window.innerWidth < 768;
    isMobile.value = nextIsMobile;
    if (nextIsMobile) isImmersiveView.value = false;
};

const handleKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isEditingTracks.value || isOrphanPickerOpen.value || isCreateMediaOpen.value) return;
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;

    if (event.key === "Escape") {
        if (isOverlay.value) leaveImmersiveView();
        else closeDetail();
    } else if (event.key === "ArrowLeft") {
        previousMedia();
    } else if (event.key === "ArrowRight") {
        nextMedia();
    }
};

onMounted(() => {
    handleResize();
    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("keydown", handleKeydown);
});

const copyLink = async () => {
    if (!selectedPost.value) return;
    try {
        await navigator.clipboard.writeText(`${window.location.origin}/posts/${selectedPost.value.id}`);
        toast.success(t("post_detail.toasts.copy_success"));
    } catch {
        toast.error(t("post_detail.toasts.copy_failed"));
    }
};

async function attachMediaIds(mediaIds: string[]) {
    if (!selectedPost.value) return false;
    try {
        const response = await useApi<{ success: boolean }>(`/post/${selectedPost.value.id}/bind_media`, {
            method: "POST",
            body: { media_ids: mediaIds },
        });
        if (response?.success) {
            queryClient.invalidateQueries({ queryKey: ["post", selectedPost.value.id] });
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            await fetchPage();
            return true;
        }
    } catch (error: any) {
        toast.error(t("post_detail.toasts.attach_failed"), { description: error.message || String(error) });
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
    if (!selectedPost.value || !mediaTotal.value) return;
    try {
        const response = await useApi<{ success: boolean; data: { list: PostMediaSummary[] } }>(`/post/${selectedPost.value.id}/media`, {
            query: { limit: mediaTotal.value },
        });
        const allMedia = response?.success ? response.data.list : [];
        const index = allMedia.findIndex((media) => media.id === mediaId);
        const targetIndex = direction === "left" ? index - 1 : index + 1;
        if (index < 0 || targetIndex < 0 || targetIndex >= allMedia.length) return;

        [allMedia[index], allMedia[targetIndex]] = [allMedia[targetIndex]!, allMedia[index]!];
        const reorderResponse = await useApi<{ success: boolean }>(`/post/${selectedPost.value.id}/media/reorder`, {
            method: "POST",
            body: { media_ids: allMedia.map((media) => media.id) },
        });
        if (!reorderResponse?.success) throw new Error(t("post_detail.toasts.reorder_failed"));
        toast.success(t("post_detail.toasts.reorder_success"));
        await fetchPage();
    } catch (error: any) {
        toast.error(t("post_detail.toasts.reorder_failed"), { description: error.message || String(error) });
    }
};

const handleUnlinkMedia = async (mediaId: string) => {
    if (!selectedPost.value) return;
    try {
        const response = await useApi<{ success: boolean }>(`/post/${selectedPost.value.id}/media/${mediaId}/remove`, { method: "POST" });
        if (!response?.success) throw new Error(t("post_detail.toasts.unlink_failed"));
        toast.success(t("post_detail.toasts.unlink_success"));
        if (activeMediaId.value === mediaId) activeMediaId.value = null;
        await fetchPage();
        queryClient.invalidateQueries({ queryKey: ["post", selectedPost.value.id] });
    } catch (error: any) {
        toast.error(t("post_detail.toasts.unlink_failed"), { description: error.message || String(error) });
    }
};

const handleTrashMedia = async (mediaId: string) => {
    if (!selectedPost.value) return;
    try {
        const response = await useApi<{ success: boolean }>(`/media/trash/${mediaId}`, { method: "POST" });
        if (!response?.success) throw new Error(t("post_detail.toasts.trash_failed"));
        toast.success(t("post_detail.toasts.trash_success"));
        if (activeMediaId.value === mediaId) activeMediaId.value = null;
        await fetchPage();
        queryClient.invalidateQueries({ queryKey: ["post", selectedPost.value.id] });
    } catch (error: any) {
        toast.error(t("post_detail.toasts.trash_failed"), { description: error.message || String(error) });
    }
};
</script>

<template>
    <div
        v-if="selectedPost"
        :class="[
            isOverlay
                ? 'fixed inset-0 z-[150] flex bg-zinc-950 text-zinc-100 pointer-events-auto'
                : 'fixed inset-y-0 right-0 z-60 w-full md:relative md:z-auto md:w-[520px] shrink-0 h-full bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 flex flex-col shadow-2xl overflow-hidden pointer-events-auto',
        ]"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('post_detail.title')"
    >
        <!-- Full-screen media stage -->
        <section v-if="isOverlay" class="relative flex min-w-0 flex-1 flex-col bg-zinc-950 group/fullscreen">
            <!-- Floating Nav Arrows for Fullscreen on Hover -->
            <button
                v-if="postMediaList.length > 1 && canPrevious && !isUiHidden"
                type="button"
                @click.stop="previousMedia"
                class="absolute left-6 top-1/2 -translate-y-1/2 flex h-12 w-12 items-center justify-center rounded-full bg-black/35 text-white border border-white/10 backdrop-blur-md hover:bg-white/10 hover:text-white hover:scale-105 active:scale-95 transition-all duration-300 opacity-0 -translate-x-3 group-hover/fullscreen:opacity-100 group-hover/fullscreen:translate-x-0 z-30 cursor-pointer"
                title="Previous media"
            >
                <ChevronLeft class="h-6 w-6" />
            </button>
            <button
                v-if="postMediaList.length > 1 && canNext && !isUiHidden"
                type="button"
                @click.stop="nextMedia"
                class="absolute right-6 top-1/2 -translate-y-1/2 flex h-12 w-12 items-center justify-center rounded-full bg-black/35 text-white border border-white/10 backdrop-blur-md hover:bg-white/10 hover:text-white hover:scale-105 active:scale-95 transition-all duration-300 opacity-0 translate-x-3 group-hover/fullscreen:opacity-100 group-hover/fullscreen:translate-x-0 z-30 cursor-pointer"
                title="Next media"
            >
                <ChevronRight class="h-6 w-6" />
            </button>

            <div
                v-if="!isUiHidden"
                class="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-6 pt-4 pb-12 bg-gradient-to-b from-black/70 via-black/25 to-transparent pointer-events-none"
            >
                <!-- Left: Title & Counter -->
                <div class="flex items-center gap-2.5 pointer-events-auto select-none">
                    <span
                        v-if="currentMedia"
                        class="max-w-[30vw] truncate text-[13px] font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
                    >
                        {{ currentMediaTitle }}
                    </span>
                    <span v-if="currentMedia" class="text-white/25 text-xs">·</span>
                    <span
                        v-if="currentMedia"
                        class="font-mono text-[11px] text-white/50 font-semibold tabular-nums drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
                        >{{ mediaCounter }}</span
                    >
                </div>

                <!-- Center: Image Inspection Tools -->
                <div v-if="currentMedia?.type === 'IMAGE'" class="hidden md:flex items-center gap-0.5 pointer-events-auto select-none">
                    <!-- Rotate Left -->
                    <button
                        type="button"
                        @click="rotateLeft"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all duration-150 cursor-pointer"
                        :title="$t('post_detail.viewer.rotate_left')"
                        :aria-label="$t('post_detail.viewer.rotate_left')"
                    >
                        <RotateCcw class="w-4 h-4" />
                    </button>
                    <!-- Rotate Right -->
                    <button
                        type="button"
                        @click="rotateRight"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all duration-150 cursor-pointer"
                        :title="$t('post_detail.viewer.rotate_right')"
                        :aria-label="$t('post_detail.viewer.rotate_right')"
                    >
                        <RotateCw class="w-4 h-4" />
                    </button>

                    <div class="h-4 w-px bg-white/15 mx-1.5" />

                    <!-- Zoom Out -->
                    <button
                        type="button"
                        @click="zoomOut"
                        :disabled="zoomLevel <= MIN_ZOOM"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-20 disabled:cursor-default disabled:hover:bg-transparent transition-all duration-150 cursor-pointer"
                        :title="$t('post_detail.viewer.zoom_out')"
                        :aria-label="$t('post_detail.viewer.zoom_out')"
                    >
                        <ZoomOut class="w-4 h-4" />
                    </button>

                    <!-- Zoom Slider -->
                    <input
                        type="range"
                        :min="MIN_ZOOM"
                        :max="MAX_ZOOM"
                        step="0.05"
                        v-model.number="zoomLevel"
                        class="w-24 h-1 rounded-full appearance-none cursor-pointer focus:outline-none mx-1 bg-white/12 hover:bg-white/20 transition-colors [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/85 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:hover:bg-white [&::-webkit-slider-thumb]:hover:scale-115 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white/85 [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:shadow-md"
                    />

                    <!-- Zoom In -->
                    <button
                        type="button"
                        @click="zoomIn"
                        :disabled="zoomLevel >= MAX_ZOOM"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-20 disabled:cursor-default disabled:hover:bg-transparent transition-all duration-150 cursor-pointer"
                        :title="$t('post_detail.viewer.zoom_in')"
                        :aria-label="$t('post_detail.viewer.zoom_in')"
                    >
                        <ZoomIn class="w-4 h-4" />
                    </button>

                    <div class="h-4 w-px bg-white/15 mx-1.5" />

                    <!-- 1:1 Size -->
                    <button
                        type="button"
                        @click="zoomTo(1)"
                        class="h-8 px-2 flex items-center justify-center rounded-full text-[10px] font-bold text-white/60 hover:text-white hover:bg-white/10 transition-all duration-150 cursor-pointer"
                        :title="$t('post_detail.viewer.zoom_reset_original')"
                    >
                        1:1
                    </button>
                    <!-- Fit Size -->
                    <button
                        type="button"
                        @click="resetZoomRotate"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all duration-150 cursor-pointer"
                        :title="$t('post_detail.viewer.zoom_reset_fit')"
                        :aria-label="$t('post_detail.viewer.zoom_reset_fit')"
                    >
                        <Maximize class="w-4 h-4" />
                    </button>
                </div>

                <!-- Right: Close Button (when Media Only mode is active) -->
                <div class="flex items-center pointer-events-auto">
                    <button
                        v-if="isMediaOnly"
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all duration-200 cursor-pointer"
                        :title="$t('post_detail.close')"
                        :aria-label="$t('post_detail.close')"
                        @click="closeDetail"
                    >
                        <X class="w-[18px] h-[18px]" />
                    </button>
                </div>
            </div>

            <div class="flex min-h-0 flex-1 items-center justify-center px-2 pb-2 pt-12 md:px-4">
                <UniversalMediaViewer
                    :media="currentMedia"
                    :is-loading="isLoadingMediaList"
                    :interactive="currentMedia?.type === 'IMAGE'"
                    :zoom="zoomLevel"
                    :rotation="rotationAngle"
                    @zoom-change="zoomLevel = $event"
                    @click-media="handleMediaClick"
                    class="h-full w-full"
                />
            </div>
        </section>

        <!-- Details inspector. It becomes the right rail in full-screen mode. -->
        <section
            v-if="!isMediaOnly"
            :class="
                isOverlay
                    ? 'flex h-full w-full shrink-0 flex-col border-l border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 md:w-[480px] xl:w-[520px]'
                    : 'flex h-full w-full flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100'
            "
        >
            <header
                class="flex h-16 shrink-0 items-center justify-between border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-4 md:px-5"
            >
                <div class="flex min-w-0 items-center gap-3">
                    <button
                        v-if="isMobile && !isOverlay"
                        type="button"
                        class="-ml-2 flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
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
                        v-if="!isOverlay && !isMobile"
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
                        :title="$t('common.immersive_view')"
                        :aria-label="$t('common.immersive_view')"
                        @click="enterImmersiveView"
                    >
                        <Maximize2 class="h-4 w-4" />
                    </button>
                    <button
                        v-if="isOverlay"
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition cursor-pointer"
                        :title="$t('common.standard_view')"
                        :aria-label="$t('common.standard_view')"
                        @click="leaveImmersiveView"
                    >
                        <Minimize2 class="h-4 w-4" />
                    </button>
                    <button
                        v-if="!isMobile || isOverlay"
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

            <!-- Compact media stage in the standard side panel (With Hover Nav Arrows) -->
            <div v-if="!isOverlay" class="relative aspect-video shrink-0 overflow-hidden bg-zinc-950 group/player">
                <UniversalMediaViewer
                    :media="currentMedia"
                    :is-loading="isLoadingMediaList"
                    :interactive="currentMedia?.type === 'IMAGE'"
                    @click-media="handleMediaClick"
                    class="h-full w-full"
                />

                <!-- Nav Arrows for Standard Player on Hover -->
                <button
                    v-if="postMediaList.length > 1 && canPrevious"
                    type="button"
                    @click.stop="previousMedia"
                    class="absolute left-3 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-xs hover:bg-black/80 transition-opacity opacity-0 group-hover/player:opacity-100 z-10 cursor-pointer"
                    title="Previous media"
                >
                    <ChevronLeft class="h-4.5 w-4.5" />
                </button>
                <button
                    v-if="postMediaList.length > 1 && canNext"
                    type="button"
                    @click.stop="nextMedia"
                    class="absolute right-3 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-xs hover:bg-black/80 transition-opacity opacity-0 group-hover/player:opacity-100 z-10 cursor-pointer"
                    title="Next media"
                >
                    <ChevronRight class="h-4.5 w-4.5" />
                </button>

                <button
                    v-if="currentMedia && currentMedia.type !== 'IMAGE' && currentMedia.type !== 'VIDEO'"
                    type="button"
                    class="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/90 backdrop-blur-xs transition hover:bg-black/60 hover:text-white cursor-pointer z-10 border border-white/10"
                    :title="$t('post_detail.media_fullscreen')"
                    :aria-label="$t('post_detail.media_fullscreen')"
                    @click="enterMediaOnly"
                >
                    <Maximize2 class="h-4 w-4" />
                </button>
            </div>

            <!-- Active Media Header Row (Linear style precision bar) -->
            <div
                v-if="!isOverlay && currentMedia"
                class="h-9 px-5 border-b border-zinc-200/60 dark:border-zinc-800/60 bg-zinc-50/60 dark:bg-zinc-900/40 flex items-center justify-between shrink-0 select-none"
            >
                <div class="min-w-0 flex-1 mr-3 flex items-center gap-2">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
                    <h4 class="text-xs font-semibold text-zinc-800 dark:text-zinc-200 truncate" :title="currentMediaTitle">
                        {{ currentMediaTitle || `Media #${currentPosition + 1}` }}
                    </h4>
                </div>
                <span class="font-mono text-[11px] tabular-nums font-semibold text-zinc-600 dark:text-zinc-300 shrink-0">
                    {{ currentPosition + 1 }}<span class="mx-0.5 text-zinc-400 dark:text-zinc-600">/</span>{{ mediaTotal }}
                </span>
            </div>

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
                            <span class="font-mono text-[11px] tabular-nums font-semibold text-zinc-600 dark:text-zinc-300">
                                {{ currentPosition + 1 }}<span class="mx-0.5 text-zinc-400 dark:text-zinc-600">/</span>{{ mediaTotal }}
                            </span>
                        </div>
                        <button
                            type="button"
                            class="inline-flex shrink-0 items-center gap-1 text-xs font-semibold transition cursor-pointer text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                            @click="activeTab = 'management'"
                        >
                            <ListFilter class="h-3.5 w-3.5" />
                            <span>{{ $t("post_detail.show_media_browser") }}</span>
                        </button>
                    </div>

                    <!-- Sleek Horizontal Swiper Cards -->
                    <div class="flex gap-2.5 overflow-x-auto pb-1 scrollbar-none select-none -mx-1 px-1">
                        <button
                            v-for="item in postMediaList"
                            :key="item.id"
                            type="button"
                            class="w-34 shrink-0 text-left rounded-lg border p-1.5 flex flex-col gap-1.5 transition-all duration-150 cursor-pointer relative group/media-card"
                            :class="[
                                activeMediaId === item.id
                                    ? 'border-emerald-500/80 dark:border-emerald-500/80 bg-emerald-50/20 dark:bg-emerald-950/20 ring-1 ring-emerald-500/20'
                                    : 'border-zinc-200/70 dark:border-zinc-800/70 bg-white dark:bg-zinc-900/40 hover:bg-zinc-50 dark:hover:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-700',
                            ]"
                            @click="selectMedia(item.id)"
                        >
                            <!-- Card Thumbnail -->
                            <div
                                class="w-full aspect-video bg-zinc-950 rounded overflow-hidden relative border border-zinc-150 dark:border-zinc-800/80"
                            >
                                <img
                                    v-if="item.cover_url || item.thumbnail_url || item.tracks?.[0]?.url"
                                    :src="item.cover_url || item.thumbnail_url || item.tracks?.[0]?.url"
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
                                <div
                                    v-if="item.type === 'VIDEO'"
                                    class="absolute inset-0 flex items-center justify-center bg-black/10 group-hover/media-card:bg-black/25 transition-all"
                                >
                                    <div
                                        class="w-5.5 h-5.5 rounded-full bg-white/95 text-zinc-950 flex items-center justify-center opacity-0 scale-75 group-hover/media-card:opacity-100 group-hover/media-card:scale-100 transition-all duration-150"
                                    >
                                        <Film class="w-2.5 h-2.5 fill-current" />
                                    </div>
                                </div>
                                <div
                                    v-if="item.duration || item.page_count"
                                    class="absolute bottom-1 right-1 bg-black/75 text-[8px] font-medium text-white px-1 py-0.5 rounded-xs font-mono"
                                >
                                    {{
                                        item.duration
                                            ? `${Math.floor(item.duration / 60)}:${String(Math.round(item.duration % 60)).padStart(2, "0")}`
                                            : `${item.page_count}p`
                                    }}
                                </div>
                            </div>

                            <!-- Card Metadata Text -->
                            <div class="min-w-0 space-y-0.5 pl-0.5">
                                <h5
                                    class="text-xs font-semibold truncate leading-tight tracking-tight"
                                    :class="[
                                        activeMediaId === item.id
                                            ? 'text-emerald-700 dark:text-emerald-400'
                                            : 'text-zinc-900 dark:text-zinc-100',
                                    ]"
                                >
                                    {{ item.title || `Media #${item.position + 1}` }}
                                </h5>
                                <div
                                    class="flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400 font-medium"
                                >
                                    <span>#{{ item.position + 1 }}</span>
                                    <span class="text-[9px] uppercase font-bold text-zinc-600 dark:text-zinc-400">
                                        {{ item.type }}
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
                    @unlink-media="handleUnlinkMedia"
                    @trash-media="handleTrashMedia"
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
</template>
