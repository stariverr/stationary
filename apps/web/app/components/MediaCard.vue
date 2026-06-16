<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { MediaListItem, MappedMediaItem } from "@/stores/media";
import {
    Play,
    Layers,
    Loader2,
    FileImage,
    Trash,
    Clock,
    CheckCircle2,
    AlertCircle,
    Sparkles,
    RefreshCw,
} from "@lucide/vue";
import { Checkbox } from "@/components/ui/checkbox";
import { getOptimizedImageUrl, getOptimizedSrcset } from "@/utils/image";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { toast } from "@/components/ui/sonner";
import { useApi } from "@/composables/useApi";
import { useMediaStore } from "@/stores/media";

const { media, isSelected, isChecked, canMove, showCheckbox } = defineProps<{
    media: MappedMediaItem;
    isSelected?: boolean;
    isChecked?: boolean;
    canMove?: boolean;
    showCheckbox?: boolean;
}>();

const emit = defineEmits<{
    toggleChecked: [checked: boolean];
    click: [event: MouseEvent];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const isHovered = ref(false);

watch(isHovered, async (hovering) => {
    if (media.type?.toLowerCase() === "video") {
        if (hovering) {
            await nextTick();
            if (videoRef.value) {
                videoRef.value.play().catch(() => {});
            }
        } else {
            if (videoRef.value) {
                videoRef.value.pause();
                videoRef.value.currentTime = 0;
            }
        }
    }
});

const handleMouseEnter = () => {
    if (typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches) {
        isHovered.value = true;
    }
};

const handleMouseLeave = () => {
    isHovered.value = false;
};

const mediaStore = useMediaStore();
const isRegenerating = ref(false);

interface ApiResponse {
    success: boolean;
}

const handleRegenerateCover = async () => {
    if (!media.id) return;

    isRegenerating.value = true;
    try {
        const response = await useApi<ApiResponse>(`/media/${media.id}/regenerate-cover`, {
            method: "POST",
        });
        if (response && response.success) {
            toast.success("Cover regeneration queued.");
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to queue cover regeneration.");
    } finally {
        isRegenerating.value = false;
    }
};

const handleDelete = async () => {
    try {
        const response = await useApi<ApiResponse>(`/media/trash/${media.id}`, { method: "POST" });
        if (response && response.success) {
            toast.success("Media moved to trash.");
            mediaStore.refetchMedia();
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to move media to trash.");
    }
};

const isRetryingSync = ref(false);
const isQueueingAi = ref(false);

const handleRetrySync = async () => {
    isRetryingSync.value = true;
    try {
        const res = await mediaStore.retrySync([media.id]);
        if (res && res.success) {
            toast.success("Sync retry queued.");
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to queue sync retry.");
    } finally {
        isRetryingSync.value = false;
    }
};

const handleQueueAi = async () => {
    isQueueingAi.value = true;
    try {
        const res = await mediaStore.queueAi([media.id]);
        if (res && res.success) {
            toast.success("AI enrichment queued.");
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to queue AI enrichment.");
    } finally {
        isQueueingAi.value = false;
    }
};
</script>

<template>
    <ContextMenu>
        <ContextMenuTrigger as-child>
            <div
                class="group relative flex flex-col gap-2 p-2 rounded-xl transition-all duration-200 cursor-pointer"
                :class="isSelected ? 'bg-blue-50 ring-2 ring-blue-500' : 'hover:bg-gray-100'"
                @mouseenter="handleMouseEnter"
                @mouseleave="handleMouseLeave"
                @click="emit('click', $event)"
            >
                <div
                    v-if="canMove !== false && (showCheckbox || isHovered)"
                    class="absolute top-4 left-4 z-20"
                    @click.stop
                >
                    <Checkbox
                        :model-value="isChecked"
                        class="size-5 border-white/80 bg-white/90 shadow-sm data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                        :aria-label="`Select ${media.title || 'media'}`"
                        @update:model-value="emit('toggleChecked', $event === true)"
                    />
                </div>

                <div
                    class="relative aspect-4/3 rounded-lg overflow-hidden border border-gray-100 bg-gray-50"
                >
                    <!-- Stack Indicator (1/N) -->
                    <div
                        v-if="media.media_count > 1"
                        class="absolute top-2 right-2 z-10 bg-black/60 text-white text-[10px] font-medium px-1.5 py-0.5 rounded flex items-center gap-1 backdrop-blur-sm"
                    >
                        <Layers class="w-3 h-3" />
                        {{ media.media_count }}
                    </div>

                    <!-- Image Card -->
                    <img
                        v-if="media.type?.toLowerCase() === 'image' || !media.type"
                        :src="
                            getOptimizedImageUrl(media.url, {
                                width: 480,
                                height: 360,
                                fit: 'cover',
                                gravity: 'auto',
                            })
                        "
                        :srcset="getOptimizedSrcset(media.url, 'list')"
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                        :alt="media.title || 'Image'"
                        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                        loading="lazy"
                    />

                    <!-- Video Card -->
                    <div
                        v-else-if="media.type?.toLowerCase() === 'video'"
                        class="w-full h-full relative bg-gray-900"
                    >
                        <video
                            v-if="isHovered"
                            ref="videoRef"
                            :src="`${media.url}#t=0.01`"
                            :poster="media.poster || undefined"
                            class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                            muted
                            playsinline
                            loop
                            preload="metadata"
                        ></video>

                        <img
                            v-if="media.poster && !isHovered"
                            :src="
                                getOptimizedImageUrl(media.poster, {
                                    width: 480,
                                    height: 360,
                                    fit: 'cover',
                                    gravity: 'auto',
                                })
                            "
                            :srcset="getOptimizedSrcset(media.poster, 'list')"
                            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                            :alt="media.title || 'Video Cover'"
                            class="absolute inset-0 w-full h-full object-cover transition-all duration-300 group-hover:scale-105 pointer-events-none"
                            loading="lazy"
                        />

                        <!-- Fallback placeholder if no poster and not hovered -->
                        <div
                            v-else-if="!media.poster && !isHovered"
                            class="absolute inset-0 flex flex-col items-center justify-center bg-gray-800 text-gray-500 pointer-events-none"
                        >
                            <Play class="w-8 h-8 opacity-40 mb-1" />
                            <span class="text-[10px] opacity-40">Hover to play</span>
                        </div>

                        <div
                            class="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-transparent transition-colors pointer-events-none"
                        >
                            <div
                                v-if="!isHovered"
                                class="bg-white/90 p-2 rounded-full shadow-sm backdrop-blur-sm"
                            >
                                <Play class="w-4 h-4 text-black fill-black ml-0.5" />
                            </div>
                        </div>
                    </div>
                </div>

                <div class="flex flex-col px-1">
                    <h3
                        class="text-sm font-medium text-gray-900 line-clamp-1 group-hover:text-blue-600 transition-colors"
                    >
                        {{ media.title || "Untitled" }}
                    </h3>
                    <div class="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                        <span>{{ media.date }}</span>
                    </div>
                    <div class="flex items-center gap-1.5 mt-1">
                        <!-- Media Sync Status Badge -->
                        <span
                            v-if="media.sync_status && media.sync_status !== 'COMPLETED'"
                            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border"
                            :class="
                                media.sync_status === 'IN_PROGRESS'
                                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                                    : media.sync_status === 'FAILED'
                                      ? 'bg-red-50 text-red-700 border-red-200 cursor-help'
                                      : 'bg-amber-50 text-amber-700 border-amber-200'
                            "
                            :title="
                                media.sync_status === 'FAILED'
                                    ? media.last_error || 'Unknown Error'
                                    : undefined
                            "
                        >
                            <Clock v-if="media.sync_status === 'PENDING'" class="size-3" />
                            <Loader2
                                v-else-if="media.sync_status === 'IN_PROGRESS'"
                                class="size-3 animate-spin"
                            />
                            <AlertCircle
                                v-else-if="media.sync_status === 'FAILED'"
                                class="size-3"
                            />
                            {{ media.sync_status }}
                        </span>

                        <!-- Media AI Status Badge -->
                        <span
                            v-if="media.ai_status"
                            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border"
                            :class="
                                media.ai_status === 'COMPLETED'
                                    ? 'bg-purple-50 text-purple-700 border-purple-200'
                                    : media.ai_status === 'IN_PROGRESS'
                                      ? 'bg-indigo-50 text-indigo-700 border-indigo-200 animate-pulse'
                                      : media.ai_status === 'FAILED'
                                        ? 'bg-red-50 text-red-700 border-red-200 cursor-help'
                                        : 'bg-slate-50 text-slate-700 border-slate-200'
                            "
                            :title="
                                media.ai_status === 'FAILED'
                                    ? media.ai_error || 'Unknown Error'
                                    : undefined
                            "
                        >
                            <Clock v-if="media.ai_status === 'PENDING'" class="size-3" />
                            <Loader2
                                v-else-if="media.ai_status === 'IN_PROGRESS'"
                                class="size-3 animate-spin"
                            />
                            <AlertCircle v-else-if="media.ai_status === 'FAILED'" class="size-3" />
                            <Sparkles v-else class="size-3" />
                            AI: {{ media.ai_status === "COMPLETED" ? "Ready" : media.ai_status }}
                        </span>
                    </div>
                    <div
                        v-if="media.matched_details"
                        class="flex flex-wrap gap-1 mt-1.5 animate-fade-in"
                    >
                        <span
                            v-if="media.matched_details.keyword"
                            class="text-[9px] px-1.5 py-0.5 rounded font-medium bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400 border border-blue-100/50 dark:border-blue-900/30"
                            :title="$t('search.keyword_search', 'Keyword Search')"
                        >
                            Keyword
                        </span>
                        <span
                            v-if="media.matched_details.text_semantic"
                            class="text-[9px] px-1.5 py-0.5 rounded font-medium bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-400 border border-purple-100/50 dark:border-purple-900/30"
                            :title="`${$t('search.text_embedding')}: ${media.matched_details.text_semantic.distance?.toFixed(4)}`"
                        >
                            Text AI
                        </span>
                        <span
                            v-if="media.matched_details.visual_semantic"
                            class="text-[9px] px-1.5 py-0.5 rounded font-medium bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-100/50 dark:border-amber-900/30"
                            :title="`${$t('search.image_embedding')}: ${media.matched_details.visual_semantic.distance?.toFixed(4)}`"
                        >
                            Visual AI
                        </span>
                    </div>
                </div>
            </div>
        </ContextMenuTrigger>
        <ContextMenuContent class="w-52">
            <ContextMenuItem
                v-if="media.type?.toLowerCase() === 'video'"
                :disabled="isRegenerating"
                class="flex items-center gap-2"
                @click.stop="handleRegenerateCover"
            >
                <Loader2 v-if="isRegenerating" class="w-4 h-4 animate-spin" />
                <FileImage v-else class="w-4 h-4" />
                <span>{{ $t("media.actions.regenerate_cover", "Regenerate Cover") }}</span>
            </ContextMenuItem>
            <ContextMenuItem
                v-if="media.sync_status === 'FAILED'"
                :disabled="isRetryingSync"
                class="flex items-center gap-2"
                @click.stop="handleRetrySync"
            >
                <Loader2 v-if="isRetryingSync" class="w-4 h-4 animate-spin" />
                <RefreshCw class="w-4 h-4" />
                <span>{{ $t("media.actions.retry_sync", "Retry Sync") }}</span>
            </ContextMenuItem>
            <ContextMenuItem
                :disabled="isQueueingAi"
                class="flex items-center gap-2"
                @click.stop="handleQueueAi"
            >
                <Loader2 v-if="isQueueingAi" class="w-4 h-4 animate-spin" />
                <Sparkles class="w-4 h-4" />
                <span>{{ $t("media.actions.queue_ai", "Queue for AI") }}</span>
            </ContextMenuItem>
            <ContextMenuItem
                class="flex items-center gap-2 text-red-600 focus:text-red-600 focus:bg-red-50"
                @click.stop="handleDelete"
            >
                <Trash class="w-4 h-4" />
                <span>{{ $t("common.delete", "Delete") }}</span>
            </ContextMenuItem>
        </ContextMenuContent>
    </ContextMenu>
</template>
