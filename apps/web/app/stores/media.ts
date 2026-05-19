import { defineStore } from 'pinia';
import { Temporal } from "@js-temporal/polyfill";
import { useQuery, keepPreviousData } from '@tanstack/vue-query';
import { useLibraryStore } from '@/stores/library';

import * as v from 'valibot';

export const MediaListResponseBodySchema = v.object({
    id: v.string(),
    eid: v.string(),
    post_id: v.nullable(v.string()),
    source: v.string(),
    title: v.nullable(v.string()),
    type: v.string(),
    create_time: v.string(),
    published_time: v.nullable(v.string()),
    s3_key: v.nullable(v.string()),
    s3_bucket: v.nullable(v.string()),
    post_media_count: v.nullable(v.number()),
    media_count: v.number(),
    media_url: v.nullable(v.string()),
});

export type MediaListItem = v.InferOutput<typeof MediaListResponseBodySchema>;


export const useMediaStore = defineStore('media', () => {
    const config = useRuntimeConfig();
    const route = useRoute();
    const router = useRouter();
    const cdnBase = config.public.cdnBaseUrl;

    const libraryStore = useLibraryStore();

    // State
    const keyword = ref((route.query.keyword as string) || '');
    const source = ref<string | undefined>((route.query.source as string) || undefined);
    const displayMode = ref<'flat' | 'stacked'>((route.query.display_mode as 'flat' | 'stacked') || 'flat');
    const page = ref(parseInt(route.query.page as string) || 1);
    const count = ref(20);
    const selectedMediaId = ref<string | null>(null);

    // Reset page to 1 when library changes
    watch(() => libraryStore.activeLibraryId, () => {
        page.value = 1;
    });

    // Sync URL
    watch(
        () => ({ keyword: keyword.value, source: source.value, page: page.value, display_mode: displayMode.value }),
        ({ keyword: newKeyword, source: newSource, page: newPage, display_mode: newDisplayMode }) => {
            const query = { ...route.query };

            if (newKeyword) query.keyword = newKeyword;
            else delete query.keyword;

            if (newSource) query.source = newSource;
            else delete query.source;

            if (newPage && newPage > 1) query.page = newPage.toString();
            else delete query.page;

            if (newDisplayMode && newDisplayMode !== 'flat') query.display_mode = newDisplayMode;
            else delete query.display_mode;

            router.push({ query });
        }
    );

    watch(
        () => route.query,
        (newQuery) => {
            if (newQuery.keyword !== undefined && newQuery.keyword !== keyword.value) {
                keyword.value = (newQuery.keyword as string) || '';
            }
            if (newQuery.source !== undefined && newQuery.source !== source.value) {
                source.value = (newQuery.source as string) || undefined;
            }
            if (newQuery.display_mode !== undefined && newQuery.display_mode !== displayMode.value) {
                displayMode.value = (newQuery.display_mode as 'flat' | 'stacked') || 'flat';
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

    const mapApiMediaToUiMedia = (apiMedia: MediaListItem) => {
        const displayTime = apiMedia.published_time ?? apiMedia.create_time;
        return {
            ...apiMedia,
            url: cdnPrefix(apiMedia.s3_key),
            date: displayTime ? Temporal.Instant.from(displayTime).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(undefined, {
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
            }) : 'Unknown',
        };
    };

    const { data: mediaData, isLoading: isLoadingMediaQuery, refetch: refetchMedia } = useQuery({
        queryKey: computed(() => ['media', { page: page.value, count: count.value, keyword: keyword.value, source: source.value, display_mode: displayMode.value, library_id: libraryStore.activeLibraryId }]),
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const response = await useApi<{ success: boolean; data: { list: MediaListItem[]; total?: number } }>('/media/list', {
                query: {
                    page: page.value,
                    count: count.value,
                    keyword: keyword.value,
                    source: source.value,
                    display_mode: displayMode.value,
                    library_id: libraryStore.activeLibraryId
                }
            });
            if (response && response.success && response.data) {
                return {
                    list: response.data.list.map(mapApiMediaToUiMedia),
                    total: response.data.total || 0
                };
            }
            return { list: [], total: 0 };
        }
    });

    const medias = computed(() => mediaData.value?.list || []);
    const total = computed(() => mediaData.value?.total || 0);
    const isLoadingMedia = computed(() => isLoadingMediaQuery.value);

    const selectedMedia = computed(() => {
        if (!selectedMediaId.value) return null;
        return medias.value.find(m => m.id === selectedMediaId.value) || null;
    });

    const selectMedia = (id: string | null) => {
        selectedMediaId.value = id;
    };

    return {
        keyword,
        source,
        displayMode,
        page,
        count,
        medias,
        total,
        isLoadingMedia,
        refetchMedia,
        selectedMediaId,
        selectedMedia,
        selectMedia
    };
});
