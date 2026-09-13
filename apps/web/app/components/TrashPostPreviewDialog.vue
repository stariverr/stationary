<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import {
    X,
    ChevronLeft,
    ChevronRight,
    RotateCcw,
    Trash2,
    Loader2,
    Layers,
    ExternalLink,
    AlertTriangle,
    Image as ImageIcon,
    Video as VideoIcon,
    FileText,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import HeicImage from "./HeicImage.vue";
import { isHeic } from "@/utils/heic-decoder";
import type { TrashItem, TrashPostItem } from "@/stores/trash";
import type { MediaType, PostMediaSummary } from "@/types/post";
import { useApi } from "@/composables/useApi";
import { getMediaTypeLabel } from "@/utils/media";
import { Temporal } from "@js-temporal/polyfill";

const props = defineProps<{
    open: boolean;
    item: TrashItem | null;
}>();

const emit = defineEmits<{
    "update:open": [value: boolean];
    restore: [item: TrashItem];
    delete: [item: TrashItem];
}>();

const { t, te, locale } = useI18n();

const formatSource = (source?: string | null): string => {
    if (!source) return "";
    const key = `platforms.${source}`;
    return te(key) ? t(key) : source;
};

const getItemTitle = (item: TrashItem | null): string => {
    if (!item) return "";
    const title = item.title?.trim();
    if (title && title.toLowerCase() !== "untitled") return title;
    const desc = item.description?.trim();
    if (desc) return desc;
    return item.item_type === "post" ? t("trash.untitled_post") : t("trash.untitled_media");
};

const formatRecycleTime = (isoString: string | null | undefined): string => {
    if (!isoString) return "";
    try {
        return Temporal.Instant.from(isoString).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(locale.value, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    } catch {
        return isoString;
    }
};

const formatMediaType = (type?: string | null): string => {
    return getMediaTypeLabel(type, t);
};

interface PreviewMediaItem {
    id: string;
    type: MediaType | string;
    title: string | null;
    url: string | null;
    cover_url: string | null;
    tracks?: Array<{ url: string; purpose?: string; type?: string }>;
}

const isLoading = ref(false);
const mediaList = ref<PreviewMediaItem[]>([]);
const currentIndex = ref(0);

const isPost = computed(() => props.item?.item_type === "post");
const postItem = computed<TrashPostItem | null>(() => (isPost.value ? (props.item as TrashPostItem) : null));

const currentMedia = computed<PreviewMediaItem | null>(() => {
    if (mediaList.value.length === 0) return null;
    return mediaList.value[currentIndex.value] ?? mediaList.value[0] ?? null;
});

const canPrevious = computed(() => currentIndex.value > 0);
const canNext = computed(() => currentIndex.value < mediaList.value.length - 1);

const close = () => {
    emit("update:open", false);
};

const previous = () => {
    if (canPrevious.value) {
        currentIndex.value--;
    }
};

const next = () => {
    if (canNext.value) {
        currentIndex.value++;
    }
};

const handleRestore = () => {
    if (!props.item) return;
    emit("restore", props.item);
};

const handleDelete = () => {
    if (!props.item) return;
    emit("delete", props.item);
};

const getMediaDisplayUrl = (media: PreviewMediaItem | null): string => {
    if (!media) return "";
    if (media.url) return media.url;
    if (media.tracks && media.tracks.length > 0) {
        const contentTrack = media.tracks.find((t) => t.purpose === "CONTENT");
        if (contentTrack?.url) return contentTrack.url;
    }
    return media.cover_url || "";
};

const getThumbUrl = (media: PreviewMediaItem): string => {
    if (media.cover_url) return media.cover_url;
    if (media.tracks && media.tracks.length > 0) {
        const coverTrack = media.tracks.find((t) => t.purpose === "COVER");
        if (coverTrack?.url) return coverTrack.url;
    }
    return media.url || "";
};

const fetchPostMedia = async (postId: string) => {
    isLoading.value = true;
    try {
        const res = await useApi<{
            success: boolean;
            data: {
                list: PostMediaSummary[];
                total: number;
            };
        }>(`/post/${postId}/media`, {
            query: { limit: 100 },
        });

        if (res && res.success && res.data?.list) {
            mediaList.value = res.data.list.map((m) => ({
                id: m.id,
                type: m.type,
                title: m.title || null,
                url: m.url || null,
                cover_url: m.cover_url || null,
                tracks: m.tracks || [],
            }));
        }
    } catch (err) {
        console.error("Failed to load trashed post media:", err);
    } finally {
        isLoading.value = false;
    }
};

watch(
    () => [props.open, props.item] as const,
    ([isOpen, item]) => {
        if (!isOpen || !item) {
            mediaList.value = [];
            currentIndex.value = 0;
            return;
        }

        currentIndex.value = 0;

        if (item.item_type === "post") {
            // Seed first cover as placeholder for instant feedback
            const firstCover = item.covers?.[0];
            const initialCover = firstCover?.url || firstCover?.thumbnail || null;
            if (initialCover && firstCover) {
                mediaList.value = [
                    {
                        id: firstCover.id || "initial-cover",
                        type: "IMAGE",
                        title: item.title,
                        url: initialCover,
                        cover_url: initialCover,
                    },
                ];
            } else {
                mediaList.value = [];
            }

            void fetchPostMedia(item.id);
        } else {
            // Standalone media item
            const firstCover = item.covers?.[0];
            const mediaUrl = item.url || firstCover?.url || firstCover?.thumbnail || null;
            mediaList.value = [
                {
                    id: item.id,
                    type: item.type,
                    title: item.title || item.description || null,
                    url: mediaUrl,
                    cover_url: firstCover?.thumbnail || firstCover?.url || mediaUrl,
                },
            ];
            isLoading.value = false;
        }
    },
    { immediate: true },
);

// Keyboard navigation
const handleKeydown = (e: KeyboardEvent) => {
    if (!props.open) return;

    if (e.key === "Escape") {
        close();
    } else if (e.key === "ArrowLeft") {
        previous();
    } else if (e.key === "ArrowRight") {
        next();
    }
};

onMounted(() => {
    window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
    window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
    <div
        v-if="open && item"
        class="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 text-zinc-100 backdrop-blur-md select-none transition-opacity duration-200"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('trash.preview.title')"
    >
        <!-- Top Toolbar Strip -->
        <header
            class="h-14 sm:h-16 px-4 sm:px-6 shrink-0 border-b border-zinc-800/80 flex items-center justify-between gap-3 sm:gap-4 bg-zinc-950/90 z-20"
        >
            <!-- Left: Status badge & Title / Author info -->
            <div class="flex items-center gap-2.5 sm:gap-3.5 min-w-0 flex-1">
                <span
                    class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 tracking-tight"
                >
                    <AlertTriangle class="w-3 h-3 text-amber-400" />
                    <span>{{ $t("trash.preview.badge") }}</span>
                </span>

                <div class="min-w-0 flex flex-col justify-center">
                    <div class="flex items-center gap-2">
                        <h2 class="text-xs sm:text-sm font-bold text-zinc-100 truncate max-w-xs sm:max-w-md md:max-w-lg">
                            {{ getItemTitle(item) }}
                        </h2>
                    </div>

                    <div class="flex items-center gap-2 text-xs text-zinc-400 mt-0.5 truncate">
                        <span v-if="postItem?.author_name" class="font-medium text-zinc-300 truncate">
                            {{ postItem.author_name }}
                        </span>
                        <span
                            v-if="item.source && item.source !== 'UNKNOWN'"
                            class="text-xs px-1 py-0.2 bg-zinc-800 text-zinc-400 rounded-sm border border-zinc-700/60"
                        >
                            {{ formatSource(item.source) }}
                        </span>
                        <span class="text-zinc-500">•</span>
                        <span class="font-mono text-zinc-400 text-xs tabular-nums">
                            {{ formatRecycleTime(item.recycle_time) }}
                        </span>
                    </div>
                </div>
            </div>

            <!-- Right: Counter & Actions -->
            <div class="flex items-center gap-2 sm:gap-3 shrink-0">
                <!-- Media Counter -->
                <span
                    v-if="mediaList.length > 1"
                    class="hidden sm:inline-flex items-center px-2.5 py-1 rounded-md text-xs font-mono font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 tabular-nums shadow-xs"
                >
                    {{ currentIndex + 1 }} / {{ mediaList.length }}
                </span>

                <!-- Restore Button -->
                <Button
                    @click="handleRestore"
                    variant="outline"
                    class="h-8.5 px-3 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 hover:text-white border-zinc-700 rounded-lg text-xs font-bold gap-1.5 shadow-xs cursor-pointer active:scale-95 transition-all"
                >
                    <RotateCcw class="w-3.5 h-3.5 text-zinc-400" />
                    <span>{{ $t("trash.preview.restore") }}</span>
                </Button>

                <!-- Permanent Delete Button -->
                <Button
                    @click="handleDelete"
                    variant="destructive"
                    class="h-8.5 px-3 bg-red-600/90 hover:bg-red-600 text-white rounded-lg text-xs font-bold gap-1.5 shadow-xs cursor-pointer active:scale-95 transition-all"
                >
                    <Trash2 class="w-3.5 h-3.5" />
                    <span>{{ $t("trash.preview.permanent_delete") }}</span>
                </Button>

                <div class="h-4 w-[1px] bg-zinc-800 mx-0.5" />

                <!-- Close Button -->
                <button
                    type="button"
                    @click="close"
                    class="w-8.5 h-8.5 rounded-lg flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-all cursor-pointer active:scale-95"
                    :title="$t('common.close')"
                >
                    <X class="w-5 h-5" />
                </button>
            </div>
        </header>

        <!-- Main Media Stage -->
        <main class="flex-1 min-h-0 relative flex items-center justify-center p-4 sm:p-6 overflow-hidden">
            <!-- Left Chevron -->
            <button
                v-if="mediaList.length > 1"
                type="button"
                @click="previous"
                :disabled="!canPrevious"
                class="absolute left-3 sm:left-6 z-30 w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 flex items-center justify-center shadow-xl backdrop-blur-sm cursor-pointer disabled:opacity-20 disabled:pointer-events-none active:scale-95 transition-all"
                :aria-label="$t('common.previous')"
            >
                <ChevronLeft class="w-5 h-5" />
            </button>

            <!-- Media Viewport -->
            <div class="relative w-full h-full flex items-center justify-center">
                <!-- Loading State -->
                <div v-if="isLoading && mediaList.length === 0" class="flex flex-col items-center justify-center gap-3 text-zinc-400">
                    <Loader2 class="w-8 h-8 animate-spin text-zinc-500" />
                    <span class="text-xs font-medium">{{ $t("trash.preview.loading") }}</span>
                </div>

                <!-- Empty State -->
                <div v-else-if="!currentMedia" class="flex flex-col items-center justify-center gap-2 text-zinc-500">
                    <FileText class="w-10 h-10 stroke-[1.5]" />
                    <span class="text-xs font-medium">{{ $t("trash.preview.no_media") }}</span>
                </div>

                <!-- Active Image View -->
                <div
                    v-else-if="currentMedia.type === 'IMAGE' || currentMedia.type === 'LIVE_PHOTO'"
                    class="relative max-w-full max-h-full flex items-center justify-center"
                >
                    <HeicImage
                        v-if="isHeic(getMediaDisplayUrl(currentMedia))"
                        :src="getMediaDisplayUrl(currentMedia)"
                        :alt="currentMedia.title || $t('trash.preview.media_alt')"
                        class="max-w-full max-h-[calc(100vh-160px)] object-contain rounded-lg shadow-2xl ring-1 ring-white/10"
                        loading="eager"
                    />
                    <img
                        v-else
                        :src="getMediaDisplayUrl(currentMedia)"
                        :alt="currentMedia.title || $t('trash.preview.media_alt')"
                        class="max-w-full max-h-[calc(100vh-160px)] object-contain rounded-lg shadow-2xl ring-1 ring-white/10"
                        loading="eager"
                    />
                </div>

                <!-- Active Video View -->
                <div v-else-if="currentMedia.type === 'VIDEO'" class="relative max-w-full max-h-full flex items-center justify-center">
                    <video
                        controls
                        playsinline
                        autoplay
                        :src="getMediaDisplayUrl(currentMedia)"
                        :poster="currentMedia.cover_url || undefined"
                        class="max-w-full max-h-[calc(100vh-160px)] rounded-lg shadow-2xl ring-1 ring-white/10 bg-black"
                    ></video>
                </div>

                <!-- Fallback Media View -->
                <div v-else class="relative max-w-full max-h-full flex items-center justify-center">
                    <HeicImage
                        v-if="getMediaDisplayUrl(currentMedia) && isHeic(getMediaDisplayUrl(currentMedia))"
                        :src="getMediaDisplayUrl(currentMedia)"
                        :alt="currentMedia.title || $t('trash.preview.media_alt')"
                        class="max-w-full max-h-[calc(100vh-160px)] object-contain rounded-lg shadow-2xl ring-1 ring-white/10"
                    />
                    <img
                        v-else-if="getMediaDisplayUrl(currentMedia)"
                        :src="getMediaDisplayUrl(currentMedia)"
                        :alt="currentMedia.title || $t('trash.preview.media_alt')"
                        class="max-w-full max-h-[calc(100vh-160px)] object-contain rounded-lg shadow-2xl ring-1 ring-white/10"
                    />
                    <div v-else class="text-zinc-500 text-xs flex flex-col items-center gap-2">
                        <ImageIcon class="w-10 h-10" />
                        <span>{{ formatMediaType(currentMedia.type) }}</span>
                    </div>
                </div>
            </div>

            <!-- Right Chevron -->
            <button
                v-if="mediaList.length > 1"
                type="button"
                @click="next"
                :disabled="!canNext"
                class="absolute right-3 sm:right-6 z-30 w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 flex items-center justify-center shadow-xl backdrop-blur-sm cursor-pointer disabled:opacity-20 disabled:pointer-events-none active:scale-95 transition-all"
                :aria-label="$t('common.next')"
            >
                <ChevronRight class="w-5 h-5" />
            </button>
        </main>

        <!-- Bottom Thumbnail Strip -->
        <footer
            v-if="mediaList.length > 1"
            class="h-16 sm:h-20 shrink-0 px-4 sm:px-6 py-2 border-t border-zinc-800/80 bg-zinc-950/90 flex items-center justify-center gap-2 overflow-x-auto z-20"
        >
            <div class="flex items-center gap-2 max-w-full overflow-x-auto py-1 px-2 scrollbar-none">
                <button
                    v-for="(m, idx) in mediaList"
                    :key="m.id || idx"
                    type="button"
                    @click="currentIndex = idx"
                    class="relative h-11 sm:h-13 aspect-square rounded-md overflow-hidden shrink-0 border transition-all cursor-pointer focus:outline-none"
                    :class="
                        currentIndex === idx
                            ? 'ring-2 ring-white border-white scale-105 shadow-md'
                            : 'border-zinc-800 opacity-60 hover:opacity-100 hover:border-zinc-600'
                    "
                    :title="m.title || $t('trash.preview.media_item_title', { index: idx + 1 })"
                >
                    <img
                        :src="getThumbUrl(m)"
                        :alt="m.title || $t('trash.preview.thumb_alt')"
                        class="w-full h-full object-cover"
                        loading="lazy"
                    />

                    <!-- Video badge -->
                    <div
                        v-if="m.type === 'VIDEO'"
                        class="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 bg-black/70 rounded-xs flex items-center justify-center text-white"
                    >
                        <VideoIcon class="w-2.5 h-2.5" />
                    </div>
                </button>
            </div>
        </footer>
    </div>
</template>
