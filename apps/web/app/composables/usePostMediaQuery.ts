import { ref, watch, toValue, type MaybeRefOrGetter } from "vue";
import { useApi } from "./useApi";
import type { ApiResponse } from "@/types/api";
import type { MediaType, PostMediaPage, PostMediaSummary } from "@/types/post";

export interface PostMediaQueryOptions {
    page?: number;
    limit?: number;
    keyword?: string;
    type?: MediaType | "";
}

export function usePostMediaQuery(
    postId: MaybeRefOrGetter<string | number | null | undefined>,
    initialPostGetter?: () => { media?: any[] } | null | undefined,
) {
    const list = ref<PostMediaSummary[]>([]);
    const page = ref(1);
    const limit = ref(50);
    const total = ref(0);
    const totalPages = ref(0);
    const isLoading = ref(false);
    const keyword = ref("");
    const typeFilter = ref<MediaType | undefined>(undefined);
    let requestSequence = 0;

    const getInitialMediaKey = () => {
        const media = initialPostGetter?.()?.media;
        if (!Array.isArray(media) || media.length === 0) return "";

        return media
            .map((item: any) => [item.id, item.cover_url, item.poster, item.thumbnail, item.url].map((value) => value || "").join(":"))
            .join("|");
    };

    async function fetchPage(options: PostMediaQueryOptions = {}) {
        const id = toValue(postId);
        if (!id) return;

        if (options.page !== undefined) page.value = options.page;
        if (options.limit !== undefined) limit.value = options.limit;
        if (options.keyword !== undefined) keyword.value = options.keyword;
        if (options.type !== undefined) typeFilter.value = options.type || undefined;
        const requestId = ++requestSequence;

        if (list.value.length === 0) {
            isLoading.value = true;
        }
        try {
            const queryParams: {
                page: number;
                limit: number;
                keyword?: string;
                type?: MediaType;
            } = {
                page: page.value,
                limit: limit.value,
            };

            const kw = options.keyword !== undefined ? options.keyword : keyword.value;
            if (kw) queryParams.keyword = kw;

            const tf = options.type !== undefined ? options.type : typeFilter.value;
            if (tf) queryParams.type = tf;

            const res = await useApi<ApiResponse<PostMediaPage>>(`/post/${id}/media`, {
                query: queryParams,
            });

            if (requestId !== requestSequence) return;
            if (res && res.success && res.data) {
                list.value = res.data.list;
                page.value = res.data.page;
                limit.value = res.data.limit;
                total.value = res.data.total;
                totalPages.value = res.data.total_pages;
            }
        } catch (e) {
            console.error("Failed to fetch post media:", e);
        } finally {
            if (requestId === requestSequence) {
                isLoading.value = false;
            }
        }
    }

    // Reset and seed instantly when post ID or its preview media changes
    watch(
        () => [toValue(postId), getInitialMediaKey()] as const,
        ([newId], oldValues) => {
            const oldId = oldValues?.[0];

            if (!newId) {
                requestSequence++;
                list.value = [];
                page.value = 1;
                total.value = 0;
                totalPages.value = 0;
                isLoading.value = false;
                return;
            }

            if (newId !== oldId) {
                list.value = [];
                page.value = 1;
                total.value = 0;
                totalPages.value = 0;
            }

            const initialPost = initialPostGetter?.();
            const postObj = initialPost as any;
            if (postObj && Array.isArray(postObj.media) && postObj.media.length > 0) {
                list.value = postObj.media.map((m: any, index: number) => ({
                    id: String(m.id),
                    type: m.type as MediaType,
                    title: m.title || null,
                    sort_order: index,
                    position: index,
                    cover_url: m.cover_url || m.poster || m.thumbnail || "",
                    url: m.url || null,
                    playback: m.playback || null,
                    subtitles: m.subtitles || [],
                    width: m.width || null,
                    height: m.height || null,
                    tracks: m.tracks || [],
                }));
                page.value = 1;
                total.value = postObj.media.length;
                totalPages.value = 1;
                isLoading.value = false;
            } else if (list.value.length === 0) {
                isLoading.value = true;
            }

            keyword.value = "";
            typeFilter.value = undefined;
            void fetchPage();
        },
        { immediate: true },
    );

    return {
        list,
        page,
        limit,
        total,
        totalPages,
        isLoading,
        keyword,
        typeFilter,
        fetchPage,
    };
}
