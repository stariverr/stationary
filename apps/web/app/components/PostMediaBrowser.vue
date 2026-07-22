<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
    ArrowDown,
    ArrowUp,
    ChevronLeft,
    ChevronRight,
    FileImage,
    FileText,
    Film,
    Layers,
    Link as LinkIcon,
    MoreVertical,
    Music,
    Plus,
    Search,
    Trash2,
    Unlink,
    X,
} from "@lucide/vue";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PostMediaSummary } from "@/types/post";

const props = defineProps<{
    list: PostMediaSummary[];
    activeMediaId: string | null;
    isLoading: boolean;
    total: number;
    page?: number;
    totalPages?: number;
}>();

const emit = defineEmits<{
    (event: "select-media", id: string): void;
    (event: "prev-page"): void;
    (event: "next-page"): void;
    (event: "search-change", value: string): void;
    (event: "type-change", value: string): void;
    (event: "upload-media"): void;
    (event: "link-orphan"): void;
    (event: "shift-media", mediaId: string, direction: "left" | "right"): void;
    (event: "unlink-media", mediaId: string): void;
    (event: "trash-media", mediaId: string): void;
    (event: "manage-tracks", mediaId: string): void;
}>();

const { t } = useI18n();
const searchValue = ref("");
const selectedType = ref("ALL");
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(searchValue, (value) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => emit("search-change", value.trim()), 300);
});

onBeforeUnmount(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
});

const clearSearch = () => {
    searchValue.value = "";
};

const selectType = (type: string) => {
    selectedType.value = type;
    emit("type-change", type === "ALL" ? "" : type);
};

const mediaTypes = [
    { labelKey: "common.all_media_types", value: "ALL" },
    { labelKey: "common.media_type_video", value: "VIDEO", icon: Film },
    { labelKey: "common.media_type_image", value: "IMAGE", icon: FileImage },
    { labelKey: "common.media_type_live_photo", value: "LIVE_PHOTO", icon: FileImage },
    { labelKey: "common.media_type_audio", value: "AUDIO", icon: Music },
    { labelKey: "common.media_type_pdf", value: "PDF", icon: FileText },
];

const displayRange = computed(() => {
    if (props.list.length === 0) return t("post_detail.manage.items_empty");
    return t("post_detail.manage.items_range", {
        from: (props.list[0]?.position ?? 0) + 1,
        to: (props.list[props.list.length - 1]?.position ?? 0) + 1,
        total: props.total,
    });
});

