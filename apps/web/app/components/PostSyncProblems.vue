<script setup lang="ts">
import { computed, ref } from "vue";
import { ExternalLink, Loader2, Pencil, RefreshCw, TriangleAlert } from "@lucide/vue";
import { toast } from "vue-sonner";
import SourceErrorNote from "@/components/SourceErrorNote.vue";
import { usePostStore } from "@/stores/posts";
import type { MediaDetail, Post } from "@/types/post";
import { canRetry } from "@/utils/source-errors";

/**
 * Whether a post is complete, and if not, which of its media failed and how to fix each
 * (docs/failure_handling.zh-Hans.md, 9.2): a link the platform refused needs the post shared again, the rest is fixed
 * in the editor of the media, and a network or server error can be retried.
 */
const props = defineProps<{
    post: Post;
    /** The media of the post on the page shown. */
    media: MediaDetail[];
}>();

const emit = defineEmits<{
    /** Open a media in the editor. */
    (e: "edit", mediaId: string): void;
    /** A retry was queued; the post and its media change status. */
    (e: "retried"): void;
}>();

const { t } = useI18n();
const postStore = usePostStore();

const failedMedia = computed(() => props.media.filter((item) => item.error_kind));
const needsReshare = computed(
    () => props.post.error_kind === "SOURCE_UNAVAILABLE" || failedMedia.value.some((item) => item.error_kind === "SOURCE_UNAVAILABLE"),
);

const isRetrying = ref(false);
const retry = async () => {
    isRetrying.value = true;
    try {
        const res = await postStore.retrySync([props.post.id]);
        if (!res?.success) throw new Error();
        const count = res.data?.retriedCount ?? 0;
        if (count > 0) toast.success(t("sync.retry_queued", { count }));
        else toast.info(t("sync.nothing_to_retry"));
        emit("retried");
    } catch {
        toast.error(t("sync.retry_failed"));
    } finally {
        isRetrying.value = false;
    }
};

const formatMediaType = (type?: string | null) => getMediaTypeLabel(type, t);
</script>

<template>
    <section
        v-if="post.sync_status && post.sync_status !== 'COMPLETED'"
        class="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3"
        aria-labelledby="post-sync-heading"
    >
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 space-y-1.5">
                <h3
                    id="post-sync-heading"
                    class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-300"
                >
                    <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
                    {{ $t("sync.problems") }}
                </h3>
                <SourceErrorNote :status="post.sync_status" :kind="post.error_kind" />
            </div>
            <div class="flex shrink-0 items-center gap-2">
                <a
                    v-if="needsReshare && post.originalUrl"
                    :href="post.originalUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                >
                    <ExternalLink class="h-3.5 w-3.5" />
                    {{ $t("sync.open_platform") }}
                </a>
                <button
                    v-if="canRetry(post.sync_status, post.error_kind)"
                    type="button"
                    class="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                    :disabled="isRetrying"
                    @click="retry"
                >
                    <Loader2 v-if="isRetrying" class="h-3.5 w-3.5 animate-spin" />
                    <RefreshCw v-else class="h-3.5 w-3.5" />
                    {{ $t("sync.retry") }}
                </button>
            </div>
        </div>

        <ul v-if="failedMedia.length" class="divide-y divide-zinc-100 dark:divide-zinc-800">
            <li v-for="item in failedMedia" :key="item.id" class="flex items-center gap-3 py-2">
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">
                        #{{ item.position + 1 }} · {{ item.title || formatMediaType(item.type) }}
                    </div>
                    <SourceErrorNote :status="item.sync_status" :kind="item.error_kind" compact />
                </div>
                <button
                    type="button"
                    class="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                    @click="emit('edit', item.id)"
                >
                    <Pencil class="h-3.5 w-3.5" />
                    {{ $t("sync.edit") }}
                </button>
            </li>
        </ul>
    </section>
</template>
