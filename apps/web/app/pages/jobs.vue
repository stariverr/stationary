<script setup lang="ts">
import { computed, ref } from "vue";
import { Sidebar, Wrench } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { toast } from "vue-sonner";
import { useAppLayout } from "@/composables/useAppLayout";
import { useApi } from "@/composables/useApi";
import PipelineStatusSection from "@/components/jobs/PipelineStatusSection.vue";
import { useLibraryStore } from "@/stores/library";

const { toggleSidebar, isSidebarCollapsed } = useAppLayout();
const { t } = useI18n();
const libraryStore = useLibraryStore();
const libraryId = computed(() => libraryStore.activeLibrary?.id ?? null);

const isSweeping = ref(false);

function isApiSuccess(res: any): boolean {
    return Boolean(res && (res.success || res.code === 0 || res.code === "SUCCESS"));
}

async function sweepStuckTasks() {
    if (!libraryId.value) return;
    isSweeping.value = true;
    try {
        const res: any = await useApi("/task/sweep-stuck-library", { method: "POST", body: { library_id: libraryId.value } });
        if (!isApiSuccess(res)) throw new Error(res?.message);
        toast.success(t("jobs.toast.swept"));
    } catch (e) {
        toast.error(t("jobs.toast.action_failed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
        isSweeping.value = false;
    }
}
</script>

<template>
    <div class="h-full flex flex-col bg-white overflow-hidden">
        <header class="h-14 border-b border-zinc-200/80 px-4 md:px-6 shrink-0 flex items-center justify-between gap-3 bg-white">
            <div class="flex items-center gap-2.5 min-w-0">
                <button
                    class="h-8 w-8 rounded-lg -ml-1 items-center justify-center text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                    :class="isSidebarCollapsed ? 'flex' : 'flex md:hidden'"
                    :aria-label="$t('common.toggle_sidebar')"
                    @click="toggleSidebar"
                >
                    <Sidebar class="w-4.5 h-4.5" />
                </button>
                <h1 class="text-sm font-bold tracking-tight text-zinc-900 leading-none truncate">
                    {{ $t("jobs.nav_title") }}
                    <span v-if="libraryStore.activeLibrary" class="font-medium text-zinc-500">
                        <span class="mx-1" aria-hidden="true">/</span>{{ libraryStore.activeLibrary.name }}
                    </span>
                </h1>
            </div>

            <Button
                variant="ghost"
                size="sm"
                class="h-8 gap-1.5 px-2.5 text-xs font-semibold text-zinc-600 rounded-lg shrink-0 active:scale-[0.96]"
                :disabled="isSweeping || !libraryId"
                :title="$t('jobs.actions.sweep_hint')"
                @click="sweepStuckTasks"
            >
                <Wrench class="w-3.5 h-3.5" :class="{ 'animate-spin': isSweeping }" />
                <span class="hidden sm:inline">{{ $t("jobs.actions.sweep") }}</span>
            </Button>
        </header>

        <PipelineStatusSection v-if="libraryId" :library-id="libraryId" />
    </div>
</template>
