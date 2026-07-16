<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useImportStore, type DraftFileItem } from "@/stores/import";
import { useLibraryStore } from "@/stores/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/components/ui/sonner";
import { useResizeObserver } from "@vueuse/core";
import {
    getAllowedFileTrackTypes,
    getAllowedTrackPurposes,
    getCompatibleMediaTypes,
    getDraftCompositionError,
    getRequiredContentTrackTypes,
    isLanguageTrackType,
    normalizeDraftTracksForMedia,
    MediaType,
    TrackPurpose,
    TrackType,
} from "@/utils/draft-media-rules";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Upload, File, Video, Music, X, Loader2, Plus, AlertCircle, Info, ArrowLeft, Search, FolderOpen } from "@lucide/vue";

const props = withDefaults(
    defineProps<{
        mode?: "standalone" | "draft";
        initialDraft?: any;
        initialFiles?: File[];
    }>(),
    {
        mode: "standalone",
        initialDraft: null,
        initialFiles: () => [],
    },
);

const emit = defineEmits<{
    cancel: [];
    created: [media: { id: string; title: string; type: string }];
    "draft-created": [
        draft: {
            temp_id: string;
            title: string;
            type: string;
            tracks: {
                draft_file_id: string;
                type: string;
                purpose: string;
                quality: string;
                is_default: boolean;
                language: string | null;
            }[];
            _files: {
                id: string;
                name: string;
                mime_type: string;
                url?: string;
            }[];
        },
    ];
}>();

const importStore = useImportStore();
const libraryStore = useLibraryStore();
const queryClient = useQueryClient();
const libraryId = computed(() => libraryStore.activeLibraryId);
const { t } = useI18n();

// Container responsive sizing
const containerRef = ref<HTMLElement | null>(null);
const isNarrow = ref(false);

useResizeObserver(containerRef, (entries) => {
    const entry = entries[0];
    if (entry) {
        const { width } = entry.contentRect;
        isNarrow.value = width < 750;
    }
});

// Uploaded draft files for this creation session
const sessionFiles = ref<DraftFileItem[]>([]);
const isUploading = ref(false);
const isDragActive = ref(false);
const uploadedFileKeys = new Set<string>();
const uploadingFileKeys = new Set<string>();
const sessionFileKeys = new Map<string, string>();

// Newly uploaded files in this session (will be deleted on discard/cancel)
const newlyUploadedFileIds = ref<string[]>([]);
// Existing files marked for deletion (will be deleted only on commit)
const pendingDeleteFileIds = ref<string[]>([]);

// Draft Box selection state
const isDraftSelectOpen = ref(false);
const draftSearchQuery = ref("");
const selectedDraftFileIds = ref<string[]>([]);
const preExistingDraftIds = ref<Set<string>>(new Set());
const isLoadingDrafts = ref(false);

const filteredDraftFiles = computed(() => {
    const list = importStore.draftFiles;
    if (!draftSearchQuery.value.trim()) return list;
    const query = draftSearchQuery.value.toLowerCase();
    return list.filter((item) => item.name.toLowerCase().includes(query));
});

function toggleDraftSelection(id: string, checked: boolean) {
    if (checked) {
        if (!selectedDraftFileIds.value.includes(id)) {
            selectedDraftFileIds.value.push(id);
        }
    } else {
        selectedDraftFileIds.value = selectedDraftFileIds.value.filter((fid) => fid !== id);
    }
}

async function openDraftSelection() {
    if (libraryId.value) {
        isLoadingDrafts.value = true;
        try {
            await importStore.fetchDraftFiles(libraryId.value);
        } finally {
            isLoadingDrafts.value = false;
        }
    }
    // Initialize selected ids with current sessionFiles
    selectedDraftFileIds.value = sessionFiles.value.map((f) => f.id);
    draftSearchQuery.value = "";
    isDraftSelectOpen.value = true;
}

function confirmDraftSelection() {
    const currentSessionMap = new Map(sessionFiles.value.map((f) => [f.id, f]));
    const newSessionFiles: DraftFileItem[] = [];

    for (const id of selectedDraftFileIds.value) {
        if (currentSessionMap.has(id)) {
            newSessionFiles.push(currentSessionMap.get(id)!);
        } else {
            const draft = importStore.draftFiles.find((d) => d.id === id);
            if (draft) {
                newSessionFiles.push(draft);
                preExistingDraftIds.value.add(id);
            }
        }
    }

    const newSelectedSet = new Set(selectedDraftFileIds.value);
    for (const file of sessionFiles.value) {
        if (!newSelectedSet.has(file.id)) {
            const isNew = newlyUploadedFileIds.value.includes(file.id);
            if (isNew && libraryId.value) {
                importStore.deleteDraftFile(libraryId.value, file.id).catch(() => undefined);
                newlyUploadedFileIds.value = newlyUploadedFileIds.value.filter((fid) => fid !== file.id);
            }
            preExistingDraftIds.value.delete(file.id);
        }
    }

    sessionFiles.value = newSessionFiles;
    rebuildTracks();
    isDraftSelectOpen.value = false;
}

