<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";
import type { Post } from "@/types/post";
import { Play, Loader2, FileImage, Link as LinkIcon, Trash, Clock, CheckCircle2, AlertCircle, Sparkles, RefreshCw } from "@lucide/vue";
import { Checkbox } from "@/components/ui/checkbox";
import { getOptimizedImageUrl, getOptimizedSrcset } from "@/utils/image";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { toast } from "@/components/ui/sonner";
import { useApi } from "@/composables/useApi";
import { usePostStore } from "@/stores/posts";

const { post, isSelected, isChecked, showCheckbox } = defineProps<{
    post: Post;
    isSelected?: boolean;
    isChecked?: boolean;
    showCheckbox?: boolean;
}>();

const emit = defineEmits<{
    toggleChecked: [checked: boolean];
    click: [event: MouseEvent];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const isHovered = ref(false);
const isRegenerating = ref(false);
const postStore = usePostStore();

watch(isHovered, async (hovering) => {
    const firstMedia = post.media?.[0];
    if (post.type === "MULTI_MEDIA" && firstMedia?.type === "VIDEO") {
        if (hovering) {
            // Wait for DOM to update and mount the video element
            await nextTick();
            if (videoRef.value) {
                videoRef.value.play().catch(() => {});
            }
        } else {
            if (videoRef.value) {
                videoRef.value.pause();
                // Reset to first frame or keep where it is? Usually reset feels cleaner for previews.
                videoRef.value.currentTime = 0;
            }
        }
    }
});

interface ApiResponse {
    success: boolean;
}

const handleRegenerateCover = async () => {
    const videoMedia = post.media?.[0];
    if (!videoMedia || !videoMedia.id) return;

    isRegenerating.value = true;
    try {
        const response = await useApi<ApiResponse>(`/media/${videoMedia.id}/regenerate-cover`, {
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

const handleCopyLink = () => {
    const url = window.location.origin + "/posts/" + post.id;
    navigator.clipboard.writeText(url);
    toast.success("Post link copied to clipboard.");
};

const handleDelete = async () => {
    try {
        const response = await useApi<ApiResponse>(`/post/trash/${post.id}`, { method: "POST" });
        if (response && response.success) {
            toast.success("Post moved to trash.");
            postStore.refetchPosts();
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to move post to trash.");
    }
};

const isRetryingSync = ref(false);
const isQueueingAi = ref(false);

const hasFailedMedia = computed(() => {
    return post.media?.some((m) => m.sync_status === "FAILED");
});

const handleRetrySync = async () => {
    isRetryingSync.value = true;
    try {
        const res = await postStore.retrySync([post.id]);
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
        const res = await postStore.queueAi([post.id]);
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
const handleMouseEnter = () => {
    if (typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches) {
        isHovered.value = true;
    }
};

const handleMouseLeave = () => {
    isHovered.value = false;
};

const getPlatformBadgeClass = (platform: string) => {
    switch (platform) {
        case "XHS":
            return "bg-red-50 text-red-600 border-red-200";
        case "BILIBILI":
            return "bg-pink-50 text-pink-600 border-pink-200";
        case "DOUYIN":
        case "TIKTOK":
            return "bg-slate-900 text-slate-100 border-slate-800 dark:bg-slate-800 dark:text-slate-200";
        case "YOUTUBE":
            return "bg-rose-50 text-rose-600 border-rose-200";
        case "INSTAGRAM":
            return "bg-purple-50 text-purple-600 border-purple-200";
        case "X":
            return "bg-gray-900 text-gray-100 border-gray-800 dark:bg-gray-800 dark:text-gray-200";
        default:
            return "bg-gray-50 text-gray-600 border-gray-200";
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
                <div v-if="showCheckbox || isHovered" class="absolute top-4 left-4 z-20" @click.stop>
                    <Checkbox
                        :model-value="isChecked"
                        class="size-5 border-white/80 bg-white/90 shadow-sm data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                        :aria-label="`Select ${post.title || 'post'}`"
                        @update:model-value="emit('toggleChecked', $event === true)"
                    />
                </div>

                <div class="relative aspect-4/3 rounded-lg overflow-hidden border border-gray-100 bg-gray-50">
                    <!-- Text Card -->
                    <div
                        v-if="post.type === 'TEXT'"
                        class="w-full h-full p-4 flex flex-col justify-center items-center bg-gray-50 text-gray-400"
                    >
                        <span class="text-xs text-center line-clamp-4">{{ post.description || post.title || "Pure Text" }}</span>
                    </div>

                    <!-- Image Card -->
                    <img
                        v-else-if="post.type === 'MULTI_MEDIA' && post.media?.[0]?.type !== 'VIDEO'"
                        :src="
                            getOptimizedImageUrl(post.media?.[0]?.url, {
                                width: 480,
                                height: 360,
                                fit: 'cover',
                                gravity: 'auto',
                            })
                        "
                        :srcset="getOptimizedSrcset(post.media?.[0]?.url, 'list')"
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                        :alt="post.title"
                        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                        loading="lazy"
                    />

                    <!-- Video Card -->
                    <div
                        v-else-if="post.type === 'MULTI_MEDIA' && post.media?.[0]?.type === 'VIDEO'"
                        class="w-full h-full relative bg-gray-900"
                    >
                        <video
                            v-if="isHovered"
                            ref="videoRef"
                            :src="`${post.media?.[0]?.url}#t=0.01`"
                            :poster="post.media?.[0]?.poster || undefined"
                            class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                            muted
                            playsinline
                            loop
                            preload="metadata"
                        ></video>

                        <img
                            v-if="post.media?.[0]?.poster && !isHovered"
                            :src="
                                getOptimizedImageUrl(post.media?.[0]?.poster, {
                                    width: 480,
                                    height: 360,
                                    fit: 'cover',
                                    gravity: 'auto',
                                })
                            "
                            :srcset="getOptimizedSrcset(post.media?.[0]?.poster, 'list')"
                            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                            :alt="post.title"
                            class="absolute inset-0 w-full h-full object-cover transition-all duration-300 group-hover:scale-105 pointer-events-none"
                            loading="lazy"
                        />

                        <!-- Fallback placeholder if no poster and not hovered -->
                        <div
                            v-else-if="!post.media?.[0]?.poster && !isHovered"
                            class="absolute inset-0 flex flex-col items-center justify-center bg-gray-800 text-gray-500 pointer-events-none"
                        >
                            <Play class="w-8 h-8 opacity-40 mb-1" />
                            <span class="text-[10px] opacity-40">Hover to play</span>
                        </div>

                        <div
                            class="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-transparent transition-colors pointer-events-none"
                        >
                            <div v-if="!isHovered" class="bg-white/90 p-2 rounded-full shadow-sm backdrop-blur-sm">
                                <Play class="w-4 h-4 text-black fill-black ml-0.5" />
                            </div>
                        </div>
                    </div>
                </div>

                <div class="flex flex-col px-1 gap-1">
                    <!-- Author & Platform Info -->
                    <div class="flex items-center justify-between mt-1 gap-2">
                        <div class="flex items-center gap-1.5 min-w-0">
                            <img
                                v-if="post.author_avatar_url"
                                :src="post.author_avatar_url"
                                alt="avatar"
                                class="w-5 h-5 rounded-full object-cover shrink-0"
                                loading="lazy"
                            />
                            <div
                                v-else
                                class="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-medium text-gray-500 shrink-0"
                            >
                                {{ (post.author || "U").charAt(0).toUpperCase() }}
                            </div>
                            <span class="text-xs text-gray-600 font-medium truncate">
                                {{ post.author }}
                            </span>
                        </div>
                        <span
                            v-if="post.platform"
                            class="text-[9px] px-1.5 py-0.5 rounded font-semibold border shrink-0"
                            :class="getPlatformBadgeClass(post.platform)"
                        >
                            {{ $t("platforms." + post.platform) }}
                        </span>
                    </div>

                    <h3 class="text-sm font-medium text-gray-900 line-clamp-1 group-hover:text-blue-600 transition-colors mt-0.5">
                        {{ post.title }}
                    </h3>
                    <div class="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                        <span
                            v-if="
                                post.type !== 'TEXT' && (post.media?.[0]?.width || post.width) && (post.media?.[0]?.height || post.height)
                            "
                            >{{ post.media?.[0]?.width || post.width }}x{{ post.media?.[0]?.height || post.height }}</span
                        >
                        <span v-if="post.type !== 'TEXT' && post.size">{{ post.size }}</span>
                    </div>
                    <div class="flex items-center gap-2 mt-1">
                        <!-- Post Sync Status (Low Presence) -->
                        <template v-if="post.sync_status && post.sync_status !== 'COMPLETED'">
                            <span
                                v-if="post.sync_status === 'PENDING'"
                                class="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400"
                            >
                                <Clock class="size-3 shrink-0" />
                                <span>Pending Sync</span>
                            </span>
                            <span
                                v-else-if="post.sync_status === 'IN_PROGRESS'"
                                class="inline-flex items-center gap-1 text-[10px] font-medium text-blue-500 animate-pulse"
                            >
                                <Loader2 class="size-3 animate-spin shrink-0" />
                                <span>Syncing...</span>
                            </span>
                            <span
                                v-else-if="post.sync_status === 'FAILED'"
                                class="inline-flex items-center gap-1 text-[10px] font-medium text-red-500 cursor-help"
                                :title="post.last_error || 'Sync failed'"
                            >
                                <AlertCircle class="size-3 shrink-0" />
                                <span>Sync Failed</span>
                            </span>
                        </template>

                        <!-- AI Status Badge (Low Presence) -->
                        <template v-if="post.media?.[0]?.ai_status">
                            <span
                                v-if="post.media[0].ai_status === 'COMPLETED'"
                                class="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400 dark:text-gray-500 select-none"
                            >
                                <Sparkles class="size-3 text-gray-400 dark:text-gray-500 shrink-0" />
                                <span>AI Ready</span>
                            </span>
                            <span
                                v-else-if="post.media[0].ai_status === 'PENDING'"
                                class="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400"
                            >
                                <Clock class="size-3 shrink-0" />
                                <span>AI Pending</span>
                            </span>
                            <span
                                v-else-if="post.media[0].ai_status === 'IN_PROGRESS'"
                                class="inline-flex items-center gap-1 text-[10px] font-medium text-indigo-400 animate-pulse"
                            >
                                <Loader2 class="size-3 animate-spin shrink-0" />
                                <span>Enriching...</span>
                            </span>
                            <span
                                v-else-if="post.media[0].ai_status === 'FAILED'"
                                class="inline-flex items-center gap-1 text-[10px] font-medium text-red-400 cursor-help"
                                :title="post.media[0].ai_error || 'AI Enrichment failed'"
                            >
                                <AlertCircle class="size-3 shrink-0" />
                                <span>AI Failed</span>
                            </span>
                        </template>
                    </div>
                    <div class="flex flex-wrap gap-1 mt-2">
                        <span v-for="tag in post.tags" :key="tag" class="px-1.5 py-0.5 bg-gray-100 text-xs text-gray-600 rounded-md">
                            #{{ tag }}
                        </span>
                    </div>
                </div>
            </div>
        </ContextMenuTrigger>
        <ContextMenuContent class="w-52">
            <ContextMenuItem
                v-if="post.type === 'MULTI_MEDIA' && post.media?.[0]?.type === 'VIDEO'"
                :disabled="isRegenerating"
                class="flex items-center gap-2"
                @click.stop="handleRegenerateCover"
            >
                <Loader2 v-if="isRegenerating" class="w-4 h-4 animate-spin" />
                <FileImage v-else class="w-4 h-4" />
                <span>{{ $t("media.actions.regenerate_cover", "Regenerate Cover") }}</span>
            </ContextMenuItem>
            <ContextMenuItem
                v-if="post.sync_status === 'FAILED' || hasFailedMedia"
                :disabled="isRetryingSync"
                class="flex items-center gap-2"
                @click.stop="handleRetrySync"
            >
                <Loader2 v-if="isRetryingSync" class="w-4 h-4 animate-spin" />
                <RefreshCw v-else class="w-4 h-4" />
                <span>{{ $t("post.actions.retry_sync", "Retry Sync") }}</span>
            </ContextMenuItem>
            <ContextMenuItem :disabled="isQueueingAi" class="flex items-center gap-2" @click.stop="handleQueueAi">
                <Loader2 v-if="isQueueingAi" class="w-4 h-4 animate-spin" />
                <Sparkles v-else class="w-4 h-4" />
                <span>{{ $t("post.actions.queue_ai", "Queue for AI") }}</span>
            </ContextMenuItem>
            <ContextMenuItem class="flex items-center gap-2" @click.stop="handleCopyLink">
                <LinkIcon class="w-4 h-4" />
                <span>{{ $t("common.copy_link", "Copy Link") }}</span>
            </ContextMenuItem>
            <ContextMenuItem class="flex items-center gap-2 text-red-600 focus:text-red-600 focus:bg-red-50" @click.stop="handleDelete">
                <Trash class="w-4 h-4" />
                <span>{{ $t("common.delete", "Delete") }}</span>
            </ContextMenuItem>
        </ContextMenuContent>
    </ContextMenu>
</template>
