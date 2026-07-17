<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import type { WritableComputedRef, ComputedRef } from "vue";
import { Languages, Check } from "@lucide/vue";

interface NuxtI18nComposer {
    locale: WritableComputedRef<string>;
    setLocale: (locale: string) => Promise<void>;
    locales: ComputedRef<Array<{ code: string; name?: string } | string>>;
    t: (key: string, values?: Record<string, unknown>) => string;
}

const { locale, locales, setLocale } = useI18n() as unknown as NuxtI18nComposer;

const isOpen = ref(false);
const containerRef = ref<HTMLElement | null>(null);

const toggleDropdown = () => {
    isOpen.value = !isOpen.value;
};

const closeDropdown = () => {
    isOpen.value = false;
};

const selectLocale = (code: string) => {
    setLocale(code);
    closeDropdown();
};

// Handle click outside to close dropdown
const handleClickOutside = (event: MouseEvent) => {
    if (containerRef.value && !containerRef.value.contains(event.target as Node)) {
        closeDropdown();
    }
};

onMounted(() => {
    document.addEventListener("click", handleClickOutside);
});

onBeforeUnmount(() => {
    document.removeEventListener("click", handleClickOutside);
});

const localeOptions = computed(() => {
    return locales.value.map((l) => ({
        code: typeof l === "string" ? l : l.code,
        name: typeof l === "string" ? l : l.name || l.code,
    }));
});

const currentLocaleName = computed(() => {
    const found = localeOptions.value.find((l) => l.code === locale.value);
    return found ? found.name : "Language";
});
</script>

<template>
    <div ref="containerRef" class="relative inline-block text-left">
        <button
            type="button"
            @click="toggleDropdown"
            class="flex items-center gap-1.5 px-3 py-1.5 bg-white/80 hover:bg-white border border-gray-200 rounded-xl text-xs font-semibold text-gray-700 shadow-sm transition-all duration-200 active:scale-[0.98] cursor-pointer backdrop-blur-md"
        >
            <Languages class="w-3.5 h-3.5 text-gray-500" />
            <span>{{ currentLocaleName }}</span>
        </button>

        <transition
            enter-active-class="transition duration-100 ease-out"
            enter-from-class="transform scale-95 opacity-0"
            enter-to-class="transform scale-100 opacity-100"
            leave-active-class="transition duration-75 ease-in"
            leave-from-class="transform scale-100 opacity-100"
            leave-to-class="transform scale-95 opacity-0"
        >
            <div
                v-if="isOpen"
                class="absolute right-0 mt-2 w-48 max-h-64 overflow-y-auto bg-white border border-gray-100 rounded-xl shadow-xl z-50 py-1 scrollbar-thin scrollbar-thumb-gray-200"
            >
                <button
                    v-for="item in localeOptions"
                    :key="item.code"
                    @click="selectLocale(item.code)"
                    class="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 flex items-center justify-between transition-colors duration-150 cursor-pointer"
                    :class="locale === item.code ? 'text-emerald-700 font-semibold' : 'text-gray-700'"
                >
                    <span>{{ item.name }}</span>
                    <Check v-if="locale === item.code" class="w-3.5 h-3.5 text-emerald-600" />
                </button>
            </div>
        </transition>
    </div>
</template>

<style scoped>
/* custom scrollbar for language list */
.scrollbar-thin::-webkit-scrollbar {
    width: 4px;
}
.scrollbar-thin::-webkit-scrollbar-track {
    background: transparent;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
    background: #e5e7eb;
    border-radius: 2px;
}
.scrollbar-thin::-webkit-scrollbar-thumb:hover {
    background: #d1d5db;
}
</style>
