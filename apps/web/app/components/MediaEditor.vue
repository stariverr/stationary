<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AudioLines, Download, FileStack, Loader2, Plus, RefreshCw, Star, Subtitles, Trash2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { apiErrorMessage, useApi } from "@/composables/useApi";
import { useImportStore } from "@/stores/import";
import { useLibraryStore } from "@/stores/library";
import { Input } from "@/components/ui/input";
import MediaCoverPanel from "@/components/MediaCoverPanel.vue";
import type { ApiResponse } from "@/types/api";
import { MediaType, type MediaCaption, type MediaDetail, type MediaOriginal, type PlaybackAudioTrack } from "@/types/post";
import { formatBytes } from "@/utils/media";

/**
 * Edits what a media is made of: its originals (add, replace, delete, download), its captions (add, rename, set the
 * default, delete), its audio tracks (rename, set the default) and its cover. New files go up as draft files first;
 * the server probes them and refuses a change that leaves the media incomplete.
 */
const props = withDefaults(defineProps<{ mediaId: string; isDark?: boolean }>(), { isDark: false });

const emit = defineEmits<{
    /** Something the media plays or shows changed. */
    (e: "changed"): void;
}>();

const { t } = useI18n();
const importStore = useImportStore();
const libraryStore = useLibraryStore();

const detail = ref<MediaDetail | null>(null);
const isLoading = ref(false);
/** The row an action runs on, e.g. `original:<id>`, `caption:new`; one at a time. */
const busyKey = ref<string | null>(null);

const fetchDetail = async () => {
    const mediaId = props.mediaId;
    isLoading.value = true;
    try {
        const res = await useApi<ApiResponse<MediaDetail>>(`/media/detail/${mediaId}`);
        if (mediaId === props.mediaId) detail.value = res?.data ?? null;
    } catch (error) {
        console.error("Failed to fetch media detail:", error);
    } finally {
        isLoading.value = false;
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

const hasCaptions = computed(() => detail.value?.type === MediaType.VIDEO || detail.value?.type === MediaType.AUDIO);
// Only a video takes a variable number of originals: its video file plus any number of audio-only files.
const canAddOriginal = computed(() => detail.value?.type === MediaType.VIDEO);
const audioTracks = computed(() => detail.value?.playback?.audio_tracks ?? []);

/** Runs one edit, then reloads the media; the server's message explains a refused change. */
const runEdit = async (key: string, action: () => Promise<unknown>, successKey: string) => {
    if (busyKey.value) return;
    busyKey.value = key;
    try {
        await action();
        toast.success(t(successKey));
        await fetchDetail();
        emit("changed");
    } catch (error) {
        toast.error(t("media.editor.edit_failed"), { description: apiErrorMessage(error) });
    } finally {
        busyKey.value = null;
    }
};

const post = <T>(path: string, body?: Record<string, unknown>) =>
    useApi<ApiResponse<T>>(`/media/${props.mediaId}${path}`, { method: "POST", ...(body ? { body } : {}) });

/** Uploads a file as a draft file and hands it to `use`; a draft the server refused is removed again. */
const withDraftFile = async (file: File, use: (draftFileId: string) => Promise<unknown>) => {
    const libraryId = libraryStore.activeLibraryId;
    if (!libraryId) throw new Error(t("media.editor.no_library"));
    const draft = await importStore.uploadFile(libraryId, file);
    importStore.isTrayOpen = false;
    try {
        await use(draft.id);
    } catch (error) {
        await importStore.deleteDraftFile(libraryId, draft.id).catch(() => undefined);
        throw error;
    }
    importStore.draftFiles = importStore.draftFiles.filter((item) => item.id !== draft.id);
};

// File picking: one hidden input, told what the picked file is for.
const fileInput = ref<HTMLInputElement | null>(null);
const fileAccept = ref("");
let onFilePicked: ((file: File) => void) | null = null;

const pickFile = (accept: string, handler: (file: File) => void) => {
    fileAccept.value = accept;
    onFilePicked = handler;
    // Let the accept attribute update before the picker opens.
    requestAnimationFrame(() => fileInput.value?.click());
};

const handleFilePicked = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) onFilePicked?.(file);
    onFilePicked = null;
};

