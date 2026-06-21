<script setup lang="ts">
import type { Post } from "@/types/post";
import {
    CheckSquare,
    ChevronLeft,
    ChevronRight,
    LayoutGrid,
    List,
    Search,
    Sidebar,
    X,
    MoreHorizontal,
    Filter,
    ChevronDown,
} from "@lucide/vue";
import { useDebounceFn } from "@vueuse/core";
import { PaginationRoot, PaginationList, PaginationListItem, PaginationPrev, PaginationNext, PaginationEllipsis } from "reka-ui";
import { Button } from "@/components/ui/button";
import { NumberField, NumberFieldInput } from "@/components/ui/number-field";
import { useVisualViewportBottomOffset } from "@/composables/useVisualViewportBottomOffset";
import { useLibraryStore } from "@/stores/library";

const { posts, selectedPostId, selectPost, fetchPosts, isLoading, keyword, source, total, page, count } = usePosts();
const { toggleSidebar } = useLayout();
const libraryStore = useLibraryStore();
const { isMultiSelectClick } = useMultiSelectModifier();
const visualViewportBottomOffsetStyle = useVisualViewportBottomOffset();

const totalPages = computed(() => Math.ceil((total.value || 0) / (count.value || 20)));

const pageSize = computed({
    get: () => count.value,
    set: async (val) => {
        page.value = 1;
        await fetchPosts({ page: 1, count: val });
    },
});
const selectedPostIds = ref<Set<string>>(new Set());
const isSelectionMode = ref(false);
const showFilters = ref(false);
const selectedPostIdList = computed(() => Array.from(selectedPostIds.value));
const selectedPostCount = computed(() => selectedPostIds.value.size);
const visiblePostIds = computed(() => ((posts.value as Post[]) || []).map((post) => String(post.id)));
const areAllVisiblePostsSelected = computed(
    () => visiblePostIds.value.length > 0 && visiblePostIds.value.every((id) => selectedPostIds.value.has(id)),
);

watch(
    () => [keyword.value, source.value, libraryStore.activeLibraryId],
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
    await fetchPosts({ page: newPage, count: count.value });
};

const isPrevDisabled = computed(() => page.value <= 1 || isLoading.value);
const isNextDisabled = computed(() => (totalPages.value && page.value >= totalPages.value) || isLoading.value);

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

const gridContainer = ref<HTMLElement | null>(null);

const isPostChecked = (id: string | number) => selectedPostIds.value.has(String(id));

const setPostChecked = (id: string | number, checked: boolean) => {
    const next = new Set(selectedPostIds.value);
    if (checked) {
        next.add(String(id));
        isSelectionMode.value = true;
    } else {
        next.delete(String(id));
    }
    selectedPostIds.value = next;
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

const clearSelectedPosts = () => {
    selectedPostIds.value = new Set();
};

const exitSelectionMode = () => {
    clearSelectedPosts();
    isSelectionMode.value = false;
};

const toggleVisiblePosts = () => {
    if (areAllVisiblePostsSelected.value) {
        const next = new Set(selectedPostIds.value);
        for (const id of visiblePostIds.value) {
            next.delete(id);
        }
        selectedPostIds.value = next;
        if (next.size === 0) {
            isSelectionMode.value = false;
        }
        return;
    }

    const next = new Set(selectedPostIds.value);
    for (const id of visiblePostIds.value) {
        next.add(id);
    }
    selectedPostIds.value = next;
    if (next.size > 0) {
        isSelectionMode.value = true;
    }
};

const handleMoved = async () => {
    exitSelectionMode();
    await fetchPosts({ page: page.value, count: count.value });
};

const handlePostClick = (post: Post, event: MouseEvent) => {
    if (isMultiSelectClick(event) || isSelectionMode.value || isPostChecked(post.id)) {
        event.preventDefault();
        setPostChecked(post.id, !isPostChecked(post.id));
        return;
    }

    selectPost(post.id);
};

const getColumns = () => {
    if (!gridContainer.value) return 1;
    const children = Array.from(gridContainer.value.children) as HTMLElement[];
    if (children.length < 2) return children.length || 1;

    const firstChild = children[0];
    if (!firstChild) return 1;

    const top0 = firstChild.offsetTop;
    let cols = 0;
    for (const child of children) {
        if (child.offsetTop === top0) cols++;
        else break;
    }
    return cols || 1;
};

const handleKeydown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;

    e.preventDefault();

    const postsArray = posts.value as Post[];
    const currentIndex = postsArray.findIndex((p) => p.id === selectedPostId.value);

    if (currentIndex === -1) {
        const firstPost = postsArray[0];
        if (firstPost) {
            selectPost(firstPost.id);
        }
        return;
    }

    const columns = getColumns();
    let nextIndex = currentIndex;

    if (e.key === "ArrowRight") nextIndex++;
    if (e.key === "ArrowLeft") nextIndex--;
    if (e.key === "ArrowDown") nextIndex += columns;
    if (e.key === "ArrowUp") nextIndex -= columns;

    if (nextIndex >= 0 && nextIndex < postsArray.length) {
        const nextPost = postsArray[nextIndex];
        if (nextPost) {
            selectPost(nextPost.id);

            nextTick(() => {
                const container = gridContainer.value;
                if (!container) return;

                const child = container.children[nextIndex] as HTMLElement | undefined;
                if (child) {
                    child.scrollIntoView({ block: "nearest" });
                }
            });
        }
    }
};

