import { Temporal } from "@js-temporal/polyfill";
import { type Post, Platform, type PostMedia } from '@/types/post';

export { Platform };
export type { Post, PostMedia };

import { usePostStore } from '@/stores/posts';

export const usePosts = () => {
    const store = usePostStore();

    return {
        posts: computed(() => store.posts),
        selectedPost: computed(() => store.selectedPost),
        selectedPostId: computed({
            get: () => store.selectedPostId,
            set: (val) => store.selectedPostId = val
        }),
        selectedPostDetail: computed(() => store.selectedPost), // Alias for compatibility
        keyword: computed({
            get: () => store.keyword,
            set: (val) => store.keyword = val
        }),
        source: computed({
            get: () => store.source,
            set: (val) => store.source = val
        }),
        selectPost: store.selectPost,
        fetchPosts: async (params: { page?: number; count?: number; keyword?: string; source?: string } = {}) => {
            if (params.page !== undefined) store.page = params.page;
            if (params.count !== undefined) store.count = params.count;
            if (params.keyword !== undefined) store.keyword = params.keyword;
            if (params.source !== undefined) store.source = params.source;
            await store.refetchPosts();
        },
        generateMockData: async () => {
            await store.refetchPosts();
        },
        isLoading: computed(() => store.isLoadingPosts),
        total: computed(() => store.total),
        page: computed({
            get: () => store.page,
            set: (val) => store.page = val
        }),
        count: computed({
            get: () => store.count,
            set: (val) => store.count = val
        })
    };
};

