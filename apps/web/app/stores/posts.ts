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
    const source = ref<string | undefined>((route.query.source as string) || undefined);
    const page = ref(parseInt(route.query.page as string) || 1);
    const count = ref(20);

    // Reset page to 1 when library changes
    watch(
        () => libraryStore.activeLibraryId,
        () => {
            page.value = 1;
        },
    );

    // Synchronize URL query parameters with internal state
    watch(
        () => ({ keyword: keyword.value, source: source.value, page: page.value }),
        ({ keyword: newKeyword, source: newSource, page: newPage }) => {
            const query = { ...route.query };

            if (newKeyword) query.keyword = newKeyword;
            else delete query.keyword;

            if (newSource) query.source = newSource;
            else delete query.source;

            if (newPage && newPage > 1) query.page = newPage.toString();
            else delete query.page;

            router.push({ query });
        },
    );

    // Watch for external URL changes (e.g. back button)
    watch(
        () => route.query,
        (newQuery) => {
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
            return {
                ...m,
                type: m.type,
                url: m.primary_file_url || null,
                thumbnail: m.cover_file_url || null,
                live_url: m.live_photo_video_url || null,
                poster: m.cover_file_url || null,
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
            media: uiMedia,
        };
    };

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
                keyword: keyword.value,
                source: source.value,
                library_id: libraryStore.activeLibraryId,
            },
        ]),
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const response = await useApi<{
                success: boolean;
                data: { list: ApiPostListItem[]; total?: number };
            }>("/post/list", {
                query: {
                    page: page.value,
                    count: count.value,
                    keyword: keyword.value,
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

                const uiMedia = detail.media?.map((m) => {
                    return {
                        ...m,
                        type: m.type as "VIDEO" | "IMAGE" | "LIVE_PHOTO",
                        url: m.primary_file_url || null,
                        thumbnail: m.cover_file_url || null,
                        live_url: m.live_photo_video_url || null,
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
                    originalUrl:
                        detail.url ||
                        (uiMedia.length ? uiMedia[0]?.url || "" : ""),
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
    };
});
