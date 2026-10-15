<script setup lang="ts">
import {
    CheckSquare,
    ChevronLeft,
    ChevronRight,
    LayoutGrid,
    Search,
    Sidebar,
    X,
    MoreHorizontal,
    Layers,
    Sparkles,
    Filter,
    ChevronDown,
    Upload,
    TriangleAlert,
} from "@lucide/vue";
import { useDebounceFn } from "@vueuse/core";
import { PaginationRoot, PaginationList, PaginationListItem, PaginationPrev, PaginationNext, PaginationEllipsis } from "reka-ui";
import { Button } from "@/components/ui/button";
import { NumberField, NumberFieldInput } from "@/components/ui/number-field";
import { useVisualViewportBottomOffset } from "@/composables/useVisualViewportBottomOffset";
import { useMediaStore, type MappedMediaItem } from "@/stores/media";
import { useLibraryStore } from "@/stores/library";
import { storeToRefs } from "pinia";

const store = useMediaStore();
const {
    medias,
    isLoadingMedia,
    keyword,
    source,
    displayMode,
    total,
    searchDegraded,
    page,
    count,
    selectedMediaId,
    useAiSearch,
    sortBy,
    sortOrder,
    mediaType,
} = storeToRefs(store);
const { refetchMedia, selectMedia } = store;
const { t } = useI18n();
const { toggleSidebar, isSidebarCollapsed, isCreateMediaOpen } = useAppLayout();
const libraryStore = useLibraryStore();
const { isMultiSelectClick } = useMultiSelectModifier();
const visualViewportBottomOffsetStyle = useVisualViewportBottomOffset();

/** Explains which AI channels the last search ran without, e.g. "Text semantic search (invalid credentials)". */
const degradedSummary = computed(() =>
    searchDegraded.value
        .map((item) => {
            const reasonKey = ["AUTHENTICATION", "CONFIGURATION", "THROTTLED", "RATE_LIMITED", "TIMEOUT", "TRANSIENT"].includes(item.reason)
                ? item.reason.toLowerCase()
                : "other";
            return t("search.degraded_item", {
                channel: t(`search.degraded_channel.${item.channel}`),
                reason: t(`search.degraded_reason.${reasonKey}`),
            });
        })
        .join(t("search.degraded_separator")),
);

const totalPages = computed(() => Math.ceil((total.value || 0) / (count.value || 20)));

const pageSize = computed({
    get: () => count.value,
    set: (val) => {
        page.value = 1;
        count.value = val;
    },
});
const selectedMediaIds = ref<Set<string>>(new Set());
const isSelectionMode = ref(false);
const showFilters = ref(false);
const selectedMediaIdList = computed(() => Array.from(selectedMediaIds.value));
const selectedMediaCount = computed(() => selectedMediaIds.value.size);
const movableVisibleMediaIds = computed(() => (medias.value || []).filter((media) => !media.post_id).map((media) => String(media.id)));
const areAllMovableVisibleMediaSelected = computed(
    () => movableVisibleMediaIds.value.length > 0 && movableVisibleMediaIds.value.every((id) => selectedMediaIds.value.has(id)),
);

const showCreateDialog = isCreateMediaOpen;

const sortValue = computed({
    get: () => {
        if (sortBy.value === "published_time") {
            return sortOrder.value === "asc" ? "published_asc" : "published_desc";
        }
        return sortOrder.value === "asc" ? "created_asc" : "created_desc";
    },
    set: (val: string) => {
        if (val === "published_desc") {
            sortBy.value = "published_time";
            sortOrder.value = "desc";
        } else if (val === "published_asc") {
            sortBy.value = "published_time";
            sortOrder.value = "asc";
        } else if (val === "created_asc") {
            sortBy.value = "create_time";
            sortOrder.value = "asc";
        } else {
            sortBy.value = "create_time";
            sortOrder.value = "desc";
        }
    },
});

const hasActiveFilters = computed(() => {
    return Boolean(
        source.value ||
        mediaType.value ||
        (sortBy.value && sortBy.value !== "create_time") ||
        (sortOrder.value && sortOrder.value !== "desc"),
    );
});

const resetFilters = () => {
    keyword.value = "";
    source.value = undefined;
    mediaType.value = undefined;
    sortBy.value = "create_time";
    sortOrder.value = "desc";
};

