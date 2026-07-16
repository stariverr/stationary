<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useImportStore, type DraftFileItem } from "@/stores/import";
import { useLibraryStore } from "@/stores/library";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "vue-sonner";
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
import {
    Upload,
    File,
    Video,
    Image as ImageIcon,
    Music,
    Trash2,
    X,
    ChevronUp,
    ChevronDown,
    Check,
    Loader2,
    Info,
    FolderPlus,
    FileDown,
    Layers,
    AlertCircle,
} from "@lucide/vue";

const importStore = useImportStore();
const libraryStore = useLibraryStore();
const queryClient = useQueryClient();

const isMinimized = computed({
    get: () => importStore.isMinimized,
    set: (val) => {
        importStore.isMinimized = val;
    },
});
const isDragActive = ref(false);
const selectedFileIds = ref<string[]>([]);

// Staging dialog state
const isMergeDialogOpen = ref(false);
const mergeTitle = ref("");
const mergeType = ref<MediaType>(MediaType.IMAGE);
type MergeTrackConfig = {
    draft_file_id: string;
    name: string;
    mime_type: string;
    type: TrackType | null;
    purpose: TrackPurpose;
    quality: "ORIGINAL" | "HIGH" | "MEDIUM" | "LOW";
    is_default: boolean;
    language: string;
};
const mergeTracksConfig = ref<MergeTrackConfig[]>([]);

const libraryId = computed(() => libraryStore.activeLibraryId);
const { t } = useI18n();

const compatibleMergeTypes = computed(() => getCompatibleMediaTypes(mergeTracksConfig.value));
const mergeCompositionError = computed(() => {
    const err = getDraftCompositionError(mergeType.value, mergeTracksConfig.value);
    if (!err) return null;
    return err.params ? t(err.key, err.params) : t(err.key);
});

function getTrackTypeOptions(track: MergeTrackConfig): TrackType[] {
    return getAllowedFileTrackTypes(track.name, track.mime_type).filter(
        (trackType) => getAllowedTrackPurposes(mergeType.value, trackType).length > 0,
    );
}

function getPurposeOptions(track: MergeTrackConfig): TrackPurpose[] {
    return getAllowedTrackPurposes(mergeType.value, track.type);
}

function reconcileDefaultTracks() {
    const defaultGroups = new Set<string>();
    for (const track of mergeTracksConfig.value) {
        if (!track.is_default || !track.type) continue;
        const key = `${track.type}:${track.purpose}`;
        if (defaultGroups.has(key)) track.is_default = false;
        else defaultGroups.add(key);
    }

    for (const requiredType of getRequiredContentTrackTypes(mergeType.value)) {
        const contentTracks = mergeTracksConfig.value.filter((track) => track.type === requiredType && track.purpose === "CONTENT");
        if (contentTracks.length > 0 && !contentTracks.some((track) => track.is_default)) {
            const firstTrack = contentTracks[0];
            if (firstTrack) {
                firstTrack.is_default = true;
            }
        }
    }
}

function normalizeMergeTracks(type: MediaType) {
    mergeTracksConfig.value = normalizeDraftTracksForMedia(type, mergeTracksConfig.value).map((track) => ({
        ...track,
        language: isLanguageTrackType(track.type) ? track.language : "",
    }));
}

function handleMergeTypeChange(value: unknown) {
    if (typeof value !== "string" || !compatibleMergeTypes.value.includes(value as MediaType)) return;
    mergeType.value = value as MediaType;
    normalizeMergeTracks(mergeType.value);
}

function handleTrackTypeChange(track: MergeTrackConfig, value: unknown) {
    if (typeof value !== "string" || !getTrackTypeOptions(track).includes(value as TrackType)) return;
    track.type = value as TrackType;
    const purposes = getPurposeOptions(track);
    if (!purposes.includes(track.purpose)) {
        track.purpose = purposes.includes(TrackPurpose.CONTENT) ? TrackPurpose.CONTENT : (purposes[0] ?? TrackPurpose.CONTENT);
    }
    if (!isLanguageTrackType(track.type)) track.language = "";
    reconcileDefaultTracks();
}

function handleTrackPurposeChange(track: MergeTrackConfig, value: unknown) {
    if (typeof value !== "string" || !getPurposeOptions(track).includes(value as TrackPurpose)) return;
    track.purpose = value as TrackPurpose;
    reconcileDefaultTracks();
}

function handleDefaultChange(track: MergeTrackConfig, checked: unknown) {
    if (!track.type) return;
    const shouldCheck = checked === true;
    const isRequiredGroup = track.purpose === "CONTENT" && getRequiredContentTrackTypes(mergeType.value).includes(track.type);
    if (!shouldCheck && isRequiredGroup && track.is_default) return;

    if (shouldCheck) {
        for (const candidate of mergeTracksConfig.value) {
            if (candidate !== track && candidate.type === track.type && candidate.purpose === track.purpose) {
                candidate.is_default = false;
            }
        }
    }
    track.is_default = shouldCheck;
}

// Fetch drafts when active library changes
watch(
    libraryId,
    async (newId) => {
        if (newId) {
            await importStore.fetchDraftFiles(newId);
            if (importStore.draftFiles.length > 0) {
                importStore.isTrayOpen = true;
                isMinimized.value = true;
            }
        }
    },
    { immediate: true },
);

