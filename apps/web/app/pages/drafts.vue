<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useImportStore, type DraftFileItem } from "@/stores/import";
import { useLibraryStore } from "@/stores/library";
import { useAppLayout } from "@/composables/useAppLayout";
import { useMultiSelectModifier } from "@/composables/useMultiSelectModifier";
import DraftMergeDialog from "@/components/DraftMergeDialog.vue";
import HeicImage from "@/components/HeicImage.vue";
import { isHeic } from "@/utils/heic-decoder";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
    FolderPlus,
    Upload,
    RotateCcw,
    Search,
    LayoutGrid,
    List,
    FileDown,
    Layers,
    Trash2,
    Sidebar,
    Eye,
    X,
    File,
    Video,
    Music,
    FileText,
    AlertTriangle,
    Loader2,
    SlidersHorizontal,
} from "@lucide/vue";
import { getAllowedFileTrackTypes, TrackType } from "@/utils/draft-media-rules";
import { formatBytes } from "@/utils/media";
import { toast } from "vue-sonner";
import { Temporal } from "@js-temporal/polyfill";

const { t, locale } = useI18n();
const importStore = useImportStore();
const libraryStore = useLibraryStore();
const queryClient = useQueryClient();
const { toggleSidebar, isSidebarCollapsed } = useAppLayout();
const { isMultiSelectClick } = useMultiSelectModifier();

const libraryId = computed(() => libraryStore.activeLibraryId);
const activeLibrary = computed(() => libraryStore.activeLibrary);
const subtitleText = computed(() => {
    const name = activeLibrary.value?.name;
    if (!name || name === "Default Library") return "";
    return name;
});

// View mode: grid or table
const viewMode = ref<"grid" | "table">("grid");
const searchQuery = ref("");
const isCardDragActive = ref(false);

// Category filter tabs
const selectedCategory = ref<"all" | "image" | "video" | "audio" | "subtitle">("all");

function getFileCategory(mime?: string | null, name?: string): "image" | "video" | "audio" | "subtitle" | "other" {
    const m = (mime || "").toLowerCase();
    const n = (name || "").toLowerCase();
    if (
        m.startsWith("image/") ||
        n.endsWith(".jpg") ||
        n.endsWith(".jpeg") ||
        n.endsWith(".png") ||
        n.endsWith(".webp") ||
        n.endsWith(".avif") ||
        n.endsWith(".heic") ||
        n.endsWith(".heif")
    ) {
        return "image";
    }
    if (m.startsWith("video/") || n.endsWith(".mp4") || n.endsWith(".mov") || n.endsWith(".webm") || n.endsWith(".m4s")) {
        return "video";
    }
    if (
        m.startsWith("audio/") ||
        n.endsWith(".mp3") ||
        n.endsWith(".flac") ||
        n.endsWith(".wav") ||
        n.endsWith(".m4a") ||
        n.endsWith(".ogg")
    ) {
        return "audio";
    }
    if (n.endsWith(".srt") || n.endsWith(".vtt") || n.endsWith(".ass")) {
        return "subtitle";
    }
    return "other";
}

const categoryFilters = computed(() => [
    { key: "all" as const, label: t("draft_box.filters.all", "全部") },
    { key: "image" as const, label: t("draft_box.filters.image", "图片") },
    { key: "video" as const, label: t("draft_box.filters.video", "视频") },
    { key: "audio" as const, label: t("draft_box.filters.audio", "音频") },
    { key: "subtitle" as const, label: t("draft_box.filters.subtitle", "字幕") },
]);

const categoryCounts = computed(() => {
    const counts = { all: 0, image: 0, video: 0, audio: 0, subtitle: 0, other: 0 };
    for (const f of importStore.draftFiles) {
        counts.all++;
        const cat = getFileCategory(f.mime_type, f.name);
        if (cat in counts) {
            counts[cat as keyof typeof counts]++;
        } else {
            counts.other++;
        }
    }
    return counts;
});

// Selection State
const selectedFileIds = ref<string[]>([]);
const lastSelectedIndex = ref<number>(-1);

// Dialog States
const isMergeDialogOpen = ref(false);
const isDeleteDialogOpen = ref(false);
const itemToDelete = ref<DraftFileItem | null>(null);
const isBatchDelete = ref(false);
const isDeleting = ref(false);

const isPreviewOpen = ref(false);
const previewItem = ref<DraftFileItem | null>(null);

// Hidden file input
const fileInputRef = ref<HTMLInputElement | null>(null);

function triggerFileSelect() {
    fileInputRef.value?.click();
}

async function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    const files = target.files;
    if (files && files.length > 0 && libraryId.value) {
        await uploadFiles(files);
        target.value = "";
    }
}

async function uploadFiles(files: FileList) {
    if (!libraryId.value) return;
    const fileArray = Array.from(files);
    for (const file of fileArray) {
        try {
            await importStore.uploadFile(libraryId.value, file);
        } catch (err) {
            console.error(`Upload error for ${file.name}:`, err);
        }
    }
}

// Drag & drop
let dragCounter = 0;
function handleCardDragEnter(e: DragEvent) {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) isCardDragActive.value = true;
}
function handleCardDragLeave(e: DragEvent) {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) isCardDragActive.value = false;
}
function handleCardDragOver(e: DragEvent) {
    e.preventDefault();
}
async function handleCardDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter = 0;
    isCardDragActive.value = false;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
        await uploadFiles(files);
    }
}

// Filtered items
const filteredDraftFiles = computed(() => {
    let list = importStore.draftFiles;
    if (selectedCategory.value !== "all") {
        list = list.filter((f) => getFileCategory(f.mime_type, f.name) === selectedCategory.value);
    }
    if (searchQuery.value.trim()) {
        const q = searchQuery.value.toLowerCase().trim();
        list = list.filter((f) => f.name.toLowerCase().includes(q) || f.mime_type?.toLowerCase().includes(q));
    }
    return list;
});

