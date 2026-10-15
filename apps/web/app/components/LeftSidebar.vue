<script setup lang="ts">
import { FileText, Tag, Trash2, Box, Settings, Sidebar, FolderPlus, Plus, Upload, Activity } from "@lucide/vue";
import { useImportStore } from "@/stores/import";
import { useLayoutStore } from "@/stores/layout";
import { Button } from "@/components/ui/button";

const route = useRoute();
const router = useRouter();

const { toggleSidebar } = useAppLayout();
const layoutStore = useLayoutStore();

const menuItems = computed(() => [
    { icon: Box, label: "common.media_assets", path: "/", active: route.path === "/" },
    { icon: FileText, label: "common.post_collections", path: "/posts", active: route.path.startsWith("/posts") },
    {
        icon: FolderPlus,
        label: "draft_box.title",
        path: "/drafts",
        active: route.path.startsWith("/drafts"),
        badge: importStore.draftFiles.length,
    },
    { icon: Tag, label: "common.tags", path: "/tags", active: route.path.startsWith("/tags") },
    { icon: Trash2, label: "common.trash", path: "/trash", active: route.path.startsWith("/trash") },
    { icon: Activity, label: "jobs.nav_title", path: "/jobs", active: route.path.startsWith("/jobs") },
]);

const importStore = useImportStore();

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
</script>

<template>
    <aside
        class="h-full bg-zinc-50/80 border-r border-zinc-200/80 flex flex-col text-sm select-none"
        :aria-label="$t('common.navigation', 'Navigation')"
    >
        <!-- Sidebar Header: Library Switcher & Collapse Toggle -->
        <div class="h-14 border-b border-zinc-200/80 px-3.5 flex items-center justify-between gap-2 shrink-0 bg-zinc-50/50">
            <div class="flex-1 min-w-0">
                <LibrarySwitcher />
            </div>
            <button
                @click="toggleSidebar"
                :title="`${$t('common.collapse', 'Collapse')} (⌘B)`"
                :aria-label="$t('common.collapse', 'Collapse')"
                class="hidden md:flex h-8 w-8 rounded-lg items-center justify-center text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 active:scale-[0.96] transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
            >
                <Sidebar class="w-4 h-4" />
            </button>
        </div>

        <!-- Creation Action Section (Spacious Full-Width) -->
        <div class="px-3.5 pt-4 pb-2 flex flex-col gap-2 shrink-0">
            <Button
                @click="triggerCreatePost"
                variant="default"
                class="w-full justify-center gap-2 shadow-xs active:scale-[0.96] cursor-pointer bg-zinc-900 hover:bg-zinc-800 text-white font-medium text-sm h-9 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 transition-colors"
            >
                <Plus class="w-4 h-4 shrink-0" />
                <span>{{ $t("post.create_btn") }}</span>
            </Button>
            <Button
                @click="triggerCreateMedia"
                variant="outline"
                class="w-full justify-center gap-2 shadow-xs active:scale-[0.96] cursor-pointer border-zinc-200/90 bg-white hover:bg-zinc-50 hover:border-zinc-300 text-zinc-700 hover:text-zinc-900 font-medium text-sm h-9 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 transition-colors"
            >
                <Upload class="w-4 h-4 shrink-0 text-zinc-400" />
                <span>{{ $t("media.create_btn") }}</span>
            </Button>
        </div>

        <!-- Menu Items -->
        <nav class="flex flex-col gap-1 px-3.5 py-3 flex-1 overflow-y-auto">
            <NuxtLink
                v-for="item in menuItems"
                :key="item.label"
                :to="item.path"
                class="group h-9 flex items-center justify-between px-3 rounded-lg text-sm font-medium border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 select-none cursor-pointer"
                :class="
                    item.active
                        ? 'bg-white text-zinc-950 font-semibold shadow-xs border-zinc-200/80'
                        : 'border-transparent text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                "
            >
                <div class="flex items-center gap-3 min-w-0">
                    <component
                        :is="item.icon"
                        class="w-4.5 h-4.5 shrink-0 transition-colors"
                        :class="item.active ? 'text-zinc-950' : 'text-zinc-400 group-hover:text-zinc-700'"
                    />
                    <span class="truncate leading-none">{{ item.label.includes(".") ? $t(item.label) : item.label }}</span>
                </div>
                <span
                    v-if="item.badge && item.badge > 0"
                    class="text-xs px-2 py-0.5 rounded-full font-medium tabular-nums min-w-5 text-center shrink-0 transition-colors leading-none"
                    :class="
                        item.active
                            ? 'bg-zinc-900 text-white'
                            : 'bg-zinc-200/70 text-zinc-600 group-hover:bg-zinc-200 group-hover:text-zinc-900'
                    "
                >
                    {{ item.badge }}
                </span>
            </NuxtLink>
        </nav>

        <!-- Settings -->
        <div class="mt-auto p-3.5 border-t border-zinc-200/60 flex flex-col gap-1 shrink-0">
            <NuxtLink
                to="/settings"
                class="group h-9 flex items-center gap-3 w-full text-sm font-medium px-3 rounded-lg border border-transparent text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors duration-150 cursor-pointer active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
            >
                <component :is="Settings" class="w-4.5 h-4.5 text-zinc-400 group-hover:text-zinc-700 transition-colors shrink-0" />
                <span class="truncate leading-none">{{ $t("common.settings") }}</span>
            </NuxtLink>
        </div>
    </aside>
</template>
