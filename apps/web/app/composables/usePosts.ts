import { Temporal } from "@js-temporal/polyfill";
import { type Post, Platform, type PostMedia } from "@/types/post";

export { Platform };
export type { Post, PostMedia };

import { usePostStore } from "@/stores/posts";

export const usePosts = () => {
    const store = usePostStore();

    return {
        posts: computed(() => store.posts),
        selectedPost: computed(() => store.selectedPost),
        selectedPostId: computed({
            get: () => store.selectedPostId,
            set: (val) => (store.selectedPostId = val),
        }),
        selectedPostDetail: computed(() => store.selectedPost), // Alias for compatibility
        keyword: computed({
            get: () => store.keyword,
            set: (val) => (store.keyword = val),
        }),
        source: computed({
            get: () => store.source,
            set: (val) => (store.source = val),
        }),
        sortBy: computed({
            get: () => store.sortBy,
            set: (val) => (store.sortBy = val),
        }),
        sortOrder: computed({
            get: () => store.sortOrder,
            set: (val) => (store.sortOrder = val),
        }),
        authorIds: computed({
            get: () => store.authorIds,
            set: (val) => (store.authorIds = val),
        }),
        authorSearchKeyword: computed({
            get: () => store.authorSearchKeyword,
            set: (val) => (store.authorSearchKeyword = val),
        }),
        authorCache: computed(() => store.authorCache),
        mediaType: computed({
            get: () => store.mediaType,
            set: (val) => (store.mediaType = val),
        }),
        authors: computed(() => store.authors),
        selectPost: store.selectPost,
        fetchPosts: async (
            params: {
                page?: number;
                count?: number;
                keyword?: string;
                source?: string;
                sort_by?: string;
                sort_order?: string;
                author_ids?: string[];
                media_type?: string;
            } = {},
        ) => {
            if (params.page !== undefined) store.page = params.page;
            if (params.count !== undefined) store.count = params.count;
            if (params.keyword !== undefined) store.keyword = params.keyword;
            if (params.source !== undefined) store.source = params.source;
            if (params.sort_by !== undefined) store.sortBy = params.sort_by;
            if (params.sort_order !== undefined) store.sortOrder = params.sort_order;
            if (params.author_ids !== undefined) store.authorIds = params.author_ids;
            if (params.media_type !== undefined) store.mediaType = params.media_type;
            await store.refetchPosts();
        },
        generateMockData: async () => {
            await store.refetchPosts();
        },
        isLoading: computed(() => store.isLoadingPosts),
        total: computed(() => store.total),
        page: computed({
            get: () => store.page,
            set: (val) => (store.page = val),
        }),
        count: computed({
            get: () => store.count,
            set: (val) => (store.count = val),
        }),
    };
};