// Storage stats
const totalStorageBytes = computed(() => {
    return importStore.draftFiles.reduce((acc, curr) => acc + (curr.size || 0), 0);
});

const selectedDraftFiles = computed(() => {
    return importStore.draftFiles.filter((d) => selectedFileIds.value.includes(d.id));
});

const totalSelectedBytes = computed(() => {
    return selectedDraftFiles.value.reduce((acc, curr) => acc + (curr.size || 0), 0);
});

const isAllSelected = computed(() => {
    return filteredDraftFiles.value.length > 0 && filteredDraftFiles.value.every((f) => selectedFileIds.value.includes(f.id));
});

function isFileSelected(id: string): boolean {
    return selectedFileIds.value.includes(id);
}

function formatRelativeTime(isoString?: string | null): string {
    if (!isoString) return "";
    try {
        const instant = Temporal.Instant.from(isoString);
        const zonedDateTime = instant.toZonedDateTimeISO(Temporal.Now.timeZoneId());
        return zonedDateTime.toLocaleString(locale.value, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return isoString;
    }
}

// Selection handlers
function toggleFileSelection(id: string, index?: number) {
    const idx = selectedFileIds.value.indexOf(id);
    if (idx === -1) {
        selectedFileIds.value.push(id);
    } else {
        selectedFileIds.value.splice(idx, 1);
    }
    if (index !== undefined) {
        lastSelectedIndex.value = index;
    }
}

function handleRangeSelect(targetIndex: number) {
    if (lastSelectedIndex.value === -1 || lastSelectedIndex.value === targetIndex) {
        const file = filteredDraftFiles.value[targetIndex];
        if (file) toggleFileSelection(file.id, targetIndex);
        return;
    }

    const start = Math.min(lastSelectedIndex.value, targetIndex);
    const end = Math.max(lastSelectedIndex.value, targetIndex);
    const rangeFiles = filteredDraftFiles.value.slice(start, end + 1);

    const newIds = new Set(selectedFileIds.value);
    for (const f of rangeFiles) {
        newIds.add(f.id);
    }
    selectedFileIds.value = Array.from(newIds);
    lastSelectedIndex.value = targetIndex;
}

function handleCardClick(file: DraftFileItem, index: number, event: MouseEvent) {
    if (event.shiftKey && lastSelectedIndex.value !== -1) {
        event.preventDefault();
        handleRangeSelect(index);
        return;
    }

    if (isMultiSelectClick(event)) {
        event.preventDefault();
        toggleFileSelection(file.id, index);
        return;
    }

    toggleFileSelection(file.id, index);
}

function toggleSelectAll() {
    if (isAllSelected.value) {
        selectedFileIds.value = [];
        lastSelectedIndex.value = -1;
    } else {
        selectedFileIds.value = filteredDraftFiles.value.map((f) => f.id);
    }
}

function clearSelection() {
    selectedFileIds.value = [];
    lastSelectedIndex.value = -1;
}

function handleCanvasClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("[data-draft-card]") || target.closest("button") || target.closest("input") || target.closest("table")) {
        return;
    }
    clearSelection();
}

// Commit single
async function handleCommitSingle(draft: DraftFileItem) {
    if (!libraryId.value) return;
    const allowed = getAllowedFileTrackTypes(draft.name, draft.mime_type);
    if (allowed.length === 0) {
        toast.warning(t("draft_box.toasts.unsupported_file"), {
            description: t("draft_box.toasts.unsupported_file_desc", { name: draft.name }),
        });
        return;
    }
    if (allowed[0] === TrackType.SUBTITLE) {
        toast.warning(t("draft_box.toasts.subtitle_cannot_standalone"), {
            description: t("draft_box.toasts.subtitle_cannot_standalone_desc"),
        });
        return;
    }

    const guessedType = allowed[0]!;
    const payload = {
        media_drafts: [
            {
                temp_id: draft.id,
                title: draft.name.substring(0, draft.name.lastIndexOf(".")) || draft.name,
                type: guessedType,
                tracks: [
                    {
                        draft_file_id: draft.id,
                        type: guessedType,
                        purpose: "CONTENT",
                        quality: "HIGH",
                        is_default: true,
                        language: null,
                    },
                ],
            },
        ],
    };

    try {
        await importStore.commitMedia(libraryId.value, payload);
        selectedFileIds.value = selectedFileIds.value.filter((id) => id !== draft.id);
        toast.success(t("draft_box.toasts.import_success", { count: 1 }));
        queryClient.invalidateQueries({ queryKey: ["media"] });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(t("draft_box.toasts.commit_failed"), { description: msg });
    }
}

// Commit separate
async function handleCommitSeparate() {
    if (selectedFileIds.value.length === 0 || !libraryId.value) return;
    const drafts = [...selectedDraftFiles.value];

    const unsupported = drafts.find((d) => getAllowedFileTrackTypes(d.name, d.mime_type).length === 0);
    if (unsupported) {
        toast.warning(t("draft_box.toasts.unsupported_file"), {
            description: t("draft_box.toasts.unsupported_file_desc", { name: unsupported.name }),
        });
        return;
    }

    const ambiguous = drafts.find((d) => getAllowedFileTrackTypes(d.name, d.mime_type).length > 1);
    if (ambiguous) {
        toast.warning(t("draft_box.toasts.choose_media_type"), {
            description: t("draft_box.toasts.choose_media_type_desc", { name: ambiguous.name }),
        });
        return;
    }

    const standaloneSubtitles = drafts.filter((d) => getAllowedFileTrackTypes(d.name, d.mime_type)[0] === TrackType.SUBTITLE);
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
                        quality: "HIGH",
                        is_default: true,
                        language: null,
                    },
                ],
            };
        }),
    };

    try {
        await importStore.commitMedia(libraryId.value, payload);
        clearSelection();
        toast.success(t("draft_box.toasts.import_success", { count: drafts.length }));
        queryClient.invalidateQueries({ queryKey: ["media"] });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(t("draft_box.toasts.commit_failed"), { description: msg });
    }
}

