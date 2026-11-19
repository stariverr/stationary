<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { ImageOff, Loader2, RotateCcw, Trash2, Upload, FileImage } from "@lucide/vue";
import { toast } from "vue-sonner";
import SourceErrorNote from "@/components/SourceErrorNote.vue";
import { apiErrorMessage, useApi } from "@/composables/useApi";
import type { ApiResponse } from "@/types/api";
import type { MediaCover, MediaCoverSource, MediaPreviews, MediaType } from "@/types/post";
import { canHaveCover } from "@/utils/media";
import { canRetry } from "@/utils/source-errors";

/**
 * The original cover of a media item, which the user can upload, replace or delete, and the previews the system
 * generates from it, shown read-only. An imported cover that failed to download shows why, with a retry after a
 * network or server error (docs/failure_handling.zh-Hans.md, 9.2).
 */
const props = withDefaults(defineProps<{ mediaId: string; isDark?: boolean }>(), { isDark: false });

const emit = defineEmits<{
    /** The cover was set, replaced or removed; the media's previews are being regenerated. */
    (e: "changed"): void;
}>();

interface MediaCoverDetail {
    type: MediaType;
    cover: MediaCover | null;
    cover_source: MediaCoverSource | null;
    previews: MediaPreviews;
}

const { t } = useI18n();

const detail = ref<MediaCoverDetail | null>(null);
const isUploading = ref(false);
const isDeleting = ref(false);
const isRetrying = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const coverable = computed(() => canHaveCover(detail.value?.type));
const isBusy = computed(() => isUploading.value || isDeleting.value || isRetrying.value);
const coverSource = computed(() => detail.value?.cover_source ?? null);

const previewSizes = computed(() => {
    const previews = detail.value?.previews;
    return [
        { key: "small", label: t("media.previews.sizes.small"), image: previews?.small ?? null },
        { key: "medium", label: t("media.previews.sizes.medium"), image: previews?.medium ?? null },
        { key: "large", label: t("media.previews.sizes.large"), image: previews?.large ?? null },
    ];
});

const fetchDetail = async () => {
    const mediaId = props.mediaId;
    try {
        const res = await useApi<ApiResponse<MediaCoverDetail>>(`/media/detail/${mediaId}`);
        if (mediaId !== props.mediaId) return;
        detail.value = res?.data ?? null;
    } catch (err) {
        console.error("Failed to fetch media cover:", err);
    }
};

watch(
    () => props.mediaId,
    (mediaId) => {
        detail.value = null;
        if (mediaId) void fetchDetail();
    },
    { immediate: true },
);

const pickFile = () => fileInput.value?.click();

const handleFileSelected = async (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    isUploading.value = true;
    try {
        const presign = await useApi<ApiResponse<{ url: string; path: string; bucket: string; mime_type: string; extension: string }>>(
            `/media/${props.mediaId}/cover/presign-upload`,
            { method: "POST", body: { fileName: file.name } },
        );
        if (!presign?.success || !presign.data) throw new Error(presign?.message);

        const { url, path, bucket, mime_type, extension } = presign.data;
        const upload = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": mime_type } });
        if (!upload.ok) throw new Error(`Upload failed with ${upload.status}`);

        const saved = await useApi<ApiResponse<unknown>>(`/media/${props.mediaId}/cover`, {
            method: "POST",
            body: { file: { path, bucket, mime_type, extension, size: file.size } },
        });
        if (!saved?.success) throw new Error(saved?.message);

        toast.success(t("media.cover.uploaded"));
        await fetchDetail();
        emit("changed");
    } catch (err) {
        console.error("Failed to upload cover:", err);
        toast.error(t("media.cover.upload_failed"));
    } finally {
        isUploading.value = false;
    }
};

const handleRetry = async () => {
    isRetrying.value = true;
    try {
        await useApi<ApiResponse<unknown>>(`/media/${props.mediaId}/cover/retry`, { method: "POST" });
        toast.success(t("media.editor.source_retried"));
        await fetchDetail();
        emit("changed");
    } catch (err) {
        toast.error(t("media.editor.edit_failed"), { description: apiErrorMessage(err) });
    } finally {
        isRetrying.value = false;
    }
};

const handleDelete = async () => {
    if (!confirm(t("media.cover.delete_confirm"))) return;
    isDeleting.value = true;
    try {
        const res = await useApi<ApiResponse<unknown>>(`/media/${props.mediaId}/cover/delete`, { method: "POST" });
        if (!res?.success) throw new Error(res?.message);
        toast.success(t("media.cover.deleted"));
        await fetchDetail();
        emit("changed");
    } catch (err) {
        console.error("Failed to delete cover:", err);
        toast.error(t("media.cover.delete_failed"));
    } finally {
        isDeleting.value = false;
    }
};
</script>

