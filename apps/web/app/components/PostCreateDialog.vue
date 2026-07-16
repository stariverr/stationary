<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useLibraryStore } from "@/stores/library";
import { useImportStore } from "@/stores/import";
import { useApi } from "@/composables/useApi";
import { toast } from "vue-sonner";
import {
    Loader2,
    Plus,
    Trash2,
    ArrowUp,
    ArrowDown,
    FileText,
    Video,
    Music,
    Edit,
    Search,
    ArrowLeft,
    GripVertical,
    MoreHorizontal,
} from "@lucide/vue";
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent, TooltipPortal } from "reka-ui";
import { getOptimizedImageUrl } from "@/utils/image";
import CreateMediaForm from "./CreateMediaForm.vue";
import TagEditor from "./TagEditor.vue";

const props = defineProps<{
    open: boolean;
}>();

const emit = defineEmits<{
    "update:open": [value: boolean];
    created: [];
}>();

import { useTagStore } from "@/stores/tag";

const libraryStore = useLibraryStore();
const importStore = useImportStore();
const tagStore = useTagStore();
const { t } = useI18n();
const libraryId = computed(() => libraryStore.activeLibraryId);

const title = ref("");
const description = ref("");
const postTagIds = ref<string[]>([]);
const isSubmitting = ref(false);
const titleInputRef = ref<HTMLInputElement | null>(null);

const postTagNames = computed(() => {
    return postTagIds.value
        .map((id) => {
            const match = tagStore.tags.find((t) => t.id === id);
            return match ? match.name : "";
        })
        .filter((name) => name.length > 0);
});

const getTagIdByName = (name: string) => {
    const match = tagStore.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    return match ? match.id : null;
};

async function handleAddTag(tagName: string) {
    let tagId = getTagIdByName(tagName);
    if (!tagId) {
        try {
            const res = await useApi<{ success: boolean; data: any }>("/tag/create", {
                method: "POST",
                body: {
                    library_id: libraryId.value,
                    name: tagName,
                },
            });
            if (res && res.success && res.data) {
                tagId = res.data.id;
                await tagStore.refetch();
            }
        } catch (e) {
            toast.error(`Failed to create tag "${tagName}"`);
            return;
        }
    }
    if (tagId && !postTagIds.value.includes(tagId)) {
        postTagIds.value.push(tagId);
    }
}

function handleRemoveTag(tagName: string) {
    const tagId = getTagIdByName(tagName);
    if (tagId) {
        postTagIds.value = postTagIds.value.filter((id) => id !== tagId);
    }
}

interface StagedItem {
    id: string; // temp ID or existing media ID
    title: string;
    type: "IMAGE" | "VIDEO" | "LIVE_PHOTO" | "AUDIO" | "PDF";
    source: "existing" | "draft";
    existingId?: string;
    draftGroup?: any; // DraftMediaGroup payload
    thumbnail?: string | null;
    preExistingDraftFileIds?: string[];
    _files?: {
        id: string;
        name: string;
        mime_type: string;
        url?: string;
    }[];
}

const stagedItems = ref<StagedItem[]>([]);
const mediaView = ref<"attached" | "library" | "upload">("attached");
const editingDraft = ref<any>(null);

// Search input for library orphans list
const searchOrphanQuery = ref("");

// Dialog for selecting existing orphan media
const orphanMediaList = ref<any[]>([]);
const isLoadingOrphans = ref(false);

// Temporary selection list for library picker
const tempSelectedMediaIds = ref<string[]>([]);

// Reset form on open/close
watch(
    () => props.open,
    (val) => {
        if (val) {
            title.value = "";
            description.value = "";
            postTagIds.value = [];
            stagedItems.value = [];
            mediaView.value = "attached";
            editingDraft.value = null;
            searchOrphanQuery.value = "";
            tempSelectedMediaIds.value = [];

            // Autofocus
            setTimeout(() => {
                titleInputRef.value?.focus();
            }, 100);
        } else {
            // Cleanup staged draft files if dialog is cancelled/closed without submitting
            if (!isSubmitting.value) {
                cleanupAllDraftFiles();
            }
        }
    },
);