// --- Originals ---

const originalAccept = computed(() => {
    switch (detail.value?.type) {
        case MediaType.VIDEO:
            return "video/*,audio/*,.mkv,.m4a,.m4s";
        case MediaType.AUDIO:
            return "audio/*,video/mp4,.m4a";
        case MediaType.LIVE_PHOTO:
            return "image/*,video/*,.heic,.heif";
        case MediaType.IMAGE:
            return "image/*,.heic,.heif,.jxl";
        case MediaType.PDF:
            return "application/pdf";
        default:
            return "";
    }
});

const originalKindLabel = (original: MediaOriginal) =>
    original.kind ? t(`media.editor.kinds.${original.kind.toLowerCase()}`) : t("media.editor.kinds.unknown");

const isMainOriginal = (original: MediaOriginal) => Boolean(original.url) && original.url === detail.value?.url;

const addOriginal = () =>
    pickFile(originalAccept.value, (file) =>
        runEdit(
            "original:new",
            () => withDraftFile(file, (id) => post("/originals", { draft_file_id: id })),
            "media.editor.original_added",
        ),
    );

const replaceOriginal = (original: MediaOriginal) =>
    pickFile(originalAccept.value, (file) =>
        runEdit(
            `original:${original.id}`,
            () => withDraftFile(file, (id) => post("/originals", { draft_file_id: id, replaces: original.id })),
            "media.editor.original_replaced",
        ),
    );

const deleteOriginal = (original: MediaOriginal) => {
    if (!confirm(t("media.editor.original_delete_confirm"))) return;
    void runEdit(`original:${original.id}`, () => post(`/originals/${original.id}/delete`), "media.editor.original_deleted");
};

const downloadOriginal = async (original: MediaOriginal) => {
    if (busyKey.value) return;
    busyKey.value = `original:${original.id}`;
    try {
        const res = await useApi<ApiResponse<{ url: string }>>(`/media/${props.mediaId}/originals/${original.id}/download-url`);
        if (!res?.data?.url) throw new Error(res?.message);
        // The URL answers with Content-Disposition: attachment, so the browser saves it without leaving the page.
        const link = document.createElement("a");
        link.href = res.data.url;
        link.rel = "noopener";
        link.click();
    } catch (error) {
        toast.error(t("post_detail.toasts.download_failed"), { description: apiErrorMessage(error) });
    } finally {
        busyKey.value = null;
    }
};

// --- Captions and audio tracks: language, label and default ---

interface TrackInfoDraft {
    language: string;
    label: string;
}
const trackInfoDrafts = ref<Record<string, TrackInfoDraft>>({});

watch(detail, (value) => {
    const drafts: Record<string, TrackInfoDraft> = {};
    for (const caption of value?.captions ?? []) drafts[caption.id] = { language: caption.language ?? "", label: caption.label ?? "" };
    for (const track of value?.playback?.audio_tracks ?? [])
        drafts[track.id] = { language: track.language ?? "", label: track.label ?? "" };
    trackInfoDrafts.value = drafts;
});

const infoChanged = (item: MediaCaption | PlaybackAudioTrack) => {
    const draft = trackInfoDrafts.value[item.id];
    return Boolean(draft) && (draft!.language.trim() !== (item.language ?? "") || draft!.label.trim() !== (item.label ?? ""));
};

const infoPatch = (id: string) => {
    const draft = trackInfoDrafts.value[id]!;
    return { language: draft.language.trim() || null, label: draft.label.trim() || null };
};

const addCaption = () =>
    pickFile(".srt,.vtt,.ass", (file) =>
        runEdit("caption:new", () => withDraftFile(file, (id) => post("/captions", { draft_file_id: id })), "media.editor.caption_added"),
    );

