<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { Post } from "@/types/post";
import {
    Play,
    Loader2,
    FileImage,
    Link as LinkIcon,
    Trash,
    Clock,
    CheckCircle2,
    AlertCircle,
    Sparkles,
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

const handleRegenerateCover = async () => {
    const videoMedia = post.media?.[0];
    if (!videoMedia || !videoMedia.id) return;

    isRegenerating.value = true;
    try {
        const response = await useApi<any>(`/media/${videoMedia.id}/regenerate-cover`, {
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
        const response = await useApi<any>(`/post/trash/${post.id}`, { method: "POST" });
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
const handleMouseEnter = () => {
    if (typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches) {
        isHovered.value = true;
    }
};

const handleMouseLeave = () => {
    isHovered.value = false;
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
                    v-if="showCheckbox || isHovered"
                    class="absolute top-4 left-4 z-20"
                    @click.stop
                >
                    <Checkbox
                        :model-value="isChecked"
                        class="size-5 border-white/80 bg-white/90 shadow-sm data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                        :aria-label="`Select ${post.title || 'post'}`"
                        @update:model-value="emit('toggleChecked', $event === true)"
                    />
                </div>

                <div
                    class="relative aspect-4/3 rounded-lg overflow-hidden border border-gray-100 bg-gray-50"
                >
                    <!-- Text Card -->
                    <div
                        v-if="post.type === 'TEXT'"
                        class="w-full h-full p-4 flex flex-col justify-center items-center bg-gray-50 text-gray-400"
                    >
                        <span class="text-xs text-center line-clamp-4">{{
                            post.description || post.title || "Pure Text"
                        }}</span>
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
                        {{ post.title }}
                    </h3>
                    <div class="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                        <span v-if="post.type !== 'TEXT'"
                            >{{ post.media?.[0]?.width || post.width }}x{{
                                post.media?.[0]?.height || post.height
                            }}</span
                        >
                        <span v-if="post.type !== 'TEXT'">{{ post.size }}</span>
                    </div>
                    <div class="flex items-center gap-1.5 mt-1">
                        <!-- Post Sync Status Badge -->
                        <span
                            v-if="post.sync_status && post.sync_status !== 'COMPLETED'"
                            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border"
                            :class="
                                post.sync_status === 'IN_PROGRESS'
                                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                                    : post.sync_status === 'FAILED'
                                      ? 'bg-red-50 text-red-700 border-red-200 cursor-help'
                                      : 'bg-amber-50 text-amber-700 border-amber-200'
                            "
                            :title="
                                post.sync_status === 'FAILED'
                                    ? post.last_error || 'Unknown Error'
                                    : undefined
                            "
                        >
                            <Clock v-if="post.sync_status === 'PENDING'" class="size-3" />
                            <Loader2
                                v-else-if="post.sync_status === 'IN_PROGRESS'"
                                class="size-3 animate-spin"
                            />
                            <AlertCircle v-else-if="post.sync_status === 'FAILED'" class="size-3" />
                            {{ post.sync_status }}
                        </span>

                        <!-- AI Status Badge for the Post's Primary Media -->
                        <span
                            v-if="post.media?.[0]?.ai_status"
                            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border"
                            :class="
                                post.media[0].ai_status === 'COMPLETED'
                                    ? 'bg-purple-50 text-purple-700 border-purple-200'
                                    : post.media[0].ai_status === 'IN_PROGRESS'
                                      ? 'bg-indigo-50 text-indigo-700 border-indigo-200 animate-pulse'
                                      : post.media[0].ai_status === 'FAILED'
                                        ? 'bg-red-50 text-red-700 border-red-200 cursor-help'
                                        : 'bg-slate-50 text-slate-700 border-slate-200'
                            "
                            :title="
                                post.media[0].ai_status === 'FAILED'
                                    ? post.media[0].ai_error || 'Unknown Error'
                                    : undefined
                            "
                        >
                            <Clock v-if="post.media[0].ai_status === 'PENDING'" class="size-3" />
                            <Loader2
                                v-else-if="post.media[0].ai_status === 'IN_PROGRESS'"
                                class="size-3 animate-spin"
                            />
                            <AlertCircle
                                v-else-if="post.media[0].ai_status === 'FAILED'"
                                class="size-3"
                            />
                            <Sparkles v-else class="size-3" />
                            AI:
                            {{
                                post.media[0].ai_status === "COMPLETED"
                                    ? "Ready"
                                    : post.media[0].ai_status
                            }}
                        </span>
                    </div>
                    <div class="flex flex-wrap gap-1 mt-2">
                        <span
                            v-for="tag in post.tags"
                            :key="tag"
                            class="px-1.5 py-0.5 bg-gray-100 text-xs text-gray-600 rounded-md"
                        >
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
            <ContextMenuItem class="flex items-center gap-2" @click.stop="handleCopyLink">
                <LinkIcon class="w-4 h-4" />
                <span>{{ $t("common.copy_link", "Copy Link") }}</span>
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