function formatDate(dateStr: string) {
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return dateStr;
    }
}

function getFileKey(file: File): string {
    return `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
}

// Track configuration
type TrackConfig = {
    draft_file_id: string;
    name: string;
    mime_type: string;
    type: TrackType | null;
    purpose: TrackPurpose;
    quality: "ORIGINAL" | "HIGH" | "MEDIUM" | "LOW";
    is_default: boolean;
    language: string;
};

const mediaTitle = ref("");
const mediaType = ref<MediaType>(MediaType.VIDEO);
const tracksConfig = ref<TrackConfig[]>([]);

const mediaTypeLabels: Record<MediaType, string> = {
    [MediaType.IMAGE]: "Image Gallery",
    [MediaType.VIDEO]: "Video Asset",
    [MediaType.LIVE_PHOTO]: "Live Photo",
    [MediaType.AUDIO]: "Audio Asset",
    [MediaType.PDF]: "PDF Document",
};

const compatibleTypes = computed(() => getCompatibleMediaTypes(tracksConfig.value));
const compositionError = computed(() => {
    const err = getDraftCompositionError(mediaType.value, tracksConfig.value);
    if (!err) return null;
    return err.params ? t(err.key, err.params) : t(err.key);
});

function getTrackTypeOptions(track: TrackConfig): TrackType[] {
    return getAllowedFileTrackTypes(track.name, track.mime_type).filter(
        (trackType) => getAllowedTrackPurposes(mediaType.value, trackType).length > 0,
    );
}

function getPurposeOptions(track: TrackConfig): TrackPurpose[] {
    return getAllowedTrackPurposes(mediaType.value, track.type);
}

function reconcileDefaultTracks() {
    const defaultGroups = new Set<string>();
    for (const track of tracksConfig.value) {
        if (!track.is_default || !track.type) continue;
        const key = `${track.type}:${track.purpose}`;
        if (defaultGroups.has(key)) track.is_default = false;
        else defaultGroups.add(key);
    }

    for (const requiredType of getRequiredContentTrackTypes(mediaType.value)) {
        const contentTracks = tracksConfig.value.filter((track) => track.type === requiredType && track.purpose === TrackPurpose.CONTENT);
        if (contentTracks.length > 0 && !contentTracks.some((track) => track.is_default)) {
            contentTracks[0]!.is_default = true;
        }
    }
}

function normalizeTracks(type: MediaType) {
    tracksConfig.value = normalizeDraftTracksForMedia(type, tracksConfig.value).map((track) => ({
        ...track,
        language: isLanguageTrackType(track.type) ? track.language : "",
    }));
}

function handleMediaTypeChange(value: unknown) {
    if (typeof value !== "string" || !compatibleTypes.value.includes(value as MediaType)) return;
    mediaType.value = value as MediaType;
    normalizeTracks(mediaType.value);
}

function handleTrackTypeChange(track: TrackConfig, value: unknown) {
    if (typeof value !== "string" || !getTrackTypeOptions(track).includes(value as TrackType)) return;
    track.type = value as TrackType;
    const purposes = getPurposeOptions(track);
    if (!purposes.includes(track.purpose)) {
        track.purpose = purposes.includes(TrackPurpose.CONTENT) ? TrackPurpose.CONTENT : (purposes[0] ?? TrackPurpose.CONTENT);
    }
    if (!isLanguageTrackType(track.type)) track.language = "";
    reconcileDefaultTracks();
}

function handleTrackPurposeChange(track: TrackConfig, value: unknown) {
    if (typeof value !== "string" || !getPurposeOptions(track).includes(value as TrackPurpose)) return;
    track.purpose = value as TrackPurpose;
    reconcileDefaultTracks();
}

function handleDefaultChange(track: TrackConfig, checked: unknown) {
    if (!track.type) return;
    const shouldCheck = checked === true;
    const isRequiredGroup = track.purpose === "CONTENT" && getRequiredContentTrackTypes(mediaType.value).includes(track.type!);
    if (!shouldCheck && isRequiredGroup && track.is_default) return;

    if (shouldCheck) {
        for (const candidate of tracksConfig.value) {
            if (candidate !== track && candidate.type === track.type && candidate.purpose === track.purpose) {
                candidate.is_default = false;
            }
        }
    }
    track.is_default = shouldCheck;
}

// File upload
let dragCounter = 0;

function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    dragCounter++;
    isDragActive.value = true;
}

function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) isDragActive.value = false;
}

function handleDragOver(e: DragEvent) {
    e.preventDefault();
}

async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter = 0;
    isDragActive.value = false;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
        await uploadFiles(Array.from(files));
    }
}

const fileInputRef = ref<HTMLInputElement | null>(null);

function triggerFileSelect() {
    fileInputRef.value?.click();
}

async function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    const files = target.files;
    if (files && files.length > 0) {
        await uploadFiles(Array.from(files));
        target.value = "";
    }
}

async function uploadFiles(files: File[]) {
    if (!libraryId.value) return;

    const filesToUpload = files.filter((file) => {
        const key = getFileKey(file);
        if (uploadedFileKeys.has(key) || uploadingFileKeys.has(key)) return false;
        uploadingFileKeys.add(key);
        return true;
    });
    if (filesToUpload.length === 0) return;

    isUploading.value = true;
    try {
        const uploaded = await Promise.all(filesToUpload.map((file) => importStore.uploadFile(libraryId.value!, file)));
        for (const [index, draft] of uploaded.entries()) {
            const fileKey = getFileKey(filesToUpload[index]!);
            uploadedFileKeys.add(fileKey);
            sessionFileKeys.set(draft.id, fileKey);
            if (!sessionFiles.value.some((file) => file.id === draft.id)) {
                sessionFiles.value.push(draft);
                newlyUploadedFileIds.value.push(draft.id);
            }
        }
        rebuildTracks();
    } catch (e: any) {
        toast.error(t("media.toast_upload_failed"), { description: e.message || String(e) });
    } finally {
        for (const file of filesToUpload) uploadingFileKeys.delete(getFileKey(file));
        isUploading.value = false;
        importStore.isTrayOpen = false;
    }
}

function rebuildTracks() {
    const existingIds = new Set(tracksConfig.value.map((t) => t.draft_file_id));
    for (const draft of sessionFiles.value) {
        if (!existingIds.has(draft.id)) {
            const type = getAllowedFileTrackTypes(draft.name, draft.mime_type)[0] ?? null;
            tracksConfig.value.push({
                draft_file_id: draft.id,
                name: draft.name,
                mime_type: draft.mime_type,
                type,
                purpose: TrackPurpose.CONTENT,
                quality: "ORIGINAL",
                is_default: false,
                language: "",
            });
        }
    }
    const sessionIds = new Set(sessionFiles.value.map((f) => f.id));
    tracksConfig.value = tracksConfig.value.filter((t) => sessionIds.has(t.draft_file_id));

    // Auto-select media type & title
    if (tracksConfig.value.length > 0 && sessionFiles.value.length > 0) {
        const compatible = getCompatibleMediaTypes(tracksConfig.value);
        if (!compatible.includes(mediaType.value)) {
            mediaType.value = compatible.includes(MediaType.VIDEO)
                ? MediaType.VIDEO
                : compatible.includes(MediaType.AUDIO)
                  ? MediaType.AUDIO
                  : (compatible[0] ?? MediaType.IMAGE);
        }
        if (!mediaTitle.value) {
            const first = sessionFiles.value[0]!;
            mediaTitle.value = first.name.substring(0, first.name.lastIndexOf(".")) || first.name;
        }
        normalizeTracks(mediaType.value);
    }
}

async function removeFile(id: string) {
    const file = sessionFiles.value.find((item) => item.id === id);
    if (!file) return;

    const isNewUpload = newlyUploadedFileIds.value.includes(id);
    const isPreExistingSelected = preExistingDraftIds.value.has(id);

    try {
        if (isNewUpload) {
            // Newly uploaded files can be physically deleted immediately
            if (libraryId.value) await importStore.deleteDraftFile(libraryId.value, id);
            newlyUploadedFileIds.value = newlyUploadedFileIds.value.filter((fid) => fid !== id);
        } else if (!isPreExistingSelected) {
            // Old files are only marked for deletion
            pendingDeleteFileIds.value.push(id);
        } else {
            // Pre-existing draft file selected from draft box, just remove from session
            preExistingDraftIds.value.delete(id);
        }

        uploadedFileKeys.delete(sessionFileKeys.get(id) ?? "");
        sessionFileKeys.delete(id);
        sessionFiles.value = sessionFiles.value.filter((item) => item.id !== id);
        rebuildTracks();
    } catch (e: any) {
        toast.error(t("media.toast_remove_failed"), { description: e.message || String(e) });
    }
}

function formatBytes(bytes: number | null | undefined, decimals = 2) {
    if (bytes === null || bytes === undefined || isNaN(Number(bytes))) return t("common.unknown_size", "Unknown Size");
    const bytesNum = Number(bytes);
    if (bytesNum === 0) return t("common.zero_bytes", "0 Bytes");
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytesNum) / Math.log(k));
    return parseFloat((bytesNum / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

const isCommitting = ref(false);
const hasCommitted = ref(false);

async function handleCreate() {
    if (!mediaTitle.value.trim() || !libraryId.value) return;

    const error = compositionError.value;
    if (error) {
        toast.warning(t("media.toast_invalid_composition"), { description: error });
        return;
    }

    // Execute actual file deletions for pending removals
    if (pendingDeleteFileIds.value.length > 0) {
        for (const id of pendingDeleteFileIds.value) {
            importStore.deleteDraftFile(libraryId.value, id).catch((e) => {
                console.error("Failed to clean up removed old file:", e);
            });
        }
        pendingDeleteFileIds.value = [];
    }

    if (props.mode === "draft") {
        const draftGroup = {
            temp_id: props.initialDraft?.temp_id || `draft-media-${Date.now()}`,
            title: mediaTitle.value.trim(),
            type: mediaType.value,
            tracks: tracksConfig.value.map((t) => ({
                draft_file_id: t.draft_file_id,
                type: t.type!,
                purpose: t.purpose,
                quality: t.quality,
                is_default: t.is_default,
                language: isLanguageTrackType(t.type) ? t.language.trim() || null : null,
            })),
            _files: sessionFiles.value.map((f) => ({
                id: f.id,
                name: f.name,
                mime_type: f.mime_type,
                size: f.size,
                url: f.url,
            })),
            preExistingDraftFileIds: Array.from(preExistingDraftIds.value),
        };
        hasCommitted.value = true;
        emit("draft-created", draftGroup);
        resetAndClose();
        return;
    }

    isCommitting.value = true;
    try {
        const result = await importStore.commitMedia(libraryId.value, {
            media_drafts: [
                {
                    title: mediaTitle.value.trim(),
                    type: mediaType.value,
                    tracks: tracksConfig.value.map((t) => ({
                        draft_file_id: t.draft_file_id,
                        type: t.type!,
                        purpose: t.purpose,
                        quality: t.quality,
                        is_default: t.is_default,
                        language: isLanguageTrackType(t.type) ? t.language.trim() || null : null,
                    })),
                },
            ],
        });
        const createdId = result?.media_ids?.[0];
        toast.success(t("media.toast_create_success"), {
            description: t("media.toast_create_success_desc", { name: mediaTitle.value.trim() }),
        });
        queryClient.invalidateQueries({ queryKey: ["media"] });
        hasCommitted.value = true;

        emit("created", {
            id: createdId || "",
            title: mediaTitle.value.trim(),
            type: mediaType.value,
        });
        resetAndClose();
    } catch (e: any) {
        toast.error(t("media.toast_create_failed"), { description: e.message || String(e) });
    } finally {
        isCommitting.value = false;
    }
}

function resetAndClose() {
    // If not committed, physically delete newly uploaded files in this session
    if (!hasCommitted.value && newlyUploadedFileIds.value.length > 0 && libraryId.value) {
        for (const id of newlyUploadedFileIds.value) {
            importStore.deleteDraftFile(libraryId.value, id).catch(() => undefined);
        }
    }
    tracksConfig.value = [];
    mediaTitle.value = "";
    mediaType.value = MediaType.VIDEO;
    sessionFiles.value = [];
    uploadedFileKeys.clear();
    uploadingFileKeys.clear();
    sessionFileKeys.clear();
    newlyUploadedFileIds.value = [];
    pendingDeleteFileIds.value = [];
    preExistingDraftIds.value.clear();
}

function handleCancel() {
    resetAndClose();
    emit("cancel");
}

// Watch initialDraft or load on mount
watch(
    () => props.initialDraft,
    (draft) => {
        if (draft) {
            mediaTitle.value = draft.title;
            mediaType.value = draft.type;
            sessionFiles.value = draft._files.map((f: any) => ({
                id: f.id,
                name: f.name,
                mime_type: f.mime_type,
                size: f.size ?? null,
                url: f.url,
            }));
            preExistingDraftIds.value = new Set(draft.preExistingDraftFileIds || []);
            tracksConfig.value = draft.tracks.map((t: any) => {
                const file = draft._files.find((f: any) => f.id === t.draft_file_id);
                return {
                    draft_file_id: t.draft_file_id,
                    name: file ? file.name : "Unknown File",
                    mime_type: file ? file.mime_type : "application/octet-stream",
                    type: t.type,
                    purpose: t.purpose,
                    quality: t.quality,
                    is_default: t.is_default,
                    language: t.language || "",
                };
            });
            newlyUploadedFileIds.value = [];
            pendingDeleteFileIds.value = [];
        } else {
            resetAndClose();
        }
    },
    { immediate: true },
);

onMounted(() => {
    if (props.initialFiles && props.initialFiles.length > 0) {
        uploadFiles(props.initialFiles);
    }
});

onUnmounted(() => {
    if (!hasCommitted.value && newlyUploadedFileIds.value.length > 0) {
        for (const id of newlyUploadedFileIds.value) {
            if (libraryId.value) {
                importStore.deleteDraftFile(libraryId.value, id).catch(() => undefined);
            }
        }
    }
});
</script>

<template>
    <div ref="containerRef" class="flex flex-col h-full overflow-hidden">
        <!-- Header: Only visible in standalone mode -->
        <div v-if="props.mode === 'standalone'" class="shrink-0 border-b px-4 py-4 text-left sm:px-6 flex items-center gap-3">
            <Button variant="ghost" size="icon" class="w-8 h-8 -ml-1 text-slate-500 hover:text-slate-700" @click="handleCancel">
                <ArrowLeft class="w-4 h-4" />
            </Button>
            <div>
                <h2 class="text-lg font-semibold text-slate-900 dark:text-zinc-50">{{ $t("media.create_title") }}</h2>
                <p class="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                    {{ $t("media.create_desc") }}
                </p>
            </div>
        </div>

        <!-- Body -->
        <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
            <!-- Upload Area -->
            <div
                class="relative rounded-xl border-2 border-dashed transition-colors duration-200"
                :class="[
                    isDragActive
                        ? 'border-primary bg-primary/5'
                        : 'border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700',
                ]"
                @dragenter.stop="handleDragEnter"
                @dragleave.stop="handleDragLeave"
                @dragover.stop="handleDragOver"
                @drop.stop="handleDrop"
            >
                <div
                    v-if="sessionFiles.length === 0 && !isUploading"
                    class="flex flex-col items-center justify-center gap-4 p-10 text-center"
                >
                    <div
                        class="p-3.5 rounded-full bg-slate-50 dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800 shadow-sm shrink-0"
                    >
                        <Upload class="w-8 h-8 text-slate-400 dark:text-zinc-500" />
                    </div>
                    <div class="space-y-1">
                        <h3 class="text-sm font-semibold text-slate-800 dark:text-zinc-100">{{ $t("media.add_tracks_title") }}</h3>
                        <p class="text-xs text-slate-400 dark:text-zinc-400 max-w-sm leading-relaxed">
                            {{ $t("media.add_tracks_desc") }}
                        </p>
                    </div>
                    <div class="flex items-center gap-3 mt-1.5">
                        <Button size="sm" variant="outline" class="gap-1.5" @click="triggerFileSelect">
                            <Plus class="w-3.5 h-3.5" />
                            {{ $t("media.upload_files") }}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            class="gap-1.5 bg-slate-50/50 hover:bg-slate-100 dark:bg-zinc-900/50 dark:hover:bg-zinc-900"
                            @click="openDraftSelection"
                        >
                            <FolderOpen class="w-3.5 h-3.5 text-slate-500" />
                            {{ $t("draft_box.select_btn") }}
                        </Button>
                    </div>
                </div>

                <div v-else class="p-4">
                    <div class="flex items-center justify-between mb-3">
                        <span class="text-xs font-semibold text-gray-500 dark:text-zinc-400">
                            {{ $t("media.uploaded_count", { count: sessionFiles.length }) }}
                        </span>
                        <div class="flex gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                class="h-7 text-xs gap-1"
                                :disabled="isUploading"
                                @click="openDraftSelection"
                            >
                                <FolderOpen class="w-3.5 h-3.5" />
                                {{ $t("draft_box.add_btn") }}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                class="h-7 text-xs gap-1"
                                :disabled="isUploading"
                                @click="triggerFileSelect"
                            >
                                <Plus class="w-3.5 h-3.5" />
                                {{ $t("media.add_files") }}
                            </Button>
                        </div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <div
                            v-for="file in sessionFiles"
                            :key="file.id"
                            class="group relative flex items-center gap-3 rounded-xl border border-slate-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-xs shadow-sm hover:shadow transition-all duration-200"
                        >
                            <img
                                v-if="file.mime_type?.startsWith('image/')"
                                :src="file.url"
                                class="w-9 h-9 rounded-lg object-cover bg-slate-100 dark:bg-zinc-800 border border-slate-100 dark:border-zinc-800 shrink-0"
                            />
                            <div
                                v-else
                                class="w-9 h-9 rounded-lg bg-slate-50 dark:bg-zinc-800/50 flex items-center justify-center border border-slate-100 dark:border-zinc-800/80 shrink-0"
                            >
                                <Video v-if="file.mime_type?.startsWith('video/')" class="w-4.5 h-4.5 text-slate-400 dark:text-zinc-500" />
                                <Music
                                    v-else-if="file.mime_type?.startsWith('audio/')"
                                    class="w-4.5 h-4.5 text-slate-400 dark:text-zinc-500"
                                />
                                <File v-else class="w-4.5 h-4.5 text-slate-400 dark:text-zinc-500" />
                            </div>
                            <div class="min-w-0">
                                <div class="truncate font-semibold max-w-[150px] text-slate-700 dark:text-zinc-200">{{ file.name }}</div>
                                <div class="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">{{ formatBytes(file.size) }}</div>
                            </div>
                            <button
                                class="ml-1 p-0.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                                @click="removeFile(file.id)"
                            >
                                <X class="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Upload progress overlay -->
                <div
                    v-if="isUploading"
                    class="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-zinc-950/80 rounded-xl"
                >
                    <div class="flex items-center gap-2 text-sm text-primary">
                        <Loader2 class="w-4 h-4 animate-spin" />
                        {{ $t("media.uploading") }}
                    </div>
                </div>
            </div>

            <!-- Hidden file input -->
            <input type="file" ref="fileInputRef" multiple class="hidden" @change="handleFileSelect" />

            <!-- Track Configuration (shown when files are uploaded) -->
            <div v-if="tracksConfig.length > 0" class="space-y-4">
                <!-- Title & Media Type -->
                <div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
                    <div class="space-y-1.5">
                        <Label for="create-title">{{ $t("media.title_label") }}</Label>
                        <Input id="create-title" v-model="mediaTitle" :placeholder="$t('media.title_placeholder')" />
                    </div>
                    <div class="space-y-1.5">
                        <Label for="create-type">{{ $t("media.type_label") }}</Label>
                        <Select :model-value="mediaType" @update:model-value="handleMediaTypeChange">
                            <SelectTrigger id="create-type">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem v-for="type in compatibleTypes" :key="type" :value="type">
                                    {{ $t("media.types." + type) }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <!-- Track configuration -->
                <div class="space-y-2">
                    <div class="text-xs font-semibold text-gray-500 dark:text-zinc-400 flex items-center gap-1">
                        <Info class="w-3.5 h-3.5" />
                        {{ $t("media.configure_tracks") }}
                    </div>

                    <!-- Container query responsive table layout (shown when container is wide) -->
                    <div v-if="!isNarrow" class="overflow-x-auto rounded-lg border bg-gray-50/20 dark:bg-zinc-900/30 text-xs">
                        <table class="w-full table-fixed border-collapse text-left" style="min-width: 680px">
                            <thead>
                                <tr
                                    class="bg-slate-50 dark:bg-zinc-900 text-slate-500 dark:text-zinc-400 font-semibold border-b border-slate-100 dark:border-zinc-800 text-[10px] uppercase tracking-wider"
                                >
                                    <th class="w-[180px] p-3">{{ $t("media.headers.file") }}</th>
                                    <th class="w-[110px] p-3">{{ $t("media.headers.track_type") }}</th>
                                    <th class="w-[110px] p-3">{{ $t("media.headers.purpose") }}</th>
                                    <th class="w-[100px] p-3">{{ $t("media.headers.quality") }}</th>
                                    <th class="w-[70px] p-3 text-center">{{ $t("media.headers.default") }}</th>
                                    <th class="w-[110px] p-3">{{ $t("media.headers.language") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="track in tracksConfig"
                                    :key="track.draft_file_id"
                                    class="border-b last:border-0 hover:bg-slate-50/40 dark:hover:bg-zinc-800/20 border-slate-100 dark:border-zinc-800 text-xs"
                                >
                                    <td class="p-3 text-slate-700 dark:text-zinc-300 font-medium" :title="track.name">
                                        <div class="truncate">{{ track.name }}</div>
                                    </td>
                                    <td class="p-1.5">
                                        <Select
                                            :model-value="track.type ?? undefined"
                                            @update:model-value="(v: unknown) => handleTrackTypeChange(track, v)"
                                        >
                                            <SelectTrigger class="h-8 text-xs">
                                                <SelectValue :placeholder="$t('media.unsupported_track')" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem v-for="type in getTrackTypeOptions(track)" :key="type" :value="type">
                                                    {{ $t("media.track_types." + type) }}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </td>
                                    <td class="p-1.5">
                                        <Select
                                            :model-value="track.purpose"
                                            @update:model-value="(v: unknown) => handleTrackPurposeChange(track, v)"
                                        >
                                            <SelectTrigger class="h-8 text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem v-for="purpose in getPurposeOptions(track)" :key="purpose" :value="purpose">
                                                    {{ $t("media.purposes." + purpose) }}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </td>
                                    <td class="p-1.5">
                                        <Select v-model="track.quality">
                                            <SelectTrigger class="h-8 text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="ORIGINAL">{{ $t("media.quality.original") }}</SelectItem>
                                                <SelectItem value="HIGH">{{ $t("media.quality.high") }}</SelectItem>
                                                <SelectItem value="MEDIUM">{{ $t("media.quality.medium") }}</SelectItem>
                                                <SelectItem value="LOW">{{ $t("media.quality.low") }}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </td>
                                    <td class="p-3 text-center">
                                        <Checkbox
                                            :checked="track.is_default"
                                            :disabled="
                                                track.purpose === 'CONTENT' && getRequiredContentTrackTypes(mediaType).includes(track.type!)
                                            "
                                            @update:checked="(v: unknown) => handleDefaultChange(track, v)"
                                        />
                                    </td>
                                    <td class="p-1.5">
                                        <Input
                                            v-if="isLanguageTrackType(track.type)"
                                            v-model="track.language"
                                            placeholder="en"
                                            class="h-8 text-xs"
                                        />
                                        <span v-else class="block px-2 text-gray-400 dark:text-zinc-500">—</span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- Container query responsive card layout (shown when container is narrow) -->
                    <div v-else class="space-y-3">
                        <div
                            v-for="track in tracksConfig"
                            :key="`mobile-${track.draft_file_id}`"
                            class="space-y-4 rounded-lg border dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5"
                        >
                            <div class="min-w-0 border-b dark:border-zinc-800 pb-3">
                                <div class="truncate text-sm font-medium">{{ track.name }}</div>
                                <div class="mt-0.5 truncate text-xs text-gray-500 dark:text-zinc-400">{{ track.mime_type }}</div>
                            </div>
                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div class="space-y-1.5">
                                    <Label class="text-xs text-gray-500 dark:text-zinc-400">{{ $t("media.headers.track_type") }}</Label>
                                    <Select
                                        :model-value="track.type ?? undefined"
                                        @update:model-value="(v: unknown) => handleTrackTypeChange(track, v)"
                                    >
                                        <SelectTrigger class="h-9 w-full text-xs">
                                            <SelectValue :placeholder="$t('media.unsupported_track')" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem v-for="type in getTrackTypeOptions(track)" :key="type" :value="type">
                                                {{ $t("media.track_types." + type) }}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div class="space-y-1.5">
                                    <Label class="text-xs text-gray-500 dark:text-zinc-400">{{ $t("media.headers.purpose") }}</Label>
                                    <Select
                                        :model-value="track.purpose"
                                        @update:model-value="(v: unknown) => handleTrackPurposeChange(track, v)"
                                    >
                                        <SelectTrigger class="h-9 w-full text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem v-for="purpose in getPurposeOptions(track)" :key="purpose" :value="purpose">
                                                {{ $t("media.purposes." + purpose) }}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div class="space-y-1.5">
                                    <Label class="text-xs text-gray-500 dark:text-zinc-400">{{ $t("media.headers.quality") }}</Label>
                                    <Select v-model="track.quality">
                                        <SelectTrigger :aria-label="`Quality for ${track.name}`" class="h-9 w-full text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="ORIGINAL">{{ $t("media.quality.original") }}</SelectItem>
                                            <SelectItem value="HIGH">{{ $t("media.quality.high") }}</SelectItem>
                                            <SelectItem value="MEDIUM">{{ $t("media.quality.medium") }}</SelectItem>
                                            <SelectItem value="LOW">{{ $t("media.quality.low") }}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div v-if="isLanguageTrackType(track.type)" class="space-y-1.5">
                                    <Label class="text-xs text-gray-500 dark:text-zinc-400">{{ $t("media.headers.language") }}</Label>
                                    <Input v-model="track.language" placeholder="en" class="h-9 text-xs" />
                                </div>
                            </div>
                            <div
                                class="flex min-h-9 items-center justify-between gap-3 rounded-md bg-gray-50 dark:bg-zinc-800/50 px-3 py-2 text-sm"
                            >
                                <span class="text-xs text-gray-500 dark:text-zinc-400">{{ $t("media.headers.default") }}</span>
                                <Checkbox
                                    :checked="track.is_default"
                                    :disabled="track.purpose === 'CONTENT' && getRequiredContentTrackTypes(mediaType).includes(track.type!)"
                                    @update:checked="(v: unknown) => handleDefaultChange(track, v)"
                                />
                            </div>
                        </div>
                    </div>

                    <!-- Composition error -->
                    <div
                        v-if="compositionError"
                        class="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 p-3 text-xs text-red-600 dark:text-red-400"
                    >
                        <AlertCircle class="mt-0.5 size-4 shrink-0" />
                        <span>{{ compositionError }}</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <div
            class="shrink-0 border-t border-slate-100 dark:border-zinc-800 px-4 py-4 sm:px-6 flex justify-end gap-2 bg-slate-50/50 dark:bg-zinc-900/10"
        >
            <Button variant="outline" class="w-full sm:w-auto" @click="handleCancel">
                {{ props.mode === "draft" ? $t("media.actions.discard") : $t("media.actions.cancel") }}
            </Button>
            <Button
                class="w-full sm:w-auto gap-1.5"
                :disabled="tracksConfig.length === 0 || !mediaTitle.trim() || !!compositionError || isUploading || isCommitting"
                @click="handleCreate"
            >
                <Loader2 v-if="isCommitting" class="w-3.5 h-3.5 animate-spin" />
                {{ props.mode === "draft" ? $t("media.actions.add") : $t("media.actions.create") }}
            </Button>
        </div>

        <!-- Draft Selection Dialog -->
        <Dialog v-model:open="isDraftSelectOpen">
            <DialogContent class="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
                <DialogHeader class="px-6 pt-6 pb-4 border-b">
                    <DialogTitle>{{ $t("draft_box.dialog_title") }}</DialogTitle>
                    <DialogDescription> {{ $t("draft_box.dialog_description") }} </DialogDescription>
                </DialogHeader>

                <!-- Search and Stats -->
                <div class="px-6 py-3 border-b flex items-center justify-between gap-4 bg-slate-50/50 dark:bg-zinc-900/50">
                    <div class="relative flex-1">
                        <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input v-model="draftSearchQuery" :placeholder="$t('draft_box.search_placeholder')" class="pl-9 h-9 text-xs" />
                    </div>
                    <span class="text-xs text-muted-foreground shrink-0">
                        {{ $t("draft_box.available_count", { count: filteredDraftFiles.length }) }}
                    </span>
                </div>

                <!-- Draft Files List -->
                <div class="flex-1 overflow-y-auto px-6 py-4 space-y-2 min-h-[250px] max-h-[450px]">
                    <div v-if="isLoadingDrafts" class="flex items-center justify-center py-8 text-sm text-slate-500">
                        <Loader2 class="w-5 h-5 animate-spin mr-2" />
                        {{ $t("draft_box.loading") }}
                    </div>
                    <div
                        v-else-if="filteredDraftFiles.length === 0"
                        class="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-zinc-500"
                    >
                        <FolderOpen class="w-10 h-10 mb-2 opacity-50" />
                        <p class="text-xs">{{ $t("draft_box.empty") }}</p>
                    </div>
                    <div v-else class="space-y-2">
                        <div
                            v-for="draft in filteredDraftFiles"
                            :key="draft.id"
                            class="flex items-center justify-between p-3 rounded-lg border dark:border-zinc-800 hover:bg-slate-50/50 dark:hover:bg-zinc-800/10 transition-colors"
                        >
                            <div class="flex items-center gap-3 min-w-0">
                                <Checkbox
                                    :checked="selectedDraftFileIds.includes(draft.id)"
                                    @update:checked="(checked: boolean) => toggleDraftSelection(draft.id, checked)"
                                />
                                <div class="shrink-0">
                                    <img
                                        v-if="draft.mime_type?.startsWith('image/')"
                                        :src="draft.url"
                                        class="w-8 h-8 rounded object-cover border border-slate-100 dark:border-zinc-800"
                                    />
                                    <div
                                        v-else
                                        class="w-8 h-8 rounded bg-slate-100 dark:bg-zinc-800/50 flex items-center justify-center border border-slate-200/50 dark:border-zinc-800/80"
                                    >
                                        <Video
                                            v-if="draft.mime_type?.startsWith('video/')"
                                            class="w-4 h-4 text-slate-400 dark:text-zinc-500"
                                        />
                                        <Music
                                            v-else-if="draft.mime_type?.startsWith('audio/')"
                                            class="w-4 h-4 text-slate-400 dark:text-zinc-500"
                                        />
                                        <File class="w-4 h-4 text-slate-400 dark:text-zinc-500" />
                                    </div>
                                </div>
                                <div class="min-w-0 flex-1">
                                    <div class="truncate text-xs font-semibold text-slate-700 dark:text-zinc-200" :title="draft.name">
                                        {{ draft.name }}
                                    </div>
                                    <div class="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 flex gap-2">
                                        <span>{{ formatBytes(draft.size) }}</span>
                                        <span>•</span>
                                        <span>{{ formatDate(draft.create_time) }}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Footer -->
                <DialogFooter
                    class="px-6 py-4 border-t bg-slate-50/50 dark:bg-zinc-900/50 flex items-center justify-between sm:justify-between"
                >
                    <span class="text-xs text-slate-500">
                        {{ $t("draft_box.selected_count", { count: selectedDraftFileIds.length }) }}
                    </span>
                    <div class="flex gap-2">
                        <Button size="sm" variant="outline" @click="isDraftSelectOpen = false"> {{ $t("draft_box.cancel_btn") }} </Button>
                        <Button size="sm" @click="confirmDraftSelection"> {{ $t("draft_box.confirm_btn") }} </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>
