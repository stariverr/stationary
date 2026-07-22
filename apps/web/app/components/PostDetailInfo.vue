<script setup lang="ts">
import { ref, watch } from "vue";
import { Edit3, Link as LinkIcon, Loader2, Tag as TagIcon, User } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { Temporal } from "@js-temporal/polyfill";
import { toast } from "vue-sonner";
import { type Post } from "@/types/post";
import { usePostStore } from "@/stores/posts";

const props = withDefaults(
    defineProps<{
        post: Post;
        isDark?: boolean;
    }>(),
    {
        isDark: false,
    },
);
const postStore = usePostStore();
const queryClient = useQueryClient();
const { t } = useI18n();

const isEditing = ref(false);
const isSaving = ref(false);
const editTitle = ref("");
const editDescription = ref("");
const editPublishedTime = ref("");
const editUrl = ref("");

const toLocalDatetimeString = (instantString?: string | null) => {
    if (!instantString) return "";
    try {
        const instant = Temporal.Instant.from(instantString);
        return instant.toZonedDateTimeISO(Temporal.Now.timeZoneId()).toString().slice(0, 16);
    } catch {
        return "";
    }
};

const fromLocalDatetimeString = (datetimeString: string) => {
    if (!datetimeString) return null;
    try {
        return Temporal.ZonedDateTime.from(`${datetimeString}:00[${Temporal.Now.timeZoneId()}]`).toInstant().toString();
    } catch {
        return null;
    }
};

const startEditing = () => {
    editTitle.value = props.post.title || "";
    editDescription.value = props.post.description || "";
    editPublishedTime.value = toLocalDatetimeString(props.post.published_time || props.post.create_time);
    editUrl.value = props.post.originalUrl || "";
    isEditing.value = true;
};

const cancelEditing = () => {
    isEditing.value = false;
};

const updateCachedTags = (tags: string[]) => {
    const postKey = ["post", String(props.post.id)];
    const cachedPost = queryClient.getQueryData<any>(postKey);
    if (cachedPost) queryClient.setQueryData(postKey, { ...cachedPost, tags });
    return cachedPost;
};

const handleRemoveTag = async (tagToRemove: string) => {
    const previousTags = props.post.tags || [];
    const nextTags = previousTags.filter((tag) => tag !== tagToRemove);
    props.post.tags = nextTags;
    const cachedPost = updateCachedTags(nextTags);

    try {
        const response = await postStore.replacePostTags(props.post.id, nextTags);
        if (!response?.success) throw new Error(t("post_detail.toasts.remove_tag_failed"));
    } catch (error: any) {
        props.post.tags = previousTags;
        if (cachedPost) queryClient.setQueryData(["post", String(props.post.id)], cachedPost);
        toast.error(t("post_detail.toasts.remove_tag_failed"), { description: error.message || String(error) });
    }
};

const handleAddTag = async (tagToAdd: string) => {
    const previousTags = props.post.tags || [];
    if (previousTags.includes(tagToAdd)) return;
    const nextTags = [...previousTags, tagToAdd];
    props.post.tags = nextTags;
    const cachedPost = updateCachedTags(nextTags);

    try {
        const response = await postStore.replacePostTags(props.post.id, nextTags);
        if (!response?.success) throw new Error(t("post_detail.toasts.add_tag_failed"));
    } catch (error: any) {
        props.post.tags = previousTags;
        if (cachedPost) queryClient.setQueryData(["post", String(props.post.id)], cachedPost);
        toast.error(t("post_detail.toasts.add_tag_failed"), { description: error.message || String(error) });
    }
};

const saveEditing = async () => {
    isSaving.value = true;
    try {
        const response = await postStore.updatePostInfo(props.post.id, {
            title: editTitle.value.trim(),
            description: editDescription.value.trim(),
            published_time: fromLocalDatetimeString(editPublishedTime.value),
            url: editUrl.value.trim() || null,
        });
        if (!response?.success) throw new Error(t("post_detail.toasts.update_failed"));
        toast.success(t("post_detail.toasts.update_success"));
        isEditing.value = false;
    } catch (error: any) {
        toast.error(t("post_detail.toasts.update_failed"), { description: error.message || String(error) });
    } finally {
        isSaving.value = false;
    }
};

watch(
    () => props.post.id,
    () => {
        isEditing.value = false;
    },
);
</script>

