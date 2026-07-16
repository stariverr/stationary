<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import {
    Info,
    Tag,
    Calendar,
    User,
    FileImage,
    Globe,
    Link as LinkIcon,
    X,
    Check,
    Edit3,
    Loader2,
    Layers,
    Plus,
    Trash2,
    FileCheck,
    Unlink,
    ArrowLeft,
    ArrowRight,
    ChevronLeft,
    ChevronRight,
    Upload,
    Music,
} from "@lucide/vue";
import { type Post } from "@/types/post";
import { usePostStore } from "@/stores/posts";
import { toast } from "vue-sonner";
import { Temporal } from "@js-temporal/polyfill";
import { useQueryClient } from "@tanstack/vue-query";
import CreateMediaDialog from "./CreateMediaDialog.vue";

const props = withDefaults(
    defineProps<{
        post: Post;
        showMedia?: boolean;
    }>(),
    {
        showMedia: false,
    },
);

const currentIndex = defineModel<number>("currentIndex", { default: 0 });
const emit = defineEmits<{
    (e: "click-media"): void;
    (e: "manage-tracks", mediaId: string): void;
}>();

const postStore = usePostStore();
const queryClient = useQueryClient();
const { t } = useI18n();

const currentMedia = computed(() => {
    if (!props.post?.media || props.post.media.length === 0) return null;
    // Map index safely
    return props.post.media[currentIndex.value] || props.post.media[0];
});

const isEditing = ref(false);
const isSaving = ref(false);
const activeTab = ref<"info" | "media">("info");

const editTitle = ref("");
const editDescription = ref("");
const editPublishedTime = ref("");
const editUrl = ref("");

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

const startEditing = () => {
    editTitle.value = props.post.title;
    editDescription.value = props.post.description || "";
    editPublishedTime.value = toLocalDatetimeString(props.post.published_time || props.post.create_time);
    editUrl.value = props.post.url || "";
    isEditing.value = true;
};

const cancelEditing = () => {
    isEditing.value = false;
};

const handleRemoveTag = async (tagToRemove: string) => {
    const currentTags = props.post.tags || [];
    const newTags = currentTags.filter((t) => t !== tagToRemove);

    // Optimistic update 1: local prop object
    if (props.post) {
        props.post.tags = newTags;
    }

    // Optimistic update 2: react-query cache
    const postKey = ["post", String(props.post.id)];
    const cachedPost = queryClient.getQueryData<any>(postKey);
    if (cachedPost) {
        queryClient.setQueryData(postKey, {
            ...cachedPost,
            tags: newTags,
        });
    }

    try {
        const res = await postStore.replacePostTags(props.post.id, newTags);
        if (!res || !res.success) {
            throw new Error("Failed to remove tag");
        }
    } catch (err) {
        console.error("Failed to remove tag:", err);
        toast.error("Failed to remove tag");
        // Revert on error
        if (props.post) {
            props.post.tags = currentTags;
        }
        if (cachedPost) {
            queryClient.setQueryData(postKey, cachedPost);
        }
    }
};

const handleAddTag = async (tagToAdd: string) => {
    const currentTags = props.post.tags || [];
    if (currentTags.includes(tagToAdd)) return;
    const newTags = [...currentTags, tagToAdd];

    // Optimistic update 1: local prop object
    if (props.post) {
        props.post.tags = newTags;
    }

    // Optimistic update 2: react-query cache
    const postKey = ["post", String(props.post.id)];
    const cachedPost = queryClient.getQueryData<any>(postKey);
    if (cachedPost) {
        queryClient.setQueryData(postKey, {
            ...cachedPost,
            tags: newTags,
        });
    }

    try {
        const res = await postStore.replacePostTags(props.post.id, newTags);
        if (!res || !res.success) {
            throw new Error("Failed to add tag");
        }
    } catch (err) {
        console.error("Failed to add tag:", err);
        toast.error("Failed to add tag");
        // Revert on error
        if (props.post) {
            props.post.tags = currentTags;
        }
        if (cachedPost) {
            queryClient.setQueryData(postKey, cachedPost);
        }
    }
};

