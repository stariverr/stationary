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
import { toast } from "vue-sonner";
import {
    buildMediaDraft,
    getCompatibleMediaTypes,
    getDraftCompositionError,
    guessMediaType,
    toDraftFileConfig,
    MediaType,
    type DraftFileConfig,
    type StagedMediaDraft,
} from "@/utils/draft-media-rules";
import DraftFilesTable from "@/components/DraftFilesTable.vue";
import { apiErrorMessage } from "@/composables/useApi";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Upload, File, Video, Music, X, Loader2, Plus, AlertCircle, Info, ArrowLeft, Search, FolderOpen } from "@lucide/vue";

const props = withDefaults(
    defineProps<{
        mode?: "standalone" | "draft";
        initialDraft?: StagedMediaDraft | null;
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
    "draft-created": [draft: StagedMediaDraft];
}>();

const importStore = useImportStore();
const libraryStore = useLibraryStore();
const queryClient = useQueryClient();
const libraryId = computed(() => libraryStore.activeLibraryId);
const { t } = useI18n();

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
    rebuildFiles();
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

// The files of the media being created, in the order they were added
const mediaTitle = ref("");
const mediaType = ref<MediaType>(MediaType.VIDEO);
const filesConfig = ref<DraftFileConfig[]>([]);

const compatibleTypes = computed(() => getCompatibleMediaTypes(filesConfig.value));
const compositionError = computed(() => {
    const err = getDraftCompositionError(mediaType.value, filesConfig.value);
    if (!err) return null;
    return err.params ? t(err.key, err.params) : t(err.key);
});

function handleMediaTypeChange(value: unknown) {
    if (typeof value !== "string" || !compatibleTypes.value.includes(value as MediaType)) return;
    mediaType.value = value as MediaType;
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
        rebuildFiles();
    } catch (e: any) {
        toast.error(t("media.toast_upload_failed"), { description: e.message || String(e) });
    } finally {
        for (const file of filesToUpload) uploadingFileKeys.delete(getFileKey(file));
        isUploading.value = false;
        importStore.isTrayOpen = false;
    }
}

function rebuildFiles() {
    const existing = new Map(filesConfig.value.map((file) => [file.draft_file_id, file]));
    filesConfig.value = sessionFiles.value.map((draft) => existing.get(draft.id) ?? toDraftFileConfig(draft));

    // Auto-select media type & title
    if (filesConfig.value.length > 0) {
        if (!compatibleTypes.value.includes(mediaType.value)) {
            mediaType.value = guessMediaType(filesConfig.value) ?? MediaType.IMAGE;
        }
        if (!mediaTitle.value) {
            const first = sessionFiles.value[0]!;
            mediaTitle.value = first.name.substring(0, first.name.lastIndexOf(".")) || first.name;
        }
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
        rebuildFiles();
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
        const draftGroup: StagedMediaDraft = {
            temp_id: props.initialDraft?.temp_id || `draft-media-${Date.now()}`,
            title: mediaTitle.value.trim(),
            type: mediaType.value,
            files: filesConfig.value.map((file) => ({ ...file })),
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
            media_drafts: [buildMediaDraft(mediaTitle.value.trim(), mediaType.value, filesConfig.value)],
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
        toast.error(t("media.toast_create_failed"), { description: apiErrorMessage(e) });
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
    filesConfig.value = [];
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
            sessionFiles.value = draft._files.map((f) => ({
                id: f.id,
                file_id: "",
                name: f.name,
                mime_type: f.mime_type,
                size: f.size ?? 0,
                url: f.url ?? "",
                create_time: "",
            }));
            preExistingDraftIds.value = new Set(draft.preExistingDraftFileIds);
            filesConfig.value = draft.files.map((file) => ({ ...file }));
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
    <div class="flex flex-col h-full overflow-hidden">
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
                        <h3 class="text-sm font-semibold text-slate-800 dark:text-zinc-100">{{ $t("media.add_files_title") }}</h3>
                        <p class="text-xs text-slate-400 dark:text-zinc-400 max-w-sm leading-relaxed">
                            {{ $t("media.add_files_desc") }}
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
                                <div class="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{{ formatBytes(file.size) }}</div>
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

            <!-- File roles (shown when files are uploaded) -->
            <div v-if="filesConfig.length > 0" class="space-y-4">
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

                <!-- What each file becomes -->
                <div class="space-y-2">
                    <div class="text-xs font-semibold text-gray-500 dark:text-zinc-400 flex items-center gap-1">
                        <Info class="w-3.5 h-3.5" />
                        {{ $t("media.configure_files") }}
                    </div>

                    <DraftFilesTable :media-type="mediaType" :files="filesConfig" />

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
                :disabled="filesConfig.length === 0 || !mediaTitle.trim() || !!compositionError || isUploading || isCommitting"
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
                                    <div class="text-xs text-slate-400 dark:text-zinc-500 mt-0.5 flex gap-2">
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
