<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { RotateCcw, ChevronLeft, ChevronRight, MoreHorizontal, Copy, Sidebar, X, Inbox, Play, Pause, XCircle, Wrench } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "vue-sonner";
import { useAppLayout } from "@/composables/useAppLayout";
import { useApi } from "@/composables/useApi";
import { formatTemporalRelative, formatTemporalDuration } from "@/utils/temporal";
import JobDetailView, { type MasterTaskItem } from "@/components/JobDetailView.vue";
import PipelineStatusSection from "@/components/jobs/PipelineStatusSection.vue";
import TaskStatusLabel from "@/components/jobs/TaskStatusLabel.vue";
import { useLibraryStore } from "@/stores/library";

const { toggleSidebar, isSidebarCollapsed } = useAppLayout();
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const libraryStore = useLibraryStore();
const libraryId = computed(() => libraryStore.activeLibrary?.id ?? null);

type TaskStatus = "DISCOVERING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
type StatusFilter = "ALL" | TaskStatus;

interface TaskStats {
    total: number;
    statuses: Record<TaskStatus, number>;
}

const STATUS_FILTERS: StatusFilter[] = ["ALL", "RUNNING", "DISCOVERING", "FAILED", "PAUSED", "COMPLETED", "CANCELLED"];
const ACTIVE_STATUSES = ["RUNNING", "DISCOVERING"];
const CANCELLABLE_STATUSES = ["RUNNING", "DISCOVERING", "PAUSED", "FAILED"];
const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 5000;

const stats = ref<TaskStats | null>(null);
const tasks = ref<MasterTaskItem[]>([]);
const tasksLoading = ref(false);
const page = ref(1);
const totalPages = ref(1);
const totalItems = ref(0);
const statusFilter = ref<StatusFilter>("ALL");
const selectedTaskIds = ref<string[]>([]);

const activeTask = ref<MasterTaskItem | null>(null);
const detailViewRef = ref<InstanceType<typeof JobDetailView> | null>(null);

const actionLoadingId = ref<string | null>(null);
const isBulkLoading = ref(false);
const isSweeping = ref(false);
/** Tasks waiting for the user to confirm cancellation; `bulk` cancels the current selection. */
const cancelTarget = ref<{ ids: string[]; bulk: boolean } | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;

function formatTaskType(type: string): string {
    const key = `jobs.task_types.${type}`;
    const translated = t(key);
    return translated !== key ? translated : type;
}

function formatScope(task: MasterTaskItem): string {
    const mediaIds = task.input_snapshot?.media_ids;
    return Array.isArray(mediaIds) ? t("jobs.tasks.scope_media", { count: mediaIds.length }) : t("jobs.tasks.scope_library");
}