watch(
    () => [keyword.value, source.value, displayMode.value, libraryStore.activeLibraryId, sortBy.value, sortOrder.value, mediaType.value],
    () => {
        exitSelectionMode();
    },
);

const clearSearch = () => {
    keyword.value = "";
};

const platforms = [
    { label: "All", value: undefined },
    { label: "Douyin", value: "DOUYIN" },
    { label: "XHS", value: "XHS" },
    { label: "Bilibili", value: "BILIBILI" },
    { label: "X", value: "X" },
    { label: "TikTok", value: "TIKTOK" },
    { label: "Instagram", value: "INSTAGRAM" },
    { label: "Youtube", value: "YOUTUBE" },
];

const scrollContainer = ref<HTMLElement | null>(null);

const changePage = async (newPage: number) => {
    if (newPage < 1 || newPage > totalPages.value) return;
    page.value = newPage;
    if (scrollContainer.value) {
        scrollContainer.value.scrollTop = 0;
    }
};

const isPrevDisabled = computed(() => page.value <= 1 || isLoadingMedia.value);
const isNextDisabled = computed(() => (totalPages.value && page.value >= totalPages.value) || isLoadingMedia.value);

const jumpPage = ref(page.value);
watch(page, (val) => {
    jumpPage.value = val;
});

const isEditingPage = ref(false);
const mobileJumpPage = ref(page.value);
const mobileInputRef = ref<any>(null);

const startEditingPage = () => {
    mobileJumpPage.value = page.value;
    isEditingPage.value = true;
    nextTick(() => {
        const inputEl = mobileInputRef.value?.$el as HTMLInputElement | undefined;
        if (inputEl) {
            inputEl.focus();
            inputEl.select();
        }
    });
};

const finishEditingPage = () => {
    isEditingPage.value = false;
    const target = Number(mobileJumpPage.value);
    if (!isNaN(target) && target >= 1 && target <= totalPages.value) {
        changePage(target);
    }
};

const handleJump = () => {
    // Jump to the specified page from the desktop input box
    const target = Number(jumpPage.value);
    if (!isNaN(target) && target >= 1 && target <= totalPages.value) {
        changePage(target);
    } else {
        jumpPage.value = page.value;
    }
};

const isMediaMovable = (media: MappedMediaItem) => !media.post_id;

const isMediaChecked = (id: string) => selectedMediaIds.value.has(String(id));

const setMediaChecked = (media: MappedMediaItem, checked: boolean) => {
    if (!isMediaMovable(media)) return;

    const next = new Set(selectedMediaIds.value);
    const id = String(media.id);
    if (checked) {
        next.add(id);
        isSelectionMode.value = true;
    } else {
        next.delete(id);
    }
    selectedMediaIds.value = next;
    if (next.size === 0) {
        isSelectionMode.value = false;
    }
};

const toggleSelectionMode = () => {
    if (isSelectionMode.value) {
        exitSelectionMode();
        return;
    }

    isSelectionMode.value = true;
};

const clearSelectedMedia = () => {
    selectedMediaIds.value = new Set();
};

const exitSelectionMode = () => {
    clearSelectedMedia();
    isSelectionMode.value = false;
};

const toggleVisibleMedia = () => {
    if (areAllMovableVisibleMediaSelected.value) {
        const next = new Set(selectedMediaIds.value);
        for (const id of movableVisibleMediaIds.value) {
            next.delete(id);
        }
        selectedMediaIds.value = next;
        if (next.size === 0) {
            isSelectionMode.value = false;
        }
        return;
    }

    const next = new Set(selectedMediaIds.value);
    for (const id of movableVisibleMediaIds.value) {
        next.add(id);
    }
    selectedMediaIds.value = next;
    if (next.size > 0) {
        isSelectionMode.value = true;
    }
};

const handleMoved = async () => {
    exitSelectionMode();
    await refetchMedia();
};

const handleMediaClick = (media: MappedMediaItem, event: MouseEvent) => {
    if (isMediaMovable(media) && (isMultiSelectClick(event) || isSelectionMode.value || isMediaChecked(media.id))) {
        event.preventDefault();
        setMediaChecked(media, !isMediaChecked(media.id));
        return;
    }

    selectMedia(media.id);
};

onMounted(() => {
    refetchMedia(); // Initial fetch
});
</script>

