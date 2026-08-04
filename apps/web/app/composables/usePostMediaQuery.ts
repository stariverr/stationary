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
            isLoading.value = false;
        }
    }

    // Reset and fetch when post ID changes
    watch(
        () => toValue(postId),
        (newId) => {
            const initialPost = initialPostGetter?.();
            if (initialPost && Array.isArray(initialPost.media) && initialPost.media.length > 0) {
                list.value = initialPost.media.map((m: any, index: number) => ({
                    id: String(m.id),
                    type: m.type as MediaType,
                    title: m.title || null,
                    sort_order: index,
                    position: index,
                    cover_url: m.poster || m.thumbnail || m.cover_url || "",
                    url: m.url || null,
                    playback: m.playback || null,
                    subtitles: m.subtitles || [],
                    width: m.width || null,
                    height: m.height || null,
                    tracks: m.tracks || [],
                }));
                page.value = 1;
                total.value = initialPost.media.length;
                totalPages.value = 1;
                isLoading.value = false;
            } else {
                list.value = [];
                page.value = 1;
                total.value = 0;
                totalPages.value = 0;
            }
            keyword.value = "";
            typeFilter.value = undefined;
            if (newId) {
                fetchPage();
            }
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
