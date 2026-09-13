<script setup lang="ts">
import { ref, computed } from "vue";
import { useTrashStore, type TrashItem, type TrashType } from "@/stores/trash";
import { useLibraryStore } from "@/stores/library";
import {
    Trash2,
    RotateCcw,
    Search,
    AlertTriangle,
    Layers,
    FileText,
    Image as ImageIcon,
    Video,
    Music,
    FileCode,
    CheckSquare,
    Square,
    Loader2,
    Inbox,
    X,
    LayoutGrid,
    List,
    SlidersHorizontal,
    Check,
    Sidebar,
    Eye,
} from "@lucide/vue";
import TrashPostPreviewDialog from "@/components/TrashPostPreviewDialog.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useAppLayout } from "@/composables/useAppLayout";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PaginationRoot, PaginationList, PaginationListItem, PaginationPrev, PaginationNext, PaginationEllipsis } from "reka-ui";
import { toast } from "vue-sonner";
import { Temporal } from "@js-temporal/polyfill";
import { getMediaTypeLabel } from "@/utils/media";

const { t, te, locale } = useI18n();
const trashStore = useTrashStore();
const libraryStore = useLibraryStore();
const { toggleSidebar, isSidebarCollapsed } = useAppLayout();

const formatTrashItemType = (item: TrashItem): string => {
    if (item.item_type === "post") {
        return t("trash.item_type.post");
    }
    const typeKey = item.type?.toLowerCase();
    const key = `trash.item_type.${typeKey}`;
    if (te(key)) {
        return t(key);
    }
    return getMediaTypeLabel(item.type, t);
};

const formatSource = (source?: string | null): string => {
    if (!source) return "";
    const key = `platforms.${source}`;
    return te(key) ? t(key) : source;
};

const getItemTitle = (item: TrashItem | null): string => {
    if (!item) return "";
    const title = item.title?.trim();
    if (title && title.toLowerCase() !== "untitled") return title;
    const desc = item.description?.trim();
    if (desc) return desc;
    return item.item_type === "post" ? t("trash.untitled_post") : t("trash.untitled_media");
};

