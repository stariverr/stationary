<script setup lang="ts">
import type { Post } from '@/types/post';
import { CheckSquare, ChevronLeft, ChevronRight, LayoutGrid, List, Menu, Search, X, MoreHorizontal } from '@lucide/vue';
import { useDebounceFn } from '@vueuse/core';
import { PaginationRoot, PaginationList, PaginationListItem, PaginationPrev, PaginationNext, PaginationEllipsis } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { useLibraryStore } from '@/stores/library';

const { posts, selectedPostId, selectPost, fetchPosts, isLoading, keyword, source, total, page } = usePosts();
const { toggleSidebar } = useLayout();
const libraryStore = useLibraryStore();

const PAGE_SIZE = 20;
const totalPages = computed(() => Math.ceil((total.value || 0) / PAGE_SIZE));
const selectedPostIds = ref<Set<string>>(new Set());
const isSelectionMode = ref(false);
const selectedPostIdList = computed(() => Array.from(selectedPostIds.value));
const selectedPostCount = computed(() => selectedPostIds.value.size);
const visiblePostIds = computed(() => ((posts.value as Post[]) || []).map((post) => String(post.id)));
const areAllVisiblePostsSelected = computed(() => visiblePostIds.value.length > 0 && visiblePostIds.value.every((id) => selectedPostIds.value.has(id)));

const debouncedFetch = useDebounceFn(() => {
    page.value = 1;
    fetchPosts({ page: 1, count: PAGE_SIZE });
}, 500);

watch(keyword, () => {
    debouncedFetch();
});

watch(source, () => {
    page.value = 1;
    fetchPosts({ page: 1, count: PAGE_SIZE });
});

watch(
    () => [keyword.value, source.value, libraryStore.activeLibraryId],
    () => {
        exitSelectionMode();
    },
);

const clearSearch = () => {
    keyword.value = '';
};

const platforms = [
    { label: 'All', value: undefined },
    { label: 'Douyin', value: 'DOUYIN' },
    { label: 'XHS', value: 'XHS' },
    { label: 'Bilibili', value: 'BILIBILI' },
    { label: 'X', value: 'X' },
    { label: 'TikTok', value: 'TIKTOK' },
    { label: 'Instagram', value: 'INSTAGRAM' },
    { label: 'Youtube', value: 'YOUTUBE' },
];

const changePage = async (newPage: number) => {
    if (newPage < 1 || newPage > totalPages.value) return;
    page.value = newPage;
    await fetchPosts({ page: newPage, count: PAGE_SIZE });
    // Scroll content area back to top
    nextTick(() => {
        const contentArea = document.querySelector('.flex-1.overflow-y-auto.p-6');
        if (contentArea) contentArea.scrollTop = 0;
    });
}

const isPrevDisabled = computed(() => page.value <= 1 || isLoading.value);
const isNextDisabled = computed(() => (totalPages.value && page.value >= totalPages.value) || isLoading.value);

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
}

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
}

const toggleSelectionMode = () => {
    if (isSelectionMode.value) {
        exitSelectionMode();
        return;
    }

    isSelectionMode.value = true;
}

const clearSelectedPosts = () => {
    selectedPostIds.value = new Set();
}

const exitSelectionMode = () => {
    clearSelectedPosts();
    isSelectionMode.value = false;
}

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
}

const handleMoved = async () => {
    exitSelectionMode();
    await fetchPosts({ page: page.value, count: PAGE_SIZE });
}

const handlePostClick = (post: Post) => {
    if (isSelectionMode.value || isPostChecked(post.id)) {
        setPostChecked(post.id, !isPostChecked(post.id));
        return;
    }

    selectPost(post.id);
}

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
}

const handleKeydown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

    e.preventDefault();

    const postsArray = posts.value as Post[];
    const currentIndex = postsArray.findIndex(p => p.id === selectedPostId.value);

    if (currentIndex === -1) {
        const firstPost = postsArray[0];
        if (firstPost) {
            selectPost(firstPost.id);
        }
        return;
    }

    const columns = getColumns();
    let nextIndex = currentIndex;

    if (e.key === 'ArrowRight') nextIndex++;
    if (e.key === 'ArrowLeft') nextIndex--;
    if (e.key === 'ArrowDown') nextIndex += columns;
    if (e.key === 'ArrowUp') nextIndex -= columns;

    if (nextIndex >= 0 && nextIndex < postsArray.length) {
        const nextPost = postsArray[nextIndex];
        if (nextPost) {
            selectPost(nextPost.id);

            nextTick(() => {
                const container = gridContainer.value;
                if (!container) return;

                const child = container.children[nextIndex] as HTMLElement | undefined;
                if (child) {
                    child.scrollIntoView({ block: 'nearest' });
                }
            });
        }
    }
}

onMounted(() => {
    fetchPosts({ count: PAGE_SIZE }); // Initial fetch
    window.addEventListener('keydown', handleKeydown);
})

onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown);
})
</script>