// Merge dialog
function openMergeSetup() {
    if (selectedFileIds.value.length < 2) {
        toast.info(t("draft_box.toasts.choose_media_type"), {
            description: "请至少选择 2 个文件进行合并。",
        });
        return;
    }
    isMergeDialogOpen.value = true;
}

// Delete handlers
function openSingleDeleteConfirm(item: DraftFileItem) {
    itemToDelete.value = item;
    isBatchDelete.value = false;
    isDeleteDialogOpen.value = true;
}

function openBatchDeleteConfirm() {
    if (selectedFileIds.value.length === 0) return;
    itemToDelete.value = null;
    isBatchDelete.value = true;
    isDeleteDialogOpen.value = true;
}

async function confirmDelete() {
    if (!libraryId.value) return;
    isDeleting.value = true;

    try {
        if (isBatchDelete.value) {
            const idsToDelete = [...selectedFileIds.value];
            await Promise.all(idsToDelete.map((id) => importStore.deleteDraftFile(libraryId.value!, id)));
            clearSelection();
            toast.success(t("draft_box.toasts.delete_files_success"));
        } else if (itemToDelete.value) {
            const id = itemToDelete.value.id;
            await importStore.deleteDraftFile(libraryId.value, id);
            selectedFileIds.value = selectedFileIds.value.filter((i) => i !== id);
            toast.success(t("draft_box.toasts.delete_files_success"));
        }
        isDeleteDialogOpen.value = false;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(t("draft_box.toasts.delete_files_failed"), { description: msg });
    } finally {
        isDeleting.value = false;
    }
}

function openPreview(item: DraftFileItem) {
    previewItem.value = item;
    isPreviewOpen.value = true;
}

async function handleRefresh() {
    if (libraryId.value) {
        await importStore.fetchDraftFiles(libraryId.value);
    }
}

function handleKeydown(e: KeyboardEvent) {
    if (isPreviewOpen.value || isMergeDialogOpen.value || isDeleteDialogOpen.value) return;

    if (e.key === "Escape") {
        if (selectedFileIds.value.length > 0) {
            clearSelection();
        }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        e.preventDefault();
        toggleSelectAll();
    } else if (e.code === "Space") {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        if (selectedDraftFiles.value.length >= 1 && selectedDraftFiles.value[0]) {
            e.preventDefault();
            openPreview(selectedDraftFiles.value[0]);
        }
    }
}

onMounted(async () => {
    window.addEventListener("keydown", handleKeydown);
    if (libraryId.value) {
        await importStore.fetchDraftFiles(libraryId.value);
    }
});

