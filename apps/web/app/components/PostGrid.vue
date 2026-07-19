<script setup lang="ts">
import type { Post } from "@/types/post";
import {
    Check,
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
    User,
    Tag as TagIcon,
    Plus,
} from "@lucide/vue";
import { useDebounceFn, onClickOutside } from "@vueuse/core";
import { PaginationRoot, PaginationList, PaginationListItem, PaginationPrev, PaginationNext, PaginationEllipsis } from "reka-ui";
import { Button } from "@/components/ui/button";
import { NumberField, NumberFieldInput } from "@/components/ui/number-field";
import { useVisualViewportBottomOffset } from "@/composables/useVisualViewportBottomOffset";
import { useLibraryStore } from "@/stores/library";
import { useTagStore } from "@/stores/tag";

const {
    posts,
    selectedPostId,
    selectPost,
    fetchPosts,
    isLoading,
    keyword,
    source,
    total,
    page,
    count,
    sortBy,
    sortOrder,
    authorIds,
    tagIds,
    mediaType,
    authors,
    authorSearchKeyword,
    authorCache,
} = usePosts();
const { toggleSidebar, isCreatePostOpen } = useAppLayout();
const libraryStore = useLibraryStore();
const tagStore = useTagStore();
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

const sortValue = computed({
    get: () => `${sortBy.value}_${sortOrder.value}`,
    set: (val) => {
        const parts = val.split("_");
        const order = parts.pop() || "desc";
        const by = parts.join("_");
        sortBy.value = by;
        sortOrder.value = order;
    },
});

const showAuthorDropdown = ref(false);
const authorDropdownRef = ref<HTMLElement | null>(null);
const localAuthorSearch = ref("");

const debounceSearchAuthor = useDebounceFn((val: string) => {
    authorSearchKeyword.value = val;
}, 300);

watch(localAuthorSearch, (newVal) => {
    debounceSearchAuthor(newVal);
});

onClickOutside(authorDropdownRef, () => {
    showAuthorDropdown.value = false;
});

const toggleAuthor = (id: string) => {
    const index = authorIds.value.indexOf(id);
    if (index > -1) {
        authorIds.value = authorIds.value.filter((aid) => aid !== id);
    } else {
        authorIds.value = [...authorIds.value, id];
    }
};

const removeAuthor = (id: string) => {
    authorIds.value = authorIds.value.filter((aid) => aid !== id);
};

const getAuthorName = (id: string) => {
    const auth = authorCache.value[id];
    return auth ? auth.nickname : "Loading...";
};

const getAuthorPlatform = (id: string) => {
    const auth = authorCache.value[id];
    return auth ? auth.platform : "";
};

const getPlatformStyle = (platform: string) => {
    switch (platform) {
        case "XHS":
            return "bg-red-50 text-red-600 border border-red-100/60";
        case "DOUYIN":
            return "bg-slate-900/5 text-slate-800 border border-slate-200/50";
        case "BILIBILI":
            return "bg-pink-50 text-pink-600 border border-pink-100/60";
        case "X":
            return "bg-slate-100 text-slate-700 border border-slate-200/60";
        case "TIKTOK":
            return "bg-teal-50 text-teal-700 border border-teal-100/60";
        case "INSTAGRAM":
            return "bg-purple-50 text-purple-600 border border-purple-100/60";
        case "YOUTUBE":
            return "bg-rose-50 text-rose-600 border border-rose-100/60";
        default:
            return "bg-slate-100 text-slate-500 border border-slate-200/40";
    }
};

// Tag Dropdown States and Handlers
const showTagDropdown = ref(false);
const tagDropdownRef = ref<HTMLElement | null>(null);
const localTagSearch = ref("");

const filteredTags = computed(() => {
    const search = localTagSearch.value.trim().toLowerCase();
    if (!search) return tagStore.activeTags;
    return tagStore.activeTags.filter((t) => t.name.toLowerCase().includes(search));
});

onClickOutside(tagDropdownRef, () => {
    showTagDropdown.value = false;
});

const toggleTag = (id: string) => {
    const index = tagIds.value.indexOf(id);
    if (index > -1) {
        tagIds.value = tagIds.value.filter((tid) => tid !== id);
    } else {
        tagIds.value = [...tagIds.value, id];
    }
};

const removeTag = (id: string) => {
    tagIds.value = tagIds.value.filter((tid) => tid !== id);
};

const getTagName = (id: string) => {
    const tag = tagStore.tags.find((t) => t.id === id);
    return tag ? tag.name : "Loading...";
};