// Drag & Drop handlers
let dragCounter = 0;

function isCreateMediaDialogOpen(): boolean {
    return document.querySelector("[data-create-media-dialog]") !== null;
}

function ignoreCreateMediaDrag(e: DragEvent): boolean {
    if (!isCreateMediaDialogOpen()) return false;
    e.preventDefault();
    dragCounter = 0;
    isDragActive.value = false;
    return true;
}

function handleDragEnter(e: DragEvent) {
    if (ignoreCreateMediaDrag(e)) return;
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
        isDragActive.value = true;
    }
}

function handleDragLeave(e: DragEvent) {
    if (ignoreCreateMediaDrag(e)) return;
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        isDragActive.value = false;
    }
}

function handleDragOver(e: DragEvent) {
    if (ignoreCreateMediaDrag(e)) return;
    e.preventDefault();
}

const MAX_CONCURRENT_UPLOADS = 3;

async function uploadFilesWithLimit(files: FileList) {
    const libId = libraryId.value;
    if (!libId) return;

    const fileArray = Array.from(files);
    const iterator = fileArray.values();

    const worker = async () => {
        for (const file of iterator) {
            try {
                await importStore.uploadFile(libId, file);
            } catch (err) {
                console.error(`Failed to upload ${file.name}:`, err);
            }
        }
    };

    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, fileArray.length) }, worker);
    await Promise.all(workers);
}

async function handleDrop(e: DragEvent) {
    if (ignoreCreateMediaDrag(e)) return;
    e.preventDefault();
    dragCounter = 0;
    isDragActive.value = false;

    const files = e.dataTransfer?.files;
    if (files && files.length > 0 && libraryId.value) {
        importStore.isTrayOpen = true;
        isMinimized.value = false;
        await uploadFilesWithLimit(files);
    }
}

// File Dialog trigger
const fileInputRef = ref<HTMLInputElement | null>(null);

function triggerFileSelect() {
    fileInputRef.value?.click();
}

async function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    const files = target.files;
    if (files && files.length > 0 && libraryId.value) {
        importStore.isTrayOpen = true;
        isMinimized.value = false;
        await uploadFilesWithLimit(files);
        target.value = ""; // reset
    }
}

// Draggable positions and state
// ballPosition records the resting position of the floating ball
const ballPosition = ref<{ x: number; y: number }>({ x: 0, y: 0 });
const position = ref<{ x: number; y: number } | null>(null);
const isDragging = ref(false);

let startX = 0;
let startY = 0;
let startLeft = 0;
let startTop = 0;
let hasMoved = false;

// Initialize ball position to bottom right corner
function initBallPosition() {
    ballPosition.value = {
        x: window.innerWidth - 56 - 16,
        y: window.innerHeight - 56 - 16,
    };
    if (isMinimized.value) {
        position.value = { ...ballPosition.value };
    }
}

function handleDragStart(e: PointerEvent) {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input") || target.closest("select")) return;

    hasMoved = false;
    isDragging.value = true;

    startX = e.clientX;
    startY = e.clientY;

    const trayId = isMinimized.value ? "global-draft-tray-ball" : "global-draft-tray-panel";
    const trayEl = document.getElementById(trayId);
    if (trayEl) {
        const rect = trayEl.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
    }

    window.addEventListener("pointermove", handleDragMove);
    window.addEventListener("pointerup", handleDragEnd);
}

function handleDragMove(e: PointerEvent) {
    if (!isDragging.value) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        hasMoved = true;
    }

    let newLeft = startLeft + deltaX;
    let newTop = startTop + deltaY;

    const trayId = isMinimized.value ? "global-draft-tray-ball" : "global-draft-tray-panel";
    const trayEl = document.getElementById(trayId);
    if (trayEl) {
        const width = trayEl.offsetWidth;
        const height = trayEl.offsetHeight;

        // Constrain within screen margins
        newLeft = Math.max(16, Math.min(newLeft, window.innerWidth - width - 16));
        newTop = Math.max(16, Math.min(newTop, window.innerHeight - height - 16));
    }

    position.value = { x: newLeft, y: newTop };
}

function handleDragEnd() {
    isDragging.value = false;
    window.removeEventListener("pointermove", handleDragMove);
    window.removeEventListener("pointerup", handleDragEnd);

    if (!position.value) return;

    const isMobile = window.innerWidth < 768;
    const panelWidth = Math.min(window.innerWidth - 32, isMobile ? 480 : 600);
    const panelHeight = 420;

    if (isMinimized.value) {
        // Magnetic snap to left or right screen edges for the ball
        const midPoint = window.innerWidth / 2;
        const targetX = position.value.x < midPoint ? 16 : window.innerWidth - 56 - 16;
        const targetY = Math.max(16, Math.min(position.value.y, window.innerHeight - 56 - 16));

        ballPosition.value = { x: targetX, y: targetY };
        position.value = { ...ballPosition.value };
    } else {
        // Map the drag coordinate of the panel back to snap coordinates for the ball when it minimizes later
        const panelMidX = position.value.x + panelWidth / 2;
        const isLeft = panelMidX < window.innerWidth / 2;
        const targetBallX = isLeft ? 16 : window.innerWidth - 56 - 16;

        const panelMidY = position.value.y + panelHeight / 2;
        const targetBallY = Math.max(16, Math.min(panelMidY - 28, window.innerHeight - 56 - 16));

        ballPosition.value = { x: targetBallX, y: targetBallY };
    }
}