<template>
    <div :style="visualViewportBottomOffsetStyle" class="flex-1 min-h-0 flex flex-col bg-white md:overflow-hidden relative">
        <!-- Header -->
        <div class="z-30 h-14 border-b border-zinc-200/80 flex items-center gap-2 px-4 md:px-6 shrink-0 bg-white">
            <!-- Left side: Sidebar Toggle & Page Title -->
            <div class="flex items-center gap-3 shrink-0">
                <button
                    @click="toggleSidebar"
                    class="h-8 w-8 rounded-lg -ml-1 items-center justify-center text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 transition-colors cursor-pointer"
                    :class="isSidebarCollapsed ? 'flex' : 'flex md:hidden'"
                    :title="$t('common.toggle_sidebar', 'Toggle sidebar')"
                    :aria-label="$t('common.toggle_sidebar', 'Toggle sidebar')"
                >
                    <Sidebar class="w-5 h-5" />
                </button>
                <h1
                    class="text-sm font-bold tracking-tight text-zinc-900 hidden md:flex items-center gap-2 select-none whitespace-nowrap shrink-0"
                >
                    <span>{{ $t("common.media_assets", "Media Assets") }}</span>
                    <span v-if="total" class="text-xs font-medium text-zinc-500 bg-zinc-100 px-2 py-0.5 rounded-full tabular-nums">{{
                        total
                    }}</span>
                </h1>
            </div>

            <!-- Right side: Filters & Actions Group -->
            <div class="flex min-w-0 items-center gap-2 sm:gap-3 flex-1 justify-end">
                <!-- Search Input (Unified height and border radius, remove shadow-sm) -->
                <div class="relative min-w-0 flex-1 sm:max-w-64 group transition-all duration-300">
                    <Search
                        class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 group-focus-within:text-blue-600 transition-colors"
                    />
                    <input
                        v-model="keyword"
                        type="text"
                        :aria-label="$t('common.search_media', 'Search media')"
                        :placeholder="$t('common.search', 'Search...')"
                        class="w-full h-9 rounded-full bg-zinc-50/90 border border-zinc-200/80 text-zinc-900 text-sm font-medium focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 block pl-9 pr-16 hover:bg-white focus:bg-white transition-all placeholder:text-zinc-400"
                    />
                    <div class="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                        <button
                            v-if="keyword"
                            @click="clearSearch"
                            :aria-label="$t('common.clear_search', 'Clear search')"
                            class="flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 transition-colors cursor-pointer"
                        >
                            <X class="w-3 h-3" />
                        </button>
                        <button
                            @click="useAiSearch = !useAiSearch"
                            :aria-pressed="useAiSearch"
                            :aria-label="$t('common.ai_search', 'AI Search')"
                            :title="$t('common.ai_search', 'AI Search')"
                            :class="useAiSearch ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700'"
                            class="flex h-6 w-6 items-center justify-center rounded-full transition-colors cursor-pointer"
                        >
                            <Sparkles class="w-3.5 h-3.5" :class="useAiSearch ? 'fill-white/20' : ''" />
                        </button>
                    </div>
                </div>

                <!-- Toggle Filters Button (Unified height and border radius, remove shadow-sm) -->
                <button
                    @click="showFilters = !showFilters"
                    :class="[
                        showFilters || hasActiveFilters
                            ? 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300'
                            : 'bg-white border-zinc-200/80 text-zinc-600 hover:bg-zinc-50 hover:border-zinc-300 hover:text-zinc-900',
                    ]"
                    class="flex h-9 w-9 rounded-full sm:h-9 sm:w-auto sm:rounded-full items-center justify-center gap-1.5 px-0 sm:px-2.5 lg:px-3.5 border text-xs font-semibold transition-all cursor-pointer select-none whitespace-nowrap shrink-0 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                    :title="$t('common.filters', 'Filters')"
                    :aria-label="$t('common.filters', 'Filters')"
                >
                    <Filter class="w-3.5 h-3.5" />
                    <span class="hidden lg:inline">{{ $t("common.filters", "Filters") }}</span>
                    <span v-if="hasActiveFilters" class="w-1.5 h-1.5 rounded-full bg-blue-600"></span>
                </button>

                <!-- Action Toolbar Divider -->
                <div class="h-5 w-px bg-zinc-200 hidden sm:block mx-0.5"></div>

                <!-- Batch Select Button (Unified height, remove shadow-sm) -->
                <button
                    @click="toggleSelectionMode"
                    :class="[
                        isSelectionMode
                            ? 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300'
                            : 'bg-white border-zinc-200/80 text-zinc-600 hover:bg-zinc-50 hover:border-zinc-300 hover:text-zinc-900',
                    ]"
                    class="flex h-9 w-9 rounded-full sm:h-9 sm:w-auto sm:rounded-full items-center justify-center gap-1.5 px-0 sm:px-2.5 lg:px-3 border text-xs font-semibold transition-all cursor-pointer select-none whitespace-nowrap shrink-0 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                    :title="$t('common.batch_select', 'Batch select')"
                    :aria-label="$t('common.batch_select', 'Batch select')"
                >
                    <CheckSquare class="w-3.5 h-3.5" />
                    <span class="hidden lg:inline">{{ $t("common.batch_select", "Batch Select") }}</span>
                </button>

                <!-- Layout Switchers (Unified height and border radius, remove shadow-sm) -->
                <div class="hidden sm:flex items-center gap-0.5 bg-zinc-100/70 p-0.5 rounded-full border border-zinc-200/50 shrink-0 h-9">
                    <button
                        @click="displayMode = 'flat'"
                        :class="[
                            displayMode === 'flat'
                                ? 'text-zinc-950 bg-white border border-zinc-200/30 font-semibold shadow-none'
                                : 'text-zinc-500 hover:text-zinc-900 hover:bg-white/50',
                        ]"
                        class="h-7 px-2.5 rounded-full transition-all flex items-center justify-center gap-1.5 text-xs cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                        :title="$t('grid.flat_layout', 'Flat layout')"
                        :aria-label="$t('grid.flat_layout', 'Flat layout')"
                    >
                        <LayoutGrid class="w-3.5 h-3.5" />
                        <span class="hidden lg:inline">{{ $t("grid.flat_layout", "Flat") }}</span>
                    </button>
                    <button
                        @click="displayMode = 'stacked'"
                        :class="[
                            displayMode === 'stacked'
                                ? 'text-zinc-950 bg-white border border-zinc-200/30 font-semibold shadow-none'
                                : 'text-zinc-500 hover:text-zinc-900 hover:bg-white/50',
                        ]"
                        class="h-7 px-2.5 rounded-full transition-all flex items-center justify-center gap-1.5 text-xs cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                        :title="$t('grid.stacked_layout', 'Stacked layout')"
                        :aria-label="$t('grid.stacked_layout', 'Stacked layout')"
                    >
                        <Layers class="w-3.5 h-3.5" />
                        <span class="hidden lg:inline">{{ $t("grid.stacked_layout", "Stacked") }}</span>
                    </button>
                </div>
            </div>
        </div>

        <!-- Main Workplace (Seamless Split-Pane) -->
        <div class="flex-1 flex flex-col min-h-0 min-w-0 bg-white relative overflow-hidden">
            <!-- Filters Drawer Strip -->
            <div
                class="transition-all duration-300 ease-in-out border-b border-zinc-200/70 bg-zinc-50/70 flex flex-col shrink-0 overflow-hidden"
                :class="[showFilters ? 'max-h-90 p-4 sm:p-5 opacity-100' : 'max-h-0 py-0! opacity-0 border-b-0']"
            >
                <div class="space-y-4">
                    <!-- Platform pill tags -->
                    <div class="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                        <span class="text-zinc-600 font-semibold text-xs whitespace-nowrap select-none mr-2"
                            >{{ $t("common.platform", "Platform") }}:</span
                        >
                        <button
                            v-for="p in platforms"
                            :key="String(p.value)"
                            @click="source = p.value"
                            class="px-4 py-1.5 rounded-full border text-xs font-semibold transition-all cursor-pointer whitespace-nowrap active:scale-[0.96]"
                            :class="
                                source === p.value
                                    ? 'bg-zinc-900 border-transparent text-white'
                                    : 'bg-white border-zinc-200/80 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                            "
                        >
                            {{ p.label }}
                        </button>
                    </div>

                    <!-- Sorting & Dropdowns row -->
                    <div class="flex flex-wrap items-center gap-4 sm:gap-6 text-xs border-t border-zinc-200/50 pt-3.5">
                        <!-- Sort by Dropdown -->
                        <div class="flex items-center gap-2">
                            <label for="media-sort-select" class="text-zinc-600 font-semibold select-none cursor-pointer"
                                >{{ $t("common.sort_by", "Sort by") }}:</label
                            >
                            <div class="relative">
                                <select
                                    id="media-sort-select"
                                    v-model="sortValue"
                                    :aria-label="$t('common.sort_by', 'Sort by')"
                                    class="appearance-none bg-white border border-zinc-200 hover:border-zinc-300 text-zinc-800 rounded-lg py-1.5 pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-blue-500/10 cursor-pointer transition-all"
                                >
                                    <option value="created_desc">{{ $t("common.sort_import_time_desc", "Newly Added") }}</option>
                                    <option value="created_asc">{{ $t("common.sort_import_time_asc", "Oldest Added") }}</option>
                                    <option value="published_desc">{{ $t("common.sort_published_time_desc", "Latest Published") }}</option>
                                    <option value="published_asc">{{ $t("common.sort_published_time_asc", "Oldest Published") }}</option>
                                </select>
                                <ChevronDown
                                    class="w-3.5 h-3.5 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                                />
                            </div>
                        </div>

                        <!-- Media Type Dropdown -->
                        <div class="flex items-center gap-2">
                            <label for="media-type-select" class="text-zinc-600 font-semibold select-none cursor-pointer"
                                >{{ $t("common.media_type", "Media Type") }}:</label
                            >
                            <div class="relative">
                                <select
                                    id="media-type-select"
                                    v-model="mediaType"
                                    :aria-label="$t('common.media_type', 'Media Type')"
                                    class="appearance-none bg-white border border-zinc-200 hover:border-zinc-300 text-zinc-800 rounded-lg py-1.5 pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-blue-500/10 cursor-pointer transition-all"
                                >
                                    <option :value="undefined">{{ $t("common.all_media_types", "All Types") }}</option>
                                    <option value="VIDEO">{{ $t("common.media_type_video", "Video Only") }}</option>
                                    <option value="IMAGE">{{ $t("common.media_type_image", "Image Only") }}</option>
                                </select>
                                <ChevronDown
                                    class="w-3.5 h-3.5 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                                />
                            </div>
                        </div>

                        <!-- Items per Page Dropdown -->
                        <div class="flex items-center gap-2">
                            <label for="media-page-size-select" class="text-zinc-600 font-semibold select-none cursor-pointer"
                                >{{ $t("grid.items_per_page_label", "Page size") }}:</label
                            >
                            <div class="relative">
                                <select
                                    id="media-page-size-select"
                                    v-model="pageSize"
                                    :aria-label="$t('grid.items_per_page_label', 'Page size')"
                                    class="appearance-none bg-white border border-zinc-200 hover:border-zinc-300 text-zinc-800 rounded-lg py-1.5 pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-blue-500/10 cursor-pointer transition-all"
                                >
                                    <option :value="20">20</option>
                                    <option :value="50">50</option>
                                    <option :value="100">100</option>
                                </select>
                                <ChevronDown
                                    class="w-3.5 h-3.5 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                                />
                            </div>
                        </div>

                        <!-- Clear Filters Button -->
                        <button
                            v-if="hasActiveFilters"
                            type="button"
                            @click="resetFilters"
                            class="text-xs font-semibold text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer ml-auto"
                        >
                            {{ $t("common.clear_all", "Clear filters") }}
                        </button>
                    </div>
                </div>
            </div>

            <!-- Content Area -->
            <div ref="scrollContainer" class="flex-1 overflow-y-auto p-4 sm:p-6 bg-zinc-50/30">
                <!-- AI channels the search ran without -->
                <div
                    v-if="degradedSummary"
                    role="status"
                    class="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-800"
                >
                    <TriangleAlert class="w-3.5 h-3.5 shrink-0" />
                    <span>{{ $t("search.degraded", { channels: degradedSummary }) }}</span>
                    <NuxtLink to="/settings/ai" class="font-semibold underline underline-offset-2 hover:text-amber-900">
                        {{ $t("search.degraded_settings") }}
                    </NuxtLink>
                </div>

                <!-- Skeletons when loading -->
                <div v-if="isLoadingMedia" class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
                    <div
                        v-for="i in 12"
                        :key="i"
                        class="aspect-square rounded-2xl bg-zinc-100 animate-pulse border border-zinc-200/50 flex flex-col justify-end p-3.5"
                    >
                        <div class="h-3 w-2/3 bg-zinc-200/80 rounded-md"></div>
                    </div>
                </div>

                <!-- Empty State -->
                <div
                    v-else-if="!medias || medias.length === 0"
                    class="h-full min-h-72 flex flex-col items-center justify-center p-8 text-center"
                >
                    <div
                        class="w-12 h-12 rounded-2xl bg-zinc-100 border border-zinc-200/60 flex items-center justify-center text-zinc-400 mb-3 shadow-xs"
                    >
                        <LayoutGrid class="w-6 h-6" />
                    </div>
                    <h2 class="text-sm font-semibold text-zinc-800 mb-1">
                        {{
                            keyword || hasActiveFilters
                                ? $t("common.no_results", "No results found")
                                : $t("common.no_media_title", "No media assets")
                        }}
                    </h2>
                    <p class="text-xs text-zinc-500 max-w-sm mb-4">
                        {{
                            keyword || hasActiveFilters
                                ? $t("common.no_results_desc", "Try adjusting your search query or filters.")
                                : $t("common.no_media_desc", "Upload files or import posts to populate your library.")
                        }}
                    </p>
                    <Button
                        v-if="keyword || hasActiveFilters"
                        variant="outline"
                        size="sm"
                        class="h-8 text-xs cursor-pointer"
                        @click="resetFilters"
                    >
                        {{ $t("common.clear_all", "Clear filters") }}
                    </Button>
                </div>

                <!-- Media Grid Cards -->
                <div
                    v-else
                    ref="gridContainer"
                    class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 pb-[calc(3.75rem+env(safe-area-inset-bottom)+var(--visual-viewport-bottom-offset,0))] sm:pb-0"
                >
                    <MediaCard
                        v-for="(media, index) in medias"
                        :key="media.id"
                        :media="media"
                        :data-index="index"
                        :is-selected="selectedMediaId === media.id"
                        :is-checked="isMediaChecked(media.id)"
                        :can-move="isMediaMovable(media)"
                        :show-checkbox="isSelectionMode || isMediaChecked(media.id)"
                        @toggle-checked="setMediaChecked(media, $event)"
                        @click="handleMediaClick(media, $event)"
                    />
                </div>
            </div>

            <!-- Footer / Pagination -->
            <div
                class="fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom)+var(--visual-viewport-bottom-offset,0))] right-4 z-30 h-10 px-1 bg-white/90 backdrop-blur-md border border-zinc-200 rounded-full flex items-center justify-center w-max sm:relative sm:bottom-auto sm:left-auto sm:right-auto sm:translate-x-0 sm:z-auto sm:h-14 sm:px-6 sm:border-0 sm:border-t sm:border-zinc-200/60 sm:rounded-none sm:bg-white/95 sm:w-full sm:justify-between"
            >
                <!-- Left side: Total items count (hidden on mobile, shown on desktop) -->
                <div class="hidden sm:block text-zinc-500 text-sm select-none font-medium">
                    {{ $t("grid.showing_items", { count: total || 0 }) }}
                </div>

                <!-- Right side: Pagination (centered on mobile, right-aligned on desktop) -->
                <div class="flex items-center sm:gap-4">
                    <PaginationRoot
                        :total="total || 0"
                        :sibling-count="1"
                        :items-per-page="count || 20"
                        :page="page"
                        @update:page="changePage"
                        class="flex items-center"
                    >
                        <PaginationList v-slot="{ items }" class="flex items-center gap-1.5">
                            <!-- Mobile Layout: A single unified pill selector -->
                            <div v-if="!isSelectionMode && selectedMediaCount === 0" class="flex sm:hidden items-center p-0.5">
                                <PaginationPrev as-child>
                                    <Button
                                        variant="ghost"
                                        class="w-8 h-8 rounded-full p-0 text-zinc-600 hover:text-zinc-900"
                                        :disabled="isPrevDisabled"
                                    >
                                        <ChevronLeft class="w-4 h-4" />
                                    </Button>
                                </PaginationPrev>
                                <NumberField v-if="isEditingPage" v-model="mobileJumpPage" :min="1" :max="totalPages" class="w-12 h-6">
                                    <NumberFieldInput
                                        ref="mobileInputRef"
                                        class="w-12 h-6 text-center p-0 bg-zinc-50 border-zinc-200 text-xs font-semibold tabular-nums"
                                        @blur="finishEditingPage"
                                        @keyup.enter="finishEditingPage"
                                    />
                                </NumberField>
                                <span
                                    v-else
                                    @click="startEditingPage"
                                    class="text-xs font-semibold text-zinc-700 px-3 min-w-14 text-center cursor-pointer hover:bg-zinc-100/80 active:bg-zinc-200/50 py-1 rounded-md transition-colors select-none tabular-nums"
                                >
                                    {{ page }} / {{ totalPages }}
                                </span>
                                <PaginationNext as-child>
                                    <Button
                                        variant="ghost"
                                        class="w-8 h-8 rounded-full p-0 text-zinc-600 hover:text-zinc-900"
                                        :disabled="isNextDisabled"
                                    >
                                        <ChevronRight class="w-4 h-4" />
                                    </Button>
                                </PaginationNext>
                            </div>

                            <!-- Desktop Layout: Standard items -->
                            <div class="hidden sm:flex items-center gap-1.5">
                                <PaginationPrev as-child>
                                    <Button
                                        variant="outline"
                                        class="w-9 h-9 rounded-lg border-zinc-200/80 hover:bg-zinc-50 text-zinc-700 p-0"
                                        :disabled="isPrevDisabled"
                                    >
                                        <ChevronLeft class="w-4 h-4" />
                                    </Button>
                                </PaginationPrev>

                                <template v-for="(p, index) in items" :key="index">
                                    <PaginationListItem v-if="p.type === 'page'" :value="p.value" as-child>
                                        <Button
                                            :variant="p.value === page ? 'default' : 'outline'"
                                            class="w-9 h-9 rounded-lg border-zinc-200/80 text-zinc-700 p-0 tabular-nums transition-all"
                                            :class="
                                                p.value === page
                                                    ? 'bg-zinc-900 hover:bg-zinc-800 text-white border-transparent'
                                                    : 'hover:bg-zinc-50'
                                            "
                                        >
                                            {{ p.value }}
                                        </Button>
                                    </PaginationListItem>
                                    <PaginationEllipsis
                                        v-else-if="p.type === 'ellipsis'"
                                        class="w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center"
                                    >
                                        <MoreHorizontal class="w-4 h-4 text-zinc-400" />
                                    </PaginationEllipsis>
                                </template>

                                <PaginationNext as-child>
                                    <Button
                                        variant="outline"
                                        class="w-9 h-9 rounded-lg border-zinc-200/80 hover:bg-zinc-50 text-zinc-700 p-0"
                                        :disabled="isNextDisabled"
                                    >
                                        <ChevronRight class="w-4 h-4" />
                                    </Button>
                                </PaginationNext>
                            </div>
                        </PaginationList>
                    </PaginationRoot>

                    <div class="hidden sm:flex items-center gap-3 border-l border-zinc-200 pl-4 tabular-nums">
                        <i18n-t
                            tag="div"
                            keypath="grid.page_info"
                            scope="global"
                            class="hidden sm:flex items-center gap-1.5 text-zinc-500 text-sm"
                        >
                            <template #current>
                                <NumberField v-model="jumpPage" :min="1" :max="totalPages" class="w-10 h-7">
                                    <NumberFieldInput
                                        class="w-10 h-7 text-center p-0 bg-zinc-50/50 border-zinc-200 text-sm tabular-nums"
                                        @keyup.enter="handleJump"
                                        @blur="handleJump"
                                    />
                                </NumberField>
                            </template>
                            <template #total>
                                <span class="font-medium text-zinc-700">{{ totalPages }}</span>
                            </template>
                        </i18n-t>
                    </div>
                </div>
            </div>
        </div>
        <MoveItemsBar
            v-if="isSelectionMode || selectedMediaCount > 0"
            :post-ids="[]"
            :media-ids="selectedMediaIdList"
            :all-visible-selected="areAllMovableVisibleMediaSelected"
            :can-select-visible="movableVisibleMediaIds.length > 0"
            @toggle-visible="toggleVisibleMedia"
            @moved="handleMoved"
            @cancel="exitSelectionMode"
        />

        <CreateMediaDialog v-model:open="showCreateDialog" />
    </div>
</template>
