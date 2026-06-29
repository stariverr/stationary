<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { Tag, X, Plus, Search, Check, Loader2 } from "@lucide/vue";
import { useTagStore } from "@/stores/tag";
import { onClickOutside } from "@vueuse/core";

const props = withDefaults(
    defineProps<{
        tags: string[];
        placeholder?: string;
    }>(),
    {
        placeholder: "Search or create tag...",
    },
);

const emit = defineEmits<{
    (e: "add-tag", tag: string): void;
    (e: "remove-tag", tag: string): void;
}>();

const tagStore = useTagStore();

const containerRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);

const showPopover = ref(false);
const searchQuery = ref("");
const focusedIndex = ref(0);

// Close popover when clicking outside the container
onClickOutside(containerRef, () => {
    showPopover.value = false;
});

// Watch showPopover to auto-focus search input
watch(showPopover, (value) => {
    if (value) {
        searchQuery.value = "";
        focusedIndex.value = 0;
        nextTick(() => {
            searchInputRef.value?.focus();
        });
    }
});

// Reset focused index when query changes
watch(searchQuery, () => {
    focusedIndex.value = 0;
});

// Dynamic styles based on tag custom colors
const getTagStyle = (tagName: string) => {
    const match = tagStore.tags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
    if (match && match.color) {
        const baseColor = match.color;
        // Hex validation & styling
        if (/^#[0-9A-F]{6}$/i.test(baseColor)) {
            const r = parseInt(baseColor.slice(1, 3), 16);
            const g = parseInt(baseColor.slice(3, 5), 16);
            const b = parseInt(baseColor.slice(5, 7), 16);
            return {
                backgroundColor: `rgba(${r}, ${g}, ${b}, 0.08)`,
                color: baseColor,
                borderColor: `rgba(${r}, ${g}, ${b}, 0.2)`,
            };
        } else {
            return {
                backgroundColor: `${baseColor}14`,
                color: baseColor,
                borderColor: `${baseColor}33`,
            };
        }
    }
    return {};
};

// Computed list of options shown in the popover dropdown
const selectOptions = computed(() => {
    const list: Array<{ type: "tag" | "create"; name: string; color?: string | null; isSelected?: boolean }> = [];
    const query = searchQuery.value.trim();

    // 1. If query is non-empty, check if it already exists or is already selected
    if (query) {
        const hasExactMatch = tagStore.activeTags.some((t) => t.name.toLowerCase() === query.toLowerCase());
        const isAlreadySelected = props.tags.some((t) => t.toLowerCase() === query.toLowerCase());

        if (!hasExactMatch && !isAlreadySelected) {
            list.push({
                type: "create",
                name: query,
            });
        }
    }

    // 2. Add matching existing active tags from the library
    const filtered = tagStore.activeTags.filter((t) => {
        if (!query) return true;
        return t.name.toLowerCase().includes(query.toLowerCase());
    });

    // Sort: put exact matched or prefix matched first, or alphabetically
    const sorted = [...filtered].sort((a, b) => {
        const aLower = a.name.toLowerCase();
        const bLower = b.name.toLowerCase();
        const qLower = query.toLowerCase();

        if (query) {
            const aStarts = aLower.startsWith(qLower);
            const bStarts = bLower.startsWith(qLower);
            if (aStarts && !bStarts) return -1;
            if (!aStarts && bStarts) return 1;
        }
        return a.name.localeCompare(b.name, "zh");
    });

    for (const t of sorted) {
        const isSelected = props.tags.some((selectedTag) => selectedTag.toLowerCase() === t.name.toLowerCase());
        list.push({
            type: "tag",
            name: t.name,
            color: t.color,
            isSelected,
        });
    }

    return list;
});

// Handle selection of a tag/create option
const handleSelectOption = (option: typeof selectOptions.value[0]) => {
    if (option.type === "create") {
        emit("add-tag", option.name);
        searchQuery.value = "";
    } else {
        if (option.isSelected) {
            emit("remove-tag", option.name);
        } else {
            emit("add-tag", option.name);
        }
        // Do NOT clear searchQuery so the user can easily toggle/select other matching tags
    }
    nextTick(() => {
        searchInputRef.value?.focus();
    });
};

// Keyboard navigation
const onKeyDown = (e: KeyboardEvent) => {
    if (!showPopover.value) return;

    if (e.key === "ArrowDown") {
        e.preventDefault();
        if (selectOptions.value.length > 0) {
            focusedIndex.value = (focusedIndex.value + 1) % selectOptions.value.length;
            scrollIntoView();
        }
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (selectOptions.value.length > 0) {
            focusedIndex.value = (focusedIndex.value - 1 + selectOptions.value.length) % selectOptions.value.length;
            scrollIntoView();
        }
    } else if (e.key === "Enter") {
        e.preventDefault();
        const option = selectOptions.value[focusedIndex.value];
        if (option) {
            handleSelectOption(option);
        }
    } else if (e.key === "Escape") {
        e.preventDefault();
        showPopover.value = false;
    }
};

// Ensure active keyboard-selected item is scrolled into view
const scrollIntoView = () => {
    nextTick(() => {
        const listEl = document.querySelector(".tag-editor-popover-list");
        const activeEl = listEl?.querySelector(".tag-editor-popover-item-active");
        if (listEl && activeEl) {
            const listRect = listEl.getBoundingClientRect();
            const activeRect = activeEl.getBoundingClientRect();
            if (activeRect.bottom > listRect.bottom) {
                listEl.scrollTop += activeRect.bottom - listRect.bottom;
            } else if (activeRect.top < listRect.top) {
                listEl.scrollTop -= listRect.top - activeRect.top;
            }
        }
    });
};
</script>

