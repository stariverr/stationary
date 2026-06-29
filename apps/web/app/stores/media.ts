import { defineStore } from "pinia";
import { Temporal } from "@js-temporal/polyfill";
import { useQuery, keepPreviousData, useQueryClient } from "@tanstack/vue-query";
import { useLibraryStore } from "@/stores/library";

import * as v from "valibot";

export const MediaListResponseBodySchema = v.object({
    id: v.string(),
    eid: v.string(),
    post_id: v.nullable(v.string()),
    source: v.string(),
    title: v.nullable(v.string()),
    type: v.string(),
    create_time: v.string(),
    published_time: v.nullable(v.string()),
    post_media_count: v.nullable(v.number()),
    media_count: v.number(),
    url: v.nullable(v.string()),
    mime_type: v.optional(v.nullable(v.string())),
    cover_url: v.optional(v.nullable(v.string())),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
    ai_status: v.optional(v.nullable(v.string())),
    ai_error: v.optional(v.nullable(v.string())),
    matched_reason: v.optional(v.nullable(v.unknown())),
    matched_details: v.optional(v.nullable(v.unknown())),
    score: v.optional(v.nullable(v.number())),
});

export type MediaListItem = v.InferOutput<typeof MediaListResponseBodySchema>;

export interface MatchedDetails {
    keyword?: Record<string, unknown> | null;
    text_semantic?: {
        distance?: number | null;
        caption?: string | null;
    } | null;
    visual_semantic?: {
        distance?: number | null;
        scene?: string | null;
        styles?: string[] | null;
    } | null;
}

export interface MappedMediaItem {
    id: string;
    eid: string;
    post_id: string | null;
    source: string;
    title: string | null;
    type: string;
    create_time: string;
    published_time: string | null;
    post_media_count: number | null;
    media_count: number;
    url: string | null;
    mime_type: string | null;
    cover_url?: string | null;
    cover?: string | null;
    poster: string | null;
    sync_status: string;
    last_error: string | null;
    ai_status: string;
    ai_error: string | null;
    matched_reason?: unknown;
    matched_details?: MatchedDetails;
    score?: number | null;
    date: string;
    tags?: string[];
}