function unitShare(task: MasterTaskItem, value: number): string {
    return task.total_units ? `${Math.min(100, (value / task.total_units) * 100)}%` : "0%";
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function isApiSuccess(res: any): boolean {
    return Boolean(res && (res.success || res.code === 0 || res.code === "SUCCESS"));
}

function copyTaskId(id: string) {
    navigator.clipboard.writeText(id);
    toast.success(t("jobs.tasks.id_copied"));
}

function statusCount(key: StatusFilter): number {
    if (!stats.value) return 0;
    return key === "ALL" ? stats.value.total : stats.value.statuses[key];
}

function filterLabel(key: StatusFilter): string {
    return t(`jobs.tabs.${key.toLowerCase()}`);
}

const visibleFilters = computed(() => STATUS_FILTERS.filter((key) => key === "ALL" || key === statusFilter.value || statusCount(key) > 0));

const selectedTasks = computed(() => tasks.value.filter((task) => selectedTaskIds.value.includes(task.id)));
const canBulkRetry = computed(() => selectedTasks.value.some((task) => task.failed_units > 0));
const canBulkPause = computed(() => selectedTasks.value.some((task) => ACTIVE_STATUSES.includes(task.status)));
const canBulkResume = computed(() => selectedTasks.value.some((task) => task.status === "PAUSED"));
const canBulkCancel = computed(() => selectedTasks.value.some((task) => CANCELLABLE_STATUSES.includes(task.status)));

const selectionState = computed(() => {
    const selected = selectedTasks.value.length;
    if (selected === 0) return false;
    return selected === tasks.value.length ? true : "indeterminate";
});

const pageRange = computed(() => ({
    from: totalItems.value === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1,
    to: Math.min(page.value * PAGE_SIZE, totalItems.value),
    total: totalItems.value,
}));

function toggleSelectAll() {
    selectedTaskIds.value = selectionState.value === true ? [] : tasks.value.map((task) => task.id);
}

function toggleSelectTask(id: string) {
    selectedTaskIds.value = selectedTaskIds.value.includes(id)
        ? selectedTaskIds.value.filter((taskId) => taskId !== id)
        : [...selectedTaskIds.value, id];
}

async function fetchStats() {
    if (!libraryId.value) return;
    try {
        const res: any = await useApi("/jobs/stats", { query: { library_id: libraryId.value } });
        if (isApiSuccess(res) && res.data) stats.value = res.data;
    } catch (e) {
        console.error("Failed to fetch task stats:", e);
    }
}

async function fetchTasks(isSilent = false) {
    if (!libraryId.value) return;
    if (!isSilent) tasksLoading.value = true;
    try {
        const res: any = await useApi("/jobs/list", {
            query: {
                library_id: libraryId.value,
                page: page.value,
                limit: PAGE_SIZE,
                status: statusFilter.value === "ALL" ? undefined : statusFilter.value,
            },
        });
        if (isApiSuccess(res) && res.data) {
            tasks.value = res.data.items || [];
            totalPages.value = res.data.pagination?.total_pages || 1;
            totalItems.value = res.data.pagination?.total || 0;
        }
    } catch (e) {
        if (!isSilent) toast.error(t("jobs.toast.load_failed"), { description: errorMessage(e) });
    } finally {
        if (!isSilent) tasksLoading.value = false;
    }
}

async function fetchTaskDetail(taskId: string) {
    try {
        const res: any = await useApi(`/jobs/${taskId}`);
        if (isApiSuccess(res) && res.data && activeTask.value?.id === taskId) {
            activeTask.value = res.data as MasterTaskItem;
        }
    } catch (e) {
        console.error("Failed to refresh task:", e);
    }
}

async function refreshAll() {
    await Promise.all([fetchStats(), fetchTasks(true), activeTask.value && fetchTaskDetail(activeTask.value.id)]);
}

async function runTaskAction(
    taskId: string,
    action: "retry-failed" | "pause" | "resume" | "cancel",
    successMessage: (data: any) => string,
) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await useApi(`/jobs/${taskId}/${action}`, { method: "POST" });
        if (!isApiSuccess(res)) throw new Error(res?.message);
        toast.success(successMessage(res.data));
        await refreshAll();
        if (activeTask.value?.id === taskId) await detailViewRef.value?.refreshUnits();
    } catch (e) {
        toast.error(t("jobs.toast.action_failed"), { description: errorMessage(e) });
    } finally {
        actionLoadingId.value = null;
    }
}

const retryTaskFailedUnits = (taskId: string) =>
    runTaskAction(taskId, "retry-failed", (data) => t("jobs.toast.retried", { count: data?.requeued_count ?? 0 }));
const pauseTask = (taskId: string) => runTaskAction(taskId, "pause", () => t("jobs.toast.paused"));
const resumeTask = (taskId: string) => runTaskAction(taskId, "resume", () => t("jobs.toast.resumed"));

async function runBulkAction(path: string, successMessage: (data: any) => string) {
    if (selectedTaskIds.value.length === 0) return;
    isBulkLoading.value = true;
    try {
        const res: any = await useApi(path, { method: "POST", body: { task_ids: selectedTaskIds.value } });
        if (!isApiSuccess(res)) throw new Error(res?.message);
        toast.success(successMessage(res.data));
        selectedTaskIds.value = [];
        await refreshAll();
    } catch (e) {
        toast.error(t("jobs.toast.action_failed"), { description: errorMessage(e) });
    } finally {
        isBulkLoading.value = false;
    }
}