const formatRecycleTime = (isoString: string | null | undefined): string => {
    if (!isoString) return "";
    try {
        return Temporal.Instant.from(isoString).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(locale.value, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    } catch {
        return isoString;
    }
};

// View Mode: grid or table
const viewMode = ref<"grid" | "table">("grid");

// Modal States
const isSingleDeleteOpen = ref(false);
const singleDeleteItem = ref<TrashItem | null>(null);

const isBatchDeleteOpen = ref(false);
const isEmptyTrashOpen = ref(false);

const isPreviewOpen = ref(false);
const previewItem = ref<TrashItem | null>(null);

const isActionLoading = ref(false);

const openPreview = (item: TrashItem) => {
    previewItem.value = item;
    isPreviewOpen.value = true;
};

const handlePreviewRestore = async (item: TrashItem) => {
    await handleSingleRestore(item);
    isPreviewOpen.value = false;
    previewItem.value = null;
};

const handlePreviewDelete = (item: TrashItem) => {
    openSingleDeleteModal(item);
};

const tabs: Array<{ key: TrashType; label: string }> = [
    { key: "all", label: "trash.tabs.all" },
    { key: "post", label: "trash.tabs.posts" },
    { key: "media", label: "trash.tabs.media" },
];

const activeLibrary = computed(() => libraryStore.activeLibrary);
const subtitleText = computed(() => {
    const libName = activeLibrary.value?.name;
    if (!libName || libName === "Default Library") {
        return "";
    }
    return libName;
});

const totalPages = computed(() => Math.ceil((trashStore.total || 0) / (trashStore.count || 20)));

const getItemCover = (item: TrashItem): string | null => {
    if (item.item_type === "post") {
        return item.covers?.[0]?.thumbnail || item.covers?.[0]?.url || null;
    }
    return item.covers?.[0]?.thumbnail || item.covers?.[0]?.url || item.url || null;
};

// Single Item Actions
const handleSingleRestore = async (item: TrashItem) => {
    isActionLoading.value = true;
    try {
        const res = await trashStore.restoreSingle(item);
        if (res && res.success) {
            toast.success(t("trash.toasts.restore_success"));
        } else {
            throw new Error();
        }
    } catch {
        toast.error(t("trash.toasts.restore_failed"));
    } finally {
        isActionLoading.value = false;
    }
};

const openSingleDeleteModal = (item: TrashItem) => {
    singleDeleteItem.value = item;
    isSingleDeleteOpen.value = true;
};

const confirmSingleDelete = async () => {
    if (!singleDeleteItem.value) return;
    isActionLoading.value = true;
    try {
        const deletedId = singleDeleteItem.value.id;
        const res = await trashStore.deleteSingle(singleDeleteItem.value);
        if (res && res.success) {
            toast.success(t("trash.toasts.delete_success"));
            if (previewItem.value?.id === deletedId) {
                isPreviewOpen.value = false;
                previewItem.value = null;
            }
            isSingleDeleteOpen.value = false;
            singleDeleteItem.value = null;
        } else {
            throw new Error();
        }
    } catch {
        toast.error(t("trash.toasts.delete_failed"));
    } finally {
        isActionLoading.value = false;
    }
};

// Batch Actions
const handleBatchRestore = async () => {
    if (trashStore.selectedItemsCount === 0) return;
    isActionLoading.value = true;
    try {
        const res = await trashStore.restoreSelected();
        if (res && res.success) {
            toast.success(t("trash.toasts.restore_success"));
        } else {
            throw new Error();
        }
    } catch {
        toast.error(t("trash.toasts.restore_failed"));
    } finally {
        isActionLoading.value = false;
    }
};

const confirmBatchDelete = async () => {
    if (trashStore.selectedItemsCount === 0) return;
    isActionLoading.value = true;
    try {
        const res = await trashStore.deleteSelected();
        if (res && res.success) {
            toast.success(t("trash.toasts.delete_success"));
            isBatchDeleteOpen.value = false;
        } else {
            throw new Error();
        }
    } catch {
        toast.error(t("trash.toasts.delete_failed"));
    } finally {
        isActionLoading.value = false;
    }
};

// Empty Trash
const confirmEmptyTrash = async () => {
    isActionLoading.value = true;
    try {
        const res = await trashStore.emptyTrash();
        if (res && res.success) {
            toast.success(t("trash.toasts.empty_success"));
            isEmptyTrashOpen.value = false;
        } else {
            throw new Error();
        }
    } catch {
        toast.error(t("trash.toasts.empty_failed"));
    } finally {
        isActionLoading.value = false;
    }
};
</script>

<template>
    <div class="h-full flex flex-col bg-white select-none overflow-hidden">
        <!-- Top Clean Header (Strictly matching tags.vue header) -->
        <header class="h-14 border-b border-zinc-200/80 px-4 md:px-6 shrink-0 flex items-center justify-between gap-3 md:gap-4 bg-white">
            <!-- Left: Title & Subtitle -->
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
                <div>
                    <h1 class="text-sm font-bold tracking-tight text-zinc-900 leading-none">
                        {{ $t("trash.title") }}
                    </h1>
                    <span v-if="subtitleText" class="text-xs text-zinc-500 font-semibold flex items-center gap-1.5 mt-1.5">
                        <SlidersHorizontal class="w-3 h-3 text-zinc-400" />
                        <span>{{ subtitleText }}</span>
                    </span>
                </div>
            </div>

            <!-- Right: Search bar & Empty Trash button -->
            <div class="flex items-center gap-2.5 sm:gap-3 w-full sm:w-auto justify-between sm:justify-start">
                <div class="relative w-full sm:w-64">
                    <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                    <Input
                        v-model="trashStore.keyword"
                        type="text"
                        :aria-label="$t('trash.search_placeholder')"
                        :placeholder="$t('trash.search_placeholder')"
                        class="pl-8 pr-7 h-9 w-full bg-zinc-50 hover:bg-zinc-100/50 focus:bg-white text-xs rounded-lg border border-zinc-200 focus:ring-1 focus:ring-zinc-950 transition-all duration-200 placeholder-zinc-500 text-zinc-800"
                    />
                    <button
                        v-if="trashStore.keyword"
                        @click="trashStore.keyword = ''"
                        class="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 transition-colors cursor-pointer"
                    >
                        <X class="w-3.5 h-3.5" />
                    </button>
                </div>

                <Button
                    @click="isEmptyTrashOpen = true"
                    :disabled="trashStore.total === 0 || isActionLoading"
                    class="h-9 gap-1.5 px-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold text-xs cursor-pointer shadow-xs transition-colors duration-200 shrink-0 active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none"
                >
                    <Trash2 class="w-3.5 h-3.5" />
                    <span>{{ $t("trash.actions.empty_trash") }}</span>
                </Button>
            </div>
        </header>

        <!-- Main Workplace (Seamless Split-Pane) -->
        <div class="flex-1 flex flex-col min-w-0 min-h-0 bg-white relative overflow-hidden">
            <!-- Unified Card Toolbar Strip -->
            <div
                class="px-4 md:px-6 py-2.5 sm:py-0 border-b border-zinc-200/80 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 sm:h-12 shrink-0 select-none"
            >
                <!-- Left: Underline Tab triggers -->
                <div class="h-10 sm:h-full flex items-center gap-4 md:gap-6 w-full sm:w-auto">
                    <button
                        v-for="tab in tabs"
                        :key="tab.key"
                        role="tab"
                        :aria-selected="trashStore.activeTab === tab.key"
                        class="relative h-full px-1 text-xs sm:text-sm font-bold tracking-tight transition-colors duration-150 cursor-pointer flex items-center gap-1.5 pb-0 pt-0"
                        :class="trashStore.activeTab === tab.key ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-700'"
                        @click="trashStore.activeTab = tab.key"
                    >
                        <span>{{ $t(tab.label) }}</span>
                        <span
                            v-if="trashStore.activeTab === tab.key && trashStore.total !== undefined"
                            class="text-xs sm:text-xs font-bold px-1.5 py-0.5 rounded-full tabular-nums bg-zinc-200 text-zinc-800 transition-colors"
                        >
                            {{ trashStore.total }}
                        </span>
                        <!-- Bottom Indicator Line -->
                        <div v-if="trashStore.activeTab === tab.key" class="absolute bottom-0 inset-x-0 h-[2px] bg-zinc-800 rounded-full" />
                    </button>
                </div>

                <!-- Right: Select All & View Switcher -->
                <div class="flex items-center justify-between sm:justify-end gap-3 sm:gap-4 text-xs font-semibold w-full sm:w-auto">
                    <!-- Select All Checkbox -->
                    <div
                        v-if="trashStore.items.length > 0"
                        class="flex items-center gap-2 select-none cursor-pointer group"
                        @click="trashStore.areAllVisibleSelected ? trashStore.deselectAll() : trashStore.selectAllVisible()"
                    >
                        <Checkbox
                            :model-value="trashStore.areAllVisibleSelected"
                            class="w-4 h-4 text-zinc-950 focus-visible:ring-zinc-950 pointer-events-none"
                        />
                        <span class="text-xs sm:text-sm font-medium text-zinc-500 group-hover:text-zinc-800 transition-colors">
                            {{ trashStore.areAllVisibleSelected ? $t("trash.actions.deselect_all") : $t("trash.actions.select_all") }}
                        </span>
                    </div>

                    <div v-if="trashStore.selectedItemsCount > 0" class="h-3.5 w-[1px] bg-zinc-200" />

                    <!-- Batch Action Button -->
                    <div v-if="trashStore.selectedItemsCount > 0" class="flex items-center gap-1.5">
                        <Button
                            @click="handleBatchRestore"
                            variant="outline"
                            :disabled="isActionLoading"
                            class="h-8 gap-1.5 px-2.5 border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-700 font-bold text-xs cursor-pointer shadow-xs rounded-lg"
                        >
                            <RotateCcw class="w-3.5 h-3.5 text-zinc-500" />
                            <span>{{ $t("trash.actions.batch_restore") }} ({{ trashStore.selectedItemsCount }})</span>
                        </Button>
                        <Button
                            @click="isBatchDeleteOpen = true"
                            variant="destructive"
                            :disabled="isActionLoading"
                            class="h-8 gap-1.5 px-2.5 font-bold text-xs cursor-pointer shadow-xs rounded-lg"
                        >
                            <Trash2 class="w-3.5 h-3.5" />
                            <span>{{ $t("trash.actions.batch_delete") }}</span>
                        </Button>
                    </div>

                    <div class="h-3.5 w-[1px] bg-zinc-200" />

                    <!-- View Switcher (Grid vs Table) -->
                    <div class="flex items-center bg-zinc-100 p-0.5 rounded-lg border border-zinc-200/60">
                        <button
                            class="p-1.5 rounded-md text-xs transition-colors cursor-pointer"
                            :class="viewMode === 'grid' ? 'bg-white text-zinc-900 shadow-xs' : 'text-zinc-500 hover:text-zinc-800'"
                            :title="$t('trash.views.grid')"
                            @click="viewMode = 'grid'"
                        >
                            <LayoutGrid class="w-3.5 h-3.5" />
                        </button>
                        <button
                            class="p-1.5 rounded-md text-xs transition-colors cursor-pointer"
                            :class="viewMode === 'table' ? 'bg-white text-zinc-900 shadow-xs' : 'text-zinc-500 hover:text-zinc-800'"
                            :title="$t('trash.views.table')"
                            @click="viewMode = 'table'"
                        >
                            <List class="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            </div>

            <!-- Main Scroll Content Area -->
            <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 bg-white">
                <!-- Loading Skeletons -->
                <div v-if="trashStore.isLoading" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                    <div
                        v-for="i in 10"
                        :key="i"
                        class="bg-white rounded-xl p-2.5 border border-zinc-200/70 shadow-xs flex flex-col gap-2.5 animate-pulse"
                    >
                        <div class="aspect-4/3 bg-zinc-100 rounded-lg w-full" />
                        <div class="space-y-2 mt-1">
                            <div class="h-3.5 bg-zinc-100 rounded-sm w-3/4" />
                            <div class="h-3 bg-zinc-100 rounded-sm w-1/2" />
                        </div>
                    </div>
                </div>

                <!-- Empty State -->
                <div
                    v-else-if="trashStore.items.length === 0"
                    class="h-full min-h-[360px] flex flex-col items-center justify-center p-8 text-center"
                >
                    <div
                        class="w-12 h-12 rounded-xl bg-zinc-50 border border-zinc-200 shadow-xs flex items-center justify-center text-zinc-400 mb-3"
                    >
                        <Inbox class="w-6 h-6 stroke-[1.5] text-zinc-400" aria-hidden="true" />
                    </div>
                    <h2 class="text-sm font-semibold text-zinc-800 tracking-tight">
                        {{ $t("trash.empty_state.title") }}
                    </h2>
                    <p class="text-xs text-zinc-500 mt-1 max-w-xs leading-relaxed">
                        {{ $t("trash.empty_state.desc") }}
                    </p>
                </div>

                <!-- View 1: Grid View -->
                <div
                    v-else-if="viewMode === 'grid'"
                    class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4"
                >
                    <ContextMenu v-for="item in trashStore.items" :key="item.id">
                        <ContextMenuTrigger as-child>
                            <div
                                class="group relative bg-white rounded-xl p-2.5 border border-zinc-200/70 shadow-xs hover:shadow-sm hover:border-zinc-300 transition-all duration-200 flex flex-col justify-between cursor-pointer"
                                :class="
                                    trashStore.selectedItemIds.has(item.id) ? 'ring-2 ring-zinc-900 border-transparent bg-zinc-50/40' : ''
                                "
                                @click="openPreview(item)"
                            >
                                <!-- Checkbox Overlay -->
                                <div
                                    class="absolute top-4 left-4 z-20 transition-opacity"
                                    :class="trashStore.selectedItemIds.has(item.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                                    @click.stop
                                >
                                    <Checkbox
                                        :model-value="trashStore.selectedItemIds.has(item.id)"
                                        :aria-label="$t('trash.actions.select_item', { name: getItemTitle(item) })"
                                        class="size-4.5 border-white/90 bg-white/95 shadow-sm data-[state=checked]:bg-zinc-900 data-[state=checked]:border-zinc-900 rounded-sm"
                                        @update:model-value="trashStore.toggleSelectItem(item.id)"
                                    />
                                </div>

                                <!-- Hover Quick Actions (Top Right) -->
                                <div
                                    class="absolute top-4 right-4 z-20 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                                    @click.stop
                                >
                                    <button
                                        type="button"
                                        class="w-6.5 h-6.5 rounded-md bg-white/95 hover:bg-white text-zinc-700 hover:text-zinc-950 shadow-xs border border-zinc-200 flex items-center justify-center cursor-pointer transition-colors active:scale-95"
                                        :title="$t('trash.actions.preview')"
                                        @click="openPreview(item)"
                                    >
                                        <Eye class="w-3 h-3 text-zinc-600" />
                                    </button>
                                    <button
                                        type="button"
                                        class="w-6.5 h-6.5 rounded-md bg-white/95 hover:bg-white text-zinc-700 hover:text-zinc-950 shadow-xs border border-zinc-200 flex items-center justify-center cursor-pointer transition-colors active:scale-95"
                                        :title="$t('trash.actions.restore')"
                                        :disabled="isActionLoading"
                                        @click="handleSingleRestore(item)"
                                    >
                                        <RotateCcw class="w-3 h-3 text-zinc-600" />
                                    </button>
                                    <button
                                        type="button"
                                        class="w-6.5 h-6.5 rounded-md bg-white/95 hover:bg-white text-red-600 hover:text-red-700 shadow-xs border border-zinc-200 flex items-center justify-center cursor-pointer transition-colors active:scale-95"
                                        :title="$t('trash.actions.permanent_delete')"
                                        :disabled="isActionLoading"
                                        @click="openSingleDeleteModal(item)"
                                    >
                                        <Trash2 class="w-3 h-3 text-red-600" />
                                    </button>
                                </div>

                                <!-- Preview Image / Poster Container -->
                                <div class="relative aspect-4/3 rounded-lg overflow-hidden bg-zinc-100 ring-1 ring-black/5 shrink-0">
                                    <img
                                        v-if="getItemCover(item)"
                                        :src="getItemCover(item)!"
                                        :alt="getItemTitle(item)"
                                        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                        loading="lazy"
                                    />
                                    <div v-else class="w-full h-full flex items-center justify-center text-zinc-300">
                                        <FileText v-if="item.item_type === 'post'" class="w-8 h-8" />
                                        <ImageIcon v-else-if="item.type === 'IMAGE'" class="w-8 h-8" />
                                        <Video v-else class="w-8 h-8" />
                                    </div>

                                    <!-- Badge overlay -->
                                    <div
                                        class="absolute top-1.5 right-1.5 flex items-center gap-1 z-10 pointer-events-none group-hover:opacity-0 transition-opacity"
                                    >
                                        <span
                                            v-if="item.item_type === 'post' && item.media_count > 1"
                                            class="bg-black/60 text-white text-xs font-medium px-1.5 py-0.5 rounded-sm flex items-center gap-1 backdrop-blur-sm shadow-xs tabular-nums"
                                        >
                                            <Layers class="w-3 h-3" />
                                            <span>{{ item.media_count }}</span>
                                        </span>

                                        <span
                                            class="text-xs font-medium px-1.5 py-0.5 rounded-sm backdrop-blur-md shadow-xs border"
                                            :class="
                                                item.item_type === 'post'
                                                    ? 'bg-amber-50/90 text-amber-800 border-amber-200/60'
                                                    : item.type === 'VIDEO'
                                                      ? 'bg-purple-50/90 text-purple-800 border-purple-200/60'
                                                      : item.type === 'AUDIO'
                                                        ? 'bg-emerald-50/90 text-emerald-800 border-emerald-200/60'
                                                        : 'bg-blue-50/90 text-blue-800 border-blue-200/60'
                                            "
                                        >
                                            {{ formatTrashItemType(item) }}
                                        </span>
                                    </div>
                                </div>

                                <!-- Card Info -->
                                <div class="flex flex-col mt-2.5 mb-0.5 px-0.5 flex-1 justify-between">
                                    <div>
                                        <h2
                                            class="text-xs font-semibold text-zinc-800 line-clamp-1 group-hover:text-zinc-950 transition-colors"
                                        >
                                            {{ getItemTitle(item) }}
                                        </h2>

                                        <div class="flex items-center gap-1.5 mt-1 text-xs text-zinc-400">
                                            <span
                                                v-if="item.item_type === 'post' && item.author_name"
                                                class="font-medium text-zinc-500 truncate max-w-[120px]"
                                            >
                                                {{ item.author_name }}
                                            </span>
                                            <span
                                                v-if="item.source && item.source !== 'UNKNOWN'"
                                                class="text-xs px-1 py-0.5 bg-zinc-100 text-zinc-500 rounded-sm border border-zinc-200/60"
                                            >
                                                {{ formatSource(item.source) }}
                                            </span>
                                        </div>
                                    </div>

                                    <div class="text-xs text-zinc-400 mt-2 font-medium font-mono tabular-nums">
                                        {{ $t("trash.recycled_at", { time: formatRecycleTime(item.recycle_time) }) }}
                                    </div>
                                </div>
                            </div>
                        </ContextMenuTrigger>

                        <ContextMenuContent class="w-44 rounded-lg shadow-xl border-zinc-200">
                            <ContextMenuItem class="flex items-center gap-2 text-xs py-1.5 cursor-pointer" @click="openPreview(item)">
                                <Eye class="w-3.5 h-3.5 text-zinc-500" />
                                <span>{{ $t("trash.actions.preview") }}</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                class="flex items-center gap-2 text-xs py-1.5 cursor-pointer"
                                @click="handleSingleRestore(item)"
                            >
                                <RotateCcw class="w-3.5 h-3.5 text-zinc-500" />
                                <span>{{ $t("trash.actions.restore") }}</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                                class="flex items-center gap-2 text-xs py-1.5 text-red-600 focus:text-red-600 focus:bg-red-50 cursor-pointer"
                                @click="openSingleDeleteModal(item)"
                            >
                                <Trash2 class="w-3.5 h-3.5 text-red-500" />
                                <span>{{ $t("trash.actions.permanent_delete") }}</span>
                            </ContextMenuItem>
                        </ContextMenuContent>
                    </ContextMenu>
                </div>

                <!-- View 2: Table View -->
                <div v-else class="w-full overflow-x-auto border border-zinc-200/80 rounded-xl overflow-hidden shadow-xs">
                    <table class="w-full text-left border-collapse text-xs min-w-[640px]">
                        <thead>
                            <tr class="tracking-wider text-xs uppercase font-bold text-zinc-400 bg-zinc-50/70 border-b border-zinc-200/80">
                                <th class="w-10 px-4 py-2.5 text-center">
                                    <Checkbox
                                        :model-value="trashStore.areAllVisibleSelected"
                                        :aria-label="$t('trash.actions.select_all')"
                                        class="size-4 rounded-sm"
                                        @update:model-value="
                                            trashStore.areAllVisibleSelected ? trashStore.deselectAll() : trashStore.selectAllVisible()
                                        "
                                    />
                                </th>
                                <th class="w-16 px-3 py-2.5">{{ $t("trash.table.preview") }}</th>
                                <th class="px-4 py-2.5">{{ $t("trash.table.name") }}</th>
                                <th class="w-28 px-4 py-2.5">{{ $t("trash.table.type") }}</th>
                                <th class="w-40 px-4 py-2.5">{{ $t("trash.table.author_source") }}</th>
                                <th class="w-44 px-4 py-2.5">{{ $t("trash.table.recycled_time") }}</th>
                                <th class="w-36 px-4 py-2.5 text-right">{{ $t("trash.table.actions") }}</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-zinc-100">
                            <tr
                                v-for="item in trashStore.items"
                                :key="item.id"
                                class="hover:bg-zinc-50/70 transition-colors group cursor-pointer"
                                :class="trashStore.selectedItemIds.has(item.id) ? 'bg-indigo-50/20' : ''"
                                @click="openPreview(item)"
                            >
                                <td class="px-4 py-2.5 text-center" @click.stop>
                                    <Checkbox
                                        :model-value="trashStore.selectedItemIds.has(item.id)"
                                        :aria-label="$t('trash.actions.select_item', { name: getItemTitle(item) })"
                                        class="size-4 rounded-sm"
                                        @update:model-value="trashStore.toggleSelectItem(item.id)"
                                    />
                                </td>
                                <td class="px-3 py-2">
                                    <div
                                        class="w-9 h-9 rounded-md overflow-hidden bg-zinc-100 ring-1 ring-black/5 shrink-0 flex items-center justify-center"
                                    >
                                        <img
                                            v-if="getItemCover(item)"
                                            :src="getItemCover(item)!"
                                            :alt="getItemTitle(item)"
                                            class="w-full h-full object-cover"
                                            loading="lazy"
                                        />
                                        <FileText v-else-if="item.item_type === 'post'" class="w-4 h-4 text-zinc-300" />
                                        <ImageIcon v-else-if="item.type === 'IMAGE'" class="w-4 h-4 text-zinc-300" />
                                        <Video v-else class="w-4 h-4 text-zinc-300" />
                                    </div>
                                </td>
                                <td class="px-4 py-2.5">
                                    <div class="font-semibold text-zinc-800 group-hover:text-zinc-950 line-clamp-1">
                                        {{ getItemTitle(item) }}
                                    </div>
                                    <div v-if="item.description && item.title" class="text-xs text-zinc-400 line-clamp-1 mt-0.5">
                                        {{ item.description }}
                                    </div>
                                </td>
                                <td class="px-4 py-2.5">
                                    <span
                                        class="text-xs font-medium px-1.5 py-0.5 rounded-sm border"
                                        :class="
                                            item.item_type === 'post'
                                                ? 'bg-amber-50 text-amber-800 border-amber-200/60'
                                                : item.type === 'VIDEO'
                                                  ? 'bg-purple-50 text-purple-800 border-purple-200/60'
                                                  : item.type === 'AUDIO'
                                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200/60'
                                                    : 'bg-blue-50 text-blue-800 border-blue-200/60'
                                        "
                                    >
                                        {{ formatTrashItemType(item) }}
                                    </span>
                                </td>
                                <td class="px-4 py-2.5">
                                    <div class="flex items-center gap-1.5">
                                        <span
                                            v-if="item.item_type === 'post' && item.author_name"
                                            class="font-medium text-zinc-600 truncate max-w-[100px]"
                                        >
                                            {{ item.author_name }}
                                        </span>
                                        <span
                                            v-if="item.source && item.source !== 'UNKNOWN'"
                                            class="text-xs px-1 py-0.2 bg-zinc-100 text-zinc-500 rounded-sm border border-zinc-200/60"
                                        >
                                            {{ formatSource(item.source) }}
                                        </span>
                                    </div>
                                </td>
                                <td class="px-4 py-2.5 text-zinc-400 font-mono text-xs tabular-nums">
                                    {{ formatRecycleTime(item.recycle_time) }}
                                </td>
                                <td class="px-4 py-2.5 text-right" @click.stop>
                                    <div class="flex items-center justify-end gap-1">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            class="h-7 px-2 text-xs text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded-md gap-1"
                                            @click="openPreview(item)"
                                        >
                                            <Eye class="w-3 h-3 text-zinc-500" />
                                            <span>{{ $t("trash.actions.preview") }}</span>
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            class="h-7 px-2 text-xs text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded-md gap-1"
                                            :disabled="isActionLoading"
                                            @click="handleSingleRestore(item)"
                                        >
                                            <RotateCcw class="w-3 h-3 text-zinc-500" />
                                            <span>{{ $t("trash.actions.restore") }}</span>
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            class="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 rounded-md gap-1"
                                            :disabled="isActionLoading"
                                            @click="openSingleDeleteModal(item)"
                                        >
                                            <Trash2 class="w-3 h-3 text-red-500" />
                                            <span>{{ $t("trash.actions.permanent_delete") }}</span>
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Card Bottom Pagination Strip -->
            <div
                v-if="totalPages > 1"
                class="px-6 py-2.5 shrink-0 bg-[#fbfbfb] border-t border-zinc-200/80 flex items-center justify-between text-xs"
            >
                <div class="text-zinc-500 font-medium tabular-nums">
                    {{ $t("grid.showing_items", { count: trashStore.total }) }}
                </div>

                <PaginationRoot
                    :page="trashStore.page"
                    :items-per-page="trashStore.count"
                    :total="trashStore.total"
                    :sibling-count="1"
                    show-edges
                    @update:page="trashStore.page = $event"
                >
                    <PaginationList v-slot="{ items: paginationItems }" class="flex items-center gap-1">
                        <PaginationPrev
                            class="h-7.5 w-7.5 rounded-lg flex items-center justify-center hover:bg-zinc-200/70 text-zinc-600 disabled:opacity-40 cursor-pointer transition-colors"
                        />

                        <template v-for="(pageItem, index) in paginationItems">
                            <PaginationListItem
                                v-if="pageItem.type === 'page'"
                                :key="index"
                                :value="pageItem.value"
                                class="h-7.5 min-w-7.5 px-2 rounded-lg flex items-center justify-center text-xs font-bold font-mono tabular-nums cursor-pointer transition-colors"
                                :class="
                                    pageItem.value === trashStore.page
                                        ? 'bg-zinc-900 text-white shadow-xs'
                                        : 'text-zinc-600 hover:bg-zinc-100'
                                "
                            >
                                {{ pageItem.value }}
                            </PaginationListItem>
                            <PaginationEllipsis
                                v-else
                                :key="pageItem.type"
                                :index="index"
                                class="h-7.5 w-7.5 flex items-center justify-center text-zinc-400"
                            >
                                &#8230;
                            </PaginationEllipsis>
                        </template>

                        <PaginationNext
                            class="h-7.5 w-7.5 rounded-lg flex items-center justify-center hover:bg-zinc-200/70 text-zinc-600 disabled:opacity-40 cursor-pointer transition-colors"
                        />
                    </PaginationList>
                </PaginationRoot>
            </div>
        </div>

        <!-- Modal: Single Permanent Delete Confirmation -->
        <Dialog v-model:open="isSingleDeleteOpen">
            <DialogContent class="sm:max-w-md bg-white rounded-xl p-5 border-zinc-200">
                <DialogHeader>
                    <div class="w-8 h-8 rounded-lg bg-red-50 text-red-600 border border-red-100 flex items-center justify-center mb-2">
                        <AlertTriangle class="w-4 h-4 text-red-600" />
                    </div>
                    <DialogTitle class="text-base font-semibold text-zinc-900">
                        {{ $t("trash.dialogs.delete_single_title") }}
                    </DialogTitle>
                    <DialogDescription class="text-xs text-zinc-500 mt-1 leading-relaxed">
                        {{ $t("trash.dialogs.delete_single_desc") }}
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter class="mt-4 flex gap-2 sm:justify-end">
                    <Button
                        variant="outline"
                        size="sm"
                        class="text-xs h-8.5 rounded-lg border-zinc-200"
                        :disabled="isActionLoading"
                        @click="isSingleDeleteOpen = false"
                    >
                        {{ $t("common.cancel") }}
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        class="text-xs h-8.5 rounded-lg shadow-xs active:scale-[0.96] transition-transform"
                        :disabled="isActionLoading"
                        @click="confirmSingleDelete"
                    >
                        <Loader2 v-if="isActionLoading" class="w-3.5 h-3.5 animate-spin mr-1" />
                        <span>{{ $t("trash.dialogs.confirm_delete") }}</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <!-- Modal: Batch Permanent Delete Confirmation -->
        <Dialog v-model:open="isBatchDeleteOpen">
            <DialogContent class="sm:max-w-md bg-white rounded-xl p-5 border-zinc-200">
                <DialogHeader>
                    <div class="w-8 h-8 rounded-lg bg-red-50 text-red-600 border border-red-100 flex items-center justify-center mb-2">
                        <AlertTriangle class="w-4 h-4 text-red-600" />
                    </div>
                    <DialogTitle class="text-base font-semibold text-zinc-900">
                        {{ $t("trash.dialogs.delete_batch_title", { count: trashStore.selectedItemsCount }) }}
                    </DialogTitle>
                    <DialogDescription class="text-xs text-zinc-500 mt-1 leading-relaxed">
                        {{ $t("trash.dialogs.delete_batch_desc") }}
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter class="mt-4 flex gap-2 sm:justify-end">
                    <Button
                        variant="outline"
                        size="sm"
                        class="text-xs h-8.5 rounded-lg border-zinc-200"
                        :disabled="isActionLoading"
                        @click="isBatchDeleteOpen = false"
                    >
                        {{ $t("common.cancel") }}
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        class="text-xs h-8.5 rounded-lg shadow-xs active:scale-[0.96] transition-transform"
                        :disabled="isActionLoading"
                        @click="confirmBatchDelete"
                    >
                        <Loader2 v-if="isActionLoading" class="w-3.5 h-3.5 animate-spin mr-1" />
                        <span>{{ $t("trash.dialogs.confirm_delete") }}</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <!-- Modal: Empty Trash Confirmation -->
        <Dialog v-model:open="isEmptyTrashOpen">
            <DialogContent class="sm:max-w-md bg-white rounded-xl p-5 border-zinc-200">
                <DialogHeader>
                    <div class="w-8 h-8 rounded-lg bg-red-50 text-red-600 border border-red-100 flex items-center justify-center mb-2">
                        <AlertTriangle class="w-4 h-4 text-red-600" />
                    </div>
                    <DialogTitle class="text-base font-semibold text-zinc-900">
                        {{ $t("trash.dialogs.empty_title") }}
                    </DialogTitle>
                    <DialogDescription class="text-xs text-zinc-500 mt-1 leading-relaxed">
                        {{ $t("trash.dialogs.empty_desc") }}
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter class="mt-4 flex gap-2 sm:justify-end">
                    <Button
                        variant="outline"
                        size="sm"
                        class="text-xs h-8.5 rounded-lg border-zinc-200"
                        :disabled="isActionLoading"
                        @click="isEmptyTrashOpen = false"
                    >
                        {{ $t("common.cancel") }}
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        class="text-xs h-8.5 rounded-lg shadow-xs active:scale-[0.96] transition-transform"
                        :disabled="isActionLoading"
                        @click="confirmEmptyTrash"
                    >
                        <Loader2 v-if="isActionLoading" class="w-3.5 h-3.5 animate-spin mr-1" />
                        <span>{{ $t("trash.dialogs.confirm_empty") }}</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <!-- Modal: Trash Post / Media Preview Dialog -->
        <TrashPostPreviewDialog
            v-model:open="isPreviewOpen"
            :item="previewItem"
            @restore="handlePreviewRestore"
            @delete="handlePreviewDelete"
        />
    </div>
</template>