function handleBallClick() {
    if (isMinimized.value && !hasMoved) {
        isMinimized.value = false;
    }
}

function handleHeaderClick() {
    if (!hasMoved && selectedFileIds.value.length === 0) {
        isMinimized.value = true;
    }
}

// Relocate panel position based on ball position when toggled
watch(isMinimized, (minimized) => {
    nextTick(() => {
        const trayEl = document.getElementById("global-draft-tray-panel");
        if (!trayEl) return;

        const isMobile = window.innerWidth < 768;
        const panelWidth = Math.min(window.innerWidth - 32, isMobile ? 480 : 600);
        const panelHeight = 420;

        if (minimized) {
            position.value = { ...ballPosition.value };
        } else {
            // Determine side: Left or Right
            const isLeft = ballPosition.value.x < window.innerWidth / 2;
            const panelX = isLeft ? 16 : window.innerWidth - panelWidth - 16;

            // Center vertical line to the ball's center
            let panelY = ballPosition.value.y + 28 - panelHeight / 2; // 56 / 2 = 28
            panelY = Math.max(16, Math.min(panelY, window.innerHeight - panelHeight - 16));

            position.value = { x: panelX, y: panelY };
        }
    });
});

// Watch for window resize to recalibrate ball position if needed
function handleResize() {
    if (isMinimized.value) {
        // Adjust ball x coordinate if it was snapped to right side
        const wasOnRight = ballPosition.value.x > window.innerWidth / 2 - 28;
        const targetX = wasOnRight ? window.innerWidth - 56 - 16 : 16;
        const targetY = Math.max(16, Math.min(ballPosition.value.y, window.innerHeight - 56 - 16));
        ballPosition.value = { x: targetX, y: targetY };
        position.value = { ...ballPosition.value };
    }
}

onMounted(async () => {
    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("resize", handleResize);

    initBallPosition();

    if (libraryId.value) {
        await importStore.fetchDraftFiles(libraryId.value);
        if (importStore.draftFiles.length > 0) {
            importStore.isTrayOpen = true;
            isMinimized.value = true;
        }
    }
});

onUnmounted(() => {
    window.removeEventListener("dragenter", handleDragEnter);
    window.removeEventListener("dragleave", handleDragLeave);
    window.removeEventListener("dragover", handleDragOver);
    window.removeEventListener("drop", handleDrop);
    window.removeEventListener("resize", handleResize);
    handleDragEnd();
});

// Single focus and Selection helpers
const activeFileId = ref<string | null>(null);

function handleCardClick(id: string) {
    activeFileId.value = activeFileId.value === id ? null : id;
}

watch(
    () => importStore.draftFiles,
    (newFiles) => {
        if (activeFileId.value && !newFiles.some((f) => f.id === activeFileId.value)) {
            activeFileId.value = null;
        }
        selectedFileIds.value = selectedFileIds.value.filter((id) => newFiles.some((f) => f.id === id));
    },
    { deep: true },
);

const isAllSelected = computed(() => {
    return importStore.draftFiles.length > 0 && selectedFileIds.value.length === importStore.draftFiles.length;
});

function toggleSelectAll() {
    if (isAllSelected.value) {
        selectedFileIds.value = [];
    } else {
        selectedFileIds.value = importStore.draftFiles.map((d) => d.id);
    }
}

function toggleSelectFile(id: string) {
    const idx = selectedFileIds.value.indexOf(id);
    if (idx === -1) {
        selectedFileIds.value.push(id);
    } else {
        selectedFileIds.value.splice(idx, 1);
    }
}

// Actions
async function handleDeleteSingle(id: string) {
    try {
        await importStore.deleteDraftFile(libraryId.value!, id);
        const idx = selectedFileIds.value.indexOf(id);
        if (idx !== -1) {
            selectedFileIds.value.splice(idx, 1);
        }
        if (activeFileId.value === id) {
            activeFileId.value = null;
        }
    } catch (e: any) {
        toast.error(t("draft_box.toasts.delete_file_failed"), {
            description: e.message || String(e),
        });
    }
}

async function handleDeleteSelected() {
    if (selectedFileIds.value.length === 0 || !libraryId.value) return;
    const idsToDelete = [...selectedFileIds.value];
    const deletePromise = Promise.all(idsToDelete.map((id) => importStore.deleteDraftFile(libraryId.value!, id)));
    toast.promise(deletePromise, {
        loading: t("draft_box.toasts.deleting_files", { count: idsToDelete.length }),
        success: t("draft_box.toasts.delete_files_success"),
        error: t("draft_box.toasts.delete_files_failed"),
    });

    try {
        await deletePromise;
        selectedFileIds.value = [];
        if (activeFileId.value && idsToDelete.includes(activeFileId.value)) {
            activeFileId.value = null;
        }
    } catch {
        // toast.promise reports the failure while the remaining selection stays available for retry.
    }
}