<template>
    <div class="space-y-7">
        <section class="space-y-3">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                    <h1
                        v-if="!isEditing"
                        class="break-words text-lg md:text-xl font-bold leading-tight tracking-tight"
                        :class="isDark ? 'text-white' : 'text-zinc-950 dark:text-white'"
                    >
                        {{ post.title || $t("post_detail.untitled_post") }}
                    </h1>
                    <div v-else class="space-y-1.5">
                        <label class="text-xs font-medium text-zinc-500 dark:text-zinc-400" for="post-detail-title">{{
                            $t("post_detail.title_label")
                        }}</label>
                        <input
                            id="post-detail-title"
                            v-model="editTitle"
                            type="text"
                            :placeholder="$t('post_detail.title_placeholder')"
                            class="w-full rounded-md border px-3 py-2 text-sm outline-none transition focus:ring-2"
                            :class="[
                                isDark
                                    ? 'border-zinc-800 bg-zinc-900 text-white focus:border-zinc-700 focus:ring-zinc-500/10'
                                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:border-zinc-500 dark:focus:border-zinc-700 focus:ring-zinc-900/10',
                            ]"
                        />
                    </div>
                </div>
                <button
                    v-if="!isEditing"
                    type="button"
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition cursor-pointer"
                    :class="
                        isDark
                            ? 'text-zinc-400 hover:bg-white/5 hover:text-white'
                            : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100'
                    "
                    :title="$t('common.edit')"
                    :aria-label="$t('common.edit')"
                    @click="startEditing"
                >
                    <Edit3 class="h-4 w-4" />
                </button>
            </div>

            <div v-if="postStore.isLoadingDetail" class="space-y-2 py-1" aria-busy="true">
                <div class="h-3 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800"></div>
                <div class="h-3 w-4/5 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800"></div>
            </div>
            <p
                v-else-if="!isEditing"
                class="whitespace-pre-line text-xs md:text-sm leading-relaxed"
                :class="isDark ? 'text-zinc-300/90' : 'text-zinc-650 dark:text-zinc-300'"
            >
                {{ post.description || $t("common.no_description") }}
            </p>
            <div v-else class="space-y-1.5">
                <label class="text-xs font-medium text-zinc-500 dark:text-zinc-400" for="post-detail-description">{{
                    $t("common.description")
                }}</label>
                <textarea
                    id="post-detail-description"
                    v-model="editDescription"
                    rows="4"
                    :placeholder="$t('post_detail.description_placeholder')"
                    class="w-full resize-y rounded-md border px-3 py-2 text-sm leading-6 outline-none transition focus:ring-2"
                    :class="[
                        isDark
                            ? 'border-zinc-800 bg-zinc-900 text-white focus:border-zinc-700 focus:ring-zinc-500/10'
                            : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:border-zinc-500 dark:focus:border-zinc-700 focus:ring-zinc-900/10',
                    ]"
                ></textarea>
            </div>

            <div v-if="isEditing" class="flex justify-end gap-2 pt-1">
                <button
                    type="button"
                    class="rounded-md border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 cursor-pointer"
                    :class="[
                        isDark
                            ? 'border-zinc-800 text-zinc-300 hover:bg-zinc-900'
                            : 'border-zinc-200 dark:border-zinc-800 text-zinc-650 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800',
                    ]"
                    :disabled="isSaving"
                    @click="cancelEditing"
                >
                    {{ $t("common.cancel") }}
                </button>
                <button
                    type="button"
                    class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 cursor-pointer"
                    :class="[
                        isDark
                            ? 'bg-white text-zinc-950 hover:bg-zinc-200'
                            : 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200',
                    ]"
                    :disabled="isSaving"
                    @click="saveEditing"
                >
                    <Loader2 v-if="isSaving" class="h-3.5 w-3.5 animate-spin" />
                    {{ $t("common.save") }}
                </button>
            </div>
        </section>

        <section class="border-t pt-5" :class="isDark ? 'border-zinc-850' : 'border-zinc-200 dark:border-zinc-800'">
            <h2
                class="mb-3 text-[10px] font-bold uppercase tracking-[0.08em]"
                :class="isDark ? 'text-zinc-300' : 'text-zinc-700 dark:text-zinc-300'"
            >
                {{ $t("post_detail.properties") }}
            </h2>
            <dl
                class="divide-y border-y"
                :class="
                    isDark ? 'divide-zinc-850 border-zinc-850' : 'divide-zinc-100 dark:divide-zinc-800 border-zinc-150 dark:border-zinc-800'
                "
            >
                <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 py-2.5 text-xs">
                    <dt :class="isDark ? 'text-zinc-400 font-medium' : 'text-zinc-600 dark:text-zinc-400 font-medium'">
                        {{ $t("common.author") }}
                    </dt>
                    <dd
                        class="flex min-w-0 items-center gap-2 font-semibold"
                        :class="isDark ? 'text-zinc-100' : 'text-zinc-900 dark:text-zinc-100'"
                    >
                        <img
                            v-if="post.author_avatar_url"
                            :src="post.author_avatar_url"
                            :alt="post.author"
                            class="h-6 w-6 shrink-0 rounded-full border object-cover animate-fade-in"
                            :class="isDark ? 'border-zinc-800' : 'border-zinc-200 dark:border-zinc-800'"
                            loading="lazy"
                        />
                        <span
                            v-else
                            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
                            :class="
                                isDark
                                    ? 'border-zinc-800 bg-zinc-900 text-zinc-400'
                                    : 'border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400'
                            "
                            ><User class="h-3.5 w-3.5"
                        /></span>
                        <span class="truncate">{{ post.author }}</span>
                    </dd>
                </div>
                <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 py-2.5 text-xs">
                    <dt :class="isDark ? 'text-zinc-400 font-medium' : 'text-zinc-600 dark:text-zinc-400 font-medium'">
                        {{ $t("common.platform") }}
                    </dt>
                    <dd class="font-semibold" :class="isDark ? 'text-zinc-150' : 'text-zinc-900 dark:text-zinc-100'">
                        {{ $t(`platforms.${post.platform}`) }}
                    </dd>
                </div>
                <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 py-2.5 text-xs">
                    <dt :class="isDark ? 'text-zinc-400 font-medium' : 'text-zinc-600 dark:text-zinc-400 font-medium'">
                        {{ $t("common.created") }}
                    </dt>
                    <dd class="min-w-0" :class="isDark ? 'text-zinc-200' : 'text-zinc-700 dark:text-zinc-300'">
                        <input
                            v-if="isEditing"
                            v-model="editPublishedTime"
                            type="datetime-local"
                            class="max-w-full rounded-md border px-2 py-1 text-xs outline-none focus:ring-1"
                            :class="[
                                isDark
                                    ? 'border-zinc-800 bg-zinc-900 text-white focus:border-zinc-700 focus:ring-zinc-500/10'
                                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-850 dark:text-zinc-100 focus:border-zinc-500 dark:focus:border-zinc-700 focus:ring-zinc-900/10',
                            ]"
                        />
                        <span v-else class="font-medium">{{ post.date }}</span>
                    </dd>
                </div>
                <div
                    v-if="post.type !== 'TEXT' && post.width && post.height"
                    class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 py-2.5 text-xs"
                >
                    <dt :class="isDark ? 'text-zinc-400 font-medium' : 'text-zinc-600 dark:text-zinc-400 font-medium'">
                        {{ $t("common.dimensions") }}
                    </dt>
                    <dd class="font-mono text-xs font-medium" :class="isDark ? 'text-zinc-300' : 'text-zinc-700 dark:text-zinc-300'">
                        {{ post.width }} × {{ post.height }}
                    </dd>
                </div>
                <div v-if="post.eid" class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 py-2.5 text-xs">
                    <dt :class="isDark ? 'text-zinc-400 font-medium' : 'text-zinc-600 dark:text-zinc-400 font-medium'">
                        {{ $t("common.eid") }}
                    </dt>
                    <dd
                        class="truncate font-mono text-xs font-medium"
                        :class="isDark ? 'text-zinc-300' : 'text-zinc-700 dark:text-zinc-300'"
                    >
                        {{ post.eid }}
                    </dd>
                </div>
                <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 py-2.5 text-xs">
                    <dt :class="isDark ? 'text-zinc-400 font-medium' : 'text-zinc-600 dark:text-zinc-400 font-medium'">
                        {{ $t("post_detail.source") }}
                    </dt>
                    <dd class="min-w-0">
                        <input
                            v-if="isEditing"
                            v-model="editUrl"
                            type="url"
                            :placeholder="$t('post_detail.original_url_placeholder')"
                            class="w-full rounded-md border px-2 py-1 text-xs outline-none focus:ring-1"
                            :class="[
                                isDark
                                    ? 'border-zinc-800 bg-zinc-900 text-white focus:border-zinc-700 focus:ring-zinc-500/10'
                                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-850 dark:text-zinc-100 focus:border-zinc-500 dark:focus:border-zinc-700 focus:ring-zinc-900/10',
                            ]"
                        />
                        <a
                            v-else-if="post.originalUrl"
                            :href="post.originalUrl"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="inline-flex max-w-full items-center gap-1 truncate font-medium underline underline-offset-2 transition"
                            :class="
                                isDark
                                    ? 'text-zinc-200 decoration-zinc-800 hover:text-white hover:decoration-white'
                                    : 'text-zinc-900 dark:text-zinc-100 decoration-zinc-300 dark:decoration-zinc-700 hover:decoration-zinc-900 dark:hover:decoration-white'
                            "
                        >
                            <span class="truncate">{{ $t("post_detail.source_link") }}</span>
                            <LinkIcon class="h-3.5 w-3.5 shrink-0" :class="isDark ? 'text-zinc-450' : 'text-zinc-500 dark:text-zinc-400'" />
                        </a>
                        <span v-else :class="isDark ? 'text-zinc-600' : 'text-zinc-400 dark:text-zinc-500'">{{
                            $t("post_detail.none")
                        }}</span>
                    </dd>
                </div>
            </dl>
        </section>

        <section class="border-t pt-5" :class="isDark ? 'border-zinc-850' : 'border-zinc-200 dark:border-zinc-800'">
            <h2
                class="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.08em]"
                :class="isDark ? 'text-zinc-400' : 'text-zinc-500 dark:text-zinc-400'"
            >
                <TagIcon class="h-3.5 w-3.5" :class="isDark ? 'text-zinc-400' : 'text-zinc-500 dark:text-zinc-400'" />
                {{ $t("common.tags") }}
            </h2>
            <TagEditor :tags="post.tags || []" :is-dark="isDark" @add-tag="handleAddTag" @remove-tag="handleRemoveTag" />
        </section>
    </div>
</template>
