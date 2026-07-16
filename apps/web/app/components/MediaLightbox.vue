<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import {
    X,
    ChevronLeft,
    ChevronRight,
    Info,
    Layers,
    Link as LinkIcon,
    FileImage,
    Loader2,
    Sparkles,
    Tag,
    Trash2,
    Plus,
    Upload,
    Play,
    Music,
    FileText,
    Image as ImageIcon,
    Video as VideoIcon,
} from "@lucide/vue";
import { useMediaStore, type MediaListItem, type MappedMediaItem, type MatchedDetails } from "@/stores/media";
import { type ApiPostDetail, type Track } from "@/types/post";
import { toast } from "vue-sonner";
import { storeToRefs } from "pinia";
import { Swiper, SwiperSlide } from "swiper/vue";
import "swiper/css";
import { Temporal } from "@js-temporal/polyfill";
import { useApi } from "@/composables/useApi";
import { getOptimizedImageUrl } from "@/utils/image";

const store = useMediaStore();
const { selectedMediaId, selectedMedia, medias, displayMode } = storeToRefs(store);

const { t } = useI18n();
const regeneratingCoverMediaId = ref<string | null>(null);

interface CoverRegenData {
    status: string;
    reason?: string;
}

const handleRegenerateCover = async (mediaId: string) => {
    if (!mediaId) return;
    regeneratingCoverMediaId.value = mediaId;
    try {
        const response = await useApi<{ success: boolean; message?: string; data: CoverRegenData }>(`/media/${mediaId}/regenerate-cover`, {
            method: "POST",
        });
        if (response && response.success && response.data) {
            const status = response.data.status;
            if (status === "queued") {
                toast.success(t("media.cover.queued", "Video cover regeneration has been queued."));
            } else if (status === "already_pending") {
                toast.info(t("media.cover.already_pending", "A cover generation task is already pending."));
            } else if (status === "skipped") {
                const reason = response.data.reason;
                if (reason === "external_cover_exists") {
                    toast.warning(t("media.cover.external_exists", "This video already has an external cover and it was not overwritten."));
                } else {
                    toast.warning(reason || t("media.cover.failed", "Skipped cover generation."));
                }
            }
        } else {
            throw new Error(response?.message || "Failed to request cover generation");
        }
    } catch (err: unknown) {
        console.error("Failed to regenerate cover:", err);
        toast.error(t("media.cover.failed", "Failed to queue cover regeneration."));
    } finally {
        regeneratingCoverMediaId.value = null;
    }
};

const isVisible = computed(() => !!selectedMediaId.value);

const closeLightbox = () => {
    store.selectMedia(null);
};

interface MappedSiblingMedia {
    id: string;
    eid?: string;
    source?: string;
    title?: string | null;
    description?: string | null;
    type: string;
    url: string | null;
    live_url?: string | null;
    media_url?: string | null;
    primary_file_url?: string | null;
    mime_type?: string | null;
    mimeType?: string | null;
    width?: number;
    height?: number;
    poster?: string | null;
    thumbnail?: string | null;
    subtitles?: Array<{
        url: string;
        language: string;
        label: string;
        format: string;
    }>;
    matched_reason?: unknown;
    matched_details?: MatchedDetails;
    score?: number;
    date?: string;
    create_time?: string;
    published_time?: string | null;
    tags?: string[];
    isPlaceholder?: boolean;
}

interface MediaInputForSubtitles {
    id?: string;
    type?: string;
    url?: string | null;
    primary_file_url?: string | null;
    media_url?: string | null;
    tracks?: Track[];
    date?: string;
    create_time?: string;
    published_time?: string | null;
    matched_details?: unknown;
}

interface SwiperInstanceType {
    slideTo: (index: number, speed?: number) => void;
    slidePrev: () => void;
    slideNext: () => void;
}

// Sibling media within a post (for Stacked mode)
const postSiblings = ref<MappedSiblingMedia[]>([]);
const postDetail = ref<ApiPostDetail | null>(null);
const isLoadingPost = ref(false);

const currentIndex = ref(0);
const swiperInstance = ref<SwiperInstanceType | null>(null);

const onSwiper = (swiper: unknown) => {
    swiperInstance.value = swiper as SwiperInstanceType;
    // Do not reset currentIndex here, as it may overwrite the watch logic
};

const onSlideChange = (swiper: unknown) => {
    currentIndex.value = (swiper as { realIndex: number }).realIndex;
};