// Commit as Separate Orphans
async function handleCommitSeparate() {
    if (selectedFileIds.value.length === 0 || !libraryId.value) return;
    const idsToCommit = [...selectedFileIds.value];
    const drafts = idsToCommit.map((id) => importStore.draftFiles.find((draft) => draft.id === id)!);
    const unsupportedDraft = drafts.find((draft) => getAllowedFileTrackTypes(draft.name, draft.mime_type).length === 0);
    if (unsupportedDraft) {
        toast.warning(t("draft_box.toasts.unsupported_file"), {
            description: t("draft_box.toasts.unsupported_file_desc", { name: unsupportedDraft.name }),
        });
        return;
    }

    const ambiguousDraft = drafts.find((draft) => getAllowedFileTrackTypes(draft.name, draft.mime_type).length > 1);
    if (ambiguousDraft) {
        toast.warning(t("draft_box.toasts.choose_media_type"), {
            description: t("draft_box.toasts.choose_media_type_desc", { name: ambiguousDraft.name }),
        });
        return;
    }

    const standaloneSubtitles = drafts.filter((draft) => getAllowedFileTrackTypes(draft.name, draft.mime_type)[0] === TrackType.SUBTITLE);
    if (standaloneSubtitles.length > 0) {
        toast.warning(t("draft_box.toasts.subtitle_cannot_standalone"), {
            description: t("draft_box.toasts.subtitle_cannot_standalone_desc"),
        });
        return;
    }

    const payload = {
        media_drafts: drafts.map((draft) => {
            const guessedType = getAllowedFileTrackTypes(draft.name, draft.mime_type)[0]!;
            return {
                temp_id: draft.id,
                title: draft.name.substring(0, draft.name.lastIndexOf(".")) || draft.name,
                type: guessedType,
                tracks: [
                    {
                        draft_file_id: draft.id,
                        type: guessedType,
                        purpose: "CONTENT",
                        quality: "ORIGINAL",
                        is_default: true,
                        language: null,
                    },
                ],
            };
        }),
    };

    try {
        await importStore.commitMedia(libraryId.value, payload);
        selectedFileIds.value = [];
        if (activeFileId.value && idsToCommit.includes(activeFileId.value)) {
            activeFileId.value = null;
        }
        toast.success(t("draft_box.toasts.import_success", { count: idsToCommit.length }), {
            description: t("draft_box.toasts.import_success_desc"),
        });
        // Emit refresh event for media grids if any
        queryClient.invalidateQueries({ queryKey: ["media"] });
    } catch (e: any) {
        toast.error(t("draft_box.toasts.commit_failed"), {
            description: e.message || String(e),
        });
    }
}

// Open merge setup
function openMergeSetup() {
    if (selectedFileIds.value.length === 0) return;
    const drafts = selectedFileIds.value.map((id) => importStore.draftFiles.find((d) => d.id === id)!);

    // Default Media Title is first file name
    const firstFile = drafts[0];
    if (!firstFile) return;
    mergeTitle.value = firstFile.name.substring(0, firstFile.name.lastIndexOf(".")) || firstFile.name;

    mergeTracksConfig.value = drafts.map((draft) => {
        const type = getAllowedFileTrackTypes(draft.name, draft.mime_type)[0] ?? null;
        return {
            draft_file_id: draft.id,
            name: draft.name,
            mime_type: draft.mime_type,
            type,
            purpose: TrackPurpose.CONTENT,
            quality: "ORIGINAL",
            is_default: false,
            language: "",
        };
    });

    const compatibleTypes = getCompatibleMediaTypes(mergeTracksConfig.value);
    mergeType.value = compatibleTypes.includes(MediaType.VIDEO)
        ? MediaType.VIDEO
        : compatibleTypes.includes(MediaType.AUDIO)
          ? MediaType.AUDIO
          : (compatibleTypes[0] ?? MediaType.IMAGE);
    normalizeMergeTracks(mergeType.value);

    isMergeDialogOpen.value = true;
}

// Commit Merged Media
async function handleCommitMerge() {
    if (!mergeTitle.value.trim() || !libraryId.value) return;

    const compositionError = mergeCompositionError.value;
    if (compositionError) {
        toast.warning(t("media.toast_invalid_composition"), {
            description: compositionError,
        });
        return;
    }

    const payload = {
        media_drafts: [
            {
                temp_id: "merged_media",
                title: mergeTitle.value.trim(),
                type: mergeType.value,
                tracks: mergeTracksConfig.value.map((t) => ({
                    draft_file_id: t.draft_file_id,
                    type: t.type!,
                    purpose: t.purpose,
                    quality: t.quality,
                    is_default: t.is_default,
                    language: isLanguageTrackType(t.type) ? t.language.trim() || null : null,
                })),
            },
        ],
    };

    const idsMerged = mergeTracksConfig.value.map((t) => t.draft_file_id);

    try {
        await importStore.commitMedia(libraryId.value, payload);
        isMergeDialogOpen.value = false;
        selectedFileIds.value = [];
        if (activeFileId.value && idsMerged.includes(activeFileId.value)) {
            activeFileId.value = null;
        }
        toast.success(t("draft_box.toasts.merge_success"), {
            description: t("draft_box.toasts.merge_success_desc", { title: mergeTitle.value.trim() }),
        });
        queryClient.invalidateQueries({ queryKey: ["media"] });
    } catch (e: any) {
        toast.error(t("draft_box.toasts.merge_failed"), {
            description: e.message || String(e),
        });
    }
}

// Prettify size
function formatBytes(bytes: number, decimals = 2) {
    if (bytes === 0) return t("common.zero_bytes", "0 Bytes");
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}
</script>

