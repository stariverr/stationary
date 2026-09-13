import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { Temporal } from "@js-temporal/polyfill";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/vue-query";
import { useLibraryStore } from "@/stores/library";
import { useApi } from "@/composables/useApi";

export type TrashType = "all" | "post" | "media";

export interface TrashPreviewItem {
    id: string;
    url: string;
    thumbnail?: string | null;
    mime_type?: string | null;
    width?: number | null;
    height?: number | null;
}

export interface TrashPostItem {
    item_type: "post";
    id: string;
    library_id: string;
    eid: string;
    title: string;
    description: string;
    source: string;
    author_name: string;
    author_avatar_url: string | null;
    create_time: string | null;
    published_time: string | null;
    recycle_time: string | null;
    media_count: number;
    covers: TrashPreviewItem[];
    tags: string[];
    formatted_recycle_time: string;
}

export interface TrashMediaItem {
    item_type: "media";
    id: string;
    library_id: string;
    eid: string;
    title: string | null;
    description: string | null;
    source: string;
    type: string;
    create_time: string | null;
    published_time: string | null;
    recycle_time: string | null;
    covers: TrashPreviewItem[];
    url: string | null;
    formatted_recycle_time: string;
}

export type TrashItem = TrashPostItem | TrashMediaItem;

export const useTrashStore = defineStore("trash", () => {
    const route = useRoute();
    const router = useRouter();
    const queryClient = useQueryClient();
    const libraryStore = useLibraryStore();

    const activeLibraryId = computed(() => libraryStore.activeLibraryId);

    // Filter & Pagination state
    const activeTab = ref<TrashType>((route.query.tab as TrashType) || "all");
    const keyword = ref((route.query.keyword as string) || "");
    const searchKeyword = ref(keyword.value);
    const page = ref(parseInt(route.query.page as string) || 1);
    const count = ref(parseInt(route.query.count as string) || 20);

    // Multi-select state
    const selectedItemIds = ref<Set<string>>(new Set());
    const isSelectionMode = ref(false);

    // Debounce keyword search
    let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
    watch(keyword, (newVal) => {
        if (debounceTimeout) clearTimeout(debounceTimeout);
        if (!newVal) {
            searchKeyword.value = "";
            page.value = 1;
            return;
        }
        debounceTimeout = setTimeout(() => {
            searchKeyword.value = newVal;
            page.value = 1;
        }, 400);
    });

    // Reset pagination and clear selection on filter changes
    watch([activeTab, () => libraryStore.activeLibraryId], () => {
        page.value = 1;
        selectedItemIds.value.clear();
    });

    // Sync URL queries
    watch(
        () => ({
            tab: activeTab.value,
            keyword: keyword.value,
            page: page.value,
            count: count.value,
        }),
        ({ tab: newTab, keyword: newKeyword, page: newPage, count: newCount }) => {
            if (!route.path.startsWith("/trash")) return;
            const query = { ...route.query };
            let changed = false;

            if (newTab !== "all") {
                if (query.tab !== newTab) {
                    query.tab = newTab;
                    changed = true;
                }
            } else if (query.tab) {
                delete query.tab;
                changed = true;
            }

            if (newKeyword) {
                if (query.keyword !== newKeyword) {
                    query.keyword = newKeyword;
                    changed = true;
                }
            } else if (query.keyword) {
                delete query.keyword;
                changed = true;
            }

            if (newPage > 1) {
                if (query.page !== String(newPage)) {
                    query.page = String(newPage);
                    changed = true;
                }
            } else if (query.page) {
                delete query.page;
                changed = true;
            }

            if (newCount !== 20) {
                if (query.count !== String(newCount)) {
                    query.count = String(newCount);
                    changed = true;
                }
            } else if (query.count) {
                delete query.count;
                changed = true;
            }

            if (changed) {
                router.push({ query });
            }
        },
    );

    const formatRecycleTime = (isoString: string | null): string => {
        if (!isoString) return "";
        try {
            return Temporal.Instant.from(isoString).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(undefined, {
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

    const isListEnabled = computed(() => route.path.startsWith("/trash") && !!activeLibraryId.value);

    // TanStack Query for Trash Items
    const {
        data: trashData,
        isLoading,
        refetch,
    } = useQuery({
        queryKey: computed(() => ["trash", activeLibraryId.value, activeTab.value, searchKeyword.value, page.value, count.value]),
        enabled: isListEnabled,
        placeholderData: keepPreviousData,
        queryFn: async (): Promise<{ list: TrashItem[]; total: number }> => {
            if (!activeLibraryId.value) return { list: [], total: 0 };

            const response = await useApi<{
                success: boolean;
                data: {
                    list: Array<Omit<TrashPostItem, "formatted_recycle_time"> | Omit<TrashMediaItem, "formatted_recycle_time">>;
                    total: number;
                    page: number;
                    count: number;
                };
            }>("/trash/list", {
                query: {
                    library_id: activeLibraryId.value,
                    type: activeTab.value,
                    keyword: searchKeyword.value || undefined,
                    page: page.value,
                    count: count.value,
                },
            });

            if (response && response.success && response.data) {
                const mappedList: TrashItem[] = response.data.list.map((item) => {
                    return {
                        ...item,
                        formatted_recycle_time: formatRecycleTime(item.recycle_time),
                    } as TrashItem;
                });

                return {
                    list: mappedList,
                    total: response.data.total || 0,
                };
            }

            return { list: [], total: 0 };
        },
    });

    const items = computed<TrashItem[]>(() => trashData.value?.list || []);
    const total = computed<number>(() => trashData.value?.total || 0);

    const selectedItemsCount = computed(() => selectedItemIds.value.size);
    const areAllVisibleSelected = computed(() => items.value.length > 0 && items.value.every((item) => selectedItemIds.value.has(item.id)));

    const toggleSelectItem = (id: string) => {
        if (selectedItemIds.value.has(id)) {
            selectedItemIds.value.delete(id);
        } else {
            selectedItemIds.value.add(id);
        }
    };

    const selectAllVisible = () => {
        for (const item of items.value) {
            selectedItemIds.value.add(item.id);
        }
    };

    const deselectAll = () => {
        selectedItemIds.value.clear();
    };

    /**
     * Restore selected items from trash
     */
    const restoreSelected = async () => {
        if (!activeLibraryId.value || selectedItemIds.value.size === 0) return;

        const postIds: string[] = [];
        const mediaIds: string[] = [];

        for (const item of items.value) {
            if (selectedItemIds.value.has(item.id)) {
                if (item.item_type === "post") {
                    postIds.push(item.id);
                } else {
                    mediaIds.push(item.id);
                }
            }
        }

        const response = await useApi<{ success: boolean }>("/trash/restore", {
            method: "POST",
            body: {
                library_id: activeLibraryId.value,
                post_ids: postIds.length > 0 ? postIds : undefined,
                media_ids: mediaIds.length > 0 ? mediaIds : undefined,
            },
        });

        if (response && response.success) {
            deselectAll();
            refetch();
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            queryClient.invalidateQueries({ queryKey: ["media"] });
        }
        return response;
    };

    /**
     * Permanently delete selected items from trash
     */
    const deleteSelected = async () => {
        if (!activeLibraryId.value || selectedItemIds.value.size === 0) return;

        const postIds: string[] = [];
        const mediaIds: string[] = [];

        for (const item of items.value) {
            if (selectedItemIds.value.has(item.id)) {
                if (item.item_type === "post") {
                    postIds.push(item.id);
                } else {
                    mediaIds.push(item.id);
                }
            }
        }

        const response = await useApi<{ success: boolean }>("/trash/delete", {
            method: "POST",
            body: {
                library_id: activeLibraryId.value,
                post_ids: postIds.length > 0 ? postIds : undefined,
                media_ids: mediaIds.length > 0 ? mediaIds : undefined,
            },
        });

        if (response && response.success) {
            deselectAll();
            refetch();
        }
        return response;
    };

    /**
     * Restore a single post or media item
     */
    const restoreSingle = async (item: TrashItem) => {
        if (!activeLibraryId.value) return;

        const endpoint = item.item_type === "post" ? `/post/restore/${item.id}` : `/media/restore/${item.id}`;
        const response = await useApi<{ success: boolean }>(endpoint, {
            method: "POST",
        });

        if (response && response.success) {
            selectedItemIds.value.delete(item.id);
            refetch();
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            queryClient.invalidateQueries({ queryKey: ["media"] });
        }
        return response;
    };

    /**
     * Permanently delete a single post or media item
     */
    const deleteSingle = async (item: TrashItem) => {
        if (!activeLibraryId.value) return;

        const endpoint = item.item_type === "post" ? `/post/delete/${item.id}` : `/media/delete/${item.id}`;
        const response = await useApi<{ success: boolean }>(endpoint, {
            method: "POST",
        });

        if (response && response.success) {
            selectedItemIds.value.delete(item.id);
            refetch();
        }
        return response;
    };

    /**
     * Empty entire trash for the active library
     */
    const emptyTrash = async () => {
        if (!activeLibraryId.value) return;

        const response = await useApi<{ success: boolean }>("/trash/empty", {
            method: "POST",
            body: {
                library_id: activeLibraryId.value,
            },
        });

        if (response && response.success) {
            deselectAll();
            refetch();
        }
        return response;
    };

    return {
        // State
        activeTab,
        keyword,
        searchKeyword,
        page,
        count,
        selectedItemIds,
        isSelectionMode,
        // Computed
        items,
        total,
        isLoading,
        selectedItemsCount,
        areAllVisibleSelected,
        // Actions
        refetch,
        toggleSelectItem,
        selectAllVisible,
        deselectAll,
        restoreSelected,
        deleteSelected,
        restoreSingle,
        deleteSingle,
        emptyTrash,
    };
});