const mapMediaWithSubtitles = (m: MediaInputForSubtitles): MappedSiblingMedia | null => {
    if (!m) return null;
    const subtitleTracks = (m.tracks || []).filter((t: Track) => t.type === "SUBTITLE");
    const liveTrack =
        m.type === "LIVE_PHOTO" ? (m.tracks || []).find((t) => t.type === "VIDEO" && t.purpose === "CONTENT" && t.priority === 0) : null;
    return {
        ...m,
        id: String(m.id || ""),
        type: String(m.type || "IMAGE"),
        url: m.url || m.primary_file_url || m.media_url || null,
        live_url: liveTrack?.url || null,
        subtitles: subtitleTracks.map((sub: Track) => ({
            url: sub.url,
            language: (sub.metadata?.language as string) || "unknown",
            label: (sub.metadata?.label as string) || (sub.metadata?.language as string) || "unknown",
            format: sub.metadata?.format === "json" ? "vtt" : (sub.metadata?.format as string) || "vtt",
        })),
        date: typeof m.date === "string" ? m.date : undefined,
        create_time: typeof m.create_time === "string" ? m.create_time : undefined,
        published_time: typeof m.published_time === "string" ? m.published_time : null,
        matched_details: (m.matched_details as MatchedDetails) || undefined,
    } as unknown as MappedSiblingMedia;
};

watch(selectedMediaId, async (newId) => {
    if (!newId) {
        postSiblings.value = [];
        postDetail.value = null;
        return;
    }

    // In Stacked mode, if there is a post_id, fetch its siblings
    if (displayMode.value === "stacked" && selectedMedia.value?.post_id) {
        // Count of media items in the post
        const totalMediaCount = selectedMedia.value.media_count || 1;

        // Optimistically set postSiblings with placeholders, so we can display the first slide immediately
        // and keep the Swiper slides count stable.
        const initialSibling = selectedMedia.value ? mapMediaWithSubtitles(selectedMedia.value) : null;
        const siblings: MappedSiblingMedia[] = [];
        if (initialSibling) {
            siblings.push(initialSibling);
            for (let i = 1; i < totalMediaCount; i++) {
                siblings.push({
                    id: `placeholder-${i}`,
                    type: "IMAGE",
                    url: null,
                    isPlaceholder: true,
                } as any);
            }
        }
        postSiblings.value = siblings;
        currentIndex.value = 0;
        nextTick(() => {
            if (swiperInstance.value) swiperInstance.value.slideTo(0, 0);
        });

        isLoadingPost.value = true;
        try {
            const response = await useApi<{ success: boolean; data: ApiPostDetail }>(`/post/detail/${selectedMedia.value.post_id}`);
            if (response && response.success && response.data) {
                postDetail.value = response.data;
                // Map the post's media list to include valid URLs
                const mapped = (response.data.media || []).map(mapMediaWithSubtitles).filter((m): m is MappedSiblingMedia => !!m);
                postSiblings.value = mapped;
                const index = mapped.findIndex((m) => m.id === newId);
                currentIndex.value = Math.max(0, index);
                nextTick(() => {
                    if (swiperInstance.value) swiperInstance.value.slideTo(currentIndex.value, 0);
                });
            } else {
                const sibling = selectedMedia.value ? mapMediaWithSubtitles(selectedMedia.value) : null;
                postSiblings.value = sibling ? [sibling] : [];
            }
        } catch (e) {
            const sibling = selectedMedia.value ? mapMediaWithSubtitles(selectedMedia.value) : null;
            postSiblings.value = sibling ? [sibling] : [];
        } finally {
            isLoadingPost.value = false;
        }
    } else {
        // Flat mode or independent media
        postSiblings.value = medias.value.map(mapMediaWithSubtitles).filter((m): m is MappedSiblingMedia => !!m);
        const index = postSiblings.value.findIndex((m) => m.id === newId);
        currentIndex.value = Math.max(0, index);
        nextTick(() => {
            if (swiperInstance.value) swiperInstance.value.slideTo(currentIndex.value, 0);
        });
    }
});

const scrollPrev = () => {
    if (displayMode.value === "stacked" && selectedMedia.value?.post_id) {
        swiperInstance.value?.slidePrev();
    } else {
        // Flat mode navigation across the entire grid
        if (currentIndex.value > 0) {
            const prevMedia = postSiblings.value[currentIndex.value - 1];
            if (prevMedia) store.selectMedia(prevMedia.id);
        }
    }
};