const saveEditing = async () => {
    isSaving.value = true;
    try {
        const publishedTimeInstant = fromLocalDatetimeString(editPublishedTime.value);

        // Update post metadata
        const updateRes = await postStore.updatePostInfo(props.post.id, {
            title: editTitle.value.trim(),
            description: editDescription.value.trim(),
            published_time: publishedTimeInstant,
            url: editUrl.value.trim() || null,
        });

        if (!updateRes || !updateRes.success) {
            throw new Error("Failed to update post info");
        }

        toast.success("Post updated successfully!");
        isEditing.value = false;
    } catch (err: any) {
        console.error("Save error:", err);
        toast.error(err.message || "Failed to save changes");
    } finally {
        isSaving.value = false;
    }
};

// Reset editing state when props post changes
watch(
    () => props.post.id,
    () => {
        isEditing.value = false;
    },
);

// Media Gallery and Draft Upload support
import { useImportStore } from "@/stores/import";
import { useApi } from "@/composables/useApi";

const importStore = useImportStore();
const isOrphanPickerOpen = ref(false);
const orphanMediaList = ref<any[]>([]);
const selectedOrphanIds = ref<string[]>([]);
const isLoadingOrphans = ref(false);
const isAttaching = ref(false);
const isCreateMediaOpen = ref(false);

async function openOrphanPicker() {
    isOrphanPickerOpen.value = true;
    isLoadingOrphans.value = true;
    try {
        const res = await useApi<{ success: boolean; data: { list: any[] } }>(
            `/media/list?library_id=${props.post.library_id}&has_no_post=true&count=100`,
        );
        if (res && res.success) {
            orphanMediaList.value = res.data.list;
        }
    } catch (e) {
        console.error("Failed to fetch orphan media:", e);
    } finally {
        isLoadingOrphans.value = false;
    }
}

async function attachMediaIds(mediaIds: string[]) {
    try {
        const res = await useApi<{ success: boolean }>(`/post/${props.post.id}/bind_media`, {
            method: "POST",
            body: {
                media_ids: mediaIds,
            },
        });
        if (res && res.success) {
            queryClient.invalidateQueries({ queryKey: ["post", String(props.post.id)] });
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            return true;
        }
    } catch (e: any) {
        toast.error("Failed to attach media", {
            description: e.message || String(e),
        });
    }
    return false;
}

async function handleAttachOrphans() {
    if (selectedOrphanIds.value.length === 0) return;
    isAttaching.value = true;
    const success = await attachMediaIds(selectedOrphanIds.value);
    if (success) {
        toast.success("Media attached successfully");
        isOrphanPickerOpen.value = false;
        selectedOrphanIds.value = [];
    }
    isAttaching.value = false;
}

async function handleUploadMediaCreated(media: { id: string; title: string }) {
    isCreateMediaOpen.value = false;
    const success = await attachMediaIds([media.id]);
    if (success) {
        toast.success(`Media "${media.title}" created and attached successfully`);
    }
}

function refreshPostMedia() {
    queryClient.invalidateQueries({ queryKey: ["post", String(props.post.id)] });
    queryClient.invalidateQueries({ queryKey: ["posts"] });
    queryClient.invalidateQueries({ queryKey: ["media"] });
    if (props.post.media && currentIndex.value >= props.post.media.length - 1) {
        currentIndex.value = Math.max(0, props.post.media.length - 2);
    }
}

async function handleUnlinkMedia(mediaId: string) {
    try {
        const res = await useApi<{ success: boolean }>(`/post/${props.post.id}/media/${mediaId}/remove`, {
            method: "POST",
        });
        if (res && res.success) {
            toast.success(t("post.manage.toast_unlink_success", "Media moved to orphan assets"));
            refreshPostMedia();
        }
    } catch (e: any) {
        toast.error(t("post.manage.toast_unlink_failed", "Failed to unlink media"), {
            description: e.message || String(e),
        });
    }
}

async function handleTrashMedia(mediaId: string) {
    try {
        const res = await useApi<{ success: boolean }>(`/media/trash/${mediaId}`, { method: "POST" });
        if (res && res.success) {
            toast.success(t("post.manage.toast_trash_success", "Media moved to trash"));
            refreshPostMedia();
        }
    } catch (e: any) {
        toast.error(t("post.manage.toast_trash_failed", "Failed to move media to trash"), {
            description: e.message || String(e),
        });
    }
}