const handleBulkRetry = () =>
    runBulkAction("/jobs/units/batch-retry", (data) => t("jobs.toast.retried", { count: data?.retried_count ?? 0 }));
const handleBulkPause = () => runBulkAction("/jobs/batch-pause", (data) => t("jobs.toast.bulk_paused", { count: data?.count ?? 0 }));
const handleBulkResume = () => runBulkAction("/jobs/batch-resume", (data) => t("jobs.toast.bulk_resumed", { count: data?.count ?? 0 }));

function requestCancel(taskId: string) {
    cancelTarget.value = { ids: [taskId], bulk: false };
}

function requestBulkCancel() {
    cancelTarget.value = { ids: [...selectedTaskIds.value], bulk: true };
}

function confirmCancel() {
    const target = cancelTarget.value;
    cancelTarget.value = null;
    if (!target) return;
    if (target.bulk) {
        runBulkAction("/jobs/batch-cancel", (data) => t("jobs.toast.bulk_cancelled", { count: data?.count ?? 0 }));
    } else {
        runTaskAction(target.ids[0]!, "cancel", () => t("jobs.toast.cancelled"));
    }
}

async function sweepStuckTasks() {
    if (!libraryId.value) return;
    isSweeping.value = true;
    try {
        const res: any = await useApi("/task/sweep-stuck-library", { method: "POST", body: { library_id: libraryId.value } });
        if (!isApiSuccess(res)) throw new Error(res?.message);
        toast.success(t("jobs.toast.swept"));
        await refreshAll();
    } catch (e) {
        toast.error(t("jobs.toast.action_failed"), { description: errorMessage(e) });
    } finally {
        isSweeping.value = false;
    }
}

function goToPage(target: number) {
    page.value = target;
    selectedTaskIds.value = [];
    fetchTasks();
}

function syncTaskQuery(taskId: string | null) {
    const query = { ...route.query };
    if (taskId) {
        query.task = taskId;
    } else {
        delete query.task;
    }
    router.replace({ query });
}

function openTaskDetail(task: MasterTaskItem) {
    activeTask.value = task;
    syncTaskQuery(task.id);
    fetchTaskDetail(task.id);
}

function closeTaskDetail() {
    activeTask.value = null;
    syncTaskQuery(null);
}

async function openTaskById(taskId: string) {
    const known = tasks.value.find((item) => item.id === taskId);
    if (known) {
        openTaskDetail(known);
        return;
    }

    try {
        const res: any = await useApi(`/jobs/${taskId}`);
        if (!isApiSuccess(res) || !res.data) throw new Error(t("jobs.toast.not_found"));
        openTaskDetail(res.data as MasterTaskItem);
    } catch (e) {
        toast.error(t("jobs.toast.detail_failed"), { description: errorMessage(e) });
        syncTaskQuery(null);
    }
}

watch(statusFilter, () => goToPage(1));

watch(libraryId, () => {
    page.value = 1;
    selectedTaskIds.value = [];
    tasks.value = [];
    stats.value = null;
    if (activeTask.value) closeTaskDetail();
    fetchStats();
    fetchTasks();
});

// Runs in the capture phase so an open confirm dialog sees Escape first and keeps the inspector open.
function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || cancelTarget.value) return;
    if (activeTask.value) {
        closeTaskDetail();
    } else if (selectedTaskIds.value.length > 0) {
        selectedTaskIds.value = [];
    }
}

onMounted(() => {
    fetchStats();
    fetchTasks();
    window.addEventListener("keydown", handleKeydown, true);

    const sharedTaskId = typeof route.query.task === "string" ? route.query.task : null;
    if (sharedTaskId) openTaskById(sharedTaskId);

    timer = setInterval(() => {
        refreshAll();
        detailViewRef.value?.refreshUnits();
    }, POLL_INTERVAL_MS);
});

