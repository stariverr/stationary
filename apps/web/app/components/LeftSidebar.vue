<script setup lang="ts">
import { FileText, Clock, Tag, Trash2, Globe, Folder, Box, Settings, Sidebar, FolderPlus, Plus, Upload } from "@lucide/vue";
import { useImportStore } from "@/stores/import";
import { useLayoutStore } from "@/stores/layout";
import { Button } from "@/components/ui/button";

const route = useRoute();
const router = useRouter();

const isSettingsOpen = ref(false);
const { toggleSidebar } = useAppLayout();
const layoutStore = useLayoutStore();

const menuItems = computed(() => [
    { icon: Box, label: "Media Assets", path: "/", active: route.path === "/" },
    { icon: FileText, label: "Post Collections", path: "/posts", count: 5, active: route.path.startsWith("/posts") },
    { icon: Clock, label: "common.to_review", path: "/review" },
    { icon: Tag, label: "common.tags", path: "/tags" },
    { icon: Trash2, label: "common.trash", path: "/trash" },
    { icon: Globe, label: "common.browser", path: "/browser" },
]);

const importStore = useImportStore();

function openDraftBox() {
    importStore.isTrayOpen = true;
    importStore.isMinimized = false;
}

function triggerCreatePost() {
    layoutStore.isCreatePostOpen = true;
    if (route.path !== "/posts") {
        router.push("/posts");
    }
}

function triggerCreateMedia() {
    layoutStore.isCreateMediaOpen = true;
    if (route.path !== "/") {
        router.push("/");
    }
}

const folders = [{ icon: Folder, label: "2D", count: 5 }];
</script>

<template>
    <div class="h-full bg-[#f6f6f6] border-r border-[#e5e5e5] flex flex-col pt-4 px-2 text-sm select-none">
        <LibrarySwitcher @open-settings="isSettingsOpen = true" />

        <!-- Creation Action Section -->
        <div class="px-2 mt-4 flex flex-col gap-1.5 shrink-0">
            <Button
                @click="triggerCreatePost"
                variant="default"
                class="w-full justify-center gap-1.5 shadow-xs active:scale-[0.98] cursor-pointer"
            >
                <Plus class="w-3.5 h-3.5" />
                <span>{{ $t("post.create_btn") }}</span>
            </Button>
            <Button
                @click="triggerCreateMedia"
                variant="outline"
                class="w-full justify-center gap-1.5 shadow-xs active:scale-[0.98] cursor-pointer"
            >
                <Upload class="w-3.5 h-3.5" />
                <span>{{ $t("media.create_btn") }}</span>
            </Button>
        </div>

        <!-- Menu Items -->
        <div class="flex flex-col gap-1 mb-6 mt-4">
            <NuxtLink
                v-for="item in menuItems"
                :key="item.label"
                :to="item.path"
                class="flex items-center justify-between px-3 py-1.5 rounded-md transition-colors duration-200"
                :class="item.active ? 'bg-[#dcdcdc] text-black' : 'text-[#606060] hover:bg-[#e8e8e8]'"
            >
                <div class="flex items-center gap-2">
                    <component :is="item.icon" class="w-4 h-4 opacity-70" />
                    <span>{{ item.label.includes("common.") ? $t(item.label) : item.label }}</span>
                </div>
                <span v-if="item.count" class="text-xs opacity-50">{{ item.count }}</span>
            </NuxtLink>
        </div>

        <div class="text-xs font-semibold text-[#808080] px-3 mb-2">{{ $t("common.folders") }}</div>
        <div class="flex flex-col gap-1 flex-1">
            <button
                v-for="item in folders"
                :key="item.label"
                class="flex items-center justify-between px-3 py-1.5 rounded-md text-[#606060] hover:bg-[#e8e8e8] transition-colors duration-200"
            >
                <div class="flex items-center gap-2">
                    <component :is="item.icon" class="w-4 h-4 opacity-70" />
                    <span>{{ item.label }}</span>
                </div>
                <span v-if="item.count" class="text-xs opacity-50">{{ item.count }}</span>
            </button>
        </div>

        <!-- Settings, Draft Box & Collapse -->
        <div class="mt-auto pb-4 px-3 flex flex-col gap-1 shrink-0 overflow-hidden">
            <!-- Draft Box Trigger (Moved here as a utility button, not a navigation tab) -->
            <button
                @click="openDraftBox"
                class="flex items-center justify-between w-full text-sm font-medium px-2 py-2 rounded-md hover:bg-[#e8e8e8] text-[#606060] transition-colors duration-200"
            >
                <div class="flex items-center gap-2">
                    <FolderPlus class="w-4 h-4 opacity-70" />
                    <span class="truncate">{{ $t("draft_box.title") }}</span>
                </div>
                <span
                    v-if="importStore.draftFiles.length > 0"
                    class="text-[10px] bg-indigo-600 text-white px-1.5 py-0.5 rounded-full font-bold scale-90"
                >
                    {{ importStore.draftFiles.length }}
                </span>
            </button>

            <button
                @click="isSettingsOpen = true"
                class="flex items-center gap-2 w-full text-sm font-medium px-2 py-2 rounded-md hover:bg-[#e8e8e8] text-[#606060] transition-colors duration-200"
            >
                <component :is="Settings" class="w-4 h-4 opacity-70" />
                <span class="truncate">{{ $t("common.settings") }}</span>
            </button>
            <button
                @click="toggleSidebar"
                class="hidden md:flex items-center gap-2 w-full text-sm font-medium px-2 py-2 rounded-md hover:bg-[#e8e8e8] text-[#606060] transition-colors duration-200"
            >
                <component :is="Sidebar" class="w-4 h-4 opacity-70" />
                <span class="truncate">{{ $t("common.collapse") }}</span>
            </button>
        </div>

        <SettingsModal v-model:open="isSettingsOpen" />
    </div>
</template>