export const useMediaStore = defineStore("media", () => {
    const route = useRoute();
    const router = useRouter();
    const queryClient = useQueryClient();

    const libraryStore = useLibraryStore();

    // State
    const keyword = ref((route.query.keyword as string) || "");
    const searchKeyword = ref(keyword.value);
    const source = ref<string | undefined>((route.query.source as string) || undefined);
    const displayMode = ref<"flat" | "stacked">((route.query.display_mode as "flat" | "stacked") || "flat");
    const page = ref(parseInt(route.query.page as string) || 1);
    const count = ref(parseInt(route.query.count as string) || 20);
    const useAiSearch = ref(true);

    const selectedMediaId = ref<string | null>(null);

    // Debounce keyword search to prevent spamming backend requests
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
        }, 500);
    });

    // Reset page to 1 when search filters change
    watch([source, displayMode, useAiSearch], () => {
        page.value = 1;
    });

    // Reset page to 1 when library changes
    watch(
        () => libraryStore.activeLibraryId,
        () => {
            page.value = 1;
        },
    );

    // Sync URL
    watch(
        () => ({
            keyword: keyword.value,
            source: source.value,
            page: page.value,
            display_mode: displayMode.value,
            count: count.value,
        }),
        ({ keyword: newKeyword, source: newSource, page: newPage, display_mode: newDisplayMode, count: newCount }) => {
            const query = { ...route.query };
            let changed = false;

            if ("is_ai" in query) {
                delete query.is_ai;
                changed = true;
            }

            const updateParam = (key: string, value: string | undefined) => {
                if (value !== undefined) {
                    if (query[key] !== value) {
                        query[key] = value;
                        changed = true;
                    }
                } else {
                    if (query[key] !== undefined) {
                        delete query[key];
                        changed = true;
                    }
                }
            };

            updateParam("keyword", newKeyword || undefined);
            updateParam("source", newSource);
            updateParam("page", newPage && newPage > 1 ? newPage.toString() : undefined);
            updateParam("display_mode", newDisplayMode && newDisplayMode !== "flat" ? newDisplayMode : undefined);
            updateParam("count", newCount && newCount !== 20 ? newCount.toString() : undefined);

            if (changed) {
                router.push({ query });
            }
        },
    );

    watch(
        () => route.query,
        (newQuery) => {
            if ("is_ai" in newQuery) {
                const query = { ...newQuery };
                delete query.is_ai;
                router.replace({ query });
                return;
            }
            if (newQuery.keyword !== undefined && newQuery.keyword !== keyword.value) {
                keyword.value = (newQuery.keyword as string) || "";
            }
            if (newQuery.source !== undefined && newQuery.source !== source.value) {
                source.value = (newQuery.source as string) || undefined;
            }
            if (newQuery.display_mode !== undefined && newQuery.display_mode !== displayMode.value) {
                displayMode.value = (newQuery.display_mode as "flat" | "stacked") || "flat";
            }
            const queryPage = parseInt(newQuery.page as string) || 1;
            if (queryPage !== page.value) {
                page.value = queryPage;
            }
            const queryCount = parseInt(newQuery.count as string) || 20;
            if (queryCount !== count.value) {
                count.value = queryCount;
            }
        },
        { deep: true },
    );

    const mapApiMediaToUiMedia = (apiMedia: MediaListItem): MappedMediaItem => {
        const displayTime = apiMedia.published_time ?? apiMedia.create_time;
        return {
            ...apiMedia,
            url: apiMedia.url,
            mime_type: apiMedia.mime_type || null,
            poster: apiMedia.cover_url || null,
            sync_status: apiMedia.sync_status || "PENDING",
            last_error: apiMedia.last_error || null,
            ai_status: apiMedia.ai_status || "PENDING",
            ai_error: apiMedia.ai_error || null,
            matched_details: (apiMedia.matched_details as MatchedDetails) || undefined,
            date: displayTime
                ? Temporal.Instant.from(displayTime).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(undefined, {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                  })
                : "Unknown",
        };
    };

    interface ApiSearchItem {
        id: string;
        title: string | null;
        type?: string;
        create_time?: string;
        published_time?: string | null;
        media_url?: string | null;
        url?: string | null;
        cover_url?: string | null;
        cover?: string | null;
        sync_status?: string | null;
        last_error?: string | null;
        ai_status?: string | null;
        ai_error?: string | null;
        matched_reason?: unknown;
        matched_details?: unknown;
        score?: number | null;
    }

    const {
        data: mediaData,
        isLoading: isLoadingMediaQuery,
        refetch: refetchMedia,
    } = useQuery({
        queryKey: computed(() => [
            "media",
            {
                page: page.value,
                count: count.value,
                keyword: searchKeyword.value,
                source: source.value,
                display_mode: displayMode.value,
                library_id: libraryStore.activeLibraryId,
                ai: useAiSearch.value,
            },
        ]),
        placeholderData: keepPreviousData,
        queryFn: async (): Promise<{ list: MappedMediaItem[]; total: number }> => {
            const hasKeyword = !!searchKeyword.value?.trim();
            const isAi = useAiSearch.value;
            console.log("[DEBUG STORE] queryFn called. hasKeyword:", hasKeyword, "isAi:", isAi, "useAiSearch:", useAiSearch.value);
            if (hasKeyword && isAi) {
                console.log("[DEBUG STORE] Fetching from /search");
                const response = await useApi<{
                    success: boolean;
                    data: { list: ApiSearchItem[]; total: number; hasMore: boolean };
                }>("/search", {
                    query: {
                        page: page.value,
                        count: count.value,
                        keyword: searchKeyword.value,
                        source: source.value,
                        library_id: libraryStore.activeLibraryId || undefined,
                    },
                });

                if (response && response.success && response.data) {
                    const mappedList: MappedMediaItem[] = response.data.list.map((item) => {
                        const displayTime = item.published_time ?? item.create_time;
                        return {
                            id: item.id,
                            eid: "",
                            post_id: null,
                            source: source.value || "UNKNOWN",
                            title: item.title,
                            type: item.type || "IMAGE",
                            create_time: item.create_time || "",
                            published_time: item.published_time || null,
                            post_media_count: 1,
                            media_count: 1,
                            url: item.media_url || item.url || null,
                            mime_type: null,
                            cover: item.cover_url || item.cover || null,
                            cover_url: item.cover_url || item.cover || null,
                            poster: item.cover_url || item.cover || null,
                            sync_status: item.sync_status || "PENDING",
                            last_error: item.last_error || null,
                            ai_status: item.ai_status || "PENDING",
                            ai_error: item.ai_error || null,
                            matched_reason: item.matched_reason,
                            matched_details: (item.matched_details as MatchedDetails) || undefined,
                            score: item.score || null,
                            date: displayTime
                                ? Temporal.Instant.from(displayTime)
                                      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
                                      .toLocaleString(undefined, {
                                          year: "numeric",
                                          month: "2-digit",
                                          day: "2-digit",
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          second: "2-digit",
                                      })
                                : "Unknown",
                        };
                    });

                    return {
                        list: mappedList,
                        total: response.data.total || 0,
                    };
                }
            } else {
                console.log("[DEBUG STORE] Fetching from /media/list");
                const response = await useApi<{
                    success: boolean;
                    data: { list: MediaListItem[]; total?: number };
                }>("/media/list", {
                    query: {
                        page: page.value,
                        count: count.value,
                        keyword: searchKeyword.value,
                        source: source.value,
                        display_mode: displayMode.value,
                        library_id: libraryStore.activeLibraryId,
                    },
                });
                if (response && response.success && response.data) {
                    return {
                        list: response.data.list.map(mapApiMediaToUiMedia),
                        total: response.data.total || 0,
                    };
                }
            }
            return { list: [], total: 0 };
        },
    });

    const medias = computed<MappedMediaItem[]>(() => mediaData.value?.list || []);
    const total = computed(() => mediaData.value?.total || 0);
    const isLoadingMedia = computed(() => isLoadingMediaQuery.value);

    watch(useAiSearch, () => {
        refetchMedia();
    });

    const selectedMedia = computed<MappedMediaItem | null>(() => {
        if (!selectedMediaId.value) return null;
        return medias.value.find((m) => m.id === selectedMediaId.value) || null;
    });

    const selectMedia = (id: string | null) => {
        selectedMediaId.value = id;
    };

    interface ApiResponse<T = unknown> {
        success: boolean;
        message?: string;
        data?: T;
    }

    const retrySync = async (mediaIds: string[]): Promise<ApiResponse> => {
        const response = await useApi<ApiResponse>("/task/retry-sync", {
            method: "POST",
            body: { media_ids: mediaIds },
        });
        if (response && response.success) {
            refetchMedia();
        }
        return response;
    };

    const queueAi = async (mediaIds: string[]): Promise<ApiResponse> => {
        const response = await useApi<ApiResponse>("/task/queue-ai", {
            method: "POST",
            body: { media_ids: mediaIds },
        });
        if (response && response.success) {
            refetchMedia();
        }
        return response;
    };

    const updateMediaInfo = async (id: string, fields: { title?: string; description?: string; published_time?: string | null }) => {
        const response = await useApi<any>(`/media/update-info/${id}`, {
            method: "POST",
            body: fields,
        });
        if (response && response.success) {
            queryClient.invalidateQueries({ queryKey: ["media", id] });
            queryClient.invalidateQueries({ queryKey: ["posts"] });
        }
        return response;
    };

    const replaceMediaTags = async (id: string, tags: string[]) => {
        const response = await useApi<any>(`/media/${id}/tags/replace`, {
            method: "POST",
            body: { tags },
        });
        if (response && response.success) {
            // Do not invalidate the single media detail query to avoid resetting component states.
            // The tags are updated optimistically in the components.
            queryClient.invalidateQueries({ queryKey: ["posts"] });
        }
        return response;
    };

    return {
        keyword,
        source,
        displayMode,
        page,
        count,
        useAiSearch,
        medias,
        total,
        isLoadingMedia,
        refetchMedia,
        selectedMediaId,
        selectedMedia,
        selectMedia,
        retrySync,
        queueAi,
        updateMediaInfo,
        replaceMediaTags,
    };
});