const saveCaption = (caption: MediaCaption) =>
    runEdit(`caption:${caption.id}`, () => post(`/captions/${caption.id}/update`, infoPatch(caption.id)), "media.editor.saved");

const toggleDefaultCaption = (caption: MediaCaption) =>
    runEdit(
        `caption:${caption.id}`,
        () => post(`/captions/${caption.id}/update`, { is_default: !caption.is_default }),
        "media.editor.saved",
    );

const deleteCaption = (caption: MediaCaption) => {
    if (!confirm(t("media.editor.caption_delete_confirm"))) return;
    void runEdit(`caption:${caption.id}`, () => post(`/captions/${caption.id}/delete`), "media.editor.caption_deleted");
};

const saveAudioTrack = (track: PlaybackAudioTrack) =>
    runEdit(`audio:${track.id}`, () => post(`/audio-tracks/${track.id}/update`, infoPatch(track.id)), "media.editor.saved");

const makeDefaultAudioTrack = (track: PlaybackAudioTrack) =>
    runEdit(`audio:${track.id}`, () => post(`/audio-tracks/${track.id}/update`, { is_default: true }), "media.editor.saved");

const statusClass = (status: string) =>
    status === "FAILED" ? "text-red-500" : status === "COMPLETED" ? (props.isDark ? "text-zinc-500" : "text-zinc-400") : "text-amber-500";

const rowClass = computed(() => (props.isDark ? "border-zinc-800 bg-zinc-900/20" : "border-zinc-200 bg-white"));
const headingClass = computed(() => (props.isDark ? "text-zinc-400" : "text-zinc-500"));
const buttonClass = computed(() =>
    props.isDark
        ? "border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
        : "border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50",
);
const dangerButtonClass = computed(() =>
    props.isDark ? "border-red-900/40 text-red-400 hover:bg-red-950/30" : "border-red-200 text-red-600 hover:bg-red-50",
);
</script>