const getTagColor = (id: string) => {
    const tag = tagStore.tags.find((t) => t.id === id);
    return tag ? tag.color : null;
};

const normalizeColor = (color: string | null): string => {
    if (!color) return "";
    const trimmed = color.trim();
    if (trimmed.startsWith("#") || /^(oklch|rgb|hsl)/i.test(trimmed)) {
        return trimmed;
    }
    if (/^[0-9a-fA-F]{3,8}$/.test(trimmed)) {
        return `#${trimmed}`;
    }
    return trimmed;
};

const getTagStyle = (color: string | null) => {
    if (!color) {
        return {
            color: "#52525b",
            backgroundColor: "#f4f4f5",
            borderColor: "#d4d4d8",
        };
    }
    const normalized = normalizeColor(color);
    return {
        color: normalized,
        backgroundColor: `color-mix(in srgb, ${normalized} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${normalized} 27%, transparent)`,
    };
};

const hasActiveFilters = computed(() => {
    return !!source.value || authorIds.value.length > 0 || tagIds.value.length > 0 || !!mediaType.value;
});

watch(
    () => [
        keyword.value,
        source.value,
        sortBy.value,
        sortOrder.value,
        [...authorIds.value],
        [...tagIds.value],
        mediaType.value,
        libraryStore.activeLibraryId,
    ],
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
                        showFilters || hasActiveFilters
                            ? 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300'
                            : 'bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-900',
                    ]"
                    class="flex h-9 w-9 rounded-full sm:h-9 sm:w-auto sm:rounded-full items-center justify-center gap-1.5 px-0 sm:px-2.5 lg:px-3.5 border text-xs font-semibold transition-all cursor-pointer select-none whitespace-nowrap shrink-0 active:scale-[0.95]"
                    title="Filters"
                >
                    <Filter class="w-3.5 h-3.5" />
                    <span class="hidden lg:inline">{{ $t("common.filters", "Filters") }}</span>
                    <span v-if="hasActiveFilters" class="w-1.5 h-1.5 rounded-full bg-blue-600"></span>
                </button>

                <!-- Create Post Button moved to Left Sidebar -->

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
            class="sticky top-15 sm:top-14 z-20 transition-all duration-300 ease-in-out border-b border-[#c2c6d6]/30 bg-[#f9f9ff] flex flex-col shrink-0"
            :class="[showFilters ? 'max-h-90 p-5 opacity-100 overflow-visible' : 'max-h-0 py-0! opacity-0 border-b-0 overflow-hidden']"
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
                                v-model="sortValue"
                                class="h-9 appearance-none bg-white border border-slate-200 hover:border-slate-300 text-slate-700 rounded-lg pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-blue-500/10 cursor-pointer transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                            >
                                <option value="import_time_desc">
                                    {{ $t("common.sort_import_time_desc", "Import Time (New -> Old)") }}
                                </option>
                                <option value="import_time_asc">{{ $t("common.sort_import_time_asc", "Import Time (Old -> New)") }}</option>
                                <option value="published_time_desc">
                                    {{ $t("common.sort_published_time_desc", "Creation Time (New -> Old)") }}
                                </option>
                                <option value="published_time_asc">
                                    {{ $t("common.sort_published_time_asc", "Creation Time (Old -> New)") }}
                                </option>
                            </select>
                            <ChevronDown
                                class="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            />
                        </div>
                    </div>

                    <!-- Author Dropdown -->
                    <div ref="authorDropdownRef" class="flex items-center gap-2 relative">
                        <span class="text-[#424754] font-semibold select-none">{{ $t("common.author", "Author") }}:</span>
                        <div class="relative">
                            <button
                                @click="showAuthorDropdown = !showAuthorDropdown"
                                type="button"
                                class="flex items-center flex-wrap gap-1.5 bg-white hover:bg-slate-50/10 border border-slate-200 hover:border-slate-300 text-[#151c27] rounded-lg py-2 px-2.5 text-xs font-semibold outline-none focus:ring-2 focus:ring-[#0058be]/10 cursor-pointer transition-all select-none min-h-9 min-w-48 max-w-md w-auto shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                            >
                                <div class="flex items-center gap-1.5 pl-1 pr-1 py-0.5 text-slate-500 shrink-0 select-none">
                                    <User class="w-3.5 h-3.5 text-slate-400" />
                                    <span v-if="authorIds.length === 0" class="text-slate-700 font-semibold">{{
                                        $t("common.all_authors", "All Authors")
                                    }}</span>
                                </div>
                                <div v-if="authorIds.length > 0" class="flex flex-wrap gap-1.5 items-center">
                                    <template v-if="authorIds.length <= 2">
                                        <span
                                            v-for="id in authorIds"
                                            :key="id"
                                            class="inline-flex items-center gap-1.5 bg-slate-100/90 border border-slate-200/50 text-slate-700 pl-2 pr-1 py-1 rounded text-xs font-semibold transition-all hover:bg-slate-200/50 hover:text-slate-900"
                                            @click.stop
                                        >
                                            <span class="truncate max-w-16 text-slate-800">{{ getAuthorName(id) }}</span>
                                            <span
                                                class="text-[9px] leading-3 font-bold border px-1 py-px rounded scale-95 origin-left shrink-0 animate-in fade-in"
                                                :class="getPlatformStyle(getAuthorPlatform(id))"
                                            >
                                                {{ $t(`platforms.${getAuthorPlatform(id)}`, getAuthorPlatform(id)) }}
                                            </span>
                                            <span
                                                @click.stop="removeAuthor(id)"
                                                class="text-slate-400 hover:text-slate-600 transition-all hover:bg-slate-200/80 p-0.5 rounded cursor-pointer shrink-0"
                                            >
                                                <X class="w-3 h-3 stroke-[2.5]" />
                                            </span>
                                        </span>
                                    </template>
                                    <template v-else>
                                        <span
                                            class="bg-blue-50 border border-blue-100 text-blue-600 px-2 py-0.5 rounded text-[11px] font-bold shrink-0 animate-in fade-in"
                                        >
                                            {{
                                                $t("common.n_authors_selected", { count: authorIds.length }, `${authorIds.length} Selected`)
                                            }}
                                        </span>
                                    </template>
                                </div>
                                <ChevronDown class="w-3.5 h-3.5 text-slate-400 shrink-0 ml-auto mr-1" />
                            </button>

                            <!-- Combobox Dropdown Card -->
                            <div
                                v-if="showAuthorDropdown"
                                class="absolute left-0 mt-1.5 w-64 bg-white/95 backdrop-blur-md border border-slate-200/80 rounded-xl shadow-[0_12px_30px_-4px_rgba(15,23,42,0.08),0_4px_12px_-2px_rgba(15,23,42,0.03)] z-40 p-1.5 flex flex-col gap-1.5 animate-in fade-in slide-in-from-top-1 duration-200"
                            >
                                <div
                                    class="flex items-center border border-slate-200/60 rounded-md bg-slate-50/50 px-2 h-8 gap-1.5 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/5 transition-all"
                                >
                                    <Search class="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                    <input
                                        v-model="localAuthorSearch"
                                        type="text"
                                        :placeholder="$t('common.search_authors_placeholder', 'Search authors...')"
                                        class="w-full text-xs font-semibold bg-transparent border-0 outline-none text-slate-700 placeholder:text-slate-400"
                                    />
                                    <button
                                        v-if="localAuthorSearch"
                                        @click="localAuthorSearch = ''"
                                        type="button"
                                        class="text-slate-400 hover:text-slate-600 cursor-pointer p-0.5 rounded-full hover:bg-slate-100"
                                    >
                                        <X class="w-3 h-3" />
                                    </button>
                                </div>
                                <div class="max-h-48 overflow-y-auto flex flex-col gap-0.5 pr-0.5 scrollbar-thin">
                                    <div
                                        v-for="author in authors"
                                        :key="author.id"
                                        @click="toggleAuthor(author.id)"
                                        class="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer select-none transition-colors group"
                                    >
                                        <div class="flex items-center gap-2 min-w-0">
                                            <div
                                                class="w-3.5 h-3.5 rounded flex items-center justify-center border shrink-0 transition-all duration-150"
                                                :class="[
                                                    authorIds.includes(author.id)
                                                        ? 'border-blue-600 bg-blue-600 text-white'
                                                        : 'border-slate-300 bg-white group-hover:border-slate-400/80',
                                                ]"
                                            >
                                                <Check v-if="authorIds.includes(author.id)" class="w-2.5 h-2.5 stroke-3" />
                                            </div>
                                            <span class="text-xs font-semibold text-slate-700 truncate">
                                                {{ author.nickname }}
                                            </span>
                                        </div>
                                        <span
                                            class="text-[9px] font-bold border px-1.5 py-0.5 rounded shrink-0 ml-2 shadow-[0_1px_1px_rgba(0,0,0,0.01)] transition-colors duration-150"
                                            :class="getPlatformStyle(author.platform)"
                                        >
                                            {{ $t(`platforms.${author.platform}`, author.platform) }}
                                        </span>
                                    </div>
                                    <div
                                        v-if="authors.length === 0"
                                        class="text-center py-4 text-xs text-slate-400 font-medium select-none"
                                    >
                                        {{ $t("common.no_authors_found", "No authors found") }}
                                    </div>
                                </div>
                                <div
                                    v-if="authorIds.length > 0"
                                    class="border-t border-slate-100 pt-1.5 px-1 pb-0.5 shrink-0 flex items-center justify-between"
                                >
                                    <span class="text-[9px] text-slate-400 font-semibold pl-1 select-none">
                                        已选 {{ authorIds.length }} 位
                                    </span>
                                    <button
                                        @click="authorIds = []"
                                        type="button"
                                        class="text-[10px] font-bold text-rose-500 hover:text-rose-600 hover:bg-rose-50/50 px-2 py-0.5 rounded transition-colors cursor-pointer"
                                    >
                                        {{ $t("common.clear_all", "Clear") }}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Tag Dropdown -->
                    <div ref="tagDropdownRef" class="flex items-center gap-2 relative">
                        <span class="text-[#424754] font-semibold select-none">{{ $t("common.tags", "Tags") }}:</span>
                        <div class="relative">
                            <button
                                @click="showTagDropdown = !showTagDropdown"
                                type="button"
                                class="flex items-center flex-wrap gap-1.5 bg-white hover:bg-slate-50/10 border border-slate-200 hover:border-slate-300 text-[#151c27] rounded-lg py-2 px-2.5 text-xs font-semibold outline-none focus:ring-2 focus:ring-[#0058be]/10 cursor-pointer transition-all select-none min-h-9 min-w-48 max-w-md w-auto shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                            >
                                <div class="flex items-center gap-1.5 pl-1 pr-1 py-0.5 text-slate-500 shrink-0 select-none">
                                    <TagIcon class="w-3.5 h-3.5 text-slate-400" />
                                    <span v-if="tagIds.length === 0" class="text-slate-700 font-semibold">{{
                                        $t("common.all_tags", "All Tags")
                                    }}</span>
                                </div>
                                <div v-if="tagIds.length > 0" class="flex flex-wrap gap-1.5 items-center">
                                    <template v-if="tagIds.length <= 2">
                                        <span
                                            v-for="id in tagIds"
                                            :key="id"
                                            class="inline-flex items-center gap-1.5 border px-2 py-1 rounded text-xs font-semibold transition-all hover:opacity-85"
                                            :style="getTagStyle(getTagColor(id))"
                                            @click.stop
                                        >
                                            <span class="truncate max-w-16 text-slate-800">{{ getTagName(id) }}</span>
                                            <span
                                                @click.stop="removeTag(id)"
                                                class="text-slate-400 hover:text-slate-600 transition-all hover:bg-slate-200/80 p-0.5 rounded cursor-pointer shrink-0"
                                            >
                                                <X class="w-3 h-3 stroke-[2.5]" />
                                            </span>
                                        </span>
                                    </template>
                                    <template v-else>
                                        <span
                                            class="bg-blue-50 border border-blue-100 text-blue-600 px-2 py-0.5 rounded text-[11px] font-bold shrink-0 animate-in fade-in"
                                        >
                                            {{ $t("common.n_tags_selected", { count: tagIds.length }, `${tagIds.length} Selected`) }}
                                        </span>
                                    </template>
                                </div>
                                <ChevronDown class="w-3.5 h-3.5 text-slate-400 shrink-0 ml-auto mr-1" />
                            </button>

                            <!-- Combobox Dropdown Card -->
                            <div
                                v-if="showTagDropdown"
                                class="absolute right-0 mt-1.5 w-64 bg-white/95 backdrop-blur-md border border-slate-200/80 rounded-xl shadow-[0_12px_30px_-4px_rgba(15,23,42,0.08),0_4px_12px_-2px_rgba(15,23,42,0.03)] z-40 p-1.5 flex flex-col gap-1.5 animate-in fade-in slide-in-from-top-1 duration-200"
                            >
                                <div
                                    class="flex items-center border border-slate-200/60 rounded-md bg-slate-50/50 px-2 h-8 gap-1.5 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/5 transition-all"
                                >
                                    <Search class="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                    <input
                                        v-model="localTagSearch"
                                        type="text"
                                        :placeholder="$t('common.search_tags_placeholder', 'Search tags...')"
                                        class="w-full text-xs font-semibold bg-transparent border-0 outline-none text-slate-700 placeholder:text-slate-400"
                                    />
                                    <button
                                        v-if="localTagSearch"
                                        @click="localTagSearch = ''"
                                        type="button"
                                        class="text-slate-400 hover:text-slate-650 cursor-pointer p-0.5 rounded-full hover:bg-slate-100"
                                    >
                                        <X class="w-3 h-3" />
                                    </button>
                                </div>
                                <div class="max-h-48 overflow-y-auto flex flex-col gap-0.5 pr-0.5 scrollbar-thin">
                                    <div
                                        v-for="tag in filteredTags"
                                        :key="tag.id"
                                        @click="toggleTag(tag.id)"
                                        class="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer select-none transition-colors group"
                                    >
                                        <div class="flex items-center gap-2 min-w-0">
                                            <div
                                                class="w-3.5 h-3.5 rounded flex items-center justify-center border shrink-0 transition-all duration-150"
                                                :class="[
                                                    tagIds.includes(tag.id)
                                                        ? 'border-blue-600 bg-blue-600 text-white'
                                                        : 'border-slate-300 bg-white group-hover:border-slate-400/80',
                                                ]"
                                            >
                                                <Check v-if="tagIds.includes(tag.id)" class="w-2.5 h-2.5 stroke-3" />
                                            </div>
                                            <span class="text-xs font-semibold text-slate-700 truncate">
                                                {{ tag.name }}
                                            </span>
                                        </div>
                                        <span
                                            v-if="tag.color"
                                            class="w-2 h-2 rounded-full shrink-0 ml-2 shadow-[0_1px_1px_rgba(0,0,0,0.01)]"
                                            :style="{ backgroundColor: normalizeColor(tag.color) }"
                                        ></span>
                                    </div>
                                    <div
                                        v-if="filteredTags.length === 0"
                                        class="text-center py-4 text-xs text-slate-400 font-medium select-none"
                                    >
                                        {{ $t("common.no_tags_found", "No tags found") }}
                                    </div>
                                </div>
                                <div
                                    v-if="tagIds.length > 0"
                                    class="border-t border-slate-100 pt-1.5 px-1 pb-0.5 shrink-0 flex items-center justify-between"
                                >
                                    <span class="text-[9px] text-slate-400 font-semibold pl-1 select-none">
                                        已选 {{ tagIds.length }} 个
                                    </span>
                                    <button
                                        @click="tagIds = []"
                                        type="button"
                                        class="text-[10px] font-bold text-rose-500 hover:text-rose-600 hover:bg-rose-50/50 px-2 py-0.5 rounded transition-colors cursor-pointer"
                                    >
                                        {{ $t("common.clear_all", "Clear") }}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Media Type Dropdown -->
                    <div class="flex items-center gap-2">
                        <span class="text-[#424754] font-semibold select-none">{{ $t("common.media_type", "Media Type") }}:</span>
                        <div class="relative">
                            <select
                                v-model="mediaType"
                                class="h-9 appearance-none bg-white border border-slate-200 hover:border-slate-300 text-slate-700 rounded-lg pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-blue-500/10 cursor-pointer transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                            >
                                <option :value="undefined">{{ $t("common.all_media_types", "All Types") }}</option>
                                <option value="IMAGE">{{ $t("common.media_type_image", "Image") }}</option>
                                <option value="VIDEO">{{ $t("common.media_type_video", "Video") }}</option>
                                <option value="LIVE_PHOTO">{{ $t("common.media_type_live_photo", "Live Photo") }}</option>
                                <option value="AUDIO">{{ $t("common.media_type_audio", "Audio") }}</option>
                                <option value="PDF">{{ $t("common.media_type_pdf", "PDF") }}</option>
                            </select>
                            <ChevronDown
                                class="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            />
                        </div>
                    </div>

                    <!-- Items per Page Dropdown -->
                    <div class="flex items-center gap-2">
                        <span class="text-[#424754] font-semibold select-none">{{ $t("grid.items_per_page_label", "每页显示") }}:</span>
                        <div class="relative">
                            <select
                                v-model="pageSize"
                                class="h-9 appearance-none bg-white border border-slate-200 hover:border-slate-300 text-slate-700 rounded-lg pl-3 pr-8 text-xs font-semibold outline-none focus:ring-2 focus:ring-blue-500/10 cursor-pointer transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                            >
                                <option :value="20">20</option>
                                <option :value="50">50</option>
                                <option :value="100">100</option>
                            </select>
                            <ChevronDown
                                class="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
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

        <PostCreateDialog v-model:open="isCreatePostOpen" @created="fetchPosts" />
    </div>
</template>