<template>
    <div ref="containerRef" class="relative space-y-2">
        <div class="flex flex-wrap gap-2 items-center">
            <!-- Selected Tags Badges -->
            <transition-group name="tag-list">
                <span
                    v-for="tag in tags"
                    :key="tag"
                    :style="getTagStyle(tag)"
                    class="group/tag inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-50 border border-zinc-200 hover:bg-zinc-100 hover:border-zinc-300 rounded-md text-xs text-zinc-700 font-medium transition-colors cursor-pointer"
                >
                    <span>#{{ tag }}</span>
                    <button
                        type="button"
                        @click.stop="emit('remove-tag', tag)"
                        class="text-zinc-400 hover:text-red-600 transition-colors cursor-pointer rounded-full p-0.5 hover:bg-black/5 shrink-0 -mr-1"
                        title="Remove tag"
                    >
                        <X class="w-3 h-3" />
                    </button>
                </span>
            </transition-group>

            <!-- Trigger Button -->
            <button
                type="button"
                @click="showPopover = !showPopover"
                class="px-3 py-1.5 border border-dashed border-zinc-300 hover:border-zinc-400 hover:text-zinc-600 rounded-md text-xs text-zinc-400 hover:bg-zinc-50 transition-colors cursor-pointer"
            >
                + {{ $t("common.add_tag", "Add Tag") }}
            </button>
        </div>

        <!-- Autocomplete Search Popover -->
        <transition name="popover-fade">
            <div
                v-if="showPopover"
                class="absolute left-0 top-full mt-1.5 z-[100] w-64 bg-white border border-zinc-200/80 rounded-xl shadow-xl p-2 focus:outline-none ring-1 ring-black/5"
            >
                <!-- Popover Search Input -->
                <div class="relative flex items-center mb-1.5 border-b border-zinc-100 pb-1.5 px-1">
                    <Search class="absolute left-2.5 w-3.5 h-3.5 text-zinc-400" />
                    <input
                        ref="searchInputRef"
                        v-model="searchQuery"
                        type="text"
                        :placeholder="placeholder"
                        class="w-full pl-8 pr-7 py-1.5 text-xs text-zinc-800 bg-zinc-50 border border-zinc-200 rounded-lg focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
                        @keydown="onKeyDown"
                    />
                    <button
                        v-if="searchQuery"
                        type="button"
                        @click="searchQuery = ''"
                        class="absolute right-2 text-zinc-400 hover:text-zinc-600 cursor-pointer"
                    >
                        <X class="w-3.5 h-3.5" />
                    </button>
                </div>

                <!-- Dropdown items list -->
                <div class="tag-editor-popover-list max-h-48 overflow-y-auto space-y-0.5 pr-0.5 custom-scrollbar">
                    <!-- Loading state -->
                    <div v-if="tagStore.isLoading" class="flex items-center justify-center py-6 text-zinc-400 text-xs gap-1.5">
                        <Loader2 class="w-3.5 h-3.5 animate-spin text-indigo-500" />
                        <span>Loading tags...</span>
                    </div>

                    <!-- Options list -->
                    <template v-else-if="selectOptions.length > 0">
                        <button
                            v-for="(option, index) in selectOptions"
                            :key="index"
                            type="button"
                            class="w-full text-left flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer"
                            :class="[
                                index === focusedIndex
                                    ? 'tag-editor-popover-item-active bg-indigo-50 text-indigo-950 font-medium'
                                    : 'text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950',
                            ]"
                            @click="handleSelectOption(option)"
                            @mouseenter="focusedIndex = index"
                        >
                            <span class="flex items-center gap-1.5 truncate">
                                <!-- Create Tag Indicator -->
                                <Plus v-if="option.type === 'create'" class="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                                <Tag v-else class="w-3.5 h-3.5 text-zinc-400 shrink-0" :style="{ color: option.color || undefined }" />

                                <span class="truncate">
                                    <span v-if="option.type === 'create'" class="text-indigo-600 font-medium">Create tag: </span>
                                    #{{ option.name }}
                                </span>
                            </span>

                            <Check
                                v-if="option.isSelected"
                                class="w-3.5 h-3.5 text-indigo-600 shrink-0"
                            />
                        </button>
                    </template>

                    <!-- Empty state -->
                    <div v-else class="text-center py-6 text-zinc-400 text-xs">
                        No tags found
                    </div>
                </div>
            </div>
        </transition>
    </div>
</template>

<style scoped>
/* Transition animations */
.popover-fade-enter-active,
.popover-fade-leave-active {
    transition: all 0.15s ease-out;
}
.popover-fade-enter-from,
.popover-fade-leave-to {
    opacity: 0;
    transform: translateY(-4px);
}

.tag-list-enter-active,
.tag-list-leave-active {
    transition: all 0.2s ease;
}
.tag-list-enter-from,
.tag-list-leave-to {
    opacity: 0;
    transform: scale(0.9);
}

/* Custom scrollbar styling */
.custom-scrollbar::-webkit-scrollbar {
    width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
    background: #e4e4e7;
    border-radius: 9999px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: #d4d4d8;
}
</style>