onMounted(() => {
    fetchPosts({ count: count.value }); // Initial fetch
    window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
    window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
    <div :style="visualViewportBottomOffsetStyle" class="flex-1 min-h-0 flex flex-col bg-white md:overflow-hidden relative">
        <!-- Header -->
        <div
            class="sticky top-0 z-30 h-15 sm:h-14 border-b border-gray-100/80 flex items-center gap-2 px-3 sm:px-6 shrink-0 bg-white/98 backdrop-blur-md supports-backdrop-filter:bg-white/98 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        >
            <!-- Left side: Sidebar Toggle & Page Title -->
            <div class="flex items-center gap-3 shrink-0">
                <button
                    @click="toggleSidebar"
                    class="h-9 w-9 rounded-full -ml-1 flex items-center justify-center text-slate-500 hover:bg-slate-50 hover:text-slate-900 active:scale-[0.95] transition-all cursor-pointer"
                    title="Toggle Sidebar"
                >
                    <Sidebar class="w-5 h-5" />
                </button>
                <h1 class="font-semibold text-base text-gray-900 hidden md:flex items-center gap-2 select-none whitespace-nowrap shrink-0">
                    <span>{{ $t("common.post_collections", "Post Collections") }}</span>
                    <span v-if="total" class="text-[11px] font-normal text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full font-mono">{{
                        total
                    }}</span>
                </h1>
            </div>

            <!-- Right side: Filters & Actions Group -->
            <div class="flex min-w-0 items-center gap-2 sm:gap-3 flex-1 justify-end">
                <!-- Search Input (Unified height and border radius, remove shadow-sm) -->
                <div class="relative min-w-0 flex-1 sm:max-w-55 group transition-all duration-300">
                    <Search
                        class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-blue-600 transition-colors"
                    />
                    <input
                        v-model="keyword"
                        type="text"
                        :placeholder="$t('common.search', 'Search...')"
                        class="w-full h-9 rounded-full bg-slate-50/90 border border-slate-200/80 text-slate-900 text-sm font-medium focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 block pl-9 pr-8 hover:bg-white focus:bg-white transition-all placeholder:text-slate-400"
                    />
                    <button
                        v-if="keyword"
                        @click="clearSearch"
                        class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 hover:bg-slate-200 rounded-full transition-colors text-slate-400"
                    >
                        <X class="w-3 h-3" />
                    </button>
                </div>

                <!-- Toggle Filters Button (Unified height and border radius, remove shadow-sm) -->
                <button
                    @click="showFilters = !showFilters"
                    :class="[
                        showFilters || source
                            ? 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300'
                            : 'bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-900',
                    ]"
                    class="flex h-9 w-9 rounded-full sm:h-9 sm:w-auto sm:rounded-full items-center justify-center gap-1.5 px-0 sm:px-2.5 lg:px-3.5 border text-xs font-semibold transition-all cursor-pointer select-none whitespace-nowrap shrink-0 active:scale-[0.95]"
                    title="Filters"
                >
                    <Filter class="w-3.5 h-3.5" />
                    <span class="hidden lg:inline">{{ $t("common.filters", "Filters") }}</span>
                    <span v-if="source" class="w-1.5 h-1.5 rounded-full bg-blue-600"></span>
                </button>

                <!-- Action Toolbar Divider -->
                <div class="h-5 w-px bg-gray-200 hidden sm:block mx-0.5"></div>

                <!-- Batch Select Button (Unified height, remove shadow-sm) -->
                <button
                    @click="toggleSelectionMode"
                    :class="[
                        isSelectionMode
                            ? 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300'
                            : 'bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-900',
                    ]"
                    class="flex h-9 w-9 rounded-full sm:h-9 sm:w-auto sm:rounded-full items-center justify-center gap-1.5 px-0 sm:px-2.5 lg:px-3 border text-xs font-semibold transition-all cursor-pointer select-none whitespace-nowrap shrink-0 active:scale-[0.95]"
                    title="Batch Select"
                >
                    <CheckSquare class="w-3.5 h-3.5" />
                    <span class="hidden lg:inline">{{ $t("common.batch_select", "Batch Select") }}</span>
                </button>

                <!-- Layout Switchers (Unified height and border radius, remove shadow-sm) -->
                <div class="hidden sm:flex items-center gap-0.5 bg-gray-100/70 p-0.5 rounded-full border border-gray-200/50 shrink-0 h-9">
                    <button
                        class="flex items-center justify-center h-7 w-7 bg-white text-gray-900 border border-gray-200/30 rounded-full transition-all cursor-pointer"
                        title="Grid Layout"
                    >
                        <LayoutGrid class="w-3.5 h-3.5" />
                    </button>
                    <button
                        class="flex items-center justify-center h-7 w-7 text-gray-500 hover:text-gray-900 hover:bg-white/50 rounded-full transition-all cursor-pointer"
                        title="List Layout"
                    >
                        <List class="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </div>

        <div
            class="sticky top-15 sm:top-14 z-20 transition-all duration-300 ease-in-out border-b border-[#c2c6d6]/30 bg-[#f9f9ff] flex flex-col shrink-0 overflow-hidden"
            :class="[showFilters ? 'max-h-90 p-5 opacity-100' : 'max-h-0 py-0! opacity-0 border-b-0']"
        >
            <div class="space-y-4">
                <!-- Platform pill tags (Horizontal Scrollable list matching Stitch, remove shadow-sm) -->
                <div class="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                    <span class="text-[#424754] font-semibold text-xs whitespace-nowrap select-none mr-2"
                        >{{ $t("common.platform", "Platform") }}:</span
                    >
                    <button
                        v-for="p in platforms"
                        :key="String(p.value)"
                        @click="source = p.value"
                        class="px-4 py-1.5 rounded-full border text-xs font-semibold transition-all cursor-pointer whitespace-nowrap"
                        :class="
                            source === p.value
                                ? 'bg-[#151c27] border-transparent text-[#f9f9ff]'
                                : 'bg-white border-[#c2c6d6]/60 text-[#424754] hover:bg-[#f9f9ff] hover:text-[#151c27] hover:border-[#c2c6d6]/80'
                        "
                    >
                        {{ p.label }}
                    </button>
                </div>

                <!-- Sorting and Dropdowns row -->
                <div class="flex flex-wrap items-center gap-4 sm:gap-6 text-xs border-t border-[#c2c6d6]/30 pt-3.5">
                    <!-- Sort by Dropdown -->
                    <div class="flex items-center gap-2">
                        <span class="text-[#424754] font-semibold select-none">{{ $t("common.sort_by", "Sort by") }}:</span>
                        <div class="relative">
                            <select
                                class="appearance-none bg-white border border-[#c2c6d6]/60 hover:border-[#c2c6d6]/80 text-[#151c27] rounded-lg py-1.5 pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-[#0058be]/10 cursor-pointer transition-all"
                            >
                                <option>Latest</option>
                                <option>Oldest</option>
                            </select>
                            <ChevronDown
                                class="w-3.5 h-3.5 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            />
                        </div>
                    </div>

                    <!-- Media Type Dropdown -->
                    <div class="flex items-center gap-2">
                        <span class="text-[#424754] font-semibold select-none">Media Type:</span>
                        <div class="relative">
                            <select
                                class="appearance-none bg-white border border-[#c2c6d6]/60 hover:border-[#c2c6d6]/80 text-[#151c27] rounded-lg py-1.5 pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-[#0058be]/10 cursor-pointer transition-all"
                            >
                                <option>All Types</option>
                                <option>Video Only</option>
                                <option>Image Only</option>
                            </select>
                            <ChevronDown
                                class="w-3.5 h-3.5 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            />
                        </div>
                    </div>

                    <!-- Items per Page Dropdown -->
                    <div class="flex items-center gap-2">
                        <span class="text-[#424754] font-semibold select-none">{{ $t("grid.items_per_page_label", "每页显示") }}:</span>
                        <div class="relative">
                            <select
                                v-model="pageSize"
                                class="appearance-none bg-white border border-[#c2c6d6]/60 hover:border-[#c2c6d6]/80 text-[#151c27] rounded-lg py-1.5 pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-[#0058be]/10 cursor-pointer transition-all"
                            >
                                <option :value="20">20</option>
                                <option :value="50">50</option>
                                <option :value="100">100</option>
                            </select>
                            <ChevronDown
                                class="w-3.5 h-3.5 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Content -->
        <div ref="scrollContainer" class="flex-1 overflow-y-auto p-6 pb-0 sm:pb-6">
            <div
                v-if="Array.isArray(posts)"
                ref="gridContainer"
                class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 pb-[calc(3.75rem+env(safe-area-inset-bottom)+var(--visual-viewport-bottom-offset,0))] sm:pb-0"
            >
                <PostCard
                    v-for="(post, index) in posts"
                    :key="post.id"
                    :post="post"
                    :is-selected="selectedPostId === post.id"
                    :is-checked="isPostChecked(post.id)"
                    :show-checkbox="isSelectionMode || isPostChecked(post.id)"
                    :data-index="index"
                    @toggle-checked="setPostChecked(post.id, $event)"
                    @click="handlePostClick(post, $event)"
                />
            </div>
        </div>

        <!-- Footer / Pagination -->
        <div
            class="fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom)+var(--visual-viewport-bottom-offset,0))] right-4 z-30 h-10 px-1 bg-white/90 backdrop-blur-md border border-slate-200 rounded-full flex items-center justify-center w-max sm:relative sm:bottom-auto sm:left-auto sm:right-auto sm:translate-x-0 sm:z-auto sm:h-14 sm:px-6 sm:border-0 sm:border-t sm:border-slate-100 sm:rounded-none sm:bg-white/95 sm:w-full sm:justify-between"
        >
            <!-- Left side: Total items count (hidden on mobile, shown on desktop) -->
            <div class="hidden sm:block text-slate-500 text-sm select-none font-medium">
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
                        <div class="flex sm:hidden items-center p-0.5">
                            <PaginationPrev as-child>
                                <Button
                                    variant="ghost"
                                    class="w-8 h-8 rounded-full p-0 text-slate-600 hover:text-slate-900"
                                    :disabled="isPrevDisabled"
                                >
                                    <ChevronLeft class="w-4 h-4" />
                                </Button>
                            </PaginationPrev>
                            <NumberField v-if="isEditingPage" v-model="mobileJumpPage" :min="1" :max="totalPages" class="w-12 h-6">
                                <NumberFieldInput
                                    ref="mobileInputRef"
                                    class="w-12 h-6 text-center p-0 bg-slate-50 border-slate-200 text-xs font-semibold tabular-nums"
                                    @blur="finishEditingPage"
                                    @keyup.enter="finishEditingPage"
                                />
                            </NumberField>
                            <span
                                v-else
                                @click="startEditingPage"
                                class="text-xs font-semibold text-slate-700 px-3 min-w-14 text-center cursor-pointer hover:bg-slate-100/80 active:bg-slate-200/50 py-1 rounded-md transition-colors select-none tabular-nums"
                            >
                                {{ page }} / {{ totalPages }}
                            </span>
                            <PaginationNext as-child>
                                <Button
                                    variant="ghost"
                                    class="w-8 h-8 rounded-full p-0 text-slate-600 hover:text-slate-900"
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
                                    class="w-9 h-9 rounded-lg border-slate-200/80 hover:bg-slate-50 text-slate-700 p-0"
                                    :disabled="isPrevDisabled"
                                >
                                    <ChevronLeft class="w-4 h-4" />
                                </Button>
                            </PaginationPrev>

                            <template v-for="(p, index) in items" :key="index">
                                <PaginationListItem v-if="p.type === 'page'" :value="p.value" as-child>
                                    <Button
                                        :variant="p.value === page ? 'default' : 'outline'"
                                        class="w-9 h-9 rounded-lg border-slate-200/80 text-slate-700 p-0 tabular-nums transition-all"
                                        :class="
                                            p.value === page
                                                ? 'bg-slate-900 hover:bg-slate-800 text-white border-transparent'
                                                : 'hover:bg-slate-50'
                                        "
                                    >
                                        {{ p.value }}
                                    </Button>
                                </PaginationListItem>
                                <PaginationEllipsis v-else-if="p.type === 'ellipsis'" class="w-9 h-9 flex items-center justify-center">
                                    <MoreHorizontal class="w-4 h-4 text-gray-400" />
                                </PaginationEllipsis>
                            </template>

                            <PaginationNext as-child>
                                <Button
                                    variant="outline"
                                    class="w-9 h-9 rounded-lg border-slate-200/80 hover:bg-slate-50 text-slate-700 p-0"
                                    :disabled="isNextDisabled"
                                >
                                    <ChevronRight class="w-4 h-4" />
                                </Button>
                            </PaginationNext>
                        </div>
                    </PaginationList>
                </PaginationRoot>

                <div class="hidden sm:flex items-center gap-3 border-l border-gray-200 pl-4 tabular-nums">
                    <i18n-t
                        tag="div"
                        keypath="grid.page_info"
                        scope="global"
                        class="hidden sm:flex items-center gap-1.5 text-gray-500 text-sm"
                    >
                        <template #current>
                            <NumberField v-model="jumpPage" :min="1" :max="totalPages" class="w-10 h-7">
                                <NumberFieldInput
                                    class="w-10 h-7 text-center p-0 bg-slate-50/50 border-slate-200 text-sm tabular-nums"
                                    @keyup.enter="handleJump"
                                    @blur="handleJump"
                                />
                            </NumberField>
                        </template>
                        <template #total>
                            <span class="font-medium text-gray-700">{{ totalPages }}</span>
                        </template>
                    </i18n-t>
                </div>
            </div>
        </div>

        <MoveItemsBar
            v-if="isSelectionMode || selectedPostCount > 0"
            :post-ids="selectedPostIdList"
            :media-ids="[]"
            :all-visible-selected="areAllVisiblePostsSelected"
            :can-select-visible="visiblePostIds.length > 0"
            @toggle-visible="toggleVisiblePosts"
            @moved="handleMoved"
            @cancel="exitSelectionMode"
        />
    </div>
</template>