function cleanupAllDraftFiles() {
    for (const item of stagedItems.value) {
        if (item.source === "draft" && item.draftGroup?.tracks) {
            for (const track of item.draftGroup.tracks) {
                const isPreExisting = item.preExistingDraftFileIds?.includes(track.draft_file_id);
                if (!isPreExisting && libraryId.value) {
                    importStore.deleteDraftFile(libraryId.value, track.draft_file_id).catch(() => undefined);
                }
            }
        }
    }
}

// Fetch active orphan media in this library
async function fetchOrphans() {
    if (!libraryId.value) return;
    isLoadingOrphans.value = true;
    try {
        const res = await useApi<{ success: boolean; data: { list: any[] } }>(
            `/media/list?library_id=${libraryId.value}&has_no_post=true&count=100`,
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

// Watch mediaView to load orphans when library view is activated
watch(mediaView, (view) => {
    if (view === "library") {
        fetchOrphans();
        // Initialize selection with currently attached library items
        tempSelectedMediaIds.value = stagedItems.value.filter((item) => item.source === "existing").map((item) => item.existingId!);
    }
});

function toggleLibrarySelection(id: string) {
    if (tempSelectedMediaIds.value.includes(id)) {
        tempSelectedMediaIds.value = tempSelectedMediaIds.value.filter((itemId) => itemId !== id);
    } else {
        tempSelectedMediaIds.value.push(id);
    }
}

function applyLibrarySelection() {
    const draftItems = stagedItems.value.filter((item) => item.source === "draft");
    const newExistingItems: StagedItem[] = tempSelectedMediaIds.value.map((id) => {
        const existing = stagedItems.value.find((item) => item.existingId === id);
        if (existing) return existing;

        const media = orphanMediaList.value.find((m) => m.id === id);
        return {
            id: id,
            title: media?.title || "Untitled Media",
            type: media?.type || "IMAGE",
            source: "existing" as const,
            existingId: id,
            thumbnail: media ? media.cover_url || media.url || null : null,
        };
    });

    stagedItems.value = [...draftItems, ...newExistingItems];
    mediaView.value = "attached";
}

function openLibraryView() {
    mediaView.value = "library";
}

const droppedFiles = ref<File[]>([]);

function handleGlobalDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (mediaView.value === "attached") {
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            droppedFiles.value = Array.from(files);
            mediaView.value = "upload";
            editingDraft.value = null;
        }
    }
}

function openUploadView() {
    editingDraft.value = null;
    droppedFiles.value = [];
    mediaView.value = "upload";
}

function getStagedItemThumbnail(item: StagedItem): string | null {
    return item.thumbnail || null;
}

function handleMediaDraftCreated(draft: any) {
    let thumbnail: string | null = null;
    const coverTrack = draft.tracks?.find((t: any) => t.purpose === "COVER");
    if (coverTrack) {
        const file = draft._files?.find((f: any) => f.id === coverTrack.draft_file_id);
        if (file?.url) thumbnail = file.url;
    }
    if (!thumbnail) {
        const firstImage = draft._files?.find((f: any) => f.mime_type.startsWith("image/"));
        if (firstImage?.url) thumbnail = firstImage.url;
    }

    const existingIndex = stagedItems.value.findIndex((item) => item.id === draft.temp_id);
    const updatedItem: StagedItem = {
        id: draft.temp_id,
        title: draft.title,
        type: draft.type,
        source: "draft",
        draftGroup: draft,
        _files: draft._files,
        thumbnail: thumbnail,
        preExistingDraftFileIds: draft.preExistingDraftFileIds || [],
    };

    if (existingIndex !== -1) {
        stagedItems.value[existingIndex] = updatedItem;
        toast.success(`Draft "${draft.title}" updated.`);
    } else {
        stagedItems.value.push(updatedItem);
        toast.success(`Draft "${draft.title}" added to post.`);
    }
    editingDraft.value = null;
    droppedFiles.value = [];
    mediaView.value = "attached";
}

function editDraftMedia(item: StagedItem) {
    editingDraft.value = item.draftGroup;
    mediaView.value = "upload";
}

// Filtered orphans list
const filteredOrphanMediaList = computed(() => {
    if (!searchOrphanQuery.value.trim()) return orphanMediaList.value;
    const query = searchOrphanQuery.value.toLowerCase().trim();
    return orphanMediaList.value.filter((media) => (media.title || "Untitled Media").toLowerCase().includes(query));
});

const isDirty = computed(() => {
    return (
        title.value.trim().length > 0 || description.value.trim().length > 0 || postTagIds.value.length > 0 || stagedItems.value.length > 0
    );
});

function handleDialogCloseAttempt(val: boolean) {
    if (val === false) {
        handleCancelAttempt();
    } else {
        emit("update:open", true);
    }
}

function handleCancelAttempt() {
    if (isDirty.value) {
        if (confirm(t("post.discard_confirm", "Are you sure you want to discard your changes?"))) {
            emit("update:open", false);
        }
    } else {
        emit("update:open", false);
    }
}

function getMediaMetadataText(item: StagedItem) {
    const typeLabel = item.type.charAt(0) + item.type.slice(1).toLowerCase().replace("_", " ");
    const sourceLabel = item.source === "existing" ? "Library" : "New";

    let filesSuffix = "";
    if (item.source === "draft") {
        const count = item._files?.length || 0;
        filesSuffix = ` · ${count} file${count !== 1 ? "s" : ""}`;
    }
    return `${typeLabel} · ${sourceLabel}${filesSuffix}`;
}

function shouldShowFilesList(item: StagedItem) {
    if (item.source !== "draft") return false;
    return (item._files?.length || 0) > 1;
}

function moveUp(idx: number) {
    if (idx === 0) return;
    const temp = stagedItems.value[idx]!;
    stagedItems.value[idx] = stagedItems.value[idx - 1]!;
    stagedItems.value[idx - 1] = temp;
}

function moveDown(idx: number) {
    if (idx === stagedItems.value.length - 1) return;
    const temp = stagedItems.value[idx]!;
    stagedItems.value[idx] = stagedItems.value[idx + 1]!;
    stagedItems.value[idx + 1] = temp;
}

function removeStagedItem(idx: number) {
    const item = stagedItems.value[idx];
    if (item && item.source === "draft" && item.draftGroup?.tracks) {
        for (const track of item.draftGroup.tracks) {
            const isPreExisting = item.preExistingDraftFileIds?.includes(track.draft_file_id);
            if (!isPreExisting && libraryId.value) {
                importStore.deleteDraftFile(libraryId.value, track.draft_file_id).catch(() => undefined);
            }
        }
    }
    stagedItems.value.splice(idx, 1);
}

// Submit Create Post request
async function handleSubmit() {
    if (!title.value.trim() || !libraryId.value) return;

    isSubmitting.value = true;

    const mediaItems = stagedItems.value.map((item) => {
        if (item.source === "existing") {
            return {
                kind: "existing" as const,
                media_id: item.existingId!,
            };
        } else {
            return {
                kind: "draft" as const,
                draft: {
                    title: item.draftGroup.title,
                    type: item.draftGroup.type,
                    tracks: item.draftGroup.tracks.map((t: any) => ({
                        draft_file_id: t.draft_file_id,
                        type: t.type,
                        purpose: t.purpose,
                        quality: t.quality,
                        is_default: t.is_default,
                        language: t.language || null,
                    })),
                },
            };
        }
    });

    try {
        const response = await useApi<{ success: boolean; data: { post_id: string } }>("/post/create", {
            method: "POST",
            body: {
                library_id: libraryId.value,
                title: title.value.trim(),
                description: description.value.trim(),
                tag_ids: postTagIds.value,
                media_items: mediaItems,
            },
        });

        if (response && response.success) {
            toast.success(t("post.toast_create_success", "Post created successfully"));
            emit("created");
            emit("update:open", false);
        }
    } catch (e: any) {
        toast.error(t("post.toast_create_failed", "Failed to create post"), {
            description: e.message || String(e),
        });
    } finally {
        isSubmitting.value = false;
    }
}
</script>

<template>
    <Dialog :open="open" @update:open="handleDialogCloseAttempt">
        <DialogContent
            class="sm:max-w-6xl w-[95vw] h-[85vh] flex flex-col p-0 gap-0 overflow-hidden bg-slate-50 dark:bg-zinc-900 border dark:border-zinc-800"
            @dragover.prevent.stop
            @dragenter.prevent.stop
            @drop="handleGlobalDrop"
        >
            <!-- Global Header -->
            <DialogHeader
                class="shrink-0 border-b border-slate-100 dark:border-zinc-800 p-4 text-left flex flex-row items-center justify-between bg-white dark:bg-zinc-950"
            >
                <div>
                    <DialogTitle class="text-lg font-bold text-slate-900 dark:text-zinc-50">{{
                        $t("post.create_title", "Create Post")
                    }}</DialogTitle>
                </div>
            </DialogHeader>

            <!-- Central Content Split -->
            <div
                class="flex-1 grid grid-cols-1 lg:grid-cols-[19rem_1fr] divide-y lg:divide-y-0 lg:divide-x border-b border-slate-100 dark:border-zinc-800 dark:divide-zinc-800 overflow-hidden"
            >
                <!-- Left Column: Post Form -->
                <div
                    class="flex flex-col h-full overflow-hidden p-5 bg-white dark:bg-zinc-950 border-r border-slate-100 dark:border-zinc-800"
                >
                    <div class="flex-1 overflow-y-auto space-y-5 pr-1 min-h-0 text-sm pb-32">
                        <div class="space-y-1.5">
                            <Label for="post-title" class="text-xs font-semibold text-slate-700 dark:text-zinc-300">{{
                                $t("post.title_label", "Title")
                            }}</Label>
                            <Input
                                id="post-title"
                                ref="titleInputRef"
                                v-model="title"
                                :placeholder="$t('post.title_placeholder', 'Enter post title')"
                                :disabled="isSubmitting"
                                class="text-sm placeholder:text-slate-400 dark:placeholder:text-zinc-500 text-slate-800 dark:text-zinc-100 focus:bg-white dark:focus:bg-zinc-950 focus:border-slate-350"
                            />
                        </div>

                        <div class="space-y-1.5">
                            <Label for="post-description" class="text-xs font-semibold text-slate-700 dark:text-zinc-300">{{
                                $t("post.description_label", "Description")
                            }}</Label>
                            <Textarea
                                id="post-description"
                                v-model="description"
                                :placeholder="$t('post.description_placeholder', 'Write something about this post...')"
                                :disabled="isSubmitting"
                                rows="8"
                                class="resize-none text-sm placeholder:text-slate-400 dark:placeholder:text-zinc-500 text-slate-800 dark:text-zinc-100 focus:bg-white dark:focus:bg-zinc-950"
                            />
                        </div>

                        <!-- Tags -->
                        <div class="space-y-1.5">
                            <Label class="text-xs font-semibold text-slate-700 dark:text-zinc-300">{{
                                $t("post.tags_label", "Tags")
                            }}</Label>
                            <TagEditor :tags="postTagNames" @add-tag="handleAddTag" @remove-tag="handleRemoveTag" />
                        </div>
                    </div>
                </div>

                <!-- Right Column: Media Workspace -->
                <div class="flex flex-col h-full overflow-hidden bg-white dark:bg-zinc-950">
                    <!-- Navigation Header for Right Column -->
                    <div
                        class="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 shrink-0 px-5 py-4 bg-white dark:bg-zinc-950"
                    >
                        <!-- Attached View Title & Actions -->
                        <template v-if="mediaView === 'attached'">
                            <span class="text-sm font-bold text-slate-800 dark:text-zinc-200">
                                {{ $t("post.media_label", "Media") }} ({{ stagedItems.length }})
                            </span>
                            <div v-if="stagedItems.length > 0" class="flex items-center gap-1.5">
                                <DropdownMenu>
                                    <DropdownMenuTrigger as-child>
                                        <Button variant="outline" size="sm" class="h-8 text-xs gap-1.5 px-3">
                                            <Plus class="w-4 h-4" />
                                            <span>{{ $t("post.add_media", "Add Media") }}</span>
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" :side-offset="6" class="w-48 z-[350]">
                                        <DropdownMenuItem class="cursor-pointer gap-2 py-2" @click="openLibraryView">
                                            <Search class="w-4 h-4 text-slate-500 dark:text-zinc-400" />
                                            <span>{{ $t("post.choose_library", "Choose from Library") }}</span>
                                        </DropdownMenuItem>
                                        <DropdownMenuItem class="cursor-pointer gap-2 py-2" @click="openUploadView">
                                            <Plus class="w-4 h-4 text-slate-500 dark:text-zinc-400" />
                                            <span>{{ $t("post.upload_media", "Upload New Media") }}</span>
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </template>

                        <!-- Library View Title -->
                        <template v-else-if="mediaView === 'library'">
                            <div class="flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    class="w-7 h-7 -ml-1 text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                                    @click="mediaView = 'attached'"
                                >
                                    <ArrowLeft class="w-4.5 h-4.5" />
                                </Button>
                                <span class="text-sm font-bold text-slate-800 dark:text-zinc-200">
                                    {{ $t("post.choose_library", "Choose from Library") }}
                                </span>
                            </div>
                        </template>

                        <!-- Upload View Title -->
                        <template v-else-if="mediaView === 'upload'">
                            <div class="flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    class="w-7 h-7 -ml-1 text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                                    @click="
                                        mediaView = 'attached';
                                        editingDraft = null;
                                    "
                                >
                                    <ArrowLeft class="w-4.5 h-4.5" />
                                </Button>
                                <span class="text-sm font-bold text-slate-800 dark:text-zinc-200">
                                    {{ editingDraft ? $t("post.edit_media", "Edit Media") : $t("post.new_media", "New Media") }}
                                </span>
                            </div>
                        </template>
                    </div>

                    <!-- View 1: Attached Media List -->
                    <div v-if="mediaView === 'attached'" class="flex-1 overflow-y-auto p-5 space-y-2.5 min-h-0">
                        <!-- Compact Empty State -->
                        <div
                            v-if="stagedItems.length === 0"
                            class="flex flex-col items-center justify-center h-full text-slate-500 dark:text-zinc-400 py-12"
                        >
                            <div class="p-3 bg-slate-50 dark:bg-zinc-900 rounded-full mb-3">
                                <FileText class="w-7 h-7 text-slate-400 dark:text-zinc-650" />
                            </div>
                            <span class="text-sm font-semibold text-slate-700 dark:text-zinc-300">{{
                                $t("post.no_media", "No media assets attached yet.")
                            }}</span>
                            <span class="text-xs text-slate-500 dark:text-zinc-400 mt-1 text-center">{{
                                $t("post.select_source", "Select from library or upload new files.")
                            }}</span>
                            <div class="flex gap-2 mt-4">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    class="h-8 text-xs gap-1.5 text-slate-700 dark:text-zinc-300"
                                    @click="openLibraryView"
                                >
                                    <Search class="w-3.5 h-3.5 text-slate-500 dark:text-zinc-450" />
                                    {{ $t("post.choose_library", "Choose from Library") }}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    class="h-8 text-xs gap-1.5 text-slate-700 dark:text-zinc-300"
                                    @click="openUploadView"
                                >
                                    <Plus class="w-3.5 h-3.5 text-slate-500 dark:text-zinc-450" />
                                    {{ $t("post.upload_media", "Upload New Media") }}
                                </Button>
                            </div>
                        </div>

                        <!-- Staged Items list -->
                        <div v-else>
                            <div
                                class="border border-slate-100 dark:border-zinc-800 rounded-xl overflow-hidden divide-y divide-slate-100 dark:divide-zinc-800 bg-white dark:bg-zinc-950"
                            >
                                <div
                                    v-for="(item, idx) in stagedItems"
                                    :key="item.id"
                                    class="flex flex-col p-4 hover:bg-slate-50/40 dark:hover:bg-zinc-900/10 transition-colors bg-white dark:bg-zinc-950"
                                >
                                    <div class="flex items-center justify-between">
                                        <div class="flex items-center gap-3.5 truncate pr-4">
                                            <!-- Drag Handle -->
                                            <GripVertical class="w-4 h-4 text-slate-300 dark:text-zinc-600 shrink-0 cursor-grab" />

                                            <!-- Media Thumbnail -->
                                            <div
                                                class="shrink-0 w-11 h-11 bg-slate-100 dark:bg-zinc-900 border dark:border-zinc-800/80 rounded-lg overflow-hidden flex items-center justify-center"
                                            >
                                                <img
                                                    v-if="getStagedItemThumbnail(item)"
                                                    :src="
                                                        getOptimizedImageUrl(getStagedItemThumbnail(item)!, {
                                                            width: 96,
                                                            height: 96,
                                                            fit: 'cover',
                                                        })
                                                    "
                                                    class="w-full h-full object-cover"
                                                />
                                                <Video
                                                    v-else-if="item.type === 'VIDEO'"
                                                    class="w-4.5 h-4.5 text-slate-400 dark:text-zinc-500"
                                                />
                                                <Music
                                                    v-else-if="item.type === 'AUDIO'"
                                                    class="w-4.5 h-4.5 text-slate-400 dark:text-zinc-500"
                                                />
                                                <FileText v-else class="w-4.5 h-4.5 text-slate-400 dark:text-zinc-500" />
                                            </div>
                                            <div class="min-w-0">
                                                <div class="text-sm font-semibold text-slate-800 dark:text-zinc-100 truncate">
                                                    {{ item.title }}
                                                </div>
                                                <div class="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                                                    {{ getMediaMetadataText(item) }}
                                                </div>
                                            </div>
                                        </div>

                                        <!-- Staged Item Action Dropdowns -->
                                        <div class="flex items-center gap-1.5 shrink-0">
                                            <!-- Edit Draft Button -->
                                            <Button
                                                v-if="item.source === 'draft'"
                                                size="icon"
                                                variant="ghost"
                                                class="w-8 h-8 text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                                                aria-label="Edit Media"
                                                @click="editDraftMedia(item)"
                                            >
                                                <Edit class="w-4 h-4" />
                                            </Button>

                                            <!-- Dropdown Menu for More Actions -->
                                            <DropdownMenu>
                                                <DropdownMenuTrigger as-child>
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        class="w-8 h-8 text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                                                        aria-label="More actions"
                                                    >
                                                        <MoreHorizontal class="w-4 h-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" class="w-40 z-[350]">
                                                    <DropdownMenuItem
                                                        :disabled="idx === 0"
                                                        class="cursor-pointer gap-2 py-2"
                                                        @click="moveUp(idx)"
                                                    >
                                                        <ArrowUp class="w-4 h-4 text-slate-500 dark:text-zinc-400" />
                                                        <span>{{ $t("post.move_up", "Move Up") }}</span>
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem
                                                        :disabled="idx === stagedItems.length - 1"
                                                        class="cursor-pointer gap-2 py-2"
                                                        @click="moveDown(idx)"
                                                    >
                                                        <ArrowDown class="w-4 h-4 text-slate-500 dark:text-zinc-400" />
                                                        <span>{{ $t("post.move_down", "Move Down") }}</span>
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        class="cursor-pointer gap-2 py-2 text-red-600 focus:text-red-655 focus:bg-red-50 dark:focus:bg-red-950/20"
                                                        @click="removeStagedItem(idx)"
                                                    >
                                                        <Trash2 class="w-4 h-4" />
                                                        <span>{{ $t("post.remove", "Remove") }}</span>
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>
                                    </div>

                                    <!-- Inline Draft Files List (Only shown if multiple files exist) -->
                                    <div
                                        v-if="shouldShowFilesList(item)"
                                        class="mt-3 pl-16 border-l border-slate-100 dark:border-zinc-800 space-y-2"
                                    >
                                        <div
                                            v-for="file in item._files"
                                            :key="file.id"
                                            class="flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-400"
                                        >
                                            <span class="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-zinc-700 shrink-0"></span>
                                            <span class="truncate max-w-[240px] font-medium" :title="file.name">{{ file.name }}</span>
                                            <span class="text-[10px] text-slate-400 dark:text-zinc-500 truncate ml-1"
                                                >({{ file.mime_type }})</span
                                            >
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Dashed add action bar for direct quick access -->
                            <div
                                class="mt-4 flex flex-col items-center justify-center gap-3 py-6 border border-dashed border-slate-200 dark:border-zinc-800 rounded-xl bg-slate-50/10 dark:bg-zinc-900/5 hover:bg-slate-50/30 dark:hover:bg-zinc-900/10 transition-colors"
                            >
                                <span class="text-xs text-slate-500 dark:text-zinc-400 font-medium">
                                    {{ $t("post.drag_or_choose", "Drag files here or choose an option below:") }}
                                </span>
                                <div class="flex items-center gap-2.5">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        class="h-8 text-xs gap-1.5 text-slate-700 dark:text-zinc-300 px-3 hover:bg-slate-100 dark:hover:bg-zinc-900 cursor-pointer"
                                        @click="openLibraryView"
                                    >
                                        <Search class="w-3.5 h-3.5 text-slate-550 dark:text-zinc-400" />
                                        {{ $t("post.choose_library", "Choose from Library") }}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        class="h-8 text-xs gap-1.5 text-slate-700 dark:text-zinc-300 px-3 hover:bg-slate-100 dark:hover:bg-zinc-900 cursor-pointer"
                                        @click="openUploadView"
                                    >
                                        <Plus class="w-3.5 h-3.5 text-slate-550 dark:text-zinc-400" />
                                        {{ $t("post.upload_media", "Upload New Media") }}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- View 2: Link Orphan Media from Library (Deferred confirm) -->
                    <div v-else-if="mediaView === 'library'" class="flex flex-col h-full overflow-hidden min-h-0">
                        <!-- Search Bar -->
                        <div class="shrink-0 p-3 border-b border-slate-100 dark:border-zinc-800 bg-slate-50/20 dark:bg-zinc-900/10">
                            <div class="relative">
                                <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400 dark:text-zinc-500" />
                                <Input v-model="searchOrphanQuery" :placeholder="$t('media.search_placeholder')" class="pl-9 h-9 text-xs" />
                            </div>
                        </div>

                        <!-- Scrollable list of orphan media -->
                        <div class="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
                            <div v-if="isLoadingOrphans" class="flex justify-center py-12">
                                <Loader2 class="w-8 h-8 animate-spin text-slate-400" />
                            </div>
                            <div v-else-if="filteredOrphanMediaList.length === 0" class="text-center text-slate-400 text-xs py-12">
                                {{ $t("media.no_orphan_found") }}
                            </div>
                            <div
                                v-else
                                v-for="media in filteredOrphanMediaList"
                                :key="media.id"
                                class="flex items-center gap-3 p-2.5 hover:bg-slate-50 dark:hover:bg-zinc-900/30 border dark:border-zinc-800 rounded-lg cursor-pointer transition-colors bg-white dark:bg-zinc-950"
                                @click="toggleLibrarySelection(media.id)"
                            >
                                <Checkbox
                                    :checked="tempSelectedMediaIds.includes(media.id)"
                                    @click.stop="toggleLibrarySelection(media.id)"
                                />
                                <!-- Media Thumbnail -->
                                <div
                                    class="shrink-0 w-10 h-10 bg-slate-100 dark:bg-zinc-900 border dark:border-zinc-800 rounded overflow-hidden flex items-center justify-center"
                                >
                                    <img
                                        v-if="media.cover_url || (media.type === 'IMAGE' && media.url)"
                                        :src="getOptimizedImageUrl(media.cover_url || media.url, { width: 80, height: 80, fit: 'cover' })"
                                        class="w-full h-full object-cover"
                                    />
                                    <Video v-else-if="media.type === 'VIDEO'" class="w-4 h-4 text-slate-400 dark:text-zinc-500" />
                                    <Music v-else-if="media.type === 'AUDIO'" class="w-4 h-4 text-slate-400 dark:text-zinc-500" />
                                    <FileText v-else class="w-4 h-4 text-slate-400 dark:text-zinc-500" />
                                </div>
                                <div class="flex-1 truncate text-xs">
                                    <div class="font-semibold text-slate-700 dark:text-zinc-200 truncate">
                                        {{ media.title || $t("media.untitled") }}
                                    </div>
                                    <div class="text-[10px] text-slate-400 mt-0.5">
                                        {{ media.type }} • {{ $t("media.tracks_count", { count: media.tracks?.length || 0 }) }}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Sub-view Footer inside the right panel -->
                        <div
                            class="shrink-0 border-t border-slate-100 dark:border-zinc-800 p-4 flex justify-end gap-2 bg-slate-50/50 dark:bg-zinc-900/10"
                        >
                            <Button
                                variant="outline"
                                size="sm"
                                class="h-9 px-4 text-xs text-slate-700 dark:text-zinc-300"
                                @click="mediaView = 'attached'"
                            >
                                {{ $t("post.back_btn", "Back") }}
                            </Button>
                            <Button size="sm" class="h-9 px-4 text-xs" @click="applyLibrarySelection">
                                {{ $t("post.add_n_media", { count: tempSelectedMediaIds.length }) }}
                            </Button>
                        </div>
                    </div>

                    <!-- View 3: Create / Edit Media Draft Form -->
                    <div v-else-if="mediaView === 'upload'" class="flex flex-col h-full overflow-hidden min-h-0">
                        <CreateMediaForm
                            mode="draft"
                            :initialDraft="editingDraft"
                            :initialFiles="droppedFiles"
                            @draft-created="handleMediaDraftCreated"
                            @cancel="
                                mediaView = 'attached';
                                editingDraft = null;
                                droppedFiles = [];
                            "
                        />
                    </div>
                </div>
            </div>

            <!-- 3. Global Footer (Only visible when right column is in 'attached' list view) -->
            <div
                v-if="mediaView === 'attached'"
                class="shrink-0 border-t border-slate-100 dark:border-zinc-800 p-4 flex justify-end gap-2 bg-slate-50 dark:bg-zinc-900/10"
            >
                <Button variant="outline" :disabled="isSubmitting" @click="handleCancelAttempt">
                    {{ $t("post.cancel_btn", "Cancel") }}
                </Button>
                <Button :disabled="!title.trim() || isSubmitting" @click="handleSubmit">
                    <Loader2 v-if="isSubmitting" class="w-4 h-4 animate-spin" />
                    {{ isSubmitting ? $t("post.creating", "Creating...") : $t("post.create_btn", "Create Post") }}
                </Button>
            </div>
        </DialogContent>
    </Dialog>
</template>