async function handleShiftMedia(index: number, direction: "left" | "right") {
    if (!props.post.media) return;
    const list = [...props.post.media];
    const targetIndex = direction === "left" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return;

    // Swap elements
    const temp = list[index];
    const target = list[targetIndex];
    if (temp === undefined || target === undefined) return;

    list[index] = target;
    list[targetIndex] = temp;

    const orderedIds = list.map((m) => m.id);

    try {
        const res = await useApi<{ success: boolean }>(`/post/${props.post.id}/media/reorder`, {
            method: "POST",
            body: {
                media_ids: orderedIds,
            },
        });
        if (res && res.success) {
            toast.success(t("post.manage.toast_reorder_success", "Media reordered successfully"));
            refreshPostMedia();
        }
    } catch (e: any) {
        toast.error(t("post.manage.toast_reorder_failed", "Failed to reorder media"), {
            description: e.message || String(e),
        });
    }
}
</script>

<template>
    <div class="bg-white flex flex-col shrink-0 relative flex-1 min-h-0 pointer-events-auto">
        <!-- Tab Bar -->
        <div class="flex border-b border-gray-100 bg-gray-50/50 px-5 gap-6 h-12 items-center text-xs shrink-0 select-none">
            <button
                @click="activeTab = 'info'"
                class="font-semibold uppercase tracking-wider transition-colors relative h-full flex items-center cursor-pointer"
                :class="activeTab === 'info' ? 'text-zinc-900 border-b-2 border-zinc-800' : 'text-zinc-400 hover:text-zinc-700'"
            >
                {{ $t("post.tabs.basic_info", "Basic Info") }}
            </button>
            <button
                @click="activeTab = 'media'"
                class="font-semibold uppercase tracking-wider transition-colors relative h-full flex items-center cursor-pointer"
                :class="activeTab === 'media' ? 'text-zinc-900 border-b-2 border-zinc-800' : 'text-zinc-400 hover:text-zinc-700'"
            >
                {{ $t("post.tabs.manage_media", "Manage Media") }} ({{ post.media?.length || 0 }})
            </button>
        </div>

        <!-- Tab 1: Basic Info -->
        <div v-show="activeTab === 'info'" class="flex-1 overflow-y-auto min-h-0 p-6 space-y-6 focus-visible:outline-none">
            <div class="space-y-4">
                <!-- Title & Inputs -->
                <div>
                    <h1 v-if="!isEditing" class="text-xl font-bold text-gray-900 leading-tight">
                        {{ post.title }}
                    </h1>
                    <div v-else class="space-y-1">
                        <label class="text-[10px] uppercase text-gray-400 font-bold tracking-wider">Title</label>
                        <input
                            v-model="editTitle"
                            type="text"
                            class="text-sm font-semibold text-gray-950 w-full px-3 py-2 border border-gray-200 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none bg-white transition-all shadow-sm"
                            placeholder="Enter title"
                        />
                    </div>
                </div>

                <!-- Action Button Bar (Only shown in View Mode) -->
                <div v-if="!isEditing" class="flex items-center gap-2 pt-0.5">
                    <button
                        v-if="post.type !== 'TEXT' && post.media?.[0]"
                        type="button"
                        @click="emit('manage-tracks', post.media[currentIndex]?.id || post.media[0].id)"
                        class="px-2.5 py-1.5 text-xs font-semibold text-zinc-700 bg-zinc-50 hover:bg-zinc-100 hover:text-zinc-900 border border-zinc-200 rounded-md transition-all cursor-pointer flex items-center gap-1.5 shadow-2xs"
                        title="Manage tracks and variants for this media"
                    >
                        <Layers class="w-3.5 h-3.5 text-zinc-500" />
                        {{ $t("media.manage_tracks") }}
                    </button>
                    <button
                        @click="startEditing"
                        class="px-2.5 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-md transition-all cursor-pointer flex items-center gap-1 shadow-2xs"
                    >
                        <Edit3 class="w-3.5 h-3.5" />
                        {{ $t("common.edit") }}
                    </button>
                </div>

                <!-- Media Carousel (Embedded in Content for Standard View) -->
                <PostMediaCarousel
                    v-if="showMedia && post.type !== 'TEXT'"
                    :post="post"
                    layout="embedded"
                    v-model:currentIndex="currentIndex"
                    @click-media="emit('click-media')"
                />

                <!-- Description -->
                <div class="space-y-1">
                    <label v-if="isEditing" class="text-[10px] uppercase text-gray-400 font-bold tracking-wider block">
                        {{ $t("common.description") }}
                    </label>
                    <div v-if="postStore.isLoadingDetail" class="space-y-2 py-1">
                        <div class="h-4 bg-gray-200 rounded animate-pulse w-full"></div>
                        <div class="h-4 bg-gray-200 rounded animate-pulse w-5/6"></div>
                        <div class="h-4 bg-gray-200 rounded animate-pulse w-2/3"></div>
                    </div>
                    <p v-else-if="!isEditing" class="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                        {{ post.description || $t("common.no_description") }}
                    </p>
                    <textarea
                        v-else
                        v-model="editDescription"
                        rows="4"
                        class="text-sm text-gray-600 leading-relaxed w-full px-3 py-2 border border-gray-200 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none bg-white transition-all resize-none shadow-sm"
                        placeholder="Enter description"
                    ></textarea>
                </div>

                <div v-if="isEditing" class="flex items-center gap-2 justify-end pt-2">
                    <button
                        @click="cancelEditing"
                        class="px-3.5 py-1.5 text-xs font-semibold text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-md transition-colors cursor-pointer"
                        :disabled="isSaving"
                    >
                        {{ $t("common.cancel") }}
                    </button>
                    <button
                        @click="saveEditing"
                        class="px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md shadow-sm transition-colors cursor-pointer flex items-center gap-1.5"
                        :disabled="isSaving"
                    >
                        <Loader2 v-if="isSaving" class="w-3.5 h-3.5 animate-spin" />
                        {{ $t("common.save") }}
                    </button>
                </div>
            </div>

            <hr class="border-gray-200" />

            <!-- Metadata Grid -->
            <div class="grid grid-cols-2 gap-4">
                <div class="space-y-1">
                    <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">
                        {{ $t("common.author") }}
                    </div>
                    <div class="flex items-center gap-2">
                        <img
                            v-if="post.author_avatar_url"
                            :src="post.author_avatar_url"
                            alt="avatar"
                            class="w-6 h-6 rounded-full object-cover shrink-0"
                            loading="lazy"
                        />
                        <div
                            v-else
                            class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500 shrink-0"
                        >
                            <User class="w-3 h-3" />
                        </div>
                        <span class="text-sm font-medium text-gray-900 truncate">{{ post.author }}</span>
                    </div>
                </div>

                <div class="space-y-1">
                    <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">
                        {{ $t("common.platform") }}
                    </div>
                    <div class="flex items-center gap-2">
                        <Globe class="w-3 h-3 text-gray-400" />
                        <span class="text-sm text-gray-900">{{ $t("platforms." + post.platform) }}</span>
                    </div>
                </div>

                <div class="space-y-1">
                    <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">
                        {{ $t("common.created") }}
                    </div>
                    <div class="flex items-center gap-2">
                        <Calendar class="w-3 h-3 text-gray-400" />
                        <input
                            v-if="isEditing"
                            type="datetime-local"
                            v-model="editPublishedTime"
                            class="text-xs text-gray-900 border border-gray-200 rounded-md px-2 py-1 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
                        />
                        <span v-else class="text-sm text-gray-900">{{ post.date }}</span>
                    </div>
                </div>

                <div v-if="post.type !== 'TEXT'" class="space-y-1">
                    <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">
                        {{ $t("common.dimensions") }}
                    </div>
                    <div class="flex items-center gap-2">
                        <FileImage class="w-3 h-3 text-gray-400" />
                        <span class="text-sm text-gray-900">
                            {{ currentMedia?.width || post.width }} x
                            {{ currentMedia?.height || post.height }}
                        </span>
                    </div>
                </div>
            </div>

            <div v-if="post.eid || post.originalUrl || isEditing || postStore.isLoadingDetail" class="space-y-3 pt-2">
                <template v-if="postStore.isLoadingDetail">
                    <div class="h-9 bg-gray-100 rounded-lg animate-pulse w-full"></div>
                    <div class="h-9 bg-gray-100 rounded-lg animate-pulse w-full"></div>
                </template>
                <template v-else>
                    <div
                        v-if="post.eid"
                        class="flex items-center justify-between text-sm py-2 px-3 bg-white border border-gray-200 rounded-lg"
                    >
                        <span class="text-gray-500">EID</span>
                        <span class="font-mono text-gray-900">{{ post.eid }}</span>
                    </div>
                    <div class="flex items-center justify-between text-sm py-2 px-3 bg-white border border-gray-200 rounded-lg">
                        <span class="text-gray-500">Source</span>
                        <input
                            v-if="isEditing"
                            type="text"
                            v-model="editUrl"
                            class="text-xs font-mono text-gray-900 border border-gray-200 rounded-md px-2 py-1 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white flex-1 ml-4"
                            placeholder="Original URL"
                        />
                        <a
                            v-else-if="post.originalUrl"
                            :href="post.originalUrl"
                            target="_blank"
                            class="text-blue-600 hover:underline truncate max-w-[200px] flex items-center gap-1"
                        >
                            Link
                            <LinkIcon class="w-3 h-3" />
                        </a>
                        <span v-else class="text-gray-400 italic">None</span>
                    </div>
                </template>
            </div>

            <hr class="border-gray-200" />

            <!-- Tags -->
            <div class="space-y-3">
                <label class="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                    <Tag class="w-3 h-3" /> {{ $t("common.tags") }}
                </label>
                <TagEditor :tags="post.tags || []" @add-tag="handleAddTag" @remove-tag="handleRemoveTag" />
            </div>
        </div>

        <!-- Tab 2: Manage Media -->
        <div v-show="activeTab === 'media'" class="flex-1 overflow-y-auto min-h-0 p-6 space-y-4 focus-visible:outline-none">
            <!-- Action Controls Header -->
            <div class="flex items-center justify-between">
                <label class="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                    <Layers class="w-3 h-3" />
                    {{ $t("post.tabs.manage_media", "Manage Media") }}
                </label>
                <div class="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" class="h-7 text-[10px] font-normal" @click="openOrphanPicker">
                        <LinkIcon class="w-3 h-3 mr-1" />
                        {{ $t("post.manage.link_orphan", "Link Orphan") }}
                    </Button>
                    <Button
                        size="sm"
                        variant="default"
                        class="h-7 text-[10px] font-normal bg-indigo-600 hover:bg-indigo-700 text-white"
                        @click="isCreateMediaOpen = true"
                    >
                        <Plus class="w-3 h-3 mr-0.5" />
                        {{ $t("post.manage.upload_create", "Upload / Create") }}
                    </Button>
                </div>
            </div>

            <!-- Media Visual Grid -->
            <div
                v-if="!post.media || post.media.length === 0"
                class="flex flex-col items-center justify-center p-8 border border-dashed rounded-lg bg-gray-50/50 text-center space-y-2"
            >
                <FileImage class="w-8 h-8 text-gray-400" />
                <p class="text-xs text-gray-500 font-medium">{{ $t("post.manage.no_media_attached", "No media assets attached") }}</p>
                <p class="text-[10px] text-gray-400">
                    {{ $t("post.manage.no_media_hint", 'Click "Upload / Create" or "Link Orphan" above to add media.') }}
                </p>
            </div>

            <div v-else class="grid grid-cols-2 gap-3">
                <div
                    v-for="(media, index) in post.media"
                    :key="media.id"
                    :class="[
                        'group relative rounded-lg border overflow-hidden aspect-video bg-slate-900 transition-all cursor-pointer shadow-sm',
                        currentIndex === index ? 'ring-2 ring-indigo-600 border-transparent' : 'border-gray-200 hover:border-gray-300',
                    ]"
                    @click="currentIndex = index"
                >
                    <!-- Cover Preview Image -->
                    <img
                        v-if="media.cover_url || media.url"
                        :src="media.cover_url || media.url || undefined"
                        alt="Preview"
                        class="w-full h-full object-cover"
                        loading="lazy"
                    />
                    <div v-else class="w-full h-full flex items-center justify-center bg-slate-100 text-slate-400">
                        <Music v-if="media.type === 'AUDIO'" class="w-6 h-6" />
                        <FileImage v-else class="w-6 h-6" />
                    </div>

                    <!-- Media Type Badge -->
                    <span
                        class="absolute top-1.5 left-1.5 text-[8px] font-bold uppercase bg-black/60 text-white backdrop-blur-xs px-1.5 py-0.5 rounded tracking-wide select-none"
                    >
                        {{ media.type }}
                    </span>

                    <!-- Action Hover Overlay -->
                    <div
                        class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-2 text-white"
                    >
                        <!-- Top Bar: Shift left/right & Remove actions -->
                        <div class="flex items-center justify-between pointer-events-auto">
                            <!-- Reorder controls -->
                            <div class="flex items-center gap-0.5">
                                <button
                                    v-if="index > 0"
                                    class="w-5 h-5 rounded bg-white/20 hover:bg-white/40 flex items-center justify-center text-white cursor-pointer"
                                    title="Move Left"
                                    @click.stop="handleShiftMedia(index, 'left')"
                                >
                                    <ChevronLeft class="w-3.5 h-3.5" />
                                </button>
                                <button
                                    v-if="index < post.media.length - 1"
                                    class="w-5 h-5 rounded bg-white/20 hover:bg-white/40 flex items-center justify-center text-white cursor-pointer"
                                    title="Move Right"
                                    @click.stop="handleShiftMedia(index, 'right')"
                                >
                                    <ChevronRight class="w-3.5 h-3.5" />
                                </button>
                            </div>

                            <!-- Unlink and Trash -->
                            <div class="flex items-center gap-0.5">
                                <button
                                    class="w-5 h-5 rounded bg-white/20 hover:bg-white/40 hover:text-slate-200 flex items-center justify-center cursor-pointer"
                                    title="Unlink"
                                    @click.stop="handleUnlinkMedia(media.id)"
                                >
                                    <Unlink class="w-3.5 h-3.5" />
                                </button>
                                <button
                                    class="w-5 h-5 rounded bg-red-600/80 hover:bg-red-600 hover:text-white flex items-center justify-center cursor-pointer"
                                    title="Move to trash"
                                    @click.stop="handleTrashMedia(media.id)"
                                >
                                    <Trash2 class="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>

                        <!-- Bottom Bar: Media Title -->
                        <p class="text-[10px] font-medium truncate w-full pr-1 select-none">
                            {{ media.title || $t("media.untitled", "Untitled Media") }}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Create Media Modal Dialog -->
    <CreateMediaDialog v-model:open="isCreateMediaOpen" @created="handleUploadMediaCreated" />

    <!-- Picker Dialog for Orphan Media -->
    <Dialog v-model:open="isOrphanPickerOpen">
        <DialogContent class="max-w-lg max-h-[70vh] flex flex-col p-6 overflow-hidden">
            <DialogHeader class="shrink-0">
                <DialogTitle>{{ $t("post.manage.link_orphan_title", "Link Orphan Media") }}</DialogTitle>
                <DialogDescription>
                    {{ $t("post.manage.link_orphan_desc", "Select media assets from your library that do not belong to any post.") }}
                </DialogDescription>
            </DialogHeader>

            <!-- Scrollable list -->
            <div class="flex-1 overflow-y-auto py-3 space-y-2 pr-1 min-h-0 text-sm">
                <div v-if="isLoadingOrphans" class="flex justify-center p-8">
                    <Loader2 class="w-8 h-8 animate-spin text-slate-400" />
                </div>
                <div v-else-if="orphanMediaList.length === 0" class="p-8 text-center text-slate-400">
                    {{ $t("post.manage.no_orphan_found", "No orphan media assets found in this library.") }}
                </div>
                <div
                    v-else
                    v-for="media in orphanMediaList"
                    :key="media.id"
                    class="flex items-center gap-3 p-2 hover:bg-slate-50 border rounded-lg cursor-pointer text-xs"
                    @click="
                        selectedOrphanIds.includes(media.id)
                            ? selectedOrphanIds.splice(selectedOrphanIds.indexOf(media.id), 1)
                            : selectedOrphanIds.push(media.id)
                    "
                >
                    <Checkbox :checked="selectedOrphanIds.includes(media.id)" />
                    <div class="flex-1 truncate">
                        <div class="font-semibold text-slate-700 truncate">{{ media.title || $t("media.untitled", "Untitled Media") }}</div>
                        <div class="text-[10px] text-slate-400 mt-0.5">{{ media.type }}</div>
                    </div>
                </div>
            </div>

            <DialogFooter class="pt-4 border-t shrink-0">
                <Button variant="outline" @click="isOrphanPickerOpen = false">{{ $t("common.cancel", "Cancel") }}</Button>
                <Button :disabled="selectedOrphanIds.length === 0 || isAttaching" @click="handleAttachOrphans">
                    <Loader2 v-if="isAttaching" class="w-4 h-4 animate-spin mr-1" />
                    {{ $t("post.manage.attach_selection", "Attach Selection") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
