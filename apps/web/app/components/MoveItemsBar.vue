<script setup lang="ts">
import type { AcceptableValue } from "reka-ui";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "vue-sonner";
import { useLibraryStore } from "@/stores/library";
import { CheckSquare, Loader2, MoveRight, X, FileImage, RefreshCw, Sparkles, Link } from "@lucide/vue";
import { useMediaStore, type MappedMediaItem } from "@/stores/media";
import { usePostStore } from "@/stores/posts";
import type { Post, PostMedia } from "@/types/post";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const props = withDefaults(
    defineProps<{
        postIds?: string[];
        mediaIds?: string[];
        allVisibleSelected?: boolean;
        canSelectVisible?: boolean;
    }>(),
    {
        postIds: () => [],
        mediaIds: () => [],
        allVisibleSelected: false,
        canSelectVisible: false,
    },
);

const emit = defineEmits<{
    moved: [];
    cancel: [];
    toggleVisible: [];
}>();

const libraryStore = useLibraryStore();
const mediaStore = useMediaStore();
const postStore = usePostStore();
const { t } = useI18n();

const targetLibraryId = ref("");
const isMoving = ref(false);
const isRegenerating = ref(false);
const isRetryingSync = ref(false);
const isQueueingAi = ref(false);

// Link to Post dialog state
const isPostPickerOpen = ref(false);
const postsList = ref<Post[]>([]);
const selectedPostIdForLink = ref("");
const isLoadingPosts = ref(false);
const isLinking = ref(false);

async function openPostPicker() {
    isPostPickerOpen.value = true;
    isLoadingPosts.value = true;
    try {
        const res = await useApi<{ success: boolean; data: { list: Post[] } }>(
            `/post/list?library_id=${libraryStore.activeLibraryId}&count=100`,
        );
        if (res && res.success) {
            postsList.value = res.data.list;
            if (postsList.value.length > 0) {
                const firstPost = postsList.value[0];
                if (firstPost) {
                    selectedPostIdForLink.value = firstPost.id;
                }
            }
        }
    } catch (e) {
        console.error("Failed to fetch posts:", e);
    } finally {
        isLoadingPosts.value = false;
    }
}

async function handleLinkToPost() {
    if (!selectedPostIdForLink.value || props.mediaIds.length === 0) return;
    isLinking.value = true;
    try {
        const res = await useApi<{ success: boolean }>(`/post/${selectedPostIdForLink.value}/bind_media`, {
            method: "POST",
            body: {
                media_ids: props.mediaIds,
            },
        });
        if (res && res.success) {
            toast.success("Media successfully linked to post");
            isPostPickerOpen.value = false;
            emit("moved");
        }
    } catch (e: any) {
        toast.error("Failed to link media to post", {
            description: e.message || String(e),
        });
    } finally {
        isLinking.value = false;
    }
}

const hasSelectedFailedSync = computed(() => {
    const directFailedMedia = mediaStore.medias.some(
        (m: MappedMediaItem) => props.mediaIds.includes(String(m.id)) && m.sync_status === "FAILED",
    );
    const directFailedPost = postStore.posts.some(
        (p: Post) =>
            props.postIds.includes(String(p.id)) && (p.sync_status === "FAILED" || p.media?.some((m) => m.sync_status === "FAILED")),
    );
    return directFailedMedia || directFailedPost;
});

