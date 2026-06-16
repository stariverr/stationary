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
} from "@lucide/vue";
import { useMediaStore } from "@/stores/media";
import { toast } from "@/components/ui/sonner";
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

const handleRegenerateCover = async (mediaId: string) => {
    if (!mediaId) return;
    regeneratingCoverMediaId.value = mediaId;
    try {
        const response = await useApi<any>(`/media/${mediaId}/regenerate-cover`, {
            method: "POST",
        });
        if (response && response.success) {
            const status = response.data.status;
            if (status === "queued") {
                toast.success(t("media.cover.queued", "Video cover regeneration has been queued."));
            } else if (status === "already_pending") {
                toast.info(
                    t("media.cover.already_pending", "A cover generation task is already pending."),
                );
            } else if (status === "skipped") {
                const reason = response.data.reason;
                if (reason === "external_cover_exists") {
                    toast.warning(
                        t(
                            "media.cover.external_exists",
                            "This video already has an external cover and it was not overwritten.",
                        ),
                    );
                } else {
                    toast.warning(reason || t("media.cover.failed", "Skipped cover generation."));
                }
            }
        } else {
            throw new Error(response?.message || "Failed to request cover generation");
        }
    } catch (err: any) {
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

// Sibling media within a post (for Stacked mode)
const postSiblings = ref<any[]>([]);
const postDetail = ref<any>(null);
const isLoadingPost = ref(false);

const currentIndex = ref(0);
const swiperInstance = ref<any>(null);

const onSwiper = (swiper: any) => {
    swiperInstance.value = swiper;
    // Do not reset currentIndex here, as it may overwrite the watch logic
};

const onSlideChange = (swiper: any) => {
    currentIndex.value = swiper.activeIndex;
};

const mapMediaWithSubtitles = (m: any) => {
    if (!m) return null;
    const subtitleTracks = (m.tracks || []).filter((t: any) => t.role === "SUBTITLE");
    return {
        ...m,
        url: m.url || m.primary_file_url || m.media_url || null,
        subtitles: subtitleTracks.map((sub: any) => ({
            url: sub.url,
            language: sub.metadata?.language || "unknown",
            label: sub.metadata?.label || sub.metadata?.language || "unknown",
            format: sub.metadata?.format === "json" ? "vtt" : sub.metadata?.format || "vtt",
        })),
    };
};

watch(selectedMediaId, async (newId) => {
    if (!newId) {
        postSiblings.value = [];
        postDetail.value = null;
        return;
    }

    // In Stacked mode, if there is a post_id, fetch its siblings
    if (displayMode.value === "stacked" && selectedMedia.value?.post_id) {
        isLoadingPost.value = true;
        try {
            const response = await useApi<any>(`/post/detail/${selectedMedia.value.post_id}`);
            if (response && response.success && response.data) {
                postDetail.value = response.data;
                // Map the post's media list to include valid URLs
                postSiblings.value = (response.data.media || [])
                    .map(mapMediaWithSubtitles)
                    .filter(Boolean);
            } else {
                postSiblings.value = selectedMedia.value
                    ? [mapMediaWithSubtitles(selectedMedia.value)]
                    : [];
            }
        } catch (e) {
            postSiblings.value = selectedMedia.value
                ? [mapMediaWithSubtitles(selectedMedia.value)]
                : [];
        } finally {
            isLoadingPost.value = false;
        }

        // Find current index
        const index = postSiblings.value.findIndex((m) => m.id === newId);
        currentIndex.value = Math.max(0, index);
        nextTick(() => {
            if (swiperInstance.value) swiperInstance.value.slideTo(currentIndex.value, 0);
        });
    } else {
        // Flat mode or independent media
        postSiblings.value = medias.value.map(mapMediaWithSubtitles).filter(Boolean);
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

onMounted(() => {
    window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
    window.removeEventListener("keydown", handleKeydown);
});

const currentMediaItem = computed(() => {
    return postSiblings.value[currentIndex.value] || selectedMedia.value;
});

const currentPublishedTime = computed(() => {
    return (
        currentMediaItem.value?.published_time ||
        currentMediaItem.value?.date ||
        currentMediaItem.value?.create_time
    );
});

const isVideo = computed(() => currentMediaItem.value?.type?.toLowerCase() === "video");

const formatDate = (dateStr: string) => {
    if (!dateStr) return "Unknown";
    try {
        return Temporal.Instant.from(dateStr)
            .toZonedDateTimeISO(Temporal.Now.timeZoneId())
            .toLocaleString(undefined, {
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
</script>

<template>
    <Teleport to="body">
        <Transition name="fade">
            <div
                v-if="isVisible"
                class="fixed inset-0 z-[200] flex bg-black/95 backdrop-blur-sm pointer-events-auto"
            >
                <!-- Main Lightbox Area -->
                <div
                    class="flex-1 relative flex items-center justify-center group/lightbox min-w-0"
                >
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
                                <div
                                    class="w-full h-full flex items-center justify-center p-4 md:p-12"
                                >
                                    <VideoPlayer
                                        v-if="media.type?.toLowerCase() === 'video'"
                                        :src="media.url || media.media_url"
                                        :subtitles="media.subtitles"
                                        :width="media.width"
                                        :height="media.height"
                                        class="max-h-full max-w-full h-full w-auto drop-shadow-2xl rounded-sm"
                                    />
                                    <img
                                        v-else
                                        :src="media.url || media.media_url"
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
                            :class="
                                index === currentIndex
                                    ? 'border-white opacity-100'
                                    : 'border-transparent opacity-50'
                            "
                        >
                            <img
                                v-if="media.type?.toLowerCase() !== 'video'"
                                :src="
                                    getOptimizedImageUrl(media.url || media.media_url, {
                                        width: 320,
                                        height: 240,
                                        fit: 'cover',
                                        gravity: 'auto',
                                    })
                                "
                                class="w-full h-full object-cover"
                            />
                            <div
                                v-else
                                class="w-full h-full bg-gray-800 flex items-center justify-center text-white text-xs"
                            >
                                VID
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Right Sidebar (Info & Provenance) -->
                <div
                    class="w-[320px] bg-white h-full shrink-0 flex flex-col shadow-2xl relative z-[210] overflow-y-auto hidden md:flex"
                >
                    <div class="p-5 border-b border-gray-100 bg-gray-50/50">
                        <h3 class="font-semibold text-gray-900 flex items-center gap-2">
                            <Info class="w-4 h-4 text-blue-500" />
                            {{ $t("common.details", "Asset Details") }}
                        </h3>
                    </div>

                    <div class="p-5 space-y-6 flex-1">
                        <!-- Basic Info -->
                        <div class="space-y-4">
                            <div>
                                <label
                                    class="text-[10px] uppercase text-gray-400 font-bold tracking-wider mb-1 block"
                                    >Title</label
                                >
                                <div class="text-sm font-medium text-gray-900 break-words">
                                    {{ currentMediaItem?.title || "Untitled Asset" }}
                                </div>
                            </div>

                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label
                                        class="text-[10px] uppercase text-gray-400 font-bold tracking-wider mb-1 block"
                                        >Type</label
                                    >
                                    <div
                                        class="flex items-center gap-1.5 text-sm text-gray-700 bg-gray-100 w-fit px-2 py-0.5 rounded"
                                    >
                                        <FileImage class="w-3.5 h-3.5 text-gray-500" />
                                        <span class="capitalize">{{
                                            currentMediaItem?.type || "Image"
                                        }}</span>
                                    </div>
                                </div>
                                <div>
                                    <label
                                        class="text-[10px] uppercase text-gray-400 font-bold tracking-wider mb-1 block"
                                        >Source</label
                                    >
                                    <div class="text-sm text-gray-700">
                                        {{ currentMediaItem?.source || "Local" }}
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label
                                    class="text-[10px] uppercase text-gray-400 font-bold tracking-wider mb-1 block"
                                    >Published Time</label
                                >
                                <div class="text-sm text-gray-700">
                                    {{ formatDate(currentPublishedTime) }}
                                </div>
                            </div>
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
                                    <span
                                        class="text-xs font-semibold text-gray-950 dark:text-gray-50"
                                        >{{ $t("search.keyword_search") }}</span
                                    >
                                </div>
                                <p
                                    class="text-[11px] text-gray-500 dark:text-gray-400 pl-3 leading-relaxed"
                                >
                                    {{ $t("search.keyword_search_tooltip") }}
                                </p>
                            </div>

                            <!-- Text Embedding Dimension -->
                            <div
                                v-if="currentMediaItem.matched_details.text_semantic"
                                class="space-y-1"
                            >
                                <div class="flex items-center justify-between gap-1.5">
                                    <div class="flex items-center gap-1.5">
                                        <span class="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
                                        <span
                                            class="text-xs font-semibold text-gray-950 dark:text-gray-50"
                                            >{{ $t("search.text_embedding") }}</span
                                        >
                                    </div>
                                    <span
                                        class="text-[10px] font-mono bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 px-1.5 py-0.5 rounded border border-purple-100/30"
                                    >
                                        d={{
                                            currentMediaItem.matched_details.text_semantic.distance?.toFixed(
                                                4,
                                            )
                                        }}
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
                            <div
                                v-if="currentMediaItem.matched_details.visual_semantic"
                                class="space-y-1"
                            >
                                <div class="flex items-center justify-between gap-1.5">
                                    <div class="flex items-center gap-1.5">
                                        <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                                        <span
                                            class="text-xs font-semibold text-gray-950 dark:text-gray-50"
                                            >{{ $t("search.image_embedding") }}</span
                                        >
                                    </div>
                                    <span
                                        class="text-[10px] font-mono bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded border border-amber-100/30"
                                    >
                                        d={{
                                            currentMediaItem.matched_details.visual_semantic.distance?.toFixed(
                                                4,
                                            )
                                        }}
                                    </span>
                                </div>
                                <div
                                    v-if="
                                        currentMediaItem.matched_details.visual_semantic.scene ||
                                        currentMediaItem.matched_details.visual_semantic.styles
                                            ?.length
                                    "
                                    class="text-[11px] text-gray-600 dark:text-gray-400 pl-3 space-y-1 leading-relaxed"
                                >
                                    <div
                                        v-if="
                                            currentMediaItem.matched_details.visual_semantic.scene
                                        "
                                    >
                                        <span class="text-gray-400 dark:text-gray-500"
                                            >{{ $t("search.scene") }}:</span
                                        >
                                        {{ currentMediaItem.matched_details.visual_semantic.scene }}
                                    </div>
                                    <div
                                        v-if="
                                            currentMediaItem.matched_details.visual_semantic.styles
                                                ?.length
                                        "
                                    >
                                        <span class="text-gray-400 dark:text-gray-500"
                                            >{{ $t("search.styles") }}:</span
                                        >
                                        <div class="flex flex-wrap gap-1 mt-0.5">
                                            <span
                                                v-for="style in currentMediaItem.matched_details
                                                    .visual_semantic.styles"
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
                            <label
                                class="text-xs uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5"
                            >
                                <Info class="w-3.5 h-3.5" />
                                {{ $t("media.actions.regenerate_cover", "Regenerate Cover") }}
                            </label>
                            <button
                                :disabled="regeneratingCoverMediaId === currentMediaItem.id"
                                @click="handleRegenerateCover(currentMediaItem.id)"
                                class="w-full flex items-center justify-center gap-2 px-4 py-2 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none"
                            >
                                <Loader2
                                    v-if="regeneratingCoverMediaId === currentMediaItem.id"
                                    class="w-4 h-4 animate-spin text-gray-500"
                                />
                                <FileImage v-else class="w-4 h-4 text-gray-500" />
                                <span>
                                    {{
                                        regeneratingCoverMediaId === currentMediaItem.id
                                            ? $t("media.cover.loading", "Requesting...")
                                            : $t(
                                                  "media.actions.regenerate_cover",
                                                  "Regenerate Cover",
                                              )
                                    }}
                                </span>
                            </button>
                        </div>

                        <hr v-if="isVideo" class="border-gray-100" />

                        <!-- Provenance / Part of Post (The Wormhole) -->
                        <div v-if="postDetail" class="space-y-3">
                            <label
                                class="text-xs uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5"
                            >
                                <Layers class="w-3.5 h-3.5" /> Part of Post
                            </label>

                            <div
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
                                        {{ postDetail.author?.charAt(0) || "A" }}
                                    </div>
                                    <span class="text-sm font-semibold text-gray-900 truncate">{{
                                        postDetail.author || "Unknown Author"
                                    }}</span>
                                </div>
                                <p class="text-xs text-gray-600 line-clamp-3 leading-relaxed">
                                    {{
                                        postDetail.description ||
                                        postDetail.title ||
                                        "View the original post context."
                                    }}
                                </p>
                                <div
                                    class="mt-3 flex items-center text-blue-600 text-xs font-medium gap-1"
                                >
                                    View Full Post
                                    <ChevronRight class="w-3 h-3" />
                                </div>
                            </div>
                        </div>
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
