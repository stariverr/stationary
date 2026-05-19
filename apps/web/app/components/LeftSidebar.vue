<script setup lang="ts">
import {
    FileText,
    Clock,
    Tag,
    Trash2,
    Globe,
    Folder,
    Box,
    Settings,
} from '@lucide/vue';

const route = useRoute();

const isSettingsOpen = ref(false);

const menuItems = computed(() => [
    { icon: Box, label: 'Media Assets', path: '/', active: route.path === '/' },
    { icon: FileText, label: 'Post Collections', path: '/posts', count: 5, active: route.path.startsWith('/posts') },
    { icon: Clock, label: 'common.to_review', path: '/review' },
    { icon: Tag, label: 'common.tags', path: '/tags' },
    { icon: Trash2, label: 'common.trash', path: '/trash' },
    { icon: Globe, label: 'common.browser', path: '/browser' },
]);

const folders = [
    { icon: Folder, label: '2D', count: 5 },
]
</script>

<template>
    <div class="h-full bg-[#f6f6f6] border-r border-[#e5e5e5] flex flex-col pt-4 px-2 text-sm select-none">
        <LibrarySwitcher @open-settings="isSettingsOpen = true" />

        <!-- Menu Items -->
        <div class="flex flex-col gap-1 mb-6 mt-6">
            <NuxtLink v-for="item in menuItems" :key="item.label" :to="item.path"
                class="flex items-center justify-between px-3 py-1.5 rounded-md transition-colors duration-200"
                :class="item.active ? 'bg-[#dcdcdc] text-black' : 'text-[#606060] hover:bg-[#e8e8e8]'">
                <div class="flex items-center gap-2">
                    <component :is="item.icon" class="w-4 h-4 opacity-70" />
                    <span>{{ item.label.includes('common.') ? $t(item.label) : item.label }}</span>
                </div>
                <span v-if="item.count" class="text-xs opacity-50">{{ item.count }}</span>
            </NuxtLink>
        </div>

        <div class="text-xs font-semibold text-[#808080] px-3 mb-2">{{ $t('common.folders') }}</div>
        <div class="flex flex-col gap-1 flex-1">
            <button v-for="item in folders" :key="item.label"
                class="flex items-center justify-between px-3 py-1.5 rounded-md text-[#606060] hover:bg-[#e8e8e8] transition-colors duration-200">
                <div class="flex items-center gap-2">
                    <component :is="item.icon" class="w-4 h-4 opacity-70" />
                    <span>{{ item.label }}</span>
                </div>
                <span v-if="item.count" class="text-xs opacity-50">{{ item.count }}</span>
            </button>
        </div>

        <!-- Settings -->
        <div class="mt-auto pb-4 px-3">
            <button @click="isSettingsOpen = true"
                class="flex items-center gap-2 w-full text-sm font-medium px-2 py-2 rounded-md hover:bg-[#e8e8e8] text-[#606060] transition-colors duration-200">
                <component :is="Settings" class="w-4 h-4 opacity-70" />
                <span>{{ $t('common.settings') }}</span>
            </button>
        </div>

        <SettingsModal v-model:open="isSettingsOpen" />
    </div>
</template>