<template>
    <div class="flex-1 min-h-0 flex flex-col bg-white overflow-hidden relative">
        <!-- Header -->
        <div class="h-14 border-b border-gray-100 flex items-center justify-between px-6 shrink-0">
            <div class="flex items-center gap-3">
                <button @click="toggleSidebar"
                    class="md:hidden p-1.5 -ml-2 hover:bg-gray-100 rounded-md text-gray-500 transition-colors">
                    <Menu class="w-5 h-5" />
                </button>
                <h1 class="text-xl font-semibold text-gray-900 hidden sm:block">{{ $t('common.all_posts') }}</h1>
            </div>

            <div class="flex-1 max-w-2xl px-4 flex items-center gap-3">
                <!-- Platform Select -->
                <div class="relative min-w-[120px]">
                    <select v-model="source"
                        class="w-full bg-gray-50 border border-gray-100 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 appearance-none pr-8 cursor-pointer hover:bg-gray-100 transition-colors">
                        <option v-for="p in platforms" :key="String(p.value)" :value="p.value">
                            {{ p.label }}
                        </option>
                    </select>
                    <div class="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none text-gray-400">
                        <ChevronRight class="w-4 h-4 rotate-90" />
                    </div>
                </div>

                <!-- Search Input -->
                <div class="relative flex-1 group">
                    <Search
                        class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-blue-500 transition-colors" />
                    <input v-model="keyword" type="text" :placeholder="$t('common.search', 'Search posts...')"
                        class="w-full bg-gray-50 border border-gray-100 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block pl-10 pr-10 py-2 hover:bg-gray-100 focus:bg-white transition-all outline-none" />
                    <button v-if="keyword" @click="clearSearch"
                        class="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-200 rounded-full transition-colors text-gray-400">
                        <X class="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            <div class="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    :class="isSelectionMode ? 'bg-gray-100 text-gray-900' : 'text-gray-500'"
                    :aria-pressed="isSelectionMode"
                    aria-label="Select items"
                    title="Select items"
                    @click="toggleSelectionMode"
                >
                    <CheckSquare />
                </Button>
                <button class="p-1.5 hover:bg-gray-100 rounded-md text-gray-500 transition-colors">
                    <LayoutGrid class="w-5 h-5" />
                </button>
                <button class="p-1.5 hover:bg-gray-100 rounded-md text-gray-500 transition-colors">
                    <List class="w-5 h-5" />
                </button>
            </div>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto p-6">
            <div v-if="Array.isArray(posts)" ref="gridContainer"
                class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
                <PostCard v-for="(post, index) in posts" :key="post.id" :post="post"
                    :is-selected="selectedPostId === post.id"
                    :is-checked="isPostChecked(post.id)"
                    :show-checkbox="isSelectionMode || isPostChecked(post.id)"
                    :data-index="index"
                    @toggle-checked="setPostChecked(post.id, $event)"
                    @click="handlePostClick(post)" />
            </div>
        </div>

        <!-- Footer / Pagination -->
        <div class="h-14 border-t border-gray-100 flex items-center justify-between px-6 shrink-0 text-sm text-gray-500 bg-white">
            <div class="hidden sm:block tabular-nums">
                {{ Array.isArray(posts) ? $t('grid.showing_items', { count: posts.length }) : '' }}
            </div>

            <div class="flex items-center gap-4">
                <PaginationRoot :total="total || 0" :sibling-count="1" :items-per-page="PAGE_SIZE" :page="page"
                    @update:page="changePage" class="flex items-center">
                    <PaginationList v-slot="{ items }" class="flex items-center gap-1">
                        <PaginationPrev as-child>
                            <Button variant="outline" class="w-9 h-9 p-0" :disabled="isPrevDisabled">
                                <ChevronLeft class="w-4 h-4" />
                            </Button>
                        </PaginationPrev>

                        <template v-for="(p, index) in items" :key="index">
                            <PaginationListItem v-if="p.type === 'page'" :value="p.value" as-child>
                                <Button :variant="p.value === page ? 'default' : 'outline'"
                                    class="w-9 h-9 p-0 tabular-nums">
                                    {{ p.value }}
                                </Button>
                            </PaginationListItem>
                            <PaginationEllipsis v-else-if="p.type === 'ellipsis'"
                                class="w-9 h-9 flex items-center justify-center">
                                <MoreHorizontal class="w-4 h-4 text-gray-400" />
                            </PaginationEllipsis>
                        </template>

                        <PaginationNext as-child>
                            <Button variant="outline" class="w-9 h-9 p-0" :disabled="isNextDisabled">
                                <ChevronRight class="w-4 h-4" />
                            </Button>
                        </PaginationNext>
                    </PaginationList>
                </PaginationRoot>

                <div class="flex items-center gap-3 border-l border-gray-200 pl-4 tabular-nums">
                    <i18n-t keypath="grid.page_info" scope="global" class="flex items-center gap-1.5 text-gray-500 text-sm hidden sm:flex">
                        <template #current>
                            <input v-model="jumpPage" type="text"
                                class="w-10 h-7 text-center bg-gray-50 border border-gray-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all tabular-nums"
                                @keyup.enter="handleJump" @blur="handleJump" />
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
