<script setup lang="ts">
import {
    CheckSquare,
    ChevronLeft,
    ChevronRight,
    LayoutGrid,
    Menu,
    Search,
    X,
    MoreHorizontal,
    Layers,
    Sparkles,
} from "@lucide/vue";
import { useDebounceFn } from "@vueuse/core";
import {
    PaginationRoot,
    PaginationList,
    PaginationListItem,
    PaginationPrev,
    PaginationNext,
    PaginationEllipsis,
} from "reka-ui";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useMediaStore } from "@/stores/media";
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
    page,
    count,
    selectedMediaId,
    useAiSearch,
} = storeToRefs(store);
const { refetchMedia, selectMedia } = store;
const { toggleSidebar } = useLayout();
const libraryStore = useLibraryStore();
const { isMultiSelectClick } = useMultiSelectModifier();

const PAGE_SIZE = 20;
const totalPages = computed(() => Math.ceil((total.value || 0) / PAGE_SIZE));
const selectedMediaIds = ref<Set<string>>(new Set());
const isSelectionMode = ref(false);
const selectedMediaIdList = computed(() => Array.from(selectedMediaIds.value));
const selectedMediaCount = computed(() => selectedMediaIds.value.size);
const movableVisibleMediaIds = computed(() =>
    (medias.value || []).filter((media) => !media.post_id).map((media) => String(media.id)),
);
const areAllMovableVisibleMediaSelected = computed(
    () =>
        movableVisibleMediaIds.value.length > 0 &&
        movableVisibleMediaIds.value.every((id) => selectedMediaIds.value.has(id)),
);

watch(
    () => [keyword.value, source.value, displayMode.value, libraryStore.activeLibraryId],
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
    await refetchMedia();
};

const isPrevDisabled = computed(() => page.value <= 1 || isLoadingMedia.value);
const isNextDisabled = computed(
    () => (totalPages.value && page.value >= totalPages.value) || isLoadingMedia.value,
);

const jumpPage = ref(page.value);
watch(page, (val) => {
    jumpPage.value = val;
});

const handleJump = () => {
    const target = Number(jumpPage.value);
    if (!isNaN(target) && target >= 1 && target <= totalPages.value) {
        changePage(target);
    } else {
        jumpPage.value = page.value;
    }
};

const isMediaMovable = (media: any) => !media.post_id;

const isMediaChecked = (id: string) => selectedMediaIds.value.has(String(id));