const scrollNext = () => {
    if (displayMode.value === "stacked" && selectedMedia.value?.post_id) {
        swiperInstance.value?.slideNext();
    } else {
        // Flat mode navigation across the entire grid
        if (currentIndex.value < postSiblings.value.length - 1) {
            const nextMedia = postSiblings.value[currentIndex.value + 1];
            if (nextMedia) store.selectMedia(nextMedia.id);
        }
    }
};

// Handle keyboard navigation
const handleKeydown = (e: KeyboardEvent) => {
    if (!isVisible.value) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") scrollPrev();
    if (e.key === "ArrowRight") scrollNext();
};

const sidebarWidth = ref(380);
const isResizing = ref(false);

const startResize = (e: MouseEvent) => {
    isResizing.value = true;
    window.addEventListener("mousemove", handleResize);
    window.addEventListener("mouseup", stopResize);
    e.preventDefault();
};

const handleResize = (e: MouseEvent) => {
    if (!isResizing.value) return;
    const newWidth = window.innerWidth - e.clientX;
    if (newWidth >= 300 && newWidth <= window.innerWidth * 0.6) {
        sidebarWidth.value = newWidth;
    }
};

const stopResize = () => {
    isResizing.value = false;
    window.removeEventListener("mousemove", handleResize);
    window.removeEventListener("mouseup", stopResize);
};

onMounted(() => {
    window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
    window.removeEventListener("keydown", handleKeydown);
    window.removeEventListener("mousemove", handleResize);
    window.removeEventListener("mouseup", stopResize);
});

const currentMediaItem = computed(() => {
    return postSiblings.value[currentIndex.value] || selectedMedia.value;
});

const currentPublishedTime = computed(() => {
    return currentMediaItem.value?.published_time || currentMediaItem.value?.date || currentMediaItem.value?.create_time;
});

const isVideo = computed(() => currentMediaItem.value?.type?.toLowerCase() === "video");

const formatDate = (dateStr: string) => {
    if (!dateStr) return "Unknown";
    try {
        return Temporal.Instant.from(dateStr).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return dateStr;
    }
};

const isEditingMedia = ref(false);
const isSavingMedia = ref(false);
const editMediaTitle = ref("");
const editMediaPublishedTime = ref("");

const toLocalDatetimeString = (displayTime: string | null | undefined) => {
    if (!displayTime) return "";
    try {
        const inst = Temporal.Instant.from(displayTime);
        const zdt = inst.toZonedDateTimeISO(Temporal.Now.timeZoneId());
        const y = String(zdt.year).padStart(4, "0");
        const m = String(zdt.month).padStart(2, "0");
        const d = String(zdt.day).padStart(2, "0");
        const hh = String(zdt.hour).padStart(2, "0");
        const mm = String(zdt.minute).padStart(2, "0");
        return `${y}-${m}-${d}T${hh}:${mm}`;
    } catch {
        return "";
    }
};

const fromLocalDatetimeString = (localStr: string) => {
    if (!localStr) return null;
    try {
        const pdt = Temporal.PlainDateTime.from(localStr);
        const zdt = pdt.toZonedDateTime(Temporal.Now.timeZoneId());
        return zdt.toInstant().toString();
    } catch {
        return null;
    }
};

const startEditingMedia = () => {
    editMediaTitle.value = currentMediaItem.value?.title || "";
    editMediaPublishedTime.value = toLocalDatetimeString(currentPublishedTime.value);
    isEditingMedia.value = true;
};

const cancelEditingMedia = () => {
    isEditingMedia.value = false;
};

const saveEditingMedia = async () => {
    if (!currentMediaItem.value) return;
    isSavingMedia.value = true;
    try {
        const publishedTimeInstant = fromLocalDatetimeString(editMediaPublishedTime.value);

        const response = await store.updateMediaInfo(currentMediaItem.value.id, {
            title: editMediaTitle.value.trim(),
            published_time: publishedTimeInstant,
        });

        if (!response || !response.success) {
            throw new Error("Failed to update media info");
        }

        toast.success("Media updated successfully!");
        isEditingMedia.value = false;

        // If in stacked mode and siblings exist, we should refresh postDetail
        if (displayMode.value === "stacked" && selectedMedia.value?.post_id) {
            const detailRes = await useApi<{ success: boolean; data: ApiPostDetail }>(`/post/detail/${selectedMedia.value.post_id}`);
            if (detailRes && detailRes.success && detailRes.data) {
                postDetail.value = detailRes.data;
                postSiblings.value = (detailRes.data.media || []).map(mapMediaWithSubtitles).filter((m): m is MappedSiblingMedia => !!m);
            }
        } else {
            // Otherwise refetch media list
            store.refetchMedia();
        }
    } catch (err: any) {
        console.error("Save media error:", err);
        toast.error(err.message || "Failed to save changes");
    } finally {
        isSavingMedia.value = false;
    }
};

