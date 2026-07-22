import { ref, watch, toValue, type MaybeRefOrGetter } from "vue";
import { useApi } from "./useApi";
import type { PostMediaSummary } from "@/types/post";

export function usePostMediaQuery(postId: MaybeRefOrGetter<string | number | null | undefined>) {
    const list = ref<PostMediaSummary[]>([]);
    const page = ref(1);
    const limit = ref(50);
    const total = ref(0);
    const totalPages = ref(0);
    const isLoading = ref(false);
    const keyword = ref("");
    const typeFilter = ref<string | undefined>(undefined);
    let requestSequence = 0;

    async function fetchPage(
        options: {
            page?: number;
            limit?: number;
            keyword?: string;
            type?: string;
        } = {},
    ) {
        const id = toValue(postId);
        if (!id) return;

        if (options.page !== undefined) page.value = options.page;
        if (options.limit !== undefined) limit.value = options.limit;
        if (options.keyword !== undefined) keyword.value = options.keyword;
        if (options.type !== undefined) typeFilter.value = options.type || undefined;
        const requestId = ++requestSequence;

        isLoading.value = true;
        try {
            const queryParams: Record<string, any> = {
                page: page.value,
                limit: limit.value,
            };

            const kw = options.keyword !== undefined ? options.keyword : keyword.value;
            if (kw) queryParams.keyword = kw;

            const tf = options.type !== undefined ? options.type : typeFilter.value;
            if (tf) queryParams.type = tf;

            const res = await useApi<{
                success: boolean;
                data: {
                    list: PostMediaSummary[];
                    page: number;
                    limit: number;
                    total: number;
                    total_pages: number;
                };
            }>(`/post/${id}/media`, {
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
            list.value = [];
            page.value = 1;
            total.value = 0;
            totalPages.value = 0;
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
