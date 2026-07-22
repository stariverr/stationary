<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { Tag, X, Plus, Search, Check, Loader2 } from "@lucide/vue";
import { useTagStore } from "@/stores/tag";
import { onClickOutside } from "@vueuse/core";

const props = withDefaults(
    defineProps<{
        tags: string[];
        placeholder?: string;
        isDark?: boolean;
    }>(),
    {
        placeholder: "Search or create tag...",
        isDark: false,
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
                backgroundColor: props.isDark ? `rgba(${r}, ${g}, ${b}, 0.15)` : `rgba(${r}, ${g}, ${b}, 0.08)`,
                color: baseColor,
                borderColor: `rgba(${r}, ${g}, ${b}, 0.3)`,
            };
        } else {
            return {
                backgroundColor: `${baseColor}20`,
                color: baseColor,
                borderColor: `${baseColor}44`,
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
const handleSelectOption = (option: (typeof selectOptions.value)[0]) => {
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
                    class="group/tag inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer border"
                    :class="[
                        isDark
                            ? 'bg-zinc-900/50 border-zinc-800 text-zinc-300 hover:bg-zinc-900 hover:border-zinc-700'
                            : 'bg-zinc-50 border-zinc-200 text-zinc-700 hover:bg-zinc-100 hover:border-zinc-300',
                    ]"
                >
                    <span>#{{ tag }}</span>
                    <button
                        type="button"
                        @click.stop="emit('remove-tag', tag)"
                        class="transition-colors cursor-pointer rounded-full p-0.5 shrink-0 -mr-1"
                        :class="
                            isDark
                                ? 'text-zinc-500 hover:text-red-400 hover:bg-white/5'
                                : 'text-zinc-400 hover:text-red-600 hover:bg-black/5'
                        "
                        title="Remove tag"
                    >
                        <X class="w-3.5 h-3.5" />
                    </button>
                </span>
            </transition-group>

            <!-- Trigger Button -->
            <button
                type="button"
                @click="showPopover = !showPopover"
                class="px-3 py-1.5 border border-dashed rounded-md text-xs transition-colors cursor-pointer"
                :class="[
                    isDark
                        ? 'border-zinc-800 text-zinc-500 hover:border-zinc-750 hover:text-zinc-300 hover:bg-zinc-900/30'
                        : 'border-zinc-305 hover:border-zinc-400 text-zinc-450 hover:text-zinc-650 hover:bg-zinc-50',
                ]"
            >
                + {{ $t("common.add_tag", "Add Tag") }}
            </button>
        </div>

        <!-- Autocomplete Search Popover -->
        <transition name="popover-fade">
            <div
                v-if="showPopover"
                class="absolute left-0 bottom-full mb-2 z-[100] w-64 rounded-xl shadow-xl p-2 focus:outline-none ring-1 ring-black/5"
                :class="[isDark ? 'bg-[#0f1115] border border-zinc-800 text-white' : 'bg-white border border-zinc-200/80 text-zinc-900']"
            >
                <!-- Popover Search Input -->
                <div class="relative flex items-center mb-1.5 pb-1.5 px-1 border-b" :class="isDark ? 'border-zinc-850' : 'border-zinc-100'">
                    <Search class="absolute left-2.5 w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                    <input
                        ref="searchInputRef"
                        v-model="searchQuery"
                        type="text"
                        :placeholder="placeholder"
                        class="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg outline-none transition-all focus:ring-1"
                        :class="[
                            isDark
                                ? 'text-white bg-zinc-950 border border-zinc-850 focus:border-emerald-500 focus:ring-emerald-500/20'
                                : 'text-zinc-800 bg-zinc-50 border border-zinc-200 focus:border-indigo-500 focus:ring-indigo-500',
                        ]"
                        @keydown="onKeyDown"
                    />
                    <button
                        v-if="searchQuery"
                        type="button"
                        @click="searchQuery = ''"
                        class="absolute right-2 cursor-pointer transition-colors"
                        :class="isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-650'"
                    >
                        <X class="w-3.5 h-3.5" />
                    </button>
                </div>

                <!-- Dropdown items list -->
                <div class="tag-editor-popover-list max-h-48 overflow-y-auto space-y-0.5 pr-0.5 custom-scrollbar">
                    <!-- Loading state -->
                    <div
                        v-if="tagStore.isLoading"
                        class="flex items-center justify-center py-6 text-xs gap-1.5"
                        :class="isDark ? 'text-zinc-500' : 'text-zinc-400'"
                    >
                        <Loader2 class="w-3.5 h-3.5 animate-spin" :class="isDark ? 'text-emerald-500' : 'text-indigo-500'" />
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
                                    ? isDark
                                        ? 'tag-editor-popover-item-active bg-emerald-950/40 text-emerald-300 font-semibold'
                                        : 'tag-editor-popover-item-active bg-indigo-50 text-indigo-950 font-medium'
                                    : isDark
                                      ? 'text-zinc-350 hover:bg-zinc-900/60 hover:text-zinc-100'
                                      : 'text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950',
                            ]"
                            @click="handleSelectOption(option)"
                            @mouseenter="focusedIndex = index"
                        >
                            <span class="flex items-center gap-1.5 truncate">
                                <!-- Create Tag Indicator -->
                                <Plus
                                    v-if="option.type === 'create'"
                                    class="w-3.5 h-3.5 shrink-0"
                                    :class="isDark ? 'text-emerald-400' : 'text-indigo-500'"
                                />
                                <Tag
                                    v-else
                                    class="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0"
                                    :style="{ color: option.color || undefined }"
                                />

                                <span class="truncate">
                                    <span
                                        v-if="option.type === 'create'"
                                        class="font-semibold"
                                        :class="isDark ? 'text-emerald-400' : 'text-indigo-650'"
                                        >Create tag:
                                    </span>
                                    #{{ option.name }}
                                </span>
                            </span>

                            <Check
                                v-if="option.isSelected"
                                class="w-3.5 h-3.5 shrink-0"
                                :class="isDark ? 'text-emerald-450' : 'text-indigo-600'"
                            />
                        </button>
                    </template>

                    <!-- Empty state -->
                    <div v-else class="text-center py-6 text-zinc-400 dark:text-zinc-500 text-xs">No tags found</div>
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
    transform: translateY(4px);
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
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: #d4d4d8;
}
html.dark .custom-scrollbar::-webkit-scrollbar-thumb {
    background: #3f3f46;
}
html.dark .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: #52525b;
}
</style>
