import { defineStore } from 'pinia';
import { Temporal } from "@js-temporal/polyfill";
import { useQuery, keepPreviousData } from '@tanstack/vue-query';
import * as v from 'valibot';
import type { Post, Platform, PostMedia } from '@/types/post';

export const PostDetailResponseBodySchema = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    source: v.optional(v.string()),
    eid: v.optional(v.string()),
    title: v.optional(v.nullable(v.string())),
    description: v.optional(v.nullable(v.string())),
    tags: v.optional(v.nullable(v.array(v.string()))),
    author_name: v.optional(v.nullable(v.string())),
    author_external_id: v.optional(v.nullable(v.string())),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    media_count: v.optional(v.number()),
    url: v.optional(v.nullable(v.string())),
    media: v.optional(v.array(
        v.object({
            id: v.pipe(v.string(), v.uuid()),
            eid: v.optional(v.string()),
            source: v.optional(v.string()),
            title: v.optional(v.nullable(v.string())),
            description: v.optional(v.nullable(v.string())),
            type: v.optional(v.string()),
            sort_order: v.optional(v.number()),
            primary_file_path: v.nullable(v.string()),
            alternative_file_path: v.nullable(v.string()),
            live_photo_video_path: v.nullable(v.string()),
            cover_file_path: v.nullable(v.string()),
            create_time: v.optional(v.string()),
            published_time: v.optional(v.nullable(v.string())),
        })
    )),
    type: v.optional(v.string()),
});

import { useLibraryStore } from '@/stores/library';