<template>
    <!-- Screen-wide Drag & Drop Overlay -->
    <div
        v-if="isDragActive"
        class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60 backdrop-blur-md pointer-events-none transition-all duration-300 ease-in-out"
    >
        <div
            class="m-8 p-12 border-2 border-dashed border-white/50 rounded-2xl flex flex-col items-center gap-4 max-w-lg text-center bg-white/5 backdrop-blur-lg"
        >
            <Upload class="w-16 h-16 text-white animate-bounce" />
            <h2 class="text-2xl font-semibold text-white">{{ $t("draft_box.drop_title") }}</h2>
            <p class="text-white/70 text-sm">
                {{ $t("draft_box.drop_desc") }}
            </p>
        </div>
    </div>

    <!-- Hidden native file input -->
    <input type="file" ref="fileInputRef" multiple class="hidden" @change="handleFileSelect" />

    <!-- 1. Minimized State: Floating Snapping Ball -->
    <Transition name="ball-fade">
        <div
            v-if="importStore.isTrayOpen && isMinimized"
            id="global-draft-tray-ball"
            class="fixed z-40 w-14 h-14 rounded-full bg-white/90 dark:bg-zinc-950/90 backdrop-blur border border-zinc-200/80 dark:border-zinc-800/80 shadow-2xl flex items-center justify-center select-none cursor-grab active:cursor-grabbing text-primary touch-none"
            :style="
                position
                    ? {
                          left: `${position.x}px`,
                          top: `${position.y}px`,
                          transition: isDragging ? 'none' : 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                      }
                    : {}
            "
            @pointerdown="handleDragStart"
            @click="handleBallClick"
        >
            <Loader2
                v-if="importStore.uploadQueue.some((q) => q.status === 'uploading' || q.status === 'pending')"
                class="w-5 h-5 animate-spin text-indigo-600 dark:text-indigo-400"
            />
            <FolderPlus v-else class="w-5 h-5 text-indigo-600 dark:text-indigo-400" />

            <span
                v-if="importStore.draftFiles.length > 0"
                class="absolute -top-1 -right-1 bg-indigo-600 text-white rounded-full text-[10px] w-5 h-5 flex items-center justify-center font-bold border border-white dark:border-zinc-950 scale-75 animate-in zoom-in-50 duration-200"
            >
                {{ importStore.draftFiles.length }}
            </span>
        </div>
    </Transition>

    <!-- 2. Maximized State: Card Manager Panel -->
    <Transition name="panel-fade">
        <div
            v-if="importStore.isTrayOpen && !isMinimized"
            id="global-draft-tray-panel"
            class="fixed z-40 bg-white/90 dark:bg-zinc-950/90 backdrop-blur border border-zinc-200/80 dark:border-zinc-800/80 shadow-2xl flex flex-col select-none overflow-hidden w-[calc(100vw-32px)] sm:w-[480px] md:w-[600px] h-[420px] rounded-2xl"
            :style="
                position
                    ? {
                          left: `${position.x}px`,
                          top: `${position.y}px`,
                          bottom: 'auto',
                          right: 'auto',
                          transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                      }
                    : {
                          bottom: '16px',
                          right: '16px',
                      }
            "
        >
            <!-- Header (Click to minimize, unless multi-selecting) -->
            <div
                class="h-12 px-4 flex items-center justify-between border-b border-gray-200/50 dark:border-gray-800/50 shrink-0 select-none cursor-grab active:cursor-grabbing touch-none"
                :class="selectedFileIds.length > 0 ? 'bg-primary/5 dark:bg-primary/10' : 'bg-gray-50/50 dark:bg-gray-900/50'"
                @pointerdown="handleDragStart"
                @click="handleHeaderClick"
            >
                <!-- Context A: Normal Header -->
                <div
                    v-if="selectedFileIds.length === 0"
                    class="flex items-center gap-2 font-medium text-sm text-gray-700 dark:text-gray-300"
                >
                    <FolderPlus class="w-4 h-4 text-primary" />
                    <span>{{ $t("draft_box.title") }}</span>
                    <span class="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-semibold">
                        {{ importStore.draftFiles.length }}
                    </span>
                </div>

                <!-- Context B: Batch Actions Header -->
                <div v-else class="flex items-center gap-4 flex-1 mr-4">
                    <span class="text-xs font-semibold text-primary shrink-0">{{
                        $t("draft_box.selected_items_count", { count: selectedFileIds.length })
                    }}</span>
                    <div class="flex items-center gap-1.5 ml-auto">
                        <Button
                            size="sm"
                            variant="secondary"
                            class="h-8 px-2.5 text-xs font-semibold border border-zinc-200/60 dark:border-zinc-800/60 shadow-sm gap-1.5 text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 animate-in fade-in duration-200"
                            :title="$t('draft_box.import_separately_tooltip')"
                            @click.stop="handleCommitSeparate"
                        >
                            <FileDown class="w-3.5 h-3.5" />
                            <span class="hidden sm:inline">{{ $t("draft_box.import_separately_btn") }}</span>
                            <span class="inline sm:hidden">{{ $t("draft_box.confirm_btn") }}</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            class="h-8 px-2.5 text-xs font-semibold border border-zinc-200/60 dark:border-zinc-800/60 shadow-sm gap-1.5 text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 animate-in fade-in duration-200"
                            :title="$t('draft_box.merge_tracks_tooltip')"
                            @click.stop="openMergeSetup"
                        >
                            <Layers class="w-3.5 h-3.5" />
                            <span class="hidden sm:inline">{{ $t("draft_box.merge_tracks_btn") }}</span>
                            <span class="inline sm:hidden">{{ $t("draft_box.merge_dialog_title") }}</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            class="h-8 px-2.5 text-xs font-semibold border border-zinc-200/60 dark:border-zinc-800/60 shadow-sm gap-1.5 text-red-600 dark:text-red-400 bg-white dark:bg-zinc-900 hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-700 hover:border-red-200 dark:hover:border-red-900 animate-in fade-in duration-200"
                            :title="$t('draft_box.delete_tooltip')"
                            @click.stop="handleDeleteSelected"
                        >
                            <Trash2 class="w-3.5 h-3.5" />
                            <span>{{ $t("draft_box.delete_btn") }}</span>
                        </Button>
                    </div>
                </div>

                <div class="flex items-center gap-1 shrink-0" @click.stop>
                    <Button variant="ghost" size="icon" class="w-7 h-7" @click="isMinimized = true">
                        <ChevronDown class="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" class="w-7 h-7 hover:text-red-500" @click="importStore.isTrayOpen = false">
                        <X class="w-4 h-4" />
                    </Button>
                </div>
            </div>

            <!-- Panel Contents -->
            <div class="flex-1 flex flex-col min-h-0 bg-white dark:bg-black">
                <!-- Upload Queue Area (Only shows if there are uploading tasks) -->
                <div
                    v-if="importStore.uploadQueue.some((q) => q.status === 'uploading' || q.status === 'pending')"
                    class="bg-blue-50/30 border-b border-blue-100 p-3 max-h-28 overflow-y-auto shrink-0 flex flex-col gap-2"
                >
                    <div class="text-xs font-semibold text-blue-600 flex items-center gap-1.5">
                        <Loader2 class="w-3.5 h-3.5 animate-spin" />
                        <span>{{ $t("draft_box.uploading_background_tasks") }}</span>
                    </div>
                    <div
                        v-for="task in importStore.uploadQueue.filter((q) => q.status === 'uploading' || q.status === 'pending')"
                        :key="task.id"
                        class="flex items-center justify-between text-xs gap-3"
                    >
                        <span class="truncate font-medium flex-1 text-gray-600">{{ task.name }}</span>
                        <div class="w-24 bg-gray-200 rounded-full h-1.5 overflow-hidden">
                            <div class="bg-primary h-full transition-all duration-300" :style="{ width: `${task.progress}%` }"></div>
                        </div>
                        <span class="text-gray-400 shrink-0 w-8 text-right">{{ task.progress }}%</span>
                    </div>
                </div>

                <!-- Draft Files Grid List -->
                <div class="flex-1 overflow-y-auto p-4 min-h-0">
                    <!-- Empty state -->
                    <div
                        v-if="importStore.draftFiles.length === 0"
                        class="h-full flex flex-col items-center justify-center text-center gap-3 p-6 text-gray-400"
                    >
                        <Upload class="w-12 h-12 opacity-30 animate-pulse" />
                        <div class="text-sm font-medium">{{ $t("draft_box.empty") }}</div>
                        <p class="text-xs max-w-xs text-gray-500">
                            {{ $t("draft_box.empty_desc") }}
                        </p>
                        <Button size="sm" variant="outline" class="mt-2" @click="triggerFileSelect">
                            {{ $t("draft_box.choose_files_btn") }}
                        </Button>
                    </div>

                    <!-- Draft Box Grid -->
                    <div v-else class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <div
                            v-for="file in importStore.draftFiles"
                            :key="file.id"
                            class="group relative border rounded-xl overflow-hidden cursor-pointer flex flex-col aspect-square select-none transition-all duration-200 hover:shadow-md"
                            :class="[
                                activeFileId === file.id
                                    ? 'ring-2 ring-zinc-950 dark:ring-zinc-100 border-transparent bg-zinc-50/50'
                                    : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50/20 hover:border-zinc-300 dark:hover:border-zinc-700',
                                selectedFileIds.includes(file.id)
                                    ? 'bg-indigo-500/5 border-indigo-200/60 dark:bg-indigo-500/10 dark:border-indigo-800/40'
                                    : '',
                            ]"
                            @click="handleCardClick(file.id)"
                        >
                            <!-- Selector checkmark -->
                            <div class="absolute top-2 left-2 z-10">
                                <Checkbox :checked="selectedFileIds.includes(file.id)" @click.stop="toggleSelectFile(file.id)" />
                            </div>

                            <!-- Trash Icon on Hover -->
                            <button
                                class="absolute top-1 right-1 z-10 w-6 h-6 rounded-full bg-white/80 border border-gray-200 shadow-sm flex items-center justify-center text-gray-500 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                                @click.stop="handleDeleteSingle(file.id)"
                            >
                                <Trash2 class="w-3.5 h-3.5" />
                            </button>

                            <!-- File Type Thumbnail -->
                            <div class="flex-1 flex items-center justify-center p-3 relative bg-gray-100/50 overflow-hidden">
                                <img
                                    v-if="file.mime_type.startsWith('image/')"
                                    :src="file.url"
                                    class="w-full h-full object-contain"
                                    loading="lazy"
                                />
                                <Video v-else-if="file.mime_type.startsWith('video/')" class="w-10 h-10 text-gray-400" />
                                <Music v-else-if="file.mime_type.startsWith('audio/')" class="w-10 h-10 text-gray-400" />
                                <File class="w-10 h-10 text-gray-400" />
                            </div>

                            <!-- Name and Size Footer -->
                            <div class="p-2 border-t border-gray-100 shrink-0 bg-white">
                                <div class="text-[11px] font-medium truncate text-gray-700">{{ file.name }}</div>
                                <div class="text-[10px] text-gray-400 mt-0.5">{{ formatBytes(file.size) }}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Footer Toolbar (Always visible when expanded and list has items) -->
                <div
                    v-if="importStore.draftFiles.length > 0"
                    class="h-12 border-t border-gray-100 px-4 flex items-center justify-between shrink-0 bg-gray-50/50"
                >
                    <div class="flex items-center gap-2">
                        <Button variant="outline" size="sm" class="h-8 text-xs font-normal" @click="toggleSelectAll">
                            {{ isAllSelected ? $t("draft_box.unselect_all_btn") : $t("draft_box.select_all_btn") }}
                        </Button>
                    </div>
                    <Button size="sm" class="h-8 text-xs gap-1.5" @click="triggerFileSelect">
                        <Upload class="w-3.5 h-3.5" /> {{ $t("draft_box.add_files_btn") }}
                    </Button>
                </div>
            </div>
        </div>
    </Transition>

    <!-- Merge Drafts configuration Dialog -->
    <Dialog v-model:open="isMergeDialogOpen">
        <DialogContent
            class="flex w-[calc(100%-1rem)] max-w-none max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:max-h-[88dvh]"
        >
            <DialogHeader class="shrink-0 border-b px-4 pt-5 pr-12 pb-4 text-left sm:px-6 sm:pt-6 sm:pr-12">
                <DialogTitle>{{ $t("draft_box.merge_dialog_title") }}</DialogTitle>
                <DialogDescription>
                    {{ $t("draft_box.merge_dialog_desc") }}
                </DialogDescription>
            </DialogHeader>

            <!-- Form Content -->
            <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
                <div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
                    <div class="space-y-1.5">
                        <Label for="merge-title">{{ $t("draft_box.merge_dialog.title_label") }}</Label>
                        <Input id="merge-title" v-model="mergeTitle" :placeholder="$t('draft_box.merge_dialog.title_placeholder')" />
                    </div>
                    <div class="space-y-1.5">
                        <Label for="merge-type">{{ $t("draft_box.merge_dialog.type_label") }}</Label>
                        <Select
                            :model-value="mergeType"
                            :disabled="compatibleMergeTypes.length <= 1"
                            @update:model-value="handleMergeTypeChange"
                        >
                            <SelectTrigger id="merge-type">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem v-for="type in compatibleMergeTypes" :key="type" :value="type">
                                    {{ $t("media.types." + type) }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <!-- Tracks Table -->
                <div class="space-y-2">
                    <div class="text-xs font-semibold text-gray-500 flex items-center gap-1">
                        <Info class="w-3.5 h-3.5" /> {{ $t("draft_box.merge_dialog.configure_tracks") }}
                    </div>

                    <!-- Desktop and tablet track table -->
                    <div class="hidden overflow-x-auto rounded-lg border bg-gray-50/20 text-xs lg:block">
                        <table class="w-full min-w-[900px] table-fixed border-collapse text-left">
                            <thead>
                                <tr class="bg-gray-50 text-gray-500 font-medium border-b">
                                    <th class="w-[230px] p-3">{{ $t("media.headers.file") }}</th>
                                    <th class="w-[135px] p-3">{{ $t("media.headers.track_type") }}</th>
                                    <th class="w-[145px] p-3">{{ $t("media.headers.purpose") }}</th>
                                    <th class="w-[130px] p-3">{{ $t("media.headers.quality") }}</th>
                                    <th class="w-[90px] p-3 text-center">{{ $t("media.headers.default") }}</th>
                                    <th class="w-[150px] p-3">{{ $t("media.headers.language") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="track in mergeTracksConfig"
                                    :key="track.draft_file_id"
                                    class="border-b last:border-0 hover:bg-gray-50/50"
                                >
                                    <td class="p-3" :title="track.name">
                                        <div class="truncate font-medium">{{ track.name }}</div>
                                    </td>

                                    <!-- Track Type Select -->
                                    <td class="p-1.5">
                                        <Select
                                            :model-value="track.type ?? undefined"
                                            :disabled="getTrackTypeOptions(track).length <= 1"
                                            @update:model-value="handleTrackTypeChange(track, $event)"
                                        >
                                            <SelectTrigger
                                                :aria-label="`Track type for ${track.name}`"
                                                class="h-8 w-full border-0 bg-transparent px-2 text-xs shadow-none disabled:opacity-100"
                                            >
                                                <SelectValue :placeholder="$t('media.unsupported_track')" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem v-for="type in getTrackTypeOptions(track)" :key="type" :value="type">
                                                    {{ $t("media.track_types." + type) }}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </td>

                                    <!-- Purpose Select -->
                                    <td class="p-1.5">
                                        <Select
                                            :model-value="track.purpose"
                                            :disabled="getPurposeOptions(track).length <= 1"
                                            @update:model-value="handleTrackPurposeChange(track, $event)"
                                        >
                                            <SelectTrigger
                                                :aria-label="`Purpose for ${track.name}`"
                                                class="h-8 w-full border-0 bg-transparent px-2 text-xs shadow-none disabled:opacity-100"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem v-for="purpose in getPurposeOptions(track)" :key="purpose" :value="purpose">
                                                    {{ $t("media.purposes." + purpose) }}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </td>

                                    <!-- Quality Select -->
                                    <td class="p-1.5">
                                        <Select v-model="track.quality">
                                            <SelectTrigger
                                                :aria-label="`Quality for ${track.name}`"
                                                class="h-8 w-full border-0 bg-transparent px-2 text-xs shadow-none"
                                            >
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

                                    <!-- Default Checkbox -->
                                    <td class="p-3 text-center">
                                        <Checkbox
                                            :model-value="track.is_default"
                                            :aria-label="`Set ${track.name} as a default track`"
                                            class="mx-auto"
                                            @update:model-value="handleDefaultChange(track, $event)"
                                        />
                                    </td>

                                    <!-- Language Input -->
                                    <td class="p-1.5">
                                        <Input
                                            v-if="isLanguageTrackType(track.type)"
                                            v-model="track.language"
                                            placeholder="en-US"
                                            :aria-label="`Language for ${track.name}`"
                                            class="h-8 w-full min-w-0 border-0 bg-transparent px-2 text-xs shadow-none"
                                        />
                                        <span v-else class="block px-2 text-gray-400">{{ $t("media.not_applicable") }}</span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- Mobile track cards -->
                    <div class="space-y-3 lg:hidden">
                        <div
                            v-for="track in mergeTracksConfig"
                            :key="`mobile-${track.draft_file_id}`"
                            class="space-y-4 rounded-lg border bg-white p-3.5"
                        >
                            <div class="min-w-0 border-b pb-3">
                                <div class="truncate text-sm font-medium" :title="track.name">{{ track.name }}</div>
                                <div class="mt-0.5 truncate text-xs text-gray-500">{{ track.mime_type }}</div>
                            </div>

                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div class="space-y-1.5">
                                    <Label class="text-xs text-gray-500">{{ $t("media.headers.track_type") }}</Label>
                                    <Select
                                        :model-value="track.type ?? undefined"
                                        :disabled="getTrackTypeOptions(track).length <= 1"
                                        @update:model-value="handleTrackTypeChange(track, $event)"
                                    >
                                        <SelectTrigger
                                            :aria-label="`Track type for ${track.name}`"
                                            class="h-9 w-full text-xs disabled:opacity-100"
                                        >
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
                                    <Label class="text-xs text-gray-500">{{ $t("media.headers.purpose") }}</Label>
                                    <Select
                                        :model-value="track.purpose"
                                        :disabled="getPurposeOptions(track).length <= 1"
                                        @update:model-value="handleTrackPurposeChange(track, $event)"
                                    >
                                        <SelectTrigger
                                            :aria-label="`Purpose for ${track.name}`"
                                            class="h-9 w-full text-xs disabled:opacity-100"
                                        >
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
                                    <Label class="text-xs text-gray-500">{{ $t("media.headers.quality") }}</Label>
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
                                    <Label class="text-xs text-gray-500">{{ $t("media.headers.language") }}</Label>
                                    <Input
                                        v-model="track.language"
                                        placeholder="en-US"
                                        :aria-label="`Language for ${track.name}`"
                                        class="h-9 text-xs"
                                    />
                                </div>
                            </div>

                            <div class="flex min-h-9 items-center justify-between gap-3 rounded-md bg-gray-50 px-3 py-2 text-sm">
                                <span>{{ $t("media.headers.default") }}</span>
                                <Checkbox
                                    :model-value="track.is_default"
                                    :aria-label="`Set ${track.name} as a default track`"
                                    @update:model-value="handleDefaultChange(track, $event)"
                                />
                            </div>
                        </div>
                    </div>

                    <div
                        v-if="mergeCompositionError"
                        class="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"
                        role="alert"
                    >
                        <AlertCircle class="mt-0.5 size-4 shrink-0" />
                        <span>{{ mergeCompositionError }}</span>
                    </div>
                </div>
            </div>

            <!-- Footer Actions -->
            <DialogFooter class="shrink-0 border-t px-4 py-4 sm:px-6">
                <Button variant="outline" class="w-full sm:w-auto" @click="isMergeDialogOpen = false">{{
                    $t("media.actions.cancel")
                }}</Button>
                <Button
                    class="w-full sm:w-auto"
                    :disabled="!mergeTitle.trim() || Boolean(mergeCompositionError)"
                    @click="handleCommitMerge"
                >
                    {{ $t("draft_box.merge_dialog.commit_btn") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>

<style scoped>
.ball-fade-enter-active,
.ball-fade-leave-active,
.panel-fade-enter-active,
.panel-fade-leave-active {
    transition:
        opacity 0.22s cubic-bezier(0.25, 0.8, 0.25, 1),
        transform 0.22s cubic-bezier(0.25, 0.8, 0.25, 1);
}

.ball-fade-enter-from,
.ball-fade-leave-to {
    opacity: 0;
    transform: scale(0.7);
}

.panel-fade-enter-from,
.panel-fade-leave-to {
    opacity: 0;
    transform: scale(0.96);
}
</style>