onUnmounted(() => {
    window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
    <!-- Hidden file input for manual upload -->
    <input type="file" ref="fileInputRef" multiple class="hidden" @change="handleFileSelect" />

    <div class="h-full flex flex-col bg-white overflow-hidden font-sans select-none">
        <!-- Top Navigation Header (Strictly matching tags.vue & trash.vue) -->
        <header class="h-14 border-b border-zinc-200/80 px-4 md:px-6 shrink-0 flex items-center justify-between gap-3 md:gap-4 bg-white">
            <!-- Left: Sidebar Toggle, Page Icon, Title & Library Subtitle -->
            <div class="flex items-center gap-3">
                <button
                    @click="toggleSidebar"
                    class="h-8 w-8 rounded-lg -ml-1 items-center justify-center text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 transition-all cursor-pointer"
                    :class="isSidebarCollapsed ? 'flex' : 'flex md:hidden'"
                    :title="$t('common.toggle_sidebar', 'Toggle sidebar')"
                    :aria-label="$t('common.toggle_sidebar', 'Toggle sidebar')"
                >
                    <Sidebar class="w-4.5 h-4.5" />
                </button>
                <div class="p-1.5 bg-zinc-50 border border-zinc-200 rounded-lg">
                    <FolderPlus class="w-4 h-4 text-zinc-700" />
                </div>
                <div>
                    <div class="flex items-center gap-2">
                        <h1 class="text-sm font-bold tracking-tight text-zinc-900 leading-none">
                            {{ $t("draft_box.title", "草稿箱") }}
                        </h1>
                        <span class="text-xs bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full font-semibold tabular-nums">
                            {{ importStore.draftFiles.length }}
                        </span>
                        <span v-if="totalStorageBytes > 0" class="text-xs text-zinc-400 font-medium tabular-nums">
                            ({{ formatBytes(totalStorageBytes) }})
                        </span>
                    </div>
                    <span v-if="subtitleText" class="text-xs text-zinc-500 font-semibold flex items-center gap-1.5 mt-1.5">
                        <SlidersHorizontal class="w-3 h-3 text-zinc-400" />
                        <span>{{ subtitleText }}</span>
                    </span>
                </div>
            </div>

            <!-- Right: Search Bar, Refresh & Upload Action -->
            <div class="flex items-center gap-2.5 sm:gap-3 w-full sm:w-auto justify-between sm:justify-start">
                <div class="relative w-full sm:w-64">
                    <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
                    <Input
                        v-model="searchQuery"
                        type="text"
                        :placeholder="$t('draft_box.search_placeholder')"
                        class="pl-8 pr-7 h-9 w-full bg-zinc-50 hover:bg-zinc-100/50 focus:bg-white text-xs rounded-lg border border-zinc-200 focus:ring-1 focus:ring-zinc-950 transition-all duration-200 placeholder-zinc-500 text-zinc-800"
                    />
                    <button
                        v-if="searchQuery"
                        @click="searchQuery = ''"
                        class="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 cursor-pointer"
                    >
                        <X class="w-3.5 h-3.5" />
                    </button>
                </div>

                <Button
                    variant="outline"
                    size="icon"
                    class="h-9 w-9 text-zinc-600 border-zinc-200 hover:text-zinc-900 cursor-pointer shrink-0 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-zinc-950"
                    :title="$t('draft_box.refresh')"
                    @click="handleRefresh"
                >
                    <RotateCcw class="w-4 h-4" :class="importStore.isLoadingDrafts ? 'animate-spin' : ''" />
                </Button>

                <Button
                    @click="triggerFileSelect"
                    class="h-9 gap-1.5 px-3.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg font-bold text-xs cursor-pointer shadow-xs transition-colors duration-200 shrink-0 active:scale-[0.96]"
                >
                    <Upload class="w-3.5 h-3.5" />
                    <span>{{ $t("draft_box.choose_files_btn") }}</span>
                </Button>
            </div>
        </header>

        <!-- Main Workplace (Seamless Split-Pane) -->
        <div
            class="flex-1 bg-white overflow-hidden flex flex-col min-w-0 min-h-0 relative"
            @dragenter="handleCardDragEnter"
            @dragleave="handleCardDragLeave"
            @dragover="handleCardDragOver"
            @drop="handleCardDrop"
        >
            <!-- Drag & Drop In-Card Overlay -->
            <div
                v-if="isCardDragActive"
                class="absolute inset-0 z-30 bg-zinc-900/10 backdrop-blur-[2px] border-2 border-dashed border-zinc-900 rounded-2xl flex flex-col items-center justify-center pointer-events-none"
            >
                <div class="p-6 bg-white rounded-2xl shadow-xl flex flex-col items-center gap-2">
                    <Upload class="w-8 h-8 text-zinc-900 animate-bounce" />
                    <p class="font-semibold text-sm text-zinc-900">{{ $t("draft_box.drop_title") }}</p>
                </div>
            </div>

            <!-- Unified Card Toolbar Strip -->
            <!-- State A: Browsing Mode (Full width for category tabs + select-all / view switcher) -->
            <div
                v-if="selectedFileIds.length === 0"
                class="px-4 sm:px-6 h-12 border-b border-zinc-200 bg-[#fafafa] flex items-center justify-between gap-4 shrink-0 select-none"
            >
                <!-- Left: Underline Tab Triggers for Categories (Never wrap!) -->
                <div class="flex items-center gap-4 sm:gap-6 h-full overflow-x-auto scrollbar-none shrink-0">
                    <button
                        v-for="cat in categoryFilters"
                        :key="cat.key"
                        role="tab"
                        :aria-selected="selectedCategory === cat.key"
                        class="relative h-full px-1 text-xs sm:text-sm font-bold tracking-tight transition-colors cursor-pointer flex items-center gap-1.5 pb-0 pt-0 whitespace-nowrap shrink-0"
                        :class="selectedCategory === cat.key ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-700'"
                        @click="selectedCategory = cat.key"
                    >
                        <span class="whitespace-nowrap">{{ cat.label }}</span>
                        <span
                            class="text-xs sm:text-xs font-bold px-1.5 py-0.5 rounded-full font-mono transition-colors"
                            :class="selectedCategory === cat.key ? 'bg-zinc-200 text-zinc-800' : 'bg-zinc-100 text-zinc-500'"
                        >
                            {{ categoryCounts[cat.key] }}
                        </span>
                        <div v-if="selectedCategory === cat.key" class="absolute bottom-0 inset-x-0 h-[2px] bg-zinc-800 rounded-full" />
                    </button>
                </div>

                <!-- Right: Select All & View Switcher -->
                <div class="flex items-center gap-3 sm:gap-4 shrink-0 text-xs font-semibold">
                    <div
                        v-if="filteredDraftFiles.length > 0"
                        class="flex items-center gap-2 select-none cursor-pointer group whitespace-nowrap"
                        @click="toggleSelectAll"
                    >
                        <Checkbox :model-value="false" class="w-4 h-4 pointer-events-none" />
                        <span
                            class="text-xs sm:text-sm font-medium text-zinc-500 group-hover:text-zinc-800 transition-colors whitespace-nowrap"
                        >
                            {{ $t("draft_box.select_all_btn") }}
                        </span>
                    </div>

                    <div v-if="filteredDraftFiles.length > 0" class="h-3.5 w-px bg-zinc-200 hidden sm:block" />

                    <!-- View Switcher -->
                    <div class="flex items-center bg-zinc-100 p-0.5 rounded-lg border border-zinc-200/60">
                        <button
                            class="p-1 rounded-md text-xs transition-colors cursor-pointer"
                            :class="viewMode === 'grid' ? 'bg-white text-zinc-900 shadow-2xs' : 'text-zinc-500 hover:text-zinc-800'"
                            :title="$t('draft_box.grid_view', '网格视图')"
                            @click="viewMode = 'grid'"
                        >
                            <LayoutGrid class="w-3.5 h-3.5" />
                        </button>
                        <button
                            class="p-1 rounded-md text-xs transition-colors cursor-pointer"
                            :class="viewMode === 'table' ? 'bg-white text-zinc-900 shadow-2xs' : 'text-zinc-500 hover:text-zinc-800'"
                            :title="$t('draft_box.table_view', '列表视图')"
                            @click="viewMode = 'table'"
                        >
                            <List class="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            </div>

            <!-- State B: Selection Action Bar (Dedicated full row, calm, spacious, zero text wrapping) -->
            <div
                v-else
                class="px-4 sm:px-6 h-12 border-b border-zinc-200 bg-zinc-50/90 flex items-center justify-between gap-4 shrink-0 select-none animate-in fade-in duration-150"
            >
                <!-- Left: Cancel X, Checkbox, Selection Count -->
                <div class="flex items-center gap-2.5 min-w-0">
                    <button
                        type="button"
                        class="h-7 w-7 rounded-lg flex items-center justify-center text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 transition-colors cursor-pointer shrink-0"
                        :title="$t('draft_box.unselect_all_btn') + ' (Esc)'"
                        @click="clearSelection"
                    >
                        <X class="w-4 h-4" />
                    </button>

                    <div class="flex items-center gap-2 select-none cursor-pointer whitespace-nowrap" @click="toggleSelectAll">
                        <Checkbox :model-value="isAllSelected ? true : 'indeterminate'" class="w-4 h-4 pointer-events-none" />
                        <span class="text-xs sm:text-sm font-bold text-zinc-900 tabular-nums whitespace-nowrap">
                            {{ $t("draft_box.selected_items_count", { count: selectedFileIds.length }) }}
                        </span>
                        <span
                            v-if="totalSelectedBytes > 0"
                            class="text-xs text-zinc-400 font-mono tabular-nums whitespace-nowrap hidden sm:inline"
                        >
                            ({{ formatBytes(totalSelectedBytes) }})
                        </span>
                    </div>
                </div>

                <!-- Right: Context Action Buttons -->
                <div class="flex items-center gap-2 shrink-0">
                    <!-- Single item selected -->
                    <template v-if="selectedFileIds.length === 1 && selectedDraftFiles[0]">
                        <Button
                            variant="outline"
                            size="sm"
                            class="h-8 px-3 text-xs border-zinc-200 bg-white hover:bg-zinc-100 text-zinc-700 font-medium cursor-pointer shadow-2xs gap-1.5"
                            @click="openPreview(selectedDraftFiles[0])"
                        >
                            <Eye class="w-3.5 h-3.5 text-zinc-500" />
                            <span>{{ $t("draft_box.preview") }}</span>
                        </Button>

                        <Button
                            size="sm"
                            class="h-8 px-3.5 text-xs bg-zinc-900 hover:bg-zinc-800 text-white font-medium gap-1.5 cursor-pointer shadow-xs active:scale-[0.96]"
                            @click="handleCommitSingle(selectedDraftFiles[0])"
                        >
                            <FileDown class="w-3.5 h-3.5" />
                            <span>{{ $t("draft_box.quick_import") }}</span>
                        </Button>

                        <Button
                            variant="outline"
                            size="sm"
                            class="h-8 px-2.5 text-xs border-zinc-200 bg-white hover:border-red-200 hover:bg-red-50 text-zinc-600 hover:text-red-600 font-medium gap-1.5 cursor-pointer shadow-2xs"
                            @click="openSingleDeleteConfirm(selectedDraftFiles[0])"
                        >
                            <Trash2 class="w-3.5 h-3.5" />
                            <span class="hidden sm:inline">{{ $t("draft_box.delete_btn") }}</span>
                        </Button>
                    </template>

                    <!-- Multiple items selected (>= 2) -->
                    <template v-else-if="selectedFileIds.length >= 2">
                        <Button
                            variant="outline"
                            size="sm"
                            class="h-8 px-3 text-xs border-zinc-200 bg-white hover:bg-zinc-100 text-zinc-700 font-medium cursor-pointer shadow-2xs gap-1.5"
                            :title="$t('draft_box.merge_tracks_tooltip')"
                            @click="openMergeSetup"
                        >
                            <Layers class="w-3.5 h-3.5 text-zinc-500" />
                            <span>{{ $t("draft_box.merge_tracks_btn") }}</span>
                        </Button>

                        <Button
                            size="sm"
                            class="h-8 px-3.5 text-xs bg-zinc-900 hover:bg-zinc-800 text-white font-medium gap-1.5 cursor-pointer shadow-xs active:scale-[0.96]"
                            :title="$t('draft_box.import_separately_tooltip')"
                            @click="handleCommitSeparate"
                        >
                            <FileDown class="w-3.5 h-3.5" />
                            <span>{{ $t("draft_box.import_separately_btn") }}</span>
                        </Button>

                        <Button
                            variant="outline"
                            size="sm"
                            class="h-8 px-2.5 text-xs border-zinc-200 bg-white hover:border-red-200 hover:bg-red-50 text-zinc-600 hover:text-red-600 font-medium gap-1.5 cursor-pointer shadow-2xs"
                            :title="$t('draft_box.delete_tooltip')"
                            @click="openBatchDeleteConfirm"
                        >
                            <Trash2 class="w-3.5 h-3.5" />
                            <span class="hidden sm:inline">{{ $t("draft_box.delete_btn") }}</span>
                        </Button>
                    </template>

                    <div class="h-3.5 w-px bg-zinc-200 mx-1 hidden sm:block" />

                    <!-- View Switcher -->
                    <div class="flex items-center bg-zinc-100 p-0.5 rounded-lg border border-zinc-200/60">
                        <button
                            class="p-1 rounded-md text-xs transition-colors cursor-pointer"
                            :class="viewMode === 'grid' ? 'bg-white text-zinc-900 shadow-2xs' : 'text-zinc-500 hover:text-zinc-800'"
                            @click="viewMode = 'grid'"
                        >
                            <LayoutGrid class="w-3.5 h-3.5" />
                        </button>
                        <button
                            class="p-1 rounded-md text-xs transition-colors cursor-pointer"
                            :class="viewMode === 'table' ? 'bg-white text-zinc-900 shadow-2xs' : 'text-zinc-500 hover:text-zinc-800'"
                            @click="viewMode = 'table'"
                        >
                            <List class="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            </div>

            <!-- Main Content Area: Grid or Table -->
            <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 bg-white" @click="handleCanvasClick">
                <!-- 1. Skeleton Loading -->
                <div v-if="importStore.isLoadingDrafts" class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 sm:gap-5">
                    <div
                        v-for="i in 12"
                        :key="i"
                        class="bg-white rounded-xl p-2.5 border border-zinc-200/70 shadow-xs flex flex-col gap-2 animate-pulse"
                    >
                        <div class="aspect-4/3 bg-zinc-100 rounded-lg w-full" />
                        <div class="space-y-1.5 mt-1">
                            <div class="h-3 bg-zinc-100 rounded w-3/4" />
                            <div class="h-2.5 bg-zinc-100 rounded w-1/2" />
                        </div>
                    </div>
                </div>

                <!-- 2. Empty State -->
                <div
                    v-else-if="filteredDraftFiles.length === 0"
                    class="h-full min-h-[380px] flex flex-col items-center justify-center p-8 text-center"
                >
                    <div
                        class="w-14 h-14 rounded-2xl bg-zinc-50 border border-zinc-200 shadow-xs flex items-center justify-center text-zinc-400 mb-3"
                    >
                        <FolderPlus class="w-6 h-6 text-zinc-400 stroke-[1.5]" />
                    </div>

                    <div v-if="searchQuery">
                        <h2 class="text-sm font-semibold text-zinc-800 tracking-tight">未找到匹配的草稿文件</h2>
                        <p class="text-xs text-zinc-500 mt-1 max-w-xs leading-relaxed">“{{ searchQuery }}”</p>
                        <Button size="sm" variant="outline" class="mt-4 text-xs" @click="searchQuery = ''">清除搜索</Button>
                    </div>

                    <div v-else class="flex flex-col items-center">
                        <h2 class="text-sm font-semibold text-zinc-800 tracking-tight">
                            {{ $t("draft_box.empty") }}
                        </h2>
                        <p class="text-xs text-zinc-500 mt-1 max-w-sm leading-relaxed">
                            {{ $t("draft_box.empty_desc") }}
                        </p>
                        <Button
                            size="sm"
                            class="mt-4 gap-1.5 text-xs bg-zinc-900 text-white hover:bg-zinc-800 cursor-pointer shadow-xs active:scale-95"
                            @click="triggerFileSelect"
                        >
                            <Upload class="w-3.5 h-3.5" />
                            <span>{{ $t("draft_box.choose_files_btn") }}</span>
                        </Button>
                    </div>
                </div>

                <!-- 3. Grid View Mode (Pure Media, Zero Overlays on Images, Robust Proportions) -->
                <div
                    v-else-if="viewMode === 'grid'"
                    class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 sm:gap-5"
                    @click.self="clearSelection"
                >
                    <ContextMenu v-for="(file, index) in filteredDraftFiles" :key="file.id">
                        <ContextMenuTrigger as-child>
                            <div
                                data-draft-card
                                class="group relative bg-white rounded-xl p-2 border transition-all duration-150 flex flex-col cursor-pointer select-none"
                                :class="[
                                    isFileSelected(file.id)
                                        ? 'ring-2 ring-zinc-900 border-zinc-900 bg-zinc-50/40 shadow-xs'
                                        : 'border-zinc-200/80 hover:border-zinc-300 hover:shadow-xs',
                                ]"
                                @click="handleCardClick(file, index, $event)"
                                @dblclick="openPreview(file)"
                            >
                                <!-- Top-Left Checkbox: CheckboxRoot uses modelValue -->
                                <div
                                    class="absolute top-3.5 left-3.5 z-10 transition-opacity"
                                    :class="
                                        selectedFileIds.length > 0 || isFileSelected(file.id)
                                            ? 'opacity-100'
                                            : 'opacity-0 group-hover:opacity-100'
                                    "
                                    @click.stop="toggleFileSelection(file.id, index)"
                                >
                                    <Checkbox
                                        :model-value="isFileSelected(file.id)"
                                        class="size-4.5 border-white/90 bg-white/90 shadow-sm data-[state=checked]:bg-zinc-900 data-[state=checked]:border-zinc-900 rounded-[5px] pointer-events-none"
                                    />
                                </div>

                                <!-- Top-Right Format Badge (Subtle dark pill) -->
                                <div class="absolute top-3.5 right-3.5 z-10 pointer-events-none">
                                    <span
                                        class="text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-sm text-white border border-white/10 shadow-2xs"
                                    >
                                        {{ (file.name.split(".").pop() || "FILE").toUpperCase() }}
                                    </span>
                                </div>

                                <!-- Thumbnail Area: 100% CLEAN MEDIA -->
                                <div
                                    class="aspect-4/3 bg-zinc-100 rounded-lg overflow-hidden relative flex items-center justify-center border border-zinc-100"
                                >
                                    <!-- Image -->
                                    <HeicImage
                                        v-if="
                                            getFileCategory(file.mime_type, file.name) === 'image' &&
                                            file.url &&
                                            isHeic(file.url, file.mime_type)
                                        "
                                        :src="file.url"
                                        :mime-type="file.mime_type"
                                        :alt="file.name"
                                        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-103"
                                        loading="lazy"
                                    />
                                    <img
                                        v-else-if="getFileCategory(file.mime_type, file.name) === 'image' && file.url"
                                        :src="file.url"
                                        :alt="file.name"
                                        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-103"
                                        loading="lazy"
                                    />
                                    <!-- Video -->
                                    <div
                                        v-else-if="getFileCategory(file.mime_type, file.name) === 'video'"
                                        class="w-full h-full flex items-center justify-center bg-zinc-900 text-white/80"
                                    >
                                        <Video class="w-8 h-8 text-zinc-400" />
                                    </div>
                                    <!-- Audio -->
                                    <div
                                        v-else-if="getFileCategory(file.mime_type, file.name) === 'audio'"
                                        class="w-full h-full flex items-center justify-center bg-indigo-50/50 text-indigo-500"
                                    >
                                        <Music class="w-8 h-8" />
                                    </div>
                                    <!-- Subtitle -->
                                    <div
                                        v-else-if="getFileCategory(file.mime_type, file.name) === 'subtitle'"
                                        class="w-full h-full flex items-center justify-center bg-amber-50/50 text-amber-600"
                                    >
                                        <FileText class="w-8 h-8" />
                                    </div>
                                    <!-- Generic -->
                                    <div v-else class="w-full h-full flex items-center justify-center bg-zinc-50 text-zinc-400">
                                        <File class="w-8 h-8" />
                                    </div>
                                </div>

                                <!-- Meta details below the image -->
                                <div class="p-1.5 mt-1 flex flex-col gap-0.5">
                                    <span class="font-medium text-xs text-zinc-900 truncate" :title="file.name">
                                        {{ file.name }}
                                    </span>
                                    <div class="flex items-center justify-between text-xs text-zinc-400 tabular-nums">
                                        <span>{{ formatBytes(file.size) }}</span>
                                        <span>{{ formatRelativeTime(file.create_time) }}</span>
                                    </div>
                                </div>
                            </div>
                        </ContextMenuTrigger>

                        <!-- Right-click Context Menu -->
                        <ContextMenuContent class="w-44">
                            <ContextMenuItem class="cursor-pointer" @click="openPreview(file)">
                                <Eye class="w-4 h-4 mr-2" />
                                <span>{{ $t("draft_box.preview") }}</span>
                            </ContextMenuItem>
                            <ContextMenuItem class="cursor-pointer" @click="handleCommitSingle(file)">
                                <FileDown class="w-4 h-4 mr-2" />
                                <span>{{ $t("draft_box.quick_import") }}</span>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem class="text-red-600 focus:text-red-600 cursor-pointer" @click="openSingleDeleteConfirm(file)">
                                <Trash2 class="w-4 h-4 mr-2" />
                                <span>{{ $t("draft_box.delete_btn") }}</span>
                            </ContextMenuItem>
                        </ContextMenuContent>
                    </ContextMenu>
                </div>

                <!-- 4. Table View Mode -->
                <div v-else-if="viewMode === 'table'" class="rounded-xl border border-zinc-200/80 overflow-hidden shadow-xs">
                    <table class="w-full border-collapse text-left text-xs">
                        <thead>
                            <tr class="bg-zinc-50 border-b border-zinc-200/80 text-zinc-500 font-medium">
                                <th class="w-10 p-3 text-center cursor-pointer select-none" @click="toggleSelectAll">
                                    <Checkbox
                                        :model-value="selectedFileIds.length === 0 ? false : isAllSelected ? true : 'indeterminate'"
                                        class="pointer-events-none"
                                    />
                                </th>
                                <th class="p-3">{{ $t("draft_box.table_headers.file") }}</th>
                                <th class="w-32 p-3">{{ $t("draft_box.table_headers.type") }}</th>
                                <th class="w-24 p-3">{{ $t("draft_box.table_headers.size") }}</th>
                                <th class="w-36 p-3">{{ $t("draft_box.table_headers.date") }}</th>
                                <th class="w-28 p-3 text-right">{{ $t("draft_box.table_headers.actions") }}</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-zinc-200/60 bg-white">
                            <tr
                                v-for="(file, index) in filteredDraftFiles"
                                :key="file.id"
                                data-draft-card
                                class="transition-colors cursor-pointer"
                                :class="[isFileSelected(file.id) ? 'bg-zinc-100/80 font-medium' : 'hover:bg-zinc-50/70']"
                                @click="handleCardClick(file, index, $event)"
                                @dblclick="openPreview(file)"
                            >
                                <td class="p-3 text-center" @click.stop="toggleFileSelection(file.id, index)">
                                    <Checkbox :model-value="isFileSelected(file.id)" class="pointer-events-none" />
                                </td>
                                <td class="p-3">
                                    <div class="flex items-center gap-2.5 min-w-0">
                                        <div
                                            class="w-7 h-7 rounded-md bg-zinc-100 overflow-hidden flex items-center justify-center shrink-0"
                                        >
                                            <HeicImage
                                                v-if="
                                                    getFileCategory(file.mime_type, file.name) === 'image' &&
                                                    file.url &&
                                                    isHeic(file.url, file.mime_type)
                                                "
                                                :src="file.url"
                                                :mime-type="file.mime_type"
                                                no-spinner
                                                class="w-full h-full object-cover"
                                            />
                                            <img
                                                v-else-if="getFileCategory(file.mime_type, file.name) === 'image' && file.url"
                                                :src="file.url"
                                                class="w-full h-full object-cover"
                                            />
                                            <Video
                                                v-else-if="getFileCategory(file.mime_type, file.name) === 'video'"
                                                class="w-3.5 h-3.5 text-zinc-500"
                                            />
                                            <Music
                                                v-else-if="getFileCategory(file.mime_type, file.name) === 'audio'"
                                                class="w-3.5 h-3.5 text-indigo-500"
                                            />
                                            <FileText
                                                v-else-if="getFileCategory(file.mime_type, file.name) === 'subtitle'"
                                                class="w-3.5 h-3.5 text-amber-600"
                                            />
                                            <File v-else class="w-3.5 h-3.5 text-zinc-400" />
                                        </div>
                                        <span class="font-medium text-zinc-900 truncate" :title="file.name">{{ file.name }}</span>
                                    </div>
                                </td>
                                <td class="p-3 text-zinc-500 font-mono text-xs truncate max-w-[120px]">
                                    {{ file.mime_type || "unknown" }}
                                </td>
                                <td class="p-3 text-zinc-500 tabular-nums">
                                    {{ formatBytes(file.size) }}
                                </td>
                                <td class="p-3 text-zinc-400 tabular-nums">
                                    {{ formatRelativeTime(file.create_time) }}
                                </td>
                                <td class="p-3 text-right" @click.stop>
                                    <div class="flex items-center justify-end gap-1">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            class="w-7 h-7 text-zinc-500 hover:text-zinc-900 cursor-pointer"
                                            :title="$t('draft_box.preview')"
                                            @click="openPreview(file)"
                                        >
                                            <Eye class="w-3.5 h-3.5" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            class="w-7 h-7 text-zinc-500 hover:text-zinc-900 cursor-pointer"
                                            :title="$t('draft_box.quick_import')"
                                            @click="handleCommitSingle(file)"
                                        >
                                            <FileDown class="w-3.5 h-3.5" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            class="w-7 h-7 text-zinc-500 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                                            :title="$t('draft_box.delete_btn')"
                                            @click="openSingleDeleteConfirm(file)"
                                        >
                                            <Trash2 class="w-3.5 h-3.5" />
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <!-- Multi-Track Merge Dialog -->
    <DraftMergeDialog
        :open="isMergeDialogOpen"
        :selected-draft-files="selectedDraftFiles"
        :library-id="libraryId || ''"
        @update:open="isMergeDialogOpen = $event"
        @merged="clearSelection"
    />

    <!-- Accessible Delete Confirmation Dialog -->
    <Dialog v-model:open="isDeleteDialogOpen">
        <DialogContent class="sm:max-w-md">
            <DialogHeader>
                <div class="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center mb-2">
                    <AlertTriangle class="w-5 h-5" />
                </div>
                <DialogTitle>
                    {{ isBatchDelete ? $t("draft_box.delete_confirm.batch_title") : $t("draft_box.delete_confirm.single_title") }}
                </DialogTitle>
                <DialogDescription class="text-xs text-zinc-500">
                    {{
                        isBatchDelete
                            ? $t("draft_box.delete_confirm.batch_desc", { count: selectedFileIds.length })
                            : $t("draft_box.delete_confirm.single_desc", { name: itemToDelete?.name || "" })
                    }}
                </DialogDescription>
            </DialogHeader>
            <DialogFooter class="mt-4 gap-2">
                <Button variant="outline" size="sm" :disabled="isDeleting" @click="isDeleteDialogOpen = false">
                    {{ $t("draft_box.cancel_btn") }}
                </Button>
                <Button variant="destructive" size="sm" class="gap-1.5" :disabled="isDeleting" @click="confirmDelete">
                    <Loader2 v-if="isDeleting" class="w-3.5 h-3.5 animate-spin" />
                    <span>{{ $t("draft_box.delete_btn") }}</span>
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>

    <!-- Preview Modal -->
    <Dialog v-model:open="isPreviewOpen">
        <DialogContent class="sm:max-w-2xl p-4">
            <DialogHeader>
                <DialogTitle class="truncate text-sm font-semibold text-zinc-900">
                    {{ previewItem?.name }}
                </DialogTitle>
                <DialogDescription class="text-xs text-zinc-400">
                    {{ previewItem?.mime_type }} · {{ formatBytes(previewItem?.size || 0) }}
                </DialogDescription>
            </DialogHeader>

            <div class="mt-2 flex items-center justify-center max-h-[60vh] overflow-hidden rounded-lg bg-zinc-950/5 p-2">
                <HeicImage
                    v-if="
                        previewItem &&
                        getFileCategory(previewItem.mime_type, previewItem.name) === 'image' &&
                        isHeic(previewItem.url, previewItem.mime_type)
                    "
                    :src="previewItem.url"
                    :mime-type="previewItem.mime_type"
                    class="max-h-[55vh] max-w-full object-contain rounded-md"
                />
                <img
                    v-else-if="previewItem && getFileCategory(previewItem.mime_type, previewItem.name) === 'image'"
                    :src="previewItem.url"
                    class="max-h-[55vh] max-w-full object-contain rounded-md"
                />
                <video
                    v-else-if="previewItem && getFileCategory(previewItem.mime_type, previewItem.name) === 'video'"
                    :src="previewItem.url"
                    controls
                    playsinline
                    class="max-h-[55vh] max-w-full rounded-md bg-black"
                />
                <div
                    v-else-if="previewItem && getFileCategory(previewItem.mime_type, previewItem.name) === 'audio'"
                    class="w-full p-8 flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-blue-50/50 to-zinc-50 rounded-lg"
                >
                    <div class="w-14 h-14 rounded-2xl bg-blue-100 text-blue-600 flex items-center justify-center shadow-xs">
                        <Music class="w-7 h-7" />
                    </div>
                    <audio v-if="previewItem.url" :src="previewItem.url" controls class="w-full max-w-md" />
                </div>
                <div
                    v-else-if="previewItem && getFileCategory(previewItem.mime_type, previewItem.name) === 'subtitle'"
                    class="py-12 text-center text-zinc-500 text-xs flex flex-col items-center gap-2"
                >
                    <div class="w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center shadow-xs">
                        <FileText class="w-6 h-6" />
                    </div>
                    <span class="font-semibold text-zinc-800">{{ previewItem.name }}</span>
                    <span class="text-zinc-400 text-xs">外挂字幕文件</span>
                </div>
                <div v-else class="py-12 text-center text-zinc-400 text-xs">
                    <FileText class="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <span>{{ previewItem?.name }}</span>
                </div>
            </div>

            <DialogFooter class="mt-4 flex items-center justify-between">
                <Button variant="outline" size="sm" @click="isPreviewOpen = false">
                    {{ $t("draft_box.cancel_btn") }}
                </Button>
                <div class="flex items-center gap-2">
                    <Button
                        v-if="previewItem"
                        size="sm"
                        variant="outline"
                        class="border-zinc-200 text-zinc-600 hover:text-red-600 hover:bg-red-50 hover:border-red-200 gap-1.5"
                        @click="
                            openSingleDeleteConfirm(previewItem);
                            isPreviewOpen = false;
                        "
                    >
                        <Trash2 class="w-3.5 h-3.5" />
                        <span>{{ $t("draft_box.delete_btn") }}</span>
                    </Button>
                    <Button
                        v-if="previewItem"
                        size="sm"
                        class="bg-zinc-900 text-white hover:bg-zinc-800 gap-1.5"
                        @click="
                            handleCommitSingle(previewItem);
                            isPreviewOpen = false;
                        "
                    >
                        <FileDown class="w-3.5 h-3.5" />
                        <span>{{ $t("draft_box.quick_import") }}</span>
                    </Button>
                </div>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