export const usePostStore = defineStore('posts', () => {
    const config = useRuntimeConfig();
    const route = useRoute();
    const router = useRouter();
    const cdnBase = config.public.cdnBaseUrl;

    const libraryStore = useLibraryStore();

    // Pinia State for UI - Initialized from URL
    const selectedPostId = ref<string | number | null>(null);
    const keyword = ref((route.query.keyword as string) || '');
    const source = ref<string | undefined>((route.query.source as string) || undefined);
    const page = ref(parseInt(route.query.page as string) || 1);
    const count = ref(20);

    // Reset page to 1 when library changes
    watch(() => libraryStore.activeLibraryId, () => {
        page.value = 1;
    });

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
        }
    );

    // Watch for external URL changes (e.g. back button)
    watch(
        () => route.query,
        (newQuery) => {
            if (newQuery.keyword !== undefined && newQuery.keyword !== keyword.value) {
                keyword.value = (newQuery.keyword as string) || '';
            }
            if (newQuery.source !== undefined && newQuery.source !== source.value) {
                source.value = (newQuery.source as string) || undefined;
            }
            const queryPage = parseInt(newQuery.page as string) || 1;
            if (queryPage !== page.value) {
                page.value = queryPage;
            }
        },
        { deep: true }
    );

    const cdnPrefix = (path?: string | null) => {
        if (!path) return '';
        if (path.startsWith('http')) return path;
        return `${cdnBase.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
    };

    interface ApiPostListItem {
        id: string;
        eid: string;
        title: string;
        source: string;
        tags: string[];
        media_id: string;
        media_type: 'VIDEO' | 'IMAGE' | 'LIVE_PHOTO';
        media_url: string;
        media_index: number;
        create_time?: string;
        published_time?: string | null;
        media_published_time?: string | null;
        s3_key: string;
        s3_bucket: string;
    }

    const mapApiPostToUiPost = (apiPost: ApiPostListItem | any): Post => {
        const hasMedia = !!apiPost.media_id;
        const rawPath = apiPost.s3_key || apiPost.path || '';
        const mediaUrl = cdnPrefix(rawPath);
        const displayTime = apiPost.published_time ?? apiPost.create_time;

        return {
            ...apiPost,
            id: apiPost.id,
            title: apiPost.title || apiPost.media_title || 'Untitled',
            description: apiPost.media_description || '',
            author: apiPost.author_name || apiPost.author?.nickname || 'Unknown',
            date: displayTime ? Temporal.Instant.from(displayTime).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(undefined, {
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
            }) : 'Unknown',
            platform: (apiPost.source || 'UNKNOWN') as Platform,
            type: apiPost.type || (hasMedia ? (apiPost.media_type === 'VIDEO' ? 'video' : 'image') : 'text'),
            url: mediaUrl,
            originalUrl: apiPost.url || mediaUrl,
            width: 1080,
            height: 1920,
            media: hasMedia ? [
                {
                    type: apiPost.media_type,
                    url: mediaUrl,
                    thumbnail: mediaUrl
                }
            ] : []
        };
    };

    type ApiPostDetail = v.InferOutput<typeof PostDetailResponseBodySchema>;
    type ApiMediaItem = NonNullable<ApiPostDetail['media']>[number];

    // TanStack Query for Posts List
    const { data: postsData, isLoading: isLoadingPostsQuery, refetch: refetchPosts } = useQuery({
        queryKey: computed(() => ['posts', { page: page.value, count: count.value, keyword: keyword.value, source: source.value, library_id: libraryStore.activeLibraryId }]),
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const response = await useApi<{ success: boolean; data: { list: ApiPostListItem[]; total?: number } }>('/post/list', {
                query: {
                    page: page.value,
                    count: count.value,
                    keyword: keyword.value,
                    source: source.value,
                    library_id: libraryStore.activeLibraryId
                }
            });
            if (response && response.success && response.data) {
                return {
                    list: response.data.list.map(mapApiPostToUiPost),
                    total: response.data.total || 0
                };
            }
            return { list: [], total: 0 };
        }
    });

    const isLoadingPosts = computed(() => isLoadingPostsQuery.value);

    // TanStack Query for Post Detail
    const { data: detailData, isLoading: isLoadingDetailQuery } = useQuery({
        queryKey: computed(() => ['post', selectedPostId.value]),
        enabled: computed(() => !!selectedPostId.value),
        queryFn: async () => {
            if (!selectedPostId.value) return null;
            const response = await useApi<{ success: boolean; data: ApiPostDetail }>(`/post/detail/${selectedPostId.value}`);

            if (response && response.success && response.data) {
                const detail = response.data;
                const displayTime = detail.published_time ?? detail.create_time;
                return {
                    ...detail,
                    id: detail.id || '',
                    eid: detail.eid || '',
                    source: detail.source || 'UNKNOWN',
                    title: detail.title || 'Untitled',
                    description: detail.description || '',
                    platform: (detail.source || 'UNKNOWN') as Platform,
                    author: detail.author_name || 'Unknown',
                    date: displayTime ? Temporal.Instant.from(displayTime).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(undefined, {
                        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
                    }) : 'Unknown',
                    width: 1080,
                    height: 1920,
                    type: (detail.type || 'text') as 'video' | 'image' | 'text',
                    originalUrl: detail.url || (detail.media?.length ? detail.media[0]?.primary_file_path : ''),
                    media: detail.media?.map((m) => {
                        const mUrl = cdnPrefix(m.primary_file_path || '');
                        const thumbUrl = cdnPrefix(m.cover_file_path || m.primary_file_path || '');
                        return {
                            ...m,
                            type: (m.type || 'IMAGE').toUpperCase() as 'VIDEO' | 'IMAGE' | 'LIVE_PHOTO',
                            url: mUrl,
                            thumbnail: thumbUrl,
                            live_url: cdnPrefix(m.live_photo_video_path)
                        } as PostMedia;
                    }) || []
                } as Post;
            }
            return null;
        }
    });

    const isLoadingDetail = computed(() => isLoadingDetailQuery.value);

    const posts = computed(() => postsData.value?.list || []);
    const total = computed(() => postsData.value?.total || 0);
    const selectedPost = computed(() => detailData.value || posts.value.find(p => p.id == selectedPostId.value) || null);

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
        refetchPosts
    };
});