<template>
    <div class="space-y-6">
        <input ref="fileInput" type="file" :accept="fileAccept" class="hidden" @change="handleFilePicked" />

        <div v-if="!detail && isLoading" class="flex items-center justify-center py-10">
            <Loader2 class="w-5 h-5 animate-spin" :class="headingClass" />
        </div>

        <template v-if="detail">
            <!-- Originals -->
            <section class="space-y-2.5">
                <div class="flex items-center justify-between gap-2 px-1">
                    <h3 class="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5" :class="headingClass">
                        <FileStack class="w-3.5 h-3.5" />
                        {{ $t("media.editor.originals") }}
                    </h3>
                    <button
                        v-if="canAddOriginal"
                        type="button"
                        :disabled="!!busyKey"
                        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        :class="buttonClass"
                        @click="addOriginal"
                    >
                        <Loader2 v-if="busyKey === 'original:new'" class="w-3.5 h-3.5 animate-spin" />
                        <Plus v-else class="w-3.5 h-3.5" />
                        {{ $t("media.editor.add_audio_file") }}
                    </button>
                </div>

                <ul class="space-y-2">
                    <li
                        v-for="original in detail.originals"
                        :key="original.id"
                        class="flex flex-wrap items-center gap-3 p-3 rounded-lg border"
                        :class="rowClass"
                    >
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 text-xs font-semibold">
                                <span>{{ originalKindLabel(original) }}</span>
                                <span
                                    v-if="isMainOriginal(original)"
                                    class="px-1.5 py-0.5 rounded-md text-[10px] uppercase tracking-wider"
                                    :class="isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-100 text-zinc-600'"
                                >
                                    {{ $t("media.editor.main") }}
                                </span>
                            </div>
                            <div class="mt-0.5 text-xs truncate" :class="headingClass">
                                <span v-if="original.mime_type">{{ original.mime_type }}</span>
                                <span v-if="original.size !== null"> · {{ formatBytes(original.size) }}</span>
                                <span v-if="original.status !== 'COMPLETED'" :class="statusClass(original.status)">
                                    · {{ $t(`media.editor.status.${original.status.toLowerCase()}`) }}
                                </span>
                            </div>
                            <p v-if="original.last_error" class="mt-1 text-xs text-red-500 break-words">{{ original.last_error }}</p>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <Loader2 v-if="busyKey === `original:${original.id}`" class="w-3.5 h-3.5 animate-spin" :class="headingClass" />
                            <button
                                v-if="original.url"
                                type="button"
                                :disabled="!!busyKey"
                                class="p-1.5 rounded-lg border transition-colors disabled:opacity-50 cursor-pointer"
                                :class="buttonClass"
                                :title="$t('post_detail.viewer.download')"
                                :aria-label="$t('post_detail.viewer.download')"
                                @click="downloadOriginal(original)"
                            >
                                <Download class="w-3.5 h-3.5" />
                            </button>
                            <button
                                type="button"
                                :disabled="!!busyKey"
                                class="p-1.5 rounded-lg border transition-colors disabled:opacity-50 cursor-pointer"
                                :class="buttonClass"
                                :title="$t('media.editor.replace')"
                                :aria-label="$t('media.editor.replace')"
                                @click="replaceOriginal(original)"
                            >
                                <RefreshCw class="w-3.5 h-3.5" />
                            </button>
                            <button
                                type="button"
                                :disabled="!!busyKey"
                                class="p-1.5 rounded-lg border transition-colors disabled:opacity-50 cursor-pointer"
                                :class="dangerButtonClass"
                                :title="$t('media.editor.delete')"
                                :aria-label="$t('media.editor.delete')"
                                @click="deleteOriginal(original)"
                            >
                                <Trash2 class="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </li>
                </ul>
            </section>

            <!-- Audio tracks: only when the media plays more than one -->
            <section v-if="audioTracks.length > 1" class="space-y-2.5">
                <h3 class="px-1 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5" :class="headingClass">
                    <AudioLines class="w-3.5 h-3.5" />
                    {{ $t("media.editor.audio_tracks") }}
                </h3>
                <ul class="space-y-2">
                    <li
                        v-for="track in audioTracks"
                        :key="track.id"
                        class="flex flex-wrap items-center gap-2 p-3 rounded-lg border"
                        :class="rowClass"
                    >
                        <span class="text-xs font-mono shrink-0" :class="headingClass">{{ track.codec }} · {{ track.channels }}ch</span>
                        <template v-if="trackInfoDrafts[track.id]">
                            <Input
                                v-model="trackInfoDrafts[track.id]!.label"
                                :placeholder="$t('media.editor.label')"
                                :aria-label="$t('media.editor.label')"
                                class="h-8 flex-1 min-w-[120px] text-xs"
                            />
                            <Input
                                v-model="trackInfoDrafts[track.id]!.language"
                                :placeholder="$t('media.editor.language')"
                                :aria-label="$t('media.editor.language')"
                                class="h-8 w-20 text-xs"
                            />
                        </template>
                        <button
                            v-if="infoChanged(track)"
                            type="button"
                            :disabled="!!busyKey"
                            class="px-2.5 py-1 rounded-lg border text-xs font-semibold disabled:opacity-50 cursor-pointer"
                            :class="buttonClass"
                            @click="saveAudioTrack(track)"
                        >
                            {{ $t("media.editor.save") }}
                        </button>
                        <button
                            type="button"
                            :disabled="!!busyKey || track.is_default"
                            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-semibold disabled:cursor-default cursor-pointer"
                            :class="[buttonClass, track.is_default ? 'opacity-100' : 'disabled:opacity-50']"
                            @click="makeDefaultAudioTrack(track)"
                        >
                            <Loader2 v-if="busyKey === `audio:${track.id}`" class="w-3.5 h-3.5 animate-spin" />
                            <Star v-else class="w-3.5 h-3.5" :class="track.is_default ? 'fill-current text-amber-500' : ''" />
                            {{ track.is_default ? $t("media.editor.default") : $t("media.editor.make_default") }}
                        </button>
                    </li>
                </ul>
            </section>

            <!-- Captions -->
            <section v-if="hasCaptions" class="space-y-2.5">
                <div class="flex items-center justify-between gap-2 px-1">
                    <h3 class="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5" :class="headingClass">
                        <Subtitles class="w-3.5 h-3.5" />
                        {{ $t("media.editor.captions") }}
                    </h3>
                    <button
                        type="button"
                        :disabled="!!busyKey"
                        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        :class="buttonClass"
                        @click="addCaption"
                    >
                        <Loader2 v-if="busyKey === 'caption:new'" class="w-3.5 h-3.5 animate-spin" />
                        <Plus v-else class="w-3.5 h-3.5" />
                        {{ $t("media.editor.add_caption") }}
                    </button>
                </div>

                <p v-if="detail.captions.length === 0" class="px-1 text-xs" :class="headingClass">{{ $t("media.editor.no_captions") }}</p>
                <ul v-else class="space-y-2">
                    <li
                        v-for="caption in detail.captions"
                        :key="caption.id"
                        class="flex flex-wrap items-center gap-2 p-3 rounded-lg border"
                        :class="rowClass"
                    >
                        <template v-if="trackInfoDrafts[caption.id]">
                            <Input
                                v-model="trackInfoDrafts[caption.id]!.label"
                                :placeholder="$t('media.editor.label')"
                                :aria-label="$t('media.editor.label')"
                                class="h-8 flex-1 min-w-[120px] text-xs"
                            />
                            <Input
                                v-model="trackInfoDrafts[caption.id]!.language"
                                :placeholder="$t('media.editor.language')"
                                :aria-label="$t('media.editor.language')"
                                class="h-8 w-20 text-xs"
                            />
                        </template>
                        <span v-if="caption.origin === 'EMBEDDED'" class="text-xs" :class="headingClass">
                            {{ $t("media.editor.embedded") }}
                        </span>
                        <span v-if="caption.status !== 'COMPLETED'" class="text-xs" :class="statusClass(caption.status)">
                            {{ $t(`media.editor.status.${caption.status.toLowerCase()}`) }}
                        </span>
                        <button
                            v-if="infoChanged(caption)"
                            type="button"
                            :disabled="!!busyKey"
                            class="px-2.5 py-1 rounded-lg border text-xs font-semibold disabled:opacity-50 cursor-pointer"
                            :class="buttonClass"
                            @click="saveCaption(caption)"
                        >
                            {{ $t("media.editor.save") }}
                        </button>
                        <button
                            type="button"
                            :disabled="!!busyKey"
                            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-semibold disabled:opacity-50 cursor-pointer"
                            :class="buttonClass"
                            :aria-pressed="caption.is_default"
                            @click="toggleDefaultCaption(caption)"
                        >
                            <Loader2 v-if="busyKey === `caption:${caption.id}`" class="w-3.5 h-3.5 animate-spin" />
                            <Star v-else class="w-3.5 h-3.5" :class="caption.is_default ? 'fill-current text-amber-500' : ''" />
                            {{ caption.is_default ? $t("media.editor.default") : $t("media.editor.make_default") }}
                        </button>
                        <button
                            type="button"
                            :disabled="!!busyKey"
                            class="p-1.5 rounded-lg border transition-colors disabled:opacity-50 cursor-pointer"
                            :class="dangerButtonClass"
                            :title="$t('media.editor.delete')"
                            :aria-label="$t('media.editor.delete')"
                            @click="deleteCaption(caption)"
                        >
                            <Trash2 class="w-3.5 h-3.5" />
                        </button>
                        <p v-if="caption.last_error" class="basis-full text-xs text-red-500 break-words">{{ caption.last_error }}</p>
                    </li>
                </ul>
            </section>
        </template>

        <MediaCoverPanel :media-id="mediaId" :is-dark="isDark" @changed="emit('changed')" />
    </div>
</template>
