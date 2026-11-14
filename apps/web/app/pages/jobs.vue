<script setup lang="ts">
import { Ellipsis, Pause, Play, Sidebar, Wrench } from "@lucide/vue";
import { onKeyStroke } from "@vueuse/core";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import PipelineInspector from "@/components/jobs/PipelineInspector.vue";
import PipelineTable from "@/components/jobs/PipelineTable.vue";
import { useAppLayout } from "@/composables/useAppLayout";
import { useLibraryPipelines } from "@/composables/useLibraryPipelines";
import { useLibraryStore } from "@/stores/library";
import type { PipelineName } from "@/types/pipeline";
import { hasWork } from "@/utils/pipelines";

const { toggleSidebar, isSidebarCollapsed } = useAppLayout();
const { t } = useI18n();
const libraryStore = useLibraryStore();
const libraryId = computed(() => libraryStore.activeLibrary?.id ?? null);

const { query, setPaused, retryFailed, sweepStuck } = useLibraryPipelines(libraryId);
const pipelines = computed(() => query.data.value?.pipelines);
const paused = computed(() => query.data.value?.paused ?? false);

const selected = ref<PipelineName | null>(null);
const selectedStatus = computed(() => pipelines.value?.find((status) => status.pipeline === selected.value) ?? null);
watch(libraryId, () => {
    selected.value = null;
});
onKeyStroke("Escape", () => {
    selected.value = null;
});

const toggleSelected = (pipeline: PipelineName) => {
    selected.value = selected.value === pipeline ? null : pipeline;
};

/** One line for the whole library, most pressing first. */
const summary = computed(() => {
    const all = pipelines.value;
    if (!all) return null;
    const remaining = all.reduce((sum, status) => sum + status.queued, 0);
    const failed = all.reduce((sum, status) => sum + status.failed, 0);
    if (paused.value) return { dot: "bg-zinc-400", text: t("jobs.summary.paused", { count: remaining }) };
    if (all.some(hasWork)) {
        return { dot: "bg-sky-500", text: remaining > 0 ? t("jobs.summary.processing", { count: remaining }) : t("jobs.summary.scanning") };
    }
    if (failed > 0) return { dot: "bg-red-500", text: t("jobs.summary.failed", { count: failed }) };
    return { dot: "bg-zinc-200", text: t("jobs.summary.idle") };
});

const actionFailed = (e: unknown) =>
    toast.error(t("jobs.toast.action_failed"), { description: e instanceof Error ? e.message : undefined });

const pausing = ref(false);
async function togglePaused() {
    pausing.value = true;
    try {
        await setPaused(!paused.value);
    } catch (e) {
        actionFailed(e);
    } finally {
        pausing.value = false;
    }
}

const retrying = ref(false);
async function retrySelected() {
    if (!selected.value) return;
    retrying.value = true;
    try {
        toast.success(t("jobs.toast.retried", { count: await retryFailed(selected.value) }));
    } catch (e) {
        actionFailed(e);
    } finally {
        retrying.value = false;
    }
}

async function sweep() {
    try {
        await sweepStuck();
        toast.success(t("jobs.toast.swept"));
    } catch (e) {
        actionFailed(e);
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

            <div v-if="libraryId" class="flex items-center gap-1.5 shrink-0">
                <p v-if="summary" role="status" class="hidden sm:flex items-center gap-1.5 mr-1.5 text-xs font-medium text-zinc-500 tabular-nums">
                    <span class="size-1.5 rounded-full" :class="summary.dot" aria-hidden="true" />
                    {{ summary.text }}
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    class="h-8 gap-1.5 px-2.5 text-xs font-semibold text-zinc-700 rounded-lg active:scale-[0.96]"
                    :disabled="pausing || !query.data.value"
                    @click="togglePaused"
                >
                    <component :is="paused ? Play : Pause" class="size-3.5" />
                    {{ paused ? $t("jobs.actions.resume") : $t("jobs.actions.pause") }}
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button
                            variant="ghost"
                            size="sm"
                            class="h-8 w-8 p-0 text-zinc-500 rounded-lg active:scale-[0.96]"
                            :aria-label="$t('jobs.actions.more')"
                        >
                            <Ellipsis class="size-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent class="w-64" align="end" :side-offset="6">
                        <DropdownMenuItem class="items-start cursor-pointer" @select="sweep">
                            <Wrench class="mt-0.5" />
                            <span class="flex flex-col gap-0.5">
                                <span class="text-sm font-medium">{{ $t("jobs.actions.sweep") }}</span>
                                <span class="text-xs leading-snug text-muted-foreground">{{ $t("jobs.actions.sweep_hint") }}</span>
                            </span>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </header>

        <div v-if="paused" role="status" class="shrink-0 px-4 md:px-6 py-2 border-b border-amber-100 bg-amber-50/60 text-xs font-medium text-amber-800">
            {{ $t("jobs.paused_notice") }}
        </div>

        <div v-if="libraryId" class="flex-1 min-h-0 flex">
            <div class="flex-1 min-w-0 overflow-y-auto">
                <p v-if="query.isError.value && !pipelines" class="px-4 md:px-6 py-6 text-xs text-red-600">{{ $t("jobs.load_error") }}</p>
                <PipelineTable v-else :pipelines="pipelines" :paused="paused" :selected="selected" @select="toggleSelected" />
            </div>

            <div v-if="selectedStatus" class="fixed inset-0 z-30 bg-black/10 backdrop-blur-xs md:hidden" @click="selected = null" />
            <Transition name="side-panel">
                <aside
                    v-if="selectedStatus"
                    class="fixed inset-y-0 right-0 z-40 w-full sm:w-96 shadow-2xl md:relative md:inset-auto md:z-auto md:w-96 md:shadow-none shrink-0 border-l border-zinc-200/80"
                >
                    <PipelineInspector
                        :library-id="libraryId"
                        :status="selectedStatus"
                        :paused="paused"
                        :retrying="retrying"
                        @close="selected = null"
                        @retry="retrySelected"
                    />
                </aside>
            </Transition>
        </div>
    </div>
</template>

<style scoped>
.side-panel-enter-active,
.side-panel-leave-active {
    transition:
        transform 0.25s cubic-bezier(0.16, 1, 0.3, 1),
        opacity 0.25s ease;
}
.side-panel-enter-from,
.side-panel-leave-to {
    transform: translateX(100%);
    opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
    .side-panel-enter-active,
    .side-panel-leave-active {
        transition: none;
    }
}
</style>