<template>
    <div v-if="detail" class="space-y-6">
        <!-- Cover: only VIDEO, AUDIO and PDF have one -->
        <section v-if="coverable" class="space-y-2.5">
            <div class="px-1">
                <h3
                    class="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5"
                    :class="isDark ? 'text-zinc-400' : 'text-zinc-500'"
                >
                    <FileImage class="w-3.5 h-3.5" />
                    {{ $t("media.cover.title") }}
                </h3>
                <p class="mt-1 text-xs" :class="isDark ? 'text-zinc-500' : 'text-zinc-500'">{{ $t("media.cover.desc") }}</p>
            </div>

            <div
                class="flex items-center gap-3 p-3 rounded-lg border"
                :class="isDark ? 'border-zinc-800 bg-zinc-900/20' : 'border-zinc-200 bg-white'"
            >
                <div
                    class="w-20 h-20 shrink-0 rounded-lg overflow-hidden flex items-center justify-center border"
                    :class="isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-zinc-50 border-zinc-200'"
                >
                    <img v-if="detail.cover" :src="detail.cover.url" :alt="$t('media.cover.title')" class="w-full h-full object-cover" />
                    <ImageOff v-else class="w-5 h-5" :class="isDark ? 'text-zinc-600' : 'text-zinc-400'" />
                </div>

                <div class="flex-1 min-w-0 flex flex-col gap-2">
                    <span v-if="!detail.cover && !coverSource?.error_kind" class="text-xs text-zinc-500">
                        {{ $t("media.cover.empty") }}
                    </span>
                    <SourceErrorNote v-if="coverSource?.error_kind" :status="coverSource.status" :kind="coverSource.error_kind" />
                    <p v-if="coverSource?.last_error" class="text-[11px] break-words text-zinc-500">{{ coverSource.last_error }}</p>
                    <div class="flex flex-wrap items-center gap-2">
                        <button
                            v-if="coverSource && canRetry(coverSource.status, coverSource.error_kind)"
                            type="button"
                            :disabled="isBusy"
                            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                            :class="
                                isDark
                                    ? 'border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
                                    : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50'
                            "
                            @click="handleRetry"
                        >
                            <Loader2 v-if="isRetrying" class="w-3.5 h-3.5 animate-spin" />
                            <RotateCcw v-else class="w-3.5 h-3.5" />
                            {{ $t("sync.retry") }}
                        </button>
                        <button
                            type="button"
                            :disabled="isBusy"
                            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                            :class="
                                isDark
                                    ? 'border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
                                    : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50'
                            "
                            @click="pickFile"
                        >
                            <Loader2 v-if="isUploading" class="w-3.5 h-3.5 animate-spin" />
                            <Upload v-else class="w-3.5 h-3.5" />
                            {{ detail.cover ? $t("media.cover.replace") : $t("media.cover.upload") }}
                        </button>
                        <button
                            v-if="detail.cover"
                            type="button"
                            :disabled="isBusy"
                            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                            :class="
                                isDark
                                    ? 'border-red-900/40 text-red-400 hover:bg-red-950/30'
                                    : 'border-red-200 text-red-600 hover:bg-red-50'
                            "
                            @click="handleDelete"
                        >
                            <Loader2 v-if="isDeleting" class="w-3.5 h-3.5 animate-spin" />
                            <Trash2 v-else class="w-3.5 h-3.5" />
                            {{ $t("media.cover.delete") }}
                        </button>
                    </div>
                    <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="handleFileSelected" />
                </div>
            </div>
        </section>

        <!-- Previews: generated by the system, read-only -->
        <section class="space-y-2.5">
            <div class="px-1">
                <h3
                    class="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5"
                    :class="isDark ? 'text-zinc-400' : 'text-zinc-500'"
                >
                    <FileImage class="w-3.5 h-3.5" />
                    {{ $t("media.previews.title") }}
                </h3>
                <p class="mt-1 text-xs" :class="isDark ? 'text-zinc-500' : 'text-zinc-500'">{{ $t("media.previews.desc") }}</p>
            </div>

            <div class="grid grid-cols-3 gap-2.5">
                <figure v-for="size in previewSizes" :key="size.key" class="flex flex-col gap-1.5">
                    <div
                        class="aspect-square rounded-lg overflow-hidden flex items-center justify-center border"
                        :class="isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-zinc-50 border-zinc-200'"
                    >
                        <img v-if="size.image" :src="size.image.url" :alt="size.label" class="w-full h-full object-cover" loading="lazy" />
                        <span v-else class="px-2 text-center text-xs" :class="isDark ? 'text-zinc-600' : 'text-zinc-400'">
                            {{ $t("media.previews.missing") }}
                        </span>
                    </div>
                    <figcaption class="flex items-center justify-between gap-1 px-0.5 text-xs">
                        <span class="font-semibold" :class="isDark ? 'text-zinc-300' : 'text-zinc-700'">{{ size.label }}</span>
                        <span v-if="size.image" class="font-mono tabular-nums" :class="isDark ? 'text-zinc-500' : 'text-zinc-500'">
                            {{ size.image.width }}×{{ size.image.height }}
                        </span>
                    </figcaption>
                </figure>
            </div>
        </section>
    </div>
</template>