onUnmounted(() => {
    if (timer) clearInterval(timer);
    window.removeEventListener("keydown", handleKeydown, true);
});
</script>

<template>
    <div class="h-full flex bg-white overflow-hidden">
        <div class="flex-1 min-w-0 flex flex-col">
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

            <!-- Status tabs, or the bulk bar while tasks are selected -->
            <div class="h-12 px-4 md:px-6 border-b border-zinc-200/80 bg-white flex items-center justify-between gap-3 shrink-0">
                <div
                    v-if="selectedTaskIds.length === 0"
                    class="h-full flex items-center gap-5 overflow-x-auto scrollbar-none"
                    role="tablist"
                    :aria-label="$t('jobs.tasks.filter_label')"
                >
                    <button
                        v-for="key in visibleFilters"
                        :key="key"
                        role="tab"
                        :aria-selected="statusFilter === key"
                        class="relative h-full px-1 text-xs sm:text-sm font-bold tracking-tight flex items-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-inset"
                        :class="statusFilter === key ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'"
                        @click="statusFilter = key"
                    >
                        {{ filterLabel(key) }}
                        <span
                            class="text-xs font-bold px-1.5 py-0.5 rounded-full tabular-nums"
                            :class="statusFilter === key ? 'bg-zinc-200 text-zinc-800' : 'bg-zinc-100 text-zinc-500'"
                        >
                            {{ statusCount(key) }}
                        </span>
                        <span v-if="statusFilter === key" class="absolute bottom-0 inset-x-0 h-[2px] bg-zinc-800 rounded-full" />
                    </button>
                </div>

                <div v-else class="h-full flex items-center gap-1.5 min-w-0 overflow-x-auto scrollbar-none">
                    <button
                        class="h-7 w-7 rounded-md flex items-center justify-center text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                        :aria-label="$t('jobs.bulk.clear')"
                        @click="selectedTaskIds = []"
                    >
                        <X class="w-4 h-4" />
                    </button>
                    <span class="text-xs sm:text-sm font-bold tracking-tight text-zinc-900 tabular-nums whitespace-nowrap me-2">
                        {{ $t("jobs.bulk.selected", { count: selectedTaskIds.length }) }}
                    </span>
                    <Button
                        v-if="canBulkRetry"
                        size="sm"
                        class="h-8 gap-1.5 px-2.5 font-bold text-xs rounded-lg active:scale-[0.96]"
                        :disabled="isBulkLoading"
                        @click="handleBulkRetry"
                    >
                        <RotateCcw class="w-3.5 h-3.5" />
                        {{ $t("jobs.bulk.retry_failed") }}
                    </Button>
                    <Button
                        v-if="canBulkPause"
                        variant="outline"
                        size="sm"
                        class="h-8 gap-1.5 px-2.5 font-bold text-xs rounded-lg active:scale-[0.96]"
                        :disabled="isBulkLoading"
                        @click="handleBulkPause"
                    >
                        <Pause class="w-3.5 h-3.5" />
                        {{ $t("jobs.bulk.pause") }}
                    </Button>
                    <Button
                        v-if="canBulkResume"
                        variant="outline"
                        size="sm"
                        class="h-8 gap-1.5 px-2.5 font-bold text-xs rounded-lg active:scale-[0.96]"
                        :disabled="isBulkLoading"
                        @click="handleBulkResume"
                    >
                        <Play class="w-3.5 h-3.5" />
                        {{ $t("jobs.bulk.resume") }}
                    </Button>
                    <Button
                        v-if="canBulkCancel"
                        variant="ghost"
                        size="sm"
                        class="h-8 gap-1.5 px-2.5 font-bold text-xs rounded-lg text-red-600 hover:text-red-700 hover:bg-red-50 active:scale-[0.96]"
                        :disabled="isBulkLoading"
                        @click="requestBulkCancel"
                    >
                        <XCircle class="w-3.5 h-3.5" />
                        {{ $t("jobs.bulk.cancel") }}
                    </Button>
                </div>
            </div>

            <div class="flex-1 min-h-0 overflow-y-auto bg-white">
                <!-- Empty: nothing has run in this library yet, or nothing matches the status tab -->
                <div
                    v-if="!tasksLoading && tasks.length === 0"
                    class="h-full min-h-64 flex flex-col items-center justify-center gap-3 px-6 text-center"
                >
                    <div class="w-12 h-12 rounded-xl bg-zinc-50 border border-zinc-200 flex items-center justify-center">
                        <Inbox class="w-5 h-5 text-zinc-400" />
                    </div>
                    <div class="space-y-1 max-w-xs">
                        <h2 class="text-sm font-semibold text-zinc-800">
                            {{ statusFilter === "ALL" ? $t("jobs.empty.no_tasks") : $t("jobs.empty.no_match") }}
                        </h2>
                        <p class="text-xs text-zinc-500 text-pretty">
                            {{ statusFilter === "ALL" ? $t("jobs.empty.no_tasks_desc") : $t("jobs.empty.no_match_desc") }}
                        </p>
                    </div>
                    <Button
                        v-if="statusFilter !== 'ALL'"
                        variant="outline"
                        size="sm"
                        class="h-8 px-3 text-xs font-bold rounded-lg"
                        @click="statusFilter = 'ALL'"
                    >
                        {{ $t("jobs.empty.reset") }}
                    </Button>
                </div>

                <table v-else class="w-full text-left border-collapse text-xs">
                    <thead class="sticky top-0 z-10">
                        <tr class="tracking-wider text-[10px] uppercase font-bold text-zinc-500 bg-zinc-50 border-b border-zinc-200/80">
                            <th class="w-10 ps-4 md:ps-6 pe-2 py-2.5">
                                <Checkbox
                                    :model-value="selectionState"
                                    :disabled="tasks.length === 0"
                                    :aria-label="$t('jobs.tasks.select_all')"
                                    class="size-4 rounded-sm"
                                    @update:model-value="toggleSelectAll"
                                />
                            </th>
                            <th class="hidden sm:table-cell w-32 px-3 py-2.5">{{ $t("jobs.tasks.col_status") }}</th>
                            <th class="px-3 py-2.5">{{ $t("jobs.tasks.col_task") }}</th>
                            <th class="w-28 sm:w-44 px-3 py-2.5">{{ $t("jobs.tasks.col_progress") }}</th>
                            <th class="w-36 px-3 py-2.5" :class="activeTask ? 'hidden' : 'hidden md:table-cell'">
                                {{ $t("jobs.tasks.col_created") }}
                            </th>
                            <th class="w-12 pe-4 md:pe-6 py-2.5">
                                <span class="sr-only">{{ $t("jobs.tasks.more") }}</span>
                            </th>
                        </tr>
                    </thead>

                    <tbody v-if="tasksLoading && tasks.length === 0">
                        <tr v-for="row in 6" :key="row" class="border-b border-zinc-100">
                            <td colspan="6" class="px-4 md:px-6 py-3.5">
                                <div class="flex items-center gap-4 animate-pulse motion-reduce:animate-none">
                                    <div class="size-4 rounded-sm bg-zinc-100" />
                                    <div class="h-3 w-16 rounded bg-zinc-100" />
                                    <div class="h-3 flex-1 max-w-56 rounded bg-zinc-100" />
                                    <div class="h-1.5 w-32 rounded-full bg-zinc-100 ms-auto" />
                                </div>
                            </td>
                        </tr>
                    </tbody>

                    <tbody v-else>
                        <tr
                            v-for="task in tasks"
                            :key="task.id"
                            class="group border-b border-zinc-100 cursor-pointer transition-colors"
                            :class="
                                activeTask?.id === task.id
                                    ? 'bg-zinc-100/80'
                                    : selectedTaskIds.includes(task.id)
                                      ? 'bg-zinc-50'
                                      : 'hover:bg-zinc-50/70'
                            "
                            @click="openTaskDetail(task)"
                        >
                            <td class="ps-4 md:ps-6 pe-2 py-3" @click.stop>
                                <Checkbox
                                    :model-value="selectedTaskIds.includes(task.id)"
                                    :aria-label="$t('jobs.tasks.select_task', { id: task.id.slice(0, 8) })"
                                    class="size-4 rounded-sm"
                                    @update:model-value="toggleSelectTask(task.id)"
                                />
                            </td>
                            <td class="hidden sm:table-cell px-3 py-3 font-medium">
                                <TaskStatusLabel :status="task.status" />
                            </td>
                            <td class="px-3 py-3 min-w-0">
                                <button
                                    class="block max-w-full text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                                    @click.stop="openTaskDetail(task)"
                                >
                                    <span class="block truncate font-semibold text-zinc-800 group-hover:text-zinc-950">
                                        {{ formatScope(task) }}
                                    </span>
                                    <span class="mt-0.5 flex items-center gap-1.5 text-zinc-500 truncate">
                                        <TaskStatusLabel :status="task.status" class="sm:hidden font-medium" />
                                        <span class="truncate">{{ formatTaskType(task.type) }}</span>
                                        <span class="font-mono tabular-nums hidden sm:inline">#{{ task.id.slice(0, 8) }}</span>
                                    </span>
                                </button>
                            </td>
                            <td class="px-3 py-3">
                                <div
                                    class="h-1.5 w-full rounded-full bg-zinc-100 overflow-hidden flex"
                                    role="progressbar"
                                    :aria-valuenow="task.progress.percentage"
                                    aria-valuemin="0"
                                    aria-valuemax="100"
                                    :aria-label="$t('jobs.tasks.col_progress')"
                                >
                                    <div
                                        class="h-full bg-zinc-800 transition-[width] duration-200"
                                        :style="{ width: unitShare(task, task.succeeded_units) }"
                                    />
                                    <div
                                        class="h-full bg-red-500 transition-[width] duration-200"
                                        :style="{ width: unitShare(task, task.failed_units) }"
                                    />
                                    <div
                                        class="h-full bg-zinc-300 transition-[width] duration-200"
                                        :style="{ width: unitShare(task, task.cancelled_units) }"
                                    />
                                </div>
                                <div class="mt-1.5 flex items-center gap-2 tabular-nums whitespace-nowrap">
                                    <span class="text-zinc-500">
                                        {{ $t("jobs.tasks.progress", { done: task.progress.processed_units, total: task.total_units }) }}
                                    </span>
                                    <span v-if="task.failed_units > 0" class="text-red-600 font-medium hidden sm:inline">
                                        {{ $t("jobs.tasks.failed_units", { count: task.failed_units }) }}
                                    </span>
                                </div>
                            </td>
                            <td class="px-3 py-3 whitespace-nowrap" :class="activeTask ? 'hidden' : 'hidden md:table-cell'">
                                <span class="block text-zinc-600 tabular-nums" :title="task.create_time">
                                    {{ formatTemporalRelative(task.create_time, locale) }}
                                </span>
                                <span v-if="task.complete_time" class="block mt-0.5 text-zinc-500 tabular-nums">
                                    {{
                                        $t("jobs.tasks.duration", {
                                            duration: formatTemporalDuration(task.create_time, task.complete_time, locale),
                                        })
                                    }}
                                </span>
                            </td>
                            <td class="pe-4 md:pe-6 py-3 text-right" @click.stop>
                                <DropdownMenu>
                                    <DropdownMenuTrigger as-child>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            class="text-zinc-500 hover:text-zinc-900 data-[state=open]:bg-zinc-100 data-[state=open]:text-zinc-900"
                                            :disabled="actionLoadingId === task.id"
                                            :aria-label="$t('jobs.tasks.more')"
                                        >
                                            <MoreHorizontal class="w-4 h-4" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" class="w-48">
                                        <DropdownMenuItem v-if="task.failed_units > 0" @click="retryTaskFailedUnits(task.id)">
                                            <RotateCcw />
                                            {{ $t("jobs.tasks.retry_failed") }}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem v-if="ACTIVE_STATUSES.includes(task.status)" @click="pauseTask(task.id)">
                                            <Pause />
                                            {{ $t("jobs.actions.pause") }}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem v-if="task.status === 'PAUSED'" @click="resumeTask(task.id)">
                                            <Play />
                                            {{ $t("jobs.actions.resume") }}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem @click="copyTaskId(task.id)">
                                            <Copy />
                                            {{ $t("jobs.tasks.copy_id") }}
                                        </DropdownMenuItem>
                                        <template v-if="CANCELLABLE_STATUSES.includes(task.status)">
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem variant="destructive" @click="requestCancel(task.id)">
                                                <XCircle />
                                                {{ $t("jobs.actions.cancel") }}
                                            </DropdownMenuItem>
                                        </template>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <nav
                v-if="totalPages > 1"
                class="h-12 px-4 md:px-6 border-t border-zinc-200/80 bg-white flex items-center justify-between gap-3 shrink-0 text-xs"
                :aria-label="$t('jobs.pagination.label')"
            >
                <span class="text-zinc-500 font-medium tabular-nums">{{ $t("jobs.pagination.range", pageRange) }}</span>
                <div class="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        class="text-zinc-600"
                        :disabled="page <= 1 || tasksLoading"
                        :aria-label="$t('jobs.pagination.prev')"
                        @click="goToPage(page - 1)"
                    >
                        <ChevronLeft class="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        class="text-zinc-600"
                        :disabled="page >= totalPages || tasksLoading"
                        :aria-label="$t('jobs.pagination.next')"
                        @click="goToPage(page + 1)"
                    >
                        <ChevronRight class="w-4 h-4" />
                    </Button>
                </div>
            </nav>
        </div>

        <!-- Inspector: docked beside the list on wide screens, a sheet over it below xl -->
        <div v-if="activeTask" class="fixed inset-0 bg-black/10 z-30 xl:hidden" aria-hidden="true" @click="closeTaskDetail" />
        <transition name="side-panel">
            <aside
                v-if="activeTask"
                class="fixed inset-y-0 right-0 xl:relative z-45 w-full sm:w-[28rem] bg-white border-l border-zinc-200/80 shadow-2xl xl:shadow-none flex flex-col overflow-hidden shrink-0 h-full"
                :aria-label="$t('jobs.inspector.title')"
            >
                <JobDetailView
                    ref="detailViewRef"
                    :task="activeTask"
                    :busy="actionLoadingId === activeTask.id"
                    @close="closeTaskDetail"
                    @task-changed="refreshAll"
                    @retry-failed-units="retryTaskFailedUnits"
                    @pause-task="pauseTask"
                    @resume-task="resumeTask"
                    @cancel-task="requestCancel"
                />
            </aside>
        </transition>

        <AlertDialog :open="cancelTarget !== null" @update:open="(open) => !open && (cancelTarget = null)">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {{
                            cancelTarget && cancelTarget.ids.length > 1
                                ? $t("jobs.cancel_dialog.title_many", { count: cancelTarget.ids.length })
                                : $t("jobs.cancel_dialog.title_one")
                        }}
                    </AlertDialogTitle>
                    <AlertDialogDescription>{{ $t("jobs.cancel_dialog.desc") }}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ $t("jobs.cancel_dialog.keep") }}</AlertDialogCancel>
                    <AlertDialogAction class="bg-destructive text-white hover:bg-destructive/90" @click="confirmCancel">
                        {{ $t("jobs.cancel_dialog.confirm") }}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </div>
</template>

<style scoped>
.side-panel-enter-active,
.side-panel-leave-active {
    transition:
        transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
        opacity 0.22s ease;
}
.side-panel-enter-from,
.side-panel-leave-to {
    transform: translateX(100%);
    opacity: 0;
}
@media (min-width: 1280px) {
    /* Docked beside the list, the panel only fades so the table doesn't jump twice. */
    .side-panel-enter-from,
    .side-panel-leave-to {
        transform: none;
    }
}
@media (prefers-reduced-motion: reduce) {
    .side-panel-enter-from,
    .side-panel-leave-to {
        transform: none;
    }
}
</style>