watch(currentIndex, () => {
    isEditingMedia.value = false;
});

watch(selectedMediaId, () => {
    isEditingMedia.value = false;
});

const mediaDetails = ref<any>(null);
const isLoadingMediaDetails = ref(false);

const fetchMediaDetails = async (mediaId: string) => {
    if (!mediaId) return;
    isLoadingMediaDetails.value = true;
    try {
        const response = await useApi<{ success: boolean; data: any }>(`/media/detail/${mediaId}`);
        if (response && response.success && response.data) {
            mediaDetails.value = response.data;
        }
    } catch (e) {
        console.error("Failed to fetch media details:", e);
    } finally {
        isLoadingMediaDetails.value = false;
    }
};

const activeTab = ref<"details" | "variants">("details");
watch(
    () => currentMediaItem.value?.id,
    (newId) => {
        mediaDetails.value = null;
        activeTab.value = "details";
        if (newId) {
            fetchMediaDetails(newId);
        }
    },
    { immediate: true },
);

const handleRemoveTag = async (tagToRemove: string) => {
    if (!currentMediaItem.value) return;
    const currentTags = mediaDetails.value?.tags || [];
    const newTags = currentTags.filter((t: string) => t !== tagToRemove);

    // Optimistically update local state
    if (mediaDetails.value) {
        mediaDetails.value.tags = newTags;
    }
    if (currentMediaItem.value) {
        currentMediaItem.value.tags = newTags;
    }

    try {
        const res = await store.replaceMediaTags(currentMediaItem.value.id, newTags);
        if (!res || !res.success) {
            throw new Error("Failed to remove tag");
        }
    } catch (err) {
        console.error("Failed to remove tag:", err);
        toast.error("Failed to remove tag");
        // Revert local state
        if (mediaDetails.value) {
            mediaDetails.value.tags = currentTags;
        }
        if (currentMediaItem.value) {
            currentMediaItem.value.tags = currentTags;
        }
    }
};

const handleAddTag = async (tagToAdd: string) => {
    if (!currentMediaItem.value) return;
    const currentTags = mediaDetails.value?.tags || [];
    if (currentTags.includes(tagToAdd)) return;
    const newTags = [...currentTags, tagToAdd];

    // Optimistically update local state
    if (mediaDetails.value) {
        mediaDetails.value.tags = newTags;
    }
    if (currentMediaItem.value) {
        currentMediaItem.value.tags = newTags;
    }

    try {
        const res = await store.replaceMediaTags(currentMediaItem.value.id, newTags);
        if (!res || !res.success) {
            throw new Error("Failed to add tag");
        }
    } catch (err) {
        console.error("Failed to add tag:", err);
        toast.error("Failed to add tag");
        // Revert local state
        if (mediaDetails.value) {
            mediaDetails.value.tags = currentTags;
        }
        if (currentMediaItem.value) {
            currentMediaItem.value.tags = currentTags;
        }
    }
};
</script>

