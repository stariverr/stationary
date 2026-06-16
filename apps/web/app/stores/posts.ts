import { defineStore } from "pinia";
import { Temporal } from "@js-temporal/polyfill";
import { useQuery, keepPreviousData } from "@tanstack/vue-query";
import {
    type Post,
    Platform,
    type PostMedia,
    type ApiPostListItem,
    type ApiPostDetail,
    PostListItemSchema,
    PostDetailResponseBodySchema,
} from "@/types/post";

import { useLibraryStore } from "@/stores/library";

export const usePostStore = defineStore("posts", () => {
    const route = useRoute();
    const router = useRouter();

    const libraryStore = useLibraryStore();

    // Pinia State for UI - Initialized from URL
    const selectedPostId = ref<string | number | null>(null);
    const keyword = ref((route.query.keyword as string) || "");
    const searchKeyword = ref(keyword.value);
    const source = ref<string | undefined>((route.query.source as string) || undefined);
    const page = ref(parseInt(route.query.page as string) || 1);
    const count = ref(20);

    // Debounce keyword search to prevent spamming backend requests
    let debounceTimeout: any = null;
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
    watch(source, () => {
        page.value = 1;
    });

    // Reset page to 1 when library changes
    watch(
        () => libraryStore.activeLibraryId,
        () => {
            page.value = 1;
        },
    );

    // Synchronize URL query parameters with internal state
    // Synchronize URL query parameters with internal state
    watch(
        () => ({ keyword: keyword.value, source: source.value, page: page.value }),
        ({ keyword: newKeyword, source: newSource, page: newPage }) => {
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

            if (changed) {
                router.push({ query });
            }
        },
    );

    // Watch for external URL changes (e.g. back button)
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
            const queryPage = parseInt(newQuery.page as string) || 1;
            if (queryPage !== page.value) {
                page.value = queryPage;
            }
        },
        { deep: true },
    );

    const mapApiPostToUiPost = (apiPost: ApiPostListItem): Post => {
        const displayTime = apiPost.published_time ?? apiPost.create_time;

        const uiMedia = apiPost.media.map((m) => {
            const primaryTrack = m.tracks.find((t) => t.role === "PRIMARY" && t.sort_order === 0);
            const coverTrack = m.tracks.find((t) => t.role === "COVER");
            const liveTrack = m.tracks.find((t) => t.role === "LIVE_PHOTO_VIDEO");
            const subtitleTracks = m.tracks.filter((t) => t.role === "SUBTITLE");

            let url = m.url || primaryTrack?.url || null;

            return {
                ...m,
                type: m.type,
                url: url,
                thumbnail: coverTrack?.url || m.cover_url || null,
                live_url: liveTrack?.url || null,
                poster: coverTrack?.url || m.cover_url || null,
                sync_status: m.sync_status || "PENDING",
                last_error: m.last_error || null,
                ai_status: m.ai_status || "PENDING",
                ai_error: m.ai_error || null,
                subtitles: subtitleTracks.map((sub) => ({
                    url: sub.url,
                    language: sub.metadata?.language || "unknown",
                    label: sub.metadata?.label || sub.metadata?.language || "unknown",
                    format: sub.metadata?.format === "json" ? "vtt" : sub.metadata?.format || "vtt",
                })),
            };
        });

        return {
            ...apiPost,
            id: apiPost.id,
            title: apiPost.title || "Untitled",
            author: apiPost.author_name || "Unknown",
            tags: apiPost.tags || undefined,
            create_time: apiPost.create_time || undefined,
            published_time: apiPost.published_time || undefined,
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
            platform: (apiPost.source || "UNKNOWN") as Platform,
            type: apiPost.type as "TEXT" | "MULTI_MEDIA",
            url: apiPost.url,
            sync_status: apiPost.sync_status || "PENDING",
            last_error: apiPost.last_error || null,
            media: uiMedia,
        };
    };

    const isListEnabled = computed(() => route.path.startsWith("/posts"));

    // TanStack Query for Posts List
    const {
        data: postsData,
        isLoading: isLoadingPostsQuery,
        refetch: refetchPosts,
    } = useQuery({
        queryKey: computed(() => [
            "posts",
            {
                page: page.value,
                count: count.value,
                keyword: searchKeyword.value,
                source: source.value,
                library_id: libraryStore.activeLibraryId,
            },
        ]),
        enabled: isListEnabled,
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const response = await useApi<{
                success: boolean;
                data: { list: ApiPostListItem[]; total?: number };
            }>("/post/list", {
                query: {
                    page: page.value,
                    count: count.value,
                    keyword: searchKeyword.value,
                    source: source.value,
                    library_id: libraryStore.activeLibraryId,
                },
            });
            if (response && response.success && response.data) {
                return {
                    list: response.data.list.map(mapApiPostToUiPost),
                    total: response.data.total || 0,
                };
            }
            return { list: [], total: 0 };
        },
    });

    const isLoadingPosts = computed(() => isLoadingPostsQuery.value);

    // TanStack Query for Post Detail
    const { data: detailData, isLoading: isLoadingDetailQuery } = useQuery({
        queryKey: computed(() => ["post", selectedPostId.value]),
        enabled: computed(() => !!selectedPostId.value),
        queryFn: async () => {
            if (!selectedPostId.value) return null;
            const response = await useApi<{ success: boolean; data: ApiPostDetail }>(
                `/post/detail/${selectedPostId.value}`,
            );

            if (response && response.success && response.data) {
                const detail = response.data;
                const displayTime = detail.published_time ?? detail.create_time;

                const uiMedia =
                    detail.media?.map((m) => {
                        const primaryTrack = m.tracks.find(
                            (t) => t.role === "PRIMARY" && t.sort_order === 0,
                        );
                        const coverTrack = m.tracks.find((t) => t.role === "COVER");
                        const liveTrack = m.tracks.find((t) => t.role === "LIVE_PHOTO_VIDEO");
                        const subtitleTracks = m.tracks.filter((t) => t.role === "SUBTITLE");

                        let url = m.url || primaryTrack?.url || null;

                        return {
                            ...m,
                            type: m.type as "VIDEO" | "IMAGE" | "LIVE_PHOTO" | "AUDIO" | "PDF",
                            url: url,
                            thumbnail: coverTrack?.url || m.cover_url || null,
                            live_url: liveTrack?.url || null,
                            poster: coverTrack?.url || m.cover_url || null,
                            sync_status: m.sync_status || "PENDING",
                            last_error: m.last_error || null,
                            ai_status: m.ai_status || "PENDING",
                            ai_error: m.ai_error || null,
                            subtitles: subtitleTracks.map((sub) => ({
                                url: sub.url,
                                language: sub.metadata?.language || "unknown",
                                label: sub.metadata?.label || sub.metadata?.language || "unknown",
                                format:
                                    sub.metadata?.format === "json"
                                        ? "vtt"
                                        : sub.metadata?.format || "vtt",
                            })),
                        };
                    }) || [];

                return {
                    ...detail,
                    id: detail.id || "",
                    eid: detail.eid || "",
                    source: detail.source || "UNKNOWN",
                    title: detail.title || "Untitled",
                    description: detail.description || "",
                    platform: (detail.source || "UNKNOWN") as Platform,
                    author: detail.author_name || "Unknown",
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
                    width: 1080,
                    height: 1920,
                    type: detail.type as "TEXT" | "MULTI_MEDIA",
                    originalUrl: detail.url || (uiMedia.length ? uiMedia[0]?.url || "" : ""),
                    sync_status: detail.sync_status || "PENDING",
                    last_error: detail.last_error || null,
                    media: uiMedia,
                } as Post;
            }
            return null;
        },
    });

    const isLoadingDetail = computed(() => isLoadingDetailQuery.value);

    const posts = computed(() => postsData.value?.list || []);
    const total = computed(() => postsData.value?.total || 0);
    const selectedPost = computed(
        () => detailData.value || posts.value.find((p) => p.id == selectedPostId.value) || null,
    );

    const selectPost = (id: string | number) => {
        selectedPostId.value = id;
    };

    const retrySync = async (postIds: string[]) => {
        const response = await useApi<any>("/task/retry-sync", {
            method: "POST",
            body: { post_ids: postIds },
        });
        if (response && response.success) {
            refetchPosts();
        }
        return response;
    };

    const queueAi = async (postIds: string[]) => {
        const response = await useApi<any>("/task/queue-ai", {
            method: "POST",
            body: { post_ids: postIds },
        });
        if (response && response.success) {
            refetchPosts();
        }
        return response;
    };

    return {
        // State
        selectedPostId,
        keyword,
        source,
        page,
        count,
        // Computed
        posts,
        total,
        selectedPost,
        isLoadingPosts,
        isLoadingDetail,
        // Actions
        selectPost,
        refetchPosts,
        retrySync,
        queueAi,
    };
});