const setMediaChecked = (media: any, checked: boolean) => {
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

const handleMediaClick = (media: any, event: MouseEvent) => {
    if (
        isMediaMovable(media) &&
        (isMultiSelectClick(event) || isSelectionMode.value || isMediaChecked(media.id))
    ) {
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
    <div class="flex-1 min-h-0 flex flex-col bg-white overflow-hidden relative">
        <!-- Header -->
        <div
            class="h-14 border-b border-gray-100 flex items-center justify-between px-3 sm:px-6 shrink-0"
        >
            <div class="flex items-center gap-3">
                <button
                    @click="toggleSidebar"
                    class="p-1.5 -ml-2 hover:bg-gray-100 rounded-md text-gray-500 transition-colors"
                >
                    <Menu class="w-5 h-5" />
                </button>
            </div>

            <div class="flex-1 max-w-2xl px-1 sm:px-4 flex items-center gap-1.5 sm:gap-3">
                <!-- Platform Select -->
                <div class="relative min-w-[80px] sm:min-w-[120px]">
                    <select
                        v-model="source"
                        class="w-full bg-gray-50 border border-gray-100 text-gray-900 text-xs sm:text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-1.5 sm:p-2 appearance-none pr-6 sm:pr-8 cursor-pointer hover:bg-gray-100 transition-colors"
                    >
                        <option v-for="p in platforms" :key="String(p.value)" :value="p.value">
                            {{ p.label }}
                        </option>
                    </select>
                    <div
                        class="absolute inset-y-0 right-0 flex items-center px-1.5 sm:px-2 pointer-events-none text-gray-400"
                    >
                        <ChevronRight class="w-3.5 h-3.5 sm:w-4 sm:h-4 rotate-90" />
                    </div>
                </div>

                <!-- Search Input -->
                <div class="relative flex-1 group">
                    <Search
                        class="absolute left-2.5 sm:left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 sm:w-4 sm:h-4 text-gray-400 group-focus-within:text-blue-500 transition-colors"
                    />
                    <input
                        v-model="keyword"
                        type="text"
                        :placeholder="$t('common.search', 'Search...')"
                        class="w-full bg-gray-50 border border-gray-100 text-gray-900 text-xs sm:text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block pl-8 sm:pl-10 pr-8 sm:pr-10 py-1.5 sm:py-2 hover:bg-gray-100 focus:bg-white transition-all outline-none"
                    />
                    <button
                        v-if="keyword"
                        @click="clearSearch"
                        class="absolute right-2.5 sm:right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-200 rounded-full transition-colors text-gray-400"
                    >
                        <X class="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    </button>
                </div>

                <!-- AI Search Toggle Switch -->
                <div
                    class="flex items-center space-x-2 select-none shrink-0 h-[34px] px-1.5"
                    :title="$t('common.ai_search_tooltip')"
                >
                    <Switch
                        id="ai-search-mode"
                        :checked="useAiSearch"
                        @update:checked="useAiSearch = $event"
                    />
                    <Label
                        for="ai-search-mode"
                        class="text-xs sm:text-sm font-normal flex items-center gap-1 cursor-pointer transition-colors"
                        :class="useAiSearch ? 'text-gray-800' : 'text-gray-400 hover:text-gray-600'"
                    >
                        <Sparkles
                            class="w-3.5 h-3.5 transition-colors"
                            :class="useAiSearch ? 'text-gray-700' : 'text-gray-400'"
                        />
                        <span>{{ $t("common.ai_search") }}</span>
                    </Label>
                </div>
            </div>

            <div class="flex items-center gap-1 sm:gap-2 bg-gray-100 p-0.5 sm:p-1 rounded-lg">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    :class="isSelectionMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'"
                    :aria-pressed="isSelectionMode"
                    aria-label="Select media"
                    title="Select media"
                    @click="toggleSelectionMode"
                    class="h-7 w-7 sm:h-8 sm:w-8 p-0"
                >
                    <CheckSquare class="w-4 h-4" />
                </Button>
                <!-- Display Mode Toggle -->
                <button
                    @click="displayMode = 'flat'"
                    :class="
                        displayMode === 'flat'
                            ? 'bg-white shadow-sm text-blue-600'
                            : 'text-gray-500 hover:text-gray-700'
                    "
                    class="p-1 sm:p-1.5 rounded-md transition-all flex items-center gap-1 text-xs sm:text-sm font-medium"
                >
                    <LayoutGrid class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    <span class="hidden sm:inline">Flat</span>
                </button>
                <button
                    @click="displayMode = 'stacked'"
                    :class="
                        displayMode === 'stacked'
                            ? 'bg-white shadow-sm text-blue-600'
                            : 'text-gray-500 hover:text-gray-700'
                    "
                    class="p-1 sm:p-1.5 rounded-md transition-all flex items-center gap-1 text-xs sm:text-sm font-medium"
                >
                    <Layers class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    <span class="hidden sm:inline">Stacked</span>
                </button>
            </div>
        </div>

        <!-- Content -->
        <div ref="scrollContainer" class="flex-1 overflow-y-auto p-6 bg-gray-50/50">
            <div
                v-if="Array.isArray(medias)"
                ref="gridContainer"
                class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"
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
            class="h-14 border-t border-gray-100 flex items-center justify-between px-3 sm:px-6 shrink-0 text-sm text-gray-500 bg-white"
        >
            <div class="hidden sm:block tabular-nums">
                {{
                    Array.isArray(medias) ? $t("grid.showing_items", { count: medias.length }) : ""
                }}
            </div>

            <div class="flex items-center gap-2 sm:gap-4">
                <PaginationRoot
                    :total="total || 0"
                    :sibling-count="1"
                    :items-per-page="PAGE_SIZE"
                    :page="page"
                    @update:page="changePage"
                    class="flex items-center"
                >
                    <PaginationList v-slot="{ items }" class="flex items-center gap-1">
                        <PaginationPrev as-child>
                            <Button
                                variant="outline"
                                class="w-8 h-8 sm:w-9 sm:h-9 p-0"
                                :disabled="isPrevDisabled"
                            >
                                <ChevronLeft class="w-4 h-4" />
                            </Button>
                        </PaginationPrev>

                        <template v-for="(p, index) in items" :key="index">
                            <PaginationListItem v-if="p.type === 'page'" :value="p.value" as-child>
                                <Button
                                    :variant="p.value === page ? 'default' : 'outline'"
                                    class="w-8 h-8 sm:w-9 sm:h-9 p-0 tabular-nums"
                                >
                                    {{ p.value }}
                                </Button>
                            </PaginationListItem>
                            <PaginationEllipsis
                                v-else-if="p.type === 'ellipsis'"
                                class="w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center"
                            >
                                <MoreHorizontal class="w-4 h-4 text-gray-400" />
                            </PaginationEllipsis>
                        </template>

                        <PaginationNext as-child>
                            <Button
                                variant="outline"
                                class="w-8 h-8 sm:w-9 sm:h-9 p-0"
                                :disabled="isNextDisabled"
                            >
                                <ChevronRight class="w-4 h-4" />
                            </Button>
                        </PaginationNext>
                    </PaginationList>
                </PaginationRoot>

                <div
                    class="flex items-center gap-3 border-l border-gray-200 pl-2 sm:pl-4 tabular-nums"
                >
                    <i18n-t
                        keypath="grid.page_info"
                        scope="global"
                        class="flex items-center gap-1.5 text-gray-500 text-sm hidden sm:flex"
                    >
                        <template #current>
                            <input
                                v-model="jumpPage"
                                type="text"
                                class="w-10 h-7 text-center bg-gray-50 border border-gray-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all tabular-nums"
                                @keyup.enter="handleJump"
                                @blur="handleJump"
                            />
                        </template>
                        <template #total>
                            <span class="font-medium text-gray-700">{{ totalPages }}</span>
                        </template>
                    </i18n-t>
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
    </div>
</template>