<template>
    <Teleport to="body">
        <Transition name="fade">
            <div v-if="isVisible" class="fixed inset-0 z-[200] flex bg-black/95 backdrop-blur-sm pointer-events-auto">
                <!-- Main Lightbox Area -->
                <div class="flex-1 relative flex items-center justify-center group/lightbox min-w-0">
                    <!-- Close Button -->
                    <button
                        @click="closeLightbox"
                        class="absolute top-4 left-4 p-2 rounded-full bg-black/50 text-white hover:bg-white/20 transition-colors z-[210]"
                    >
                        <X class="w-6 h-6" />
                    </button>

                    <!-- Counter -->
                    <div
                        v-if="displayMode === 'stacked' && postSiblings.length > 1"
                        class="absolute top-4 right-4 px-3 py-1.5 rounded-full bg-black/50 text-white text-sm font-medium z-[210] font-mono tracking-wider backdrop-blur-md"
                    >
                        {{ currentIndex + 1 }} / {{ postSiblings.length }}
                    </div>

                    <!-- Media Carousel -->
                    <div class="w-full h-full">
                        <swiper
                            :slides-per-view="1"
                            :loop="false"
                            :initial-slide="currentIndex"
                            @swiper="onSwiper"
                            @slideChange="onSlideChange"
                            class="w-full h-full"
                        >
                            <swiper-slide
                                v-for="(media, index) in postSiblings"
                                :key="media.id || index"
                                class="flex items-center justify-center"
                            >
                                <div class="w-full h-full flex items-center justify-center p-4 md:p-12">
                                    <div v-if="media.isPlaceholder" class="flex flex-col items-center justify-center gap-2 text-zinc-500">
                                        <Loader2 class="w-8 h-8 animate-spin text-zinc-400" />
                                    </div>
                                    <VideoPlayer
                                        v-else-if="media.type?.toLowerCase() === 'video'"
                                        :src="media.url || media.media_url || ''"
                                        :subtitles="media.subtitles"
                                        :width="media.width"
                                        :height="media.height"
                                        class="max-h-full max-w-full h-full w-auto drop-shadow-2xl rounded-sm"
                                    />
                                    <LivePhotoPlayer
                                        v-else-if="media.type?.toLowerCase() === 'live_photo'"
                                        :src="
                                            getOptimizedImageUrl(media.url || media.media_url || '', {
                                                width: 1920,
                                                fit: 'scale-down',
                                            })
                                        "
                                        :live-src="media.live_url || ''"
                                        :mime-type="media.mime_type || media.mimeType || undefined"
                                        :width="media.width"
                                        :height="media.height"
                                        class="max-h-full max-w-full object-contain drop-shadow-2xl rounded-sm"
                                    />
                                    <HeicImage
                                        v-else
                                        :src="media.url || media.media_url || ''"
                                        :mime-type="media.mime_type || media.mimeType || undefined"
                                        class="max-h-full max-w-full object-contain drop-shadow-2xl rounded-sm"
                                    />
                                </div>
                            </swiper-slide>
                        </swiper>
                    </div>

                    <!-- Navigation Arrows -->
                    <button
                        v-if="currentIndex > 0"
                        class="absolute left-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/lightbox:opacity-100 transition-all hover:bg-black/80 hover:scale-110 z-[210]"
                        @click.stop="scrollPrev"
                    >
                        <ChevronLeft class="w-8 h-8" />
                    </button>
                    <button
                        v-if="currentIndex < postSiblings.length - 1"
                        class="absolute right-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/lightbox:opacity-100 transition-all hover:bg-black/80 hover:scale-110 z-[210]"
                        @click.stop="scrollNext"
                    >
                        <ChevronRight class="w-8 h-8" />
                    </button>

                    <!-- Bottom Filmstrip (Only for Stacked mode with siblings) -->
                    <div
                        v-if="displayMode === 'stacked' && postSiblings.length > 1"
                        class="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 p-2 bg-black/50 backdrop-blur-md rounded-xl z-[210] max-w-[80%] overflow-x-auto custom-scrollbar"
                    >
                        <div
                            v-for="(media, index) in postSiblings"
                            :key="media.id || index"
                            @click="swiperInstance?.slideTo(index)"
                            class="w-12 h-12 shrink-0 rounded-md overflow-hidden border-2 cursor-pointer transition-all hover:opacity-100"
                            :class="index === currentIndex ? 'border-white opacity-100' : 'border-transparent opacity-50'"
                        >
                            <div v-if="media.isPlaceholder" class="w-full h-full bg-zinc-900 flex items-center justify-center">
                                <Loader2 class="w-3 h-3 animate-spin text-zinc-500" />
                            </div>
                            <HeicImage
                                v-else-if="media.type?.toLowerCase() !== 'video'"
                                :src="
                                    getOptimizedImageUrl(media.url || media.media_url || '', {
                                        width: 320,
                                        height: 240,
                                        fit: 'cover',
                                        gravity: 'auto',
                                    })
                                "
                                :mime-type="media.mime_type || media.mimeType || undefined"
                                class="w-full h-full object-cover"
                            />
                            <div v-else class="w-full h-full bg-gray-800 flex items-center justify-center text-white text-xs">VID</div>
                        </div>
                    </div>
                </div>

                <!-- Resizing Overlay to prevent iframe/video event stealing -->
                <div v-if="isResizing" class="fixed inset-0 z-[300] cursor-col-resize select-none"></div>

                <!-- Resize Drag Handle -->
                <div
                    @mousedown="startResize"
                    class="w-1 hover:w-1.5 bg-zinc-200/50 hover:bg-indigo-500/50 cursor-col-resize h-full shrink-0 relative z-[220] transition-all hidden md:block"
                    :class="isResizing ? 'bg-indigo-500/70 w-1.5' : ''"
                ></div>

                <!-- Right Sidebar (Info & Provenance) -->
                <div
                    :style="{ width: `${sidebarWidth}px` }"
                    class="bg-white h-full shrink-0 flex flex-col shadow-2xl relative z-[210] overflow-hidden hidden md:flex"
                >
                    <div class="p-5 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between shrink-0">
                        <h3 class="font-semibold text-gray-900 flex items-center gap-2">
                            <Info class="w-4 h-4 text-blue-500" />
                            {{ $t("common.details", "Asset Details") }}
                        </h3>
                        <button
                            v-if="!isEditingMedia && activeTab === 'details'"
                            @click="startEditingMedia"
                            class="px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-md transition-colors cursor-pointer"
                        >
                            {{ $t("common.edit") }}
                        </button>
                    </div>

                    <!-- Tab Bar -->
                    <div class="flex border-b border-gray-100 bg-gray-50/50 px-5 gap-6 h-12 items-center text-xs shrink-0 select-none">
                        <button
                            @click="activeTab = 'details'"
                            class="font-semibold uppercase tracking-wider transition-colors relative h-full flex items-center cursor-pointer"
                            :class="
                                activeTab === 'details' ? 'text-zinc-900 border-b-2 border-zinc-800' : 'text-zinc-400 hover:text-zinc-700'
                            "
                        >
                            {{ $t("common.details", "Details") }}
                        </button>
                        <button
                            @click="activeTab = 'variants'"
                            class="font-semibold uppercase tracking-wider transition-colors relative h-full flex items-center cursor-pointer"
                            :class="
                                activeTab === 'variants' ? 'text-zinc-900 border-b-2 border-zinc-800' : 'text-zinc-400 hover:text-zinc-700'
                            "
                        >
                            {{ $t("common.variants", "Variants") }}
                        </button>
                    </div>

                    <div v-if="activeTab === 'details'" key="tab-details" class="p-5 space-y-6 flex-1 overflow-y-auto custom-scrollbar">
                        <!-- Basic Info -->
                        <div class="space-y-4">
                            <div>
                                <label class="text-[10px] uppercase text-gray-400 font-bold tracking-wider mb-1 block">Title</label>
                                <input
                                    v-if="isEditingMedia"
                                    type="text"
                                    v-model="editMediaTitle"
                                    class="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-md focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none bg-white text-gray-900"
                                    placeholder="Enter title"
                                />
                                <div v-else class="text-sm font-medium text-gray-900 break-words">
                                    {{ currentMediaItem?.title || "Untitled Asset" }}
                                </div>
                            </div>

                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="text-[10px] uppercase text-gray-400 font-bold tracking-wider mb-1 block">Type</label>
                                    <div class="flex items-center gap-1.5 text-sm text-gray-700 bg-gray-100 w-fit px-2 py-0.5 rounded">
                                        <FileImage class="w-3.5 h-3.5 text-gray-500" />
                                        <span class="capitalize">{{ currentMediaItem?.type || "Image" }}</span>
                                    </div>
                                </div>
                                <div>
                                    <label class="text-[10px] uppercase text-gray-400 font-bold tracking-wider mb-1 block">Source</label>
                                    <div class="text-sm text-gray-700">
                                        {{ currentMediaItem?.source || "Local" }}
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label class="text-[10px] uppercase text-gray-400 font-bold tracking-wider mb-1 block"
                                    >Published Time</label
                                >
                                <input
                                    v-if="isEditingMedia"
                                    type="datetime-local"
                                    v-model="editMediaPublishedTime"
                                    class="w-full px-2 py-1 text-xs border border-gray-200 rounded-md focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none bg-white text-gray-900"
                                />
                                <div v-else class="text-sm text-gray-700">
                                    {{ formatDate(currentPublishedTime || "") }}
                                </div>
                            </div>

                            <!-- Save / Cancel Buttons -->
                            <div v-if="isEditingMedia" class="flex items-center gap-2 justify-end pt-2">
                                <button
                                    @click="cancelEditingMedia"
                                    class="px-2.5 py-1 text-xs font-semibold text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded transition-colors cursor-pointer"
                                    :disabled="isSavingMedia"
                                >
                                    {{ $t("common.cancel") }}
                                </button>
                                <button
                                    @click="saveEditingMedia"
                                    class="px-2.5 py-1 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded shadow-sm transition-colors cursor-pointer flex items-center gap-1"
                                    :disabled="isSavingMedia"
                                >
                                    <Loader2 v-if="isSavingMedia" class="w-3 animate-spin" />
                                    {{ $t("common.save") }}
                                </button>
                            </div>
                        </div>

                        <hr class="border-gray-100" />

                        <!-- Tags -->
                        <div class="space-y-3">
                            <label class="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                                <Tag class="w-3 h-3 text-gray-400" /> {{ $t("common.tags", "Tags") }}
                            </label>
                            <div v-if="isLoadingMediaDetails" class="text-xs text-zinc-400 flex items-center gap-1.5 py-1">
                                <Loader2 class="w-3 h-3 animate-spin text-indigo-500" />
                                <span>Loading tags...</span>
                            </div>
                            <TagEditor v-else :tags="mediaDetails?.tags || []" @add-tag="handleAddTag" @remove-tag="handleRemoveTag" />
                        </div>

                        <hr class="border-gray-100" />

                        <!-- Match Details -->
                        <div
                            v-if="currentMediaItem?.matched_details"
                            class="space-y-4 bg-gray-50/50 dark:bg-gray-900/10 p-4 rounded-xl border border-gray-100/80 dark:border-gray-800/40"
                        >
                            <h4
                                class="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2 flex items-center gap-1.5"
                            >
                                <Sparkles class="w-3.5 h-3.5 text-amber-500 fill-amber-500/20" />
                                {{ $t("search.matched_reason") }}
                            </h4>

                            <!-- Keyword Dimension -->
                            <div v-if="currentMediaItem.matched_details.keyword" class="space-y-1">
                                <div class="flex items-center gap-1.5">
                                    <span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                                    <span class="text-xs font-semibold text-gray-950 dark:text-gray-50">{{
                                        $t("search.keyword_search")
                                    }}</span>
                                </div>
                                <p class="text-[11px] text-gray-500 dark:text-gray-400 pl-3 leading-relaxed">
                                    {{ $t("search.keyword_search_tooltip") }}
                                </p>
                            </div>

                            <!-- Text Embedding Dimension -->
                            <div v-if="currentMediaItem.matched_details.text_semantic" class="space-y-1">
                                <div class="flex items-center justify-between gap-1.5">
                                    <div class="flex items-center gap-1.5">
                                        <span class="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
                                        <span class="text-xs font-semibold text-gray-950 dark:text-gray-50">{{
                                            $t("search.text_embedding")
                                        }}</span>
                                    </div>
                                    <span
                                        class="text-[10px] font-mono bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 px-1.5 py-0.5 rounded border border-purple-100/30"
                                    >
                                        d={{ currentMediaItem.matched_details.text_semantic.distance?.toFixed(4) }}
                                    </span>
                                </div>
                                <p
                                    v-if="currentMediaItem.matched_details.text_semantic.caption"
                                    class="text-[11px] text-gray-600 dark:text-gray-400 pl-3 italic border-l-2 border-purple-100 dark:border-purple-900/30 my-1 py-0.5 leading-relaxed"
                                >
                                    "{{ currentMediaItem.matched_details.text_semantic.caption }}"
                                </p>
                            </div>

                            <!-- Image Embedding Dimension -->
                            <div v-if="currentMediaItem.matched_details.visual_semantic" class="space-y-1">
                                <div class="flex items-center justify-between gap-1.5">
                                    <div class="flex items-center gap-1.5">
                                        <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                                        <span class="text-xs font-semibold text-gray-950 dark:text-gray-50">{{
                                            $t("search.image_embedding")
                                        }}</span>
                                    </div>
                                    <span
                                        class="text-[10px] font-mono bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded border border-amber-100/30"
                                    >
                                        d={{ currentMediaItem.matched_details.visual_semantic.distance?.toFixed(4) }}
                                    </span>
                                </div>
                                <div
                                    v-if="
                                        currentMediaItem.matched_details.visual_semantic.scene ||
                                        currentMediaItem.matched_details.visual_semantic.styles?.length
                                    "
                                    class="text-[11px] text-gray-600 dark:text-gray-400 pl-3 space-y-1 leading-relaxed"
                                >
                                    <div v-if="currentMediaItem.matched_details.visual_semantic.scene">
                                        <span class="text-gray-400 dark:text-gray-500">{{ $t("search.scene") }}:</span>
                                        {{ currentMediaItem.matched_details.visual_semantic.scene }}
                                    </div>
                                    <div v-if="currentMediaItem.matched_details.visual_semantic.styles?.length">
                                        <span class="text-gray-400 dark:text-gray-500">{{ $t("search.styles") }}:</span>
                                        <div class="flex flex-wrap gap-1 mt-0.5">
                                            <span
                                                v-for="style in currentMediaItem.matched_details.visual_semantic.styles"
                                                :key="style"
                                                class="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded text-[10px]"
                                            >
                                                {{ style }}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <hr class="border-gray-100" />

                        <!-- Actions (Regenerate Cover) -->
                        <div v-if="isVideo" class="space-y-3">
                            <label class="text-xs uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                                <Info class="w-3.5 h-3.5" />
                                {{ $t("media.actions.regenerate_cover", "Regenerate Cover") }}
                            </label>
                            <button
                                :disabled="!currentMediaItem || regeneratingCoverMediaId === currentMediaItem.id"
                                @click="currentMediaItem && handleRegenerateCover(currentMediaItem.id)"
                                class="w-full flex items-center justify-center gap-2 px-4 py-2 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none"
                            >
                                <Loader2
                                    v-if="currentMediaItem && regeneratingCoverMediaId === currentMediaItem.id"
                                    class="w-4 h-4 animate-spin text-gray-500"
                                />
                                <FileImage v-else class="w-4 h-4 text-gray-500" />
                                <span>
                                    {{
                                        currentMediaItem && regeneratingCoverMediaId === currentMediaItem.id
                                            ? $t("media.cover.loading", "Requesting...")
                                            : $t("media.actions.regenerate_cover", "Regenerate Cover")
                                    }}
                                </span>
                            </button>
                        </div>

                        <hr v-if="isVideo" class="border-gray-100" />

                        <!-- Provenance / Part of Post (The Wormhole) -->
                        <div v-if="postDetail || isLoadingPost" class="space-y-3">
                            <label class="text-xs uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                                <Layers class="w-3.5 h-3.5" /> Part of Post
                            </label>

                            <div v-if="isLoadingPost" class="border border-zinc-100 rounded-xl p-4 space-y-3 animate-pulse">
                                <div class="flex items-center gap-2">
                                    <div class="w-6 h-6 rounded-full bg-zinc-200"></div>
                                    <div class="h-4 bg-zinc-200 rounded w-1/3"></div>
                                </div>
                                <div class="space-y-2">
                                    <div class="h-3 bg-zinc-200 rounded w-full"></div>
                                    <div class="h-3 bg-zinc-200 rounded w-5/6"></div>
                                </div>
                            </div>
                            <div
                                v-else-if="postDetail"
                                class="bg-blue-50/50 border border-blue-100 rounded-xl p-4 transition-all hover:bg-blue-50 cursor-pointer"
                                @click="navigateTo(`/posts/${postDetail.id}`)"
                            >
                                <div class="flex items-center gap-2 mb-2">
                                    <img
                                        v-if="postDetail.author_avatar_url"
                                        :src="postDetail.author_avatar_url"
                                        alt="avatar"
                                        class="w-6 h-6 rounded-full object-cover shrink-0"
                                        loading="lazy"
                                    />
                                    <div
                                        v-else
                                        class="w-6 h-6 rounded-full bg-white shadow-sm flex items-center justify-center text-xs font-bold text-blue-600 shrink-0"
                                    >
                                        {{ postDetail.author_name?.charAt(0) || "A" }}
                                    </div>
                                    <span class="text-sm font-semibold text-gray-900 truncate">{{
                                        postDetail.author_name || "Unknown Author"
                                    }}</span>
                                </div>
                                <p class="text-xs text-gray-600 line-clamp-3 leading-relaxed">
                                    {{ postDetail.description || postDetail.title || "View the original post context." }}
                                </p>
                                <div class="mt-3 flex items-center text-blue-600 text-xs font-medium gap-1">
                                    View Full Post
                                    <ChevronRight class="w-3 h-3" />
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Variants panel -->
                    <div v-if="activeTab === 'variants'" key="tab-variants" class="flex-1 flex flex-col overflow-hidden min-h-0 bg-white">
                        <MediaVariantsManager v-if="currentMediaItem" :media-id="currentMediaItem.id" />
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
    opacity: 0;
}

.custom-scrollbar::-webkit-scrollbar {
    height: 6px;
}

.custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.2);
    border-radius: 10px;
}
</style>
