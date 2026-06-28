<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { Info, Tag, Calendar, User, FileImage, Globe, Link as LinkIcon, X, Check, Edit3, Loader2, Layers } from "@lucide/vue";
import { type Post } from "@/types/post";
import { usePostStore } from "@/stores/posts";
import { toast } from "@/components/ui/sonner";
import { Temporal } from "@js-temporal/polyfill";

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

const currentMedia = computed(() => {
    if (!props.post?.media || props.post.media.length === 0) return null;
    // Map index safely
    return props.post.media[currentIndex.value] || props.post.media[0];
});

const isEditing = ref(false);
const isSaving = ref(false);

const editTitle = ref("");
const editDescription = ref("");
const editPublishedTime = ref("");
const editUrl = ref("");

// Tag input state
const isAddingTag = ref(false);
const newTagValue = ref("");
const newTagInput = ref<HTMLInputElement | null>(null);

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
    try {
        const res = await postStore.replacePostTags(props.post.id, newTags);
        if (res && res.success) {
            toast.success("Tag removed");
        } else {
            throw new Error("Failed to remove tag");
        }
    } catch (err) {
        console.error("Failed to remove tag:", err);
        toast.error("Failed to remove tag");
    }
};

const startAddTag = () => {
    isAddingTag.value = true;
    nextTick(() => {
        newTagInput.value?.focus();
    });
};

const confirmAddTag = async () => {
    const value = newTagValue.value.trim();
    const currentTags = props.post.tags || [];
    if (value) {
        if (currentTags.includes(value)) {
            isAddingTag.value = false;
            newTagValue.value = "";
            return;
        }
        const newTags = [...currentTags, value];
        try {
            const res = await postStore.replacePostTags(props.post.id, newTags);
            if (res && res.success) {
                toast.success("Tag added");
            } else {
                throw new Error("Failed to add tag");
            }
        } catch (err) {
            console.error("Failed to add tag:", err);
            toast.error("Failed to add tag");
        }
    }
    isAddingTag.value = false;
    newTagValue.value = "";
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
</script>

<template>
    <div class="bg-white flex flex-col shrink-0 relative flex-1 min-h-0 pointer-events-auto">
        <div class="flex-1 overflow-y-auto p-6 space-y-6">
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

                <div class="space-y-1">
                    <label v-if="isEditing" class="text-[10px] uppercase text-gray-400 font-bold tracking-wider block">{{
                        $t("common.description")
                    }}</label>
                    <p v-if="!isEditing" class="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
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

            <div v-if="post.eid || post.originalUrl || isEditing" class="space-y-3 pt-2">
                <div v-if="post.eid" class="flex items-center justify-between text-sm py-2 px-3 bg-white border border-gray-200 rounded-lg">
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
            </div>

            <hr class="border-gray-200" />

            <!-- Tags -->
            <div class="space-y-3">
                <label class="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                    <Tag class="w-3 h-3" /> {{ $t("common.tags") }}
                </label>
                <div class="flex flex-wrap gap-2">
                    <span
                        v-for="tag in post.tags"
                        :key="tag"
                        class="group/tag flex items-center gap-1 px-2.5 py-1 bg-gray-50 border border-gray-200 hover:border-red-200 hover:bg-red-50 hover:text-red-700 rounded-md text-xs text-gray-700 font-medium transition-all"
                    >
                        #{{ tag }}
                        <button
                            type="button"
                            @click="handleRemoveTag(tag)"
                            class="opacity-0 group-hover/tag:opacity-100 text-gray-400 hover:text-red-600 transition-all cursor-pointer"
                        >
                            <X class="w-3 h-3" />
                        </button>
                    </span>
                    <span v-if="!post.tags || post.tags.length === 0" class="text-xs text-gray-400 italic"> No tags </span>

                    <div v-if="isAddingTag" class="flex items-center gap-1 border border-indigo-200 rounded-md px-2 py-0.5 bg-white">
                        <input
                            ref="newTagInput"
                            v-model="newTagValue"
                            type="text"
                            placeholder="Tag name"
                            class="outline-none border-none text-xs text-gray-700 w-16"
                            @keyup.enter="confirmAddTag"
                            @blur="confirmAddTag"
                        />
                    </div>
                    <button
                        v-else
                        type="button"
                        @click="startAddTag"
                        class="px-3 py-1 border border-dashed border-gray-300 rounded-md text-xs text-gray-400 hover:text-gray-600 hover:border-gray-400 transition-colors cursor-pointer"
                    >
                        + {{ $t("common.add_tag") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