const mediaTypeLabel = (type: string) => t(`common.media_type_${type.toLowerCase()}`);
const fallbackTitle = (position: number) => t("post_detail.media_item", { number: position + 1 });
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="shrink-0 space-y-3 border-b border-zinc-200 dark:border-zinc-800 pb-3">
            <div class="flex items-center gap-2">
                <div class="relative flex flex-1 items-center">
                    <Search class="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-zinc-400" />
                    <input
                        v-model="searchValue"
                        type="search"
                        :placeholder="$t('post_detail.manage.search_placeholder')"
                        class="w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 py-2 pl-8 pr-7 text-xs text-zinc-800 dark:text-zinc-100 outline-none transition placeholder-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-700 focus:border-zinc-500 dark:focus:border-zinc-700 focus:ring-2 focus:ring-zinc-900/10"
                    />
                    <button
                        v-if="searchValue"
                        type="button"
                        class="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-300 cursor-pointer"
                        :title="$t('post_detail.manage.clear_search')"
                        :aria-label="$t('post_detail.manage.clear_search')"
                        @click="clearSearch"
                    >
                        <X class="h-3 w-3" />
                    </button>
                </div>
                <button
                    type="button"
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 transition hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                    :title="$t('post_detail.manage.upload_create')"
                    :aria-label="$t('post_detail.manage.upload_create')"
                    @click="emit('upload-media')"
                >
                    <Plus class="h-4 w-4" />
                </button>
                <button
                    type="button"
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 transition hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                    :title="$t('post_detail.manage.link_orphan')"
                    :aria-label="$t('post_detail.manage.link_orphan')"
                    @click="emit('link-orphan')"
                >
                    <LinkIcon class="h-3.5 w-3.5" />
                </button>
            </div>

            <div
                class="flex items-center gap-1 overflow-x-auto rounded-md bg-zinc-100 dark:bg-zinc-900 p-1 scrollbar-none"
                role="tablist"
                :aria-label="$t('common.media_type')"
            >
                <button
                    v-for="type in mediaTypes"
                    :key="type.value"
                    type="button"
                    role="tab"
                    :aria-selected="selectedType === type.value"
                    class="shrink-0 rounded px-2 py-1 text-[11px] font-medium transition cursor-pointer"
                    :class="
                        selectedType === type.value
                            ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-xs'
                            : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                    "
                    @click="selectType(type.value)"
                >
                    {{ $t(type.labelKey) }}
                </button>
            </div>
        </div>

        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto py-3 scrollbar-thin">
            <div v-if="isLoading" class="flex items-center justify-center gap-2 p-8 text-zinc-500 dark:text-zinc-400" aria-busy="true">
                <div
                    class="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-700 border-t-zinc-800 dark:border-t-zinc-200"
                ></div>
                <span class="text-xs">{{ $t("post_detail.manage.loading_playlist") }}</span>
            </div>

            <div
                v-else-if="list.length === 0"
                class="flex flex-col items-center justify-center gap-1.5 p-8 text-center text-zinc-500 dark:text-zinc-400"
            >
                <FileImage class="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                <p class="text-xs font-medium">{{ $t("post_detail.manage.no_media_found") }}</p>
                <p class="text-[11px] text-zinc-400 dark:text-zinc-500">{{ $t("post_detail.manage.adjust_filters_hint") }}</p>
            </div>

            <template v-else>
                <button
                    v-for="item in list"
                    :key="item.id"
                    type="button"
                    class="group relative flex w-full items-center gap-3 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2.5 text-left transition hover:border-zinc-400 dark:hover:border-zinc-700 cursor-pointer"
                    :class="
                        activeMediaId === item.id
                            ? 'border-zinc-900 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-850 ring-1 ring-zinc-900/10 dark:ring-zinc-100/10'
                            : ''
                    "
                    @click="emit('select-media', item.id)"
                >
                    <span
                        v-if="activeMediaId === item.id"
                        class="absolute left-0 top-1/2 h-8 w-0.5 -translate-y-1/2 bg-zinc-900 dark:bg-zinc-100"
                    ></span>

                    <span
                        class="relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950"
                    >
                        <img
                            v-if="item.cover_url || item.thumbnail_url || item.tracks?.[0]?.url"
                            :src="item.cover_url || item.thumbnail_url || item.tracks?.[0]?.url"
                            :alt="item.title || fallbackTitle(item.position)"
                            class="h-full w-full object-cover"
                            loading="lazy"
                        />
                        <component
                            v-else
                            :is="item.type === 'VIDEO' ? Film : item.type === 'AUDIO' ? Music : FileImage"
                            class="h-4 w-4 text-zinc-400"
                        />
                        <span
                            v-if="item.duration || item.page_count"
                            class="absolute bottom-0.5 right-0.5 rounded-sm bg-black/75 px-1 font-mono text-[8px] text-white"
                        >
                            {{
                                item.duration
                                    ? `${Math.floor(item.duration / 60)}:${String(Math.round(item.duration % 60)).padStart(2, "0")}`
                                    : `${item.page_count}p`
                            }}
                        </span>
                    </span>

                    <span class="min-w-0 flex-1">
                        <span class="flex items-center justify-between gap-2">
                            <span class="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">{{
                                item.title || fallbackTitle(item.position)
                            }}</span>
                            <span class="shrink-0 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">#{{ item.position + 1 }}</span>
                        </span>
                        <span class="mt-1 flex items-center gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
                            <span class="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-600 dark:text-zinc-300">{{
                                mediaTypeLabel(item.type)
                            }}</span>
                            <span v-if="item.width && item.height" class="font-mono text-zinc-400 dark:text-zinc-500"
                                >{{ item.width }} × {{ item.height }}</span
                            >
                        </span>
                    </span>

                    <span
                        class="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                        @click.stop
                    >
                        <DropdownMenu>
                            <DropdownMenuTrigger as-child>
                                <button
                                    type="button"
                                    class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
                                    :title="$t('post_detail.manage.actions')"
                                    :aria-label="$t('post_detail.manage.actions')"
                                >
                                    <MoreVertical class="h-4 w-4" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" class="z-[200] w-48">
                                <DropdownMenuItem
                                    :disabled="item.position === 0"
                                    class="cursor-pointer gap-2 py-2 text-xs"
                                    @click="emit('shift-media', item.id, 'left')"
                                >
                                    <ArrowUp class="h-4 w-4 text-zinc-500" />
                                    {{ $t("post_detail.manage.move_up") }}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    :disabled="item.position === total - 1"
                                    class="cursor-pointer gap-2 py-2 text-xs"
                                    @click="emit('shift-media', item.id, 'right')"
                                >
                                    <ArrowDown class="h-4 w-4 text-zinc-500" />
                                    {{ $t("post_detail.manage.move_down") }}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem class="cursor-pointer gap-2 py-2 text-xs" @click="emit('manage-tracks', item.id)">
                                    <Layers class="h-4 w-4 text-zinc-500" />
                                    {{ $t("post_detail.manage.manage_tracks") }}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    class="cursor-pointer gap-2 py-2 text-xs text-amber-700 dark:text-amber-400 focus:bg-amber-50 dark:focus:bg-amber-950/30 focus:text-amber-800 dark:focus:text-amber-300"
                                    @click="emit('unlink-media', item.id)"
                                >
                                    <Unlink class="h-4 w-4 text-amber-600 dark:text-amber-500" />
                                    {{ $t("post_detail.manage.unlink_from_post") }}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    class="cursor-pointer gap-2 py-2 text-xs text-red-600 dark:text-red-400 focus:bg-red-50 dark:focus:bg-red-950/30 focus:text-red-700 dark:focus:text-red-300"
                                    @click="emit('trash-media', item.id)"
                                >
                                    <Trash2 class="h-4 w-4 text-red-500" />
                                    {{ $t("post_detail.manage.delete_to_trash") }}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </span>
                </button>
            </template>
        </div>

        <div class="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-200 dark:border-zinc-800 pt-3 text-xs">
            <span class="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{{ displayRange }}</span>
            <div class="flex items-center gap-1">
                <button
                    type="button"
                    class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
                    :disabled="!(page && page > 1) || isLoading"
                    :title="$t('post_detail.previous_page')"
                    :aria-label="$t('post_detail.previous_page')"
                    @click="emit('prev-page')"
                >
                    <ChevronLeft class="h-4 w-4" />
                </button>
                <button
                    type="button"
                    class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
                    :disabled="!(page && totalPages && page < totalPages) || isLoading"
                    :title="$t('post_detail.next_page')"
                    :aria-label="$t('post_detail.next_page')"
                    @click="emit('next-page')"
                >
                    <ChevronRight class="h-4 w-4" />
                </button>
            </div>
        </div>
    </div>
</template>