const handleBatchRetrySync = async () => {
    if (props.postIds.length === 0 && props.mediaIds.length === 0) return;
    isRetryingSync.value = true;
    try {
        let response;
        if (props.postIds.length > 0) {
            response = await postStore.retrySync(props.postIds);
        } else if (props.mediaIds.length > 0) {
            response = await mediaStore.retrySync(props.mediaIds);
        }
        if (response && response.success) {
            toast.success("Batch sync retry queued.");
            emit("cancel");
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to queue batch sync retry.");
    } finally {
        isRetryingSync.value = false;
    }
};

const handleBatchQueueAi = async () => {
    if (props.postIds.length === 0 && props.mediaIds.length === 0) return;
    isQueueingAi.value = true;
    try {
        let response;
        if (props.postIds.length > 0) {
            response = await postStore.queueAi(props.postIds);
        } else if (props.mediaIds.length > 0) {
            response = await mediaStore.queueAi(props.mediaIds);
        }
        if (response && response.success) {
            toast.success("Batch AI enrichment queued.");
            emit("cancel");
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to queue batch AI enrichment.");
    } finally {
        isQueueingAi.value = false;
    }
};

type VideoItemLike = MappedMediaItem | PostMedia;

const selectedVideos = computed<VideoItemLike[]>(() => {
    const directVideos = mediaStore.medias.filter(
        (m: MappedMediaItem) => props.mediaIds.includes(String(m.id)) && m.type?.toLowerCase() === "video",
    );

    const postVideos: PostMedia[] = [];
    if (props.postIds && props.postIds.length > 0) {
        const selectedPosts = postStore.posts.filter((p: Post) => props.postIds.includes(String(p.id)));
        for (const post of selectedPosts) {
            if (post.media) {
                for (const media of post.media) {
                    if (media.type?.toLowerCase() === "video" || media.type === "VIDEO") {
                        postVideos.push(media);
                    }
                }
            }
        }
    }

    const combined: VideoItemLike[] = [...directVideos, ...postVideos];
    const uniqueMap = new Map<string, VideoItemLike>();
    for (const v of combined) {
        uniqueMap.set(String(v.id), v);
    }
    return Array.from(uniqueMap.values());
});

const hasSelectedVideos = computed(() => selectedVideos.value.length > 0);

const handleBatchRegenerate = async () => {
    const videoIds = selectedVideos.value.map((v: VideoItemLike) => v.id);
    if (videoIds.length === 0) {
        toast.warning(t("media.cover.select_video_required", "Please select at least one video."));
        return;
    }

    try {
        isRegenerating.value = true;
        const response = await useApi<{ success: boolean; data: { queued: number; skipped: number }; message?: string }>(
            "/media/regenerate-covers",
            {
                method: "POST",
                body: {
                    media_ids: videoIds,
                },
            },
        );
        if (response && response.success && response.data) {
            const { queued, skipped } = response.data;
            toast.success(
                t("media.cover.batch_queued", {
                    queued,
                    skipped,
                    default: "Queued {queued} cover regeneration tasks. Skipped {skipped}.",
                }),
            );
            emit("cancel");
        } else {
            throw new Error(response?.message || "Failed to batch request cover generation");
        }
    } catch (err: unknown) {
        console.error("Failed to batch regenerate covers:", err);
        toast.error(t("media.cover.failed", "Failed to queue cover regeneration."));
    } finally {
        isRegenerating.value = false;
    }
};

const targetLibraries = computed(() => libraryStore.libraries.filter((library) => library.id !== libraryStore.activeLibraryId));

const itemCount = computed(() => props.postIds.length + props.mediaIds.length);
const hasTargetLibrary = computed(() => targetLibraries.value.length > 0);

const itemSummary = computed(() => {
    const parts = [];
    if (props.postIds.length > 0) {
        parts.push(`${props.postIds.length} post${props.postIds.length === 1 ? "" : "s"}`);
    }
    if (props.mediaIds.length > 0) {
        parts.push(`${props.mediaIds.length} media`);
    }
    return parts.join(" and ");
});

watch(
    targetLibraries,
    (libraries) => {
        if (!libraries.some((library) => library.id === targetLibraryId.value)) {
            targetLibraryId.value = libraries[0]?.id ?? "";
        }
    },
    { immediate: true },
);

const handleTargetChange = (value: AcceptableValue) => {
    if (typeof value === "string") {
        targetLibraryId.value = value;
    }
};

interface FetchErrorLike {
    data?: {
        message?: string;
        error?: string;
    };
    response?: {
        _data?: {
            message?: string;
            error?: string;
        };
    };
    message?: string;
}

const getMoveErrorDescription = (e: unknown) => {
    const err = e as FetchErrorLike;
    return (
        err?.data?.message ||
        err?.data?.error ||
        err?.response?._data?.message ||
        err?.response?._data?.error ||
        err?.message ||
        "Something went wrong while moving the selected items."
    );
};

const handleMove = async () => {
    if (itemCount.value === 0 || isMoving.value) return;

    if (!targetLibraryId.value) {
        toast.warning("Choose a target library", {
            description: "Create or choose another library before moving items.",
        });
        return;
    }

    try {
        isMoving.value = true;
        await libraryStore.moveItems({
            postIds: props.postIds,
            mediaIds: props.mediaIds,
            targetLibraryId: targetLibraryId.value,
        });
        toast.success("Items moved", {
            description: `${itemSummary.value} moved to the selected library.`,
        });
        emit("moved");
    } catch (e: unknown) {
        toast.error("Failed to move items", {
            description: getMoveErrorDescription(e),
        });
    } finally {
        isMoving.value = false;
    }
};
</script>

<template>
    <div class="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
        <div
            class="pointer-events-auto flex w-full max-w-4xl flex-col gap-3 rounded-lg border bg-white p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between"
        >
            <div class="flex min-w-0 items-center gap-3">
                <div class="whitespace-nowrap tabular-nums text-sm font-semibold text-gray-900">{{ itemCount }} selected</div>
                <div v-if="itemCount > 0" class="hidden truncate text-sm text-muted-foreground sm:block">
                    Move {{ itemSummary || "selected items" }} to
                </div>
                <div v-else class="hidden truncate text-sm text-muted-foreground sm:block">Choose items to move</div>
            </div>

            <div class="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <Button type="button" variant="outline" size="sm" :disabled="!canSelectVisible || isMoving" @click="emit('toggleVisible')">
                    <CheckSquare />
                    {{ allVisibleSelected ? "Deselect visible" : "Select visible" }}
                </Button>
                <Button
                    v-if="mediaIds.length > 0 && postIds.length === 0"
                    type="button"
                    variant="outline"
                    size="sm"
                    :disabled="isMoving || isLinking"
                    @click="openPostPicker"
                >
                    <Loader2 v-if="isLinking" class="animate-spin text-slate-400" />
                    <Link v-else class="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    Link to Post
                </Button>
                <Button
                    v-if="hasSelectedVideos"
                    type="button"
                    variant="outline"
                    size="sm"
                    :disabled="isMoving || isRegenerating"
                    @click="handleBatchRegenerate"
                >
                    <Loader2 v-if="isRegenerating" class="animate-spin" />
                    <FileImage v-else />
                    {{ $t("media.actions.regenerate_covers", "Regenerate Covers") }}
                </Button>
                <Button
                    v-if="hasSelectedFailedSync"
                    type="button"
                    variant="outline"
                    size="sm"
                    :disabled="isMoving || isRegenerating || isRetryingSync"
                    @click="handleBatchRetrySync"
                >
                    <Loader2 v-if="isRetryingSync" class="animate-spin" />
                    <RefreshCw v-else />
                    {{ $t("media.actions.retry_sync", "Retry Sync") }}
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    :disabled="isMoving || isRegenerating || isQueueingAi"
                    @click="handleBatchQueueAi"
                >
                    <Loader2 v-if="isQueueingAi" class="animate-spin" />
                    <Sparkles v-else />
                    {{ $t("media.actions.queue_ai", "Queue for AI") }}
                </Button>
                <Select :model-value="targetLibraryId" @update:model-value="handleTargetChange">
                    <SelectTrigger class="h-9 w-[220px]">
                        <SelectValue :placeholder="hasTargetLibrary ? 'Choose library' : 'No target library'" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectItem v-for="library in targetLibraries" :key="library.id" :value="library.id">
                                {{ library.name }}
                            </SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
                <Button type="button" size="sm" :disabled="!hasTargetLibrary || itemCount === 0 || isMoving" @click="handleMove">
                    <Loader2 v-if="isMoving" class="animate-spin" />
                    <MoveRight v-else />
                    Move
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    :disabled="isMoving"
                    aria-label="Cancel selection"
                    @click="emit('cancel')"
                >
                    <X />
                </Button>
            </div>
        </div>
    </div>

    <!-- Picker Dialog to select Post -->
    <Dialog v-model:open="isPostPickerOpen">
        <DialogContent class="max-w-md p-6">
            <DialogHeader>
                <DialogTitle>Link Media to Post</DialogTitle>
                <DialogDescription> Select a post to attach the {{ mediaIds.length }} selected media assets. </DialogDescription>
            </DialogHeader>

            <div class="py-4">
                <div v-if="isLoadingPosts" class="flex justify-center p-6">
                    <Loader2 class="w-8 h-8 animate-spin text-slate-400" />
                </div>
                <div v-else-if="postsList.length === 0" class="text-center p-6 text-slate-400 text-sm">
                    No posts available in this library.
                </div>
                <div v-else class="space-y-2">
                    <Label for="target-post-select">Select Target Post</Label>
                    <Select v-model="selectedPostIdForLink">
                        <SelectTrigger id="target-post-select">
                            <SelectValue placeholder="Select a post" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem v-for="post in postsList" :key="post.id" :value="post.id">
                                {{ post.title || "Untitled Post" }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <DialogFooter>
                <Button variant="outline" @click="isPostPickerOpen = false">Cancel</Button>
                <Button :disabled="!selectedPostIdForLink || isLinking" @click="handleLinkToPost">Link Media</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
