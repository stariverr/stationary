<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import {
    Activity,
    RefreshCw,
    RotateCcw,
    CheckCircle2,
    Clock,
    Search,
    Play,
    Pause,
    XCircle,
    Eye,
    ChevronLeft,
    ChevronRight,
    Terminal,
    AlertTriangle,
    Layers2,
    MoreHorizontal,
    FileText,
    SlidersHorizontal,
    ArrowUpRight,
    Filter,
    Copy,
    Check,
    ListFilter,
    Layers,
    Sparkles,
} from "@lucide/vue";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "vue-sonner";

interface QueueStats {
    tasks: {
        total: number;
        running: number;
        failed: number;
        completed: number;
    };
    units: {
        total: number;
        running: number;
        pending: number;
        succeeded: number;
        failed: number;
    };
}

interface MasterTaskItem {
    id: string;
    type: string;
    status: string;
    library_id: string | null;
    owner_id: string | null;
    config_version: number;
    control_requested: string;
    discovery_complete: boolean;
    total_units: number;
    succeeded_units: number;
    failed_units: number;
    cancelled_units: number;
    last_error: string | null;
    input_snapshot: Record<string, any> | null;
    create_time: string;
    update_time: string;
    complete_time: string | null;
    progress: {
        total_units: number;
        succeeded_units: number;
        failed_units: number;
        cancelled_units: number;
        processed_units: number;
        percentage: number;
    };
}

interface TaskUnitItem {
    id: string;
    task_id: string;
    unit_key: string;
    kind: string | null;
    subject_type: string | null;
    subject_id: string | null;
    status: string;
    outcome_code: string | null;
    attempt_count: number;
    max_attempts: number;
    last_error: string | null;
    create_time: string;
    complete_time: string | null;
}

const { t } = useI18n();

const stats = ref<QueueStats>({
    tasks: { total: 0, running: 0, failed: 0, completed: 0 },
    units: { total: 0, running: 0, pending: 0, succeeded: 0, failed: 0 },
});

// Master tasks table state
const tasks = ref<MasterTaskItem[]>([]);
const tasksLoading = ref(false);
const statsLoading = ref(false);
const page = ref(1);
const totalPages = ref(1);
const totalItems = ref(0);
const limit = ref(20);

const statusFilter = ref<string>("ALL");
const selectedTaskType = ref<string>("ALL");
const searchQuery = ref<string>("");

// Multi-select state
const selectedTaskIds = ref<string[]>([]);

// Task Detail & Sub-units Modal
const isDetailOpen = ref(false);
const activeTask = ref<MasterTaskItem | null>(null);
const taskUnits = ref<TaskUnitItem[]>([]);
const taskUnitsLoading = ref(false);

// Action loading state
const actionLoadingId = ref<string | null>(null);
const isBulkLoading = ref(false);
const isSweeping = ref(false);
const copiedId = ref<string | null>(null);

let timer: NodeJS.Timeout | null = null;

const taskTypeKeys: Record<string, string> = {
    ALL: "jobs.task_types.all",
    COVER_BATCH: "jobs.task_types.COVER_BATCH",
    COVER_RECONCILE: "jobs.task_types.COVER_RECONCILE",
    AI_ENRICH: "jobs.task_types.AI_ENRICH",
    POST_PROCESS: "jobs.task_types.POST_PROCESS",
    AVATAR_COPY: "jobs.task_types.AVATAR_COPY",
};

function formatTaskType(type: string): string {
    const key = taskTypeKeys[type];
    return key ? t(key) : type;
}

function formatStatus(status: string): string {
    switch (status) {
        case "RUNNING":
            return t("jobs.tabs.running");
        case "DISCOVERING":
            return t("jobs.tabs.discovering");
        case "PENDING":
            return t("jobs.tabs.pending");
        case "PAUSED":
            return t("jobs.tabs.paused");
        case "COMPLETED":
            return t("jobs.tabs.completed");
        case "FAILED":
            return t("jobs.tabs.failed");
        case "CANCELLED":
            return t("jobs.tabs.cancelled");
        case "SUCCEEDED":
            return t("jobs.tabs.succeeded");
        default:
            return status;
    }
}

function formatInputScope(task: MasterTaskItem): string {
    if (task.input_snapshot?.media_ids && Array.isArray(task.input_snapshot.media_ids)) {
        return `${task.input_snapshot.media_ids.length} 个文件`;
    }
    return "全局批处理";
}

function copyTaskId(id: string, e?: Event) {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(id);
    copiedId.value = id;
    toast.success("已复制任务 ID 到剪贴板");
    setTimeout(() => {
        if (copiedId.value === id) {
            copiedId.value = null;
        }
    }, 2000);
}

function isApiSuccess(res: any): boolean {
    return Boolean(res && (res.success || res.code === 0 || res.code === "SUCCESS"));
}

// Checkbox Multi-select Logic
const isAllSelected = computed(() => {
    if (filteredTasks.value.length === 0) return false;
    return filteredTasks.value.every((t) => selectedTaskIds.value.includes(t.id));
});

function toggleSelectAll() {
    if (isAllSelected.value) {
        selectedTaskIds.value = [];
    } else {
        selectedTaskIds.value = filteredTasks.value.map((t) => t.id);
    }
}

function toggleSelectTask(id: string, e?: Event) {
    if (e) e.stopPropagation();
    const idx = selectedTaskIds.value.indexOf(id);
    if (idx > -1) {
        selectedTaskIds.value.splice(idx, 1);
    } else {
        selectedTaskIds.value.push(id);
    }
    selectedTaskIds.value = [...selectedTaskIds.value];
}

async function fetchStats(isSilent = false) {
    if (!isSilent) statsLoading.value = true;
    try {
        const res: any = await $fetch("/api/jobs/stats");
        if (isApiSuccess(res) && res.data) {
            stats.value = res.data;
        }
    } catch (e: any) {
        console.error("Failed to fetch queue stats:", e);
    } finally {
        if (!isSilent) statsLoading.value = false;
    }
}

async function fetchTasks(isSilent = false) {
    if (!isSilent) tasksLoading.value = true;
    try {
        const queryParams: Record<string, any> = {
            page: page.value,
            limit: limit.value,
            status: statusFilter.value === "ALL" ? undefined : statusFilter.value,
        };
        if (selectedTaskType.value !== "ALL") {
            queryParams.type = selectedTaskType.value;
        }

        const res: any = await $fetch("/api/jobs/list", { query: queryParams });
        if (isApiSuccess(res) && res.data) {
            tasks.value = res.data.items || [];
            totalPages.value = res.data.pagination?.total_pages || 1;
            totalItems.value = res.data.pagination?.total || 0;
        }
    } catch (e: any) {
        toast.error(`加载任务列表失败: ${e.message || e}`);
    } finally {
        if (!isSilent) tasksLoading.value = false;
    }
}

async function fetchTaskUnits(taskId: string) {
    taskUnitsLoading.value = true;
    try {
        const res: any = await $fetch(`/api/jobs/${taskId}/items`, { query: { limit: 100 } });
        if (isApiSuccess(res) && res.data) {
            taskUnits.value = res.data.items || [];
        }
    } catch (e: any) {
        console.error("Failed to fetch task units:", e);
    } finally {
        taskUnitsLoading.value = false;
    }
}

async function refreshAll() {
    await Promise.all([fetchStats(false), fetchTasks(false)]);
}

async function pauseTask(taskId: string) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await $fetch(`/api/jobs/${taskId}/pause`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("已暂停任务");
            await refreshAll();
        } else {
            toast.error(res?.message || "暂停任务失败");
        }
    } catch (e: any) {
        toast.error(`暂停任务异常: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

async function resumeTask(taskId: string) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await $fetch(`/api/jobs/${taskId}/resume`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("已恢复任务");
            await refreshAll();
        } else {
            toast.error(res?.message || "恢复任务失败");
        }
    } catch (e: any) {
        toast.error(`恢复任务异常: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

async function cancelTask(taskId: string) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await $fetch(`/api/jobs/${taskId}/cancel`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("已标记为忽略 / 取消任务");
            await refreshAll();
        } else {
            toast.error(res?.message || "操作失败");
        }
    } catch (e: any) {
        toast.error(`操作异常: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

async function retryTaskFailedUnits(taskId: string) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await $fetch(`/api/jobs/${taskId}/retry-failed`, { method: "POST" });
        if (isApiSuccess(res)) {
            const count = res.data?.retried_count || 0;
            toast.success(`已重新入队 ${count} 个失败项`);
            await refreshAll();
            if (activeTask.value?.id === taskId) {
                fetchTaskUnits(taskId);
            }
        } else {
            toast.error(res?.message || "重试失败");
        }
    } catch (e: any) {
        toast.error(`重试过程发生错误: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

async function retryUnit(unitId: string) {
    actionLoadingId.value = unitId;
    try {
        const res: any = await $fetch(`/api/jobs/units/${unitId}/retry`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("已重试该子单元");
            if (activeTask.value) {
                fetchTaskUnits(activeTask.value.id);
            }
            await refreshAll();
        } else {
            toast.error(res?.message || "重试子单元失败");
        }
    } catch (e: any) {
        toast.error(`重试子单元异常: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

// Bulk Actions Logic
async function handleBulkRetry() {
    if (selectedTaskIds.value.length === 0) return;
    isBulkLoading.value = true;
    try {
        const res: any = await $fetch("/api/jobs/units/batch-retry", {
            method: "POST",
            body: { task_ids: selectedTaskIds.value },
        });
        if (isApiSuccess(res)) {
            toast.success(`已成功批量重试 ${res.data?.retried_count || 0} 项失败单元`);
            selectedTaskIds.value = [];
            await refreshAll();
        } else {
            toast.error(res?.message || "批量重试失败");
        }
    } catch (e: any) {
        toast.error(`批量重试异常: ${e.message || e}`);
    } finally {
        isBulkLoading.value = false;
    }
}

async function handleBulkPause() {
    if (selectedTaskIds.value.length === 0) return;
    isBulkLoading.value = true;
    try {
        const res: any = await $fetch("/api/jobs/batch-pause", {
            method: "POST",
            body: { task_ids: selectedTaskIds.value },
        });
        if (isApiSuccess(res)) {
            toast.success(`已批量暂停 ${res.data?.count || 0} 项任务`);
            selectedTaskIds.value = [];
            await refreshAll();
        }
    } catch (e: any) {
        toast.error(`批量暂停异常: ${e.message || e}`);
    } finally {
        isBulkLoading.value = false;
    }
}

async function handleBulkResume() {
    if (selectedTaskIds.value.length === 0) return;
    isBulkLoading.value = true;
    try {
        const res: any = await $fetch("/api/jobs/batch-resume", {
            method: "POST",
            body: { task_ids: selectedTaskIds.value },
        });
        if (isApiSuccess(res)) {
            toast.success(`已批量恢复 ${res.data?.count || 0} 项任务`);
            selectedTaskIds.value = [];
            await refreshAll();
        }
    } catch (e: any) {
        toast.error(`批量恢复异常: ${e.message || e}`);
    } finally {
        isBulkLoading.value = false;
    }
}

async function handleBulkCancel() {
    if (selectedTaskIds.value.length === 0) return;
    isBulkLoading.value = true;
    try {
        const res: any = await $fetch("/api/jobs/batch-cancel", {
            method: "POST",
            body: { task_ids: selectedTaskIds.value },
        });
        if (isApiSuccess(res)) {
            toast.success(`已批量标记/取消 ${res.data?.count || 0} 项任务`);
            selectedTaskIds.value = [];
            await refreshAll();
        }
    } catch (e: any) {
        toast.error(`批量取消异常: ${e.message || e}`);
    } finally {
        isBulkLoading.value = false;
    }
}

async function sweepStuckTasks() {
    isSweeping.value = true;
    try {
        const res: any = await $fetch("/api/task/sweep-stuck-tasks", { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("卡住的任务已修复完成");
            await refreshAll();
        } else {
            toast.error(res?.message || "修复失败");
        }
    } catch (e: any) {
        toast.error(`修复异常: ${e.message || e}`);
    } finally {
        isSweeping.value = false;
    }
}

function inspectTask(task: MasterTaskItem) {
    activeTask.value = task;
    isDetailOpen.value = true;
    fetchTaskUnits(task.id);
}

const filteredTasks = computed(() => {
    if (!searchQuery.value.trim()) return tasks.value;
    const q = searchQuery.value.toLowerCase().trim();
    return tasks.value.filter(
        (task) =>
            task.id.toLowerCase().includes(q) ||
            task.type.toLowerCase().includes(q) ||
            formatTaskType(task.type).toLowerCase().includes(q) ||
            (task.last_error && task.last_error.toLowerCase().includes(q)),
    );
});

const taskTypeOptions = ["ALL", "COVER_BATCH", "COVER_RECONCILE", "AI_ENRICH", "POST_PROCESS", "AVATAR_COPY"];

watch(statusFilter, () => {
    page.value = 1;
    selectedTaskIds.value = [];
    fetchTasks();
});

watch(selectedTaskType, () => {
    page.value = 1;
    selectedTaskIds.value = [];
    fetchTasks();
});

onMounted(() => {
    refreshAll();
    timer = setInterval(() => {
        fetchStats(true);
        fetchTasks(true);
    }, 5000);
});

onUnmounted(() => {
    if (timer) clearInterval(timer);
});
</script>

<template>
    <div class="h-screen bg-[#f9fafb] text-zinc-900 flex flex-col overflow-hidden font-sans antialiased select-none">
        <!-- Top Telemetry & Control Toolbar -->
        <header
            class="shrink-0 bg-white border-b border-zinc-200/80 px-6 py-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 z-10 shadow-2xs"
        >
            <div class="flex items-center gap-3">
                <div class="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-900 text-white shadow-xs">
                    <Activity class="w-4.5 h-4.5 text-white" />
                </div>
                <div>
                    <div class="flex items-center gap-2.5">
                        <h1 class="text-base font-semibold tracking-tight text-zinc-900">{{ $t("jobs.title") }}</h1>
                        <span
                            class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200/80 text-[11px] font-medium text-[#1e7e34]"
                        >
                            <span class="relative flex h-1.5 w-1.5">
                                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#27a644]"></span>
                            </span>
                            实时连接 (5s)
                        </span>
                    </div>
                </div>
            </div>

            <div class="flex items-center gap-2.5 self-end sm:self-auto">
                <Button
                    @click="refreshAll"
                    variant="outline"
                    size="sm"
                    class="h-8 px-3 text-xs bg-white hover:bg-zinc-50 border-zinc-200 text-zinc-700 shadow-2xs font-medium cursor-pointer rounded-lg transition-all"
                >
                    <RefreshCw class="w-3.5 h-3.5 mr-1.5 text-zinc-500" :class="{ 'animate-spin': tasksLoading || statsLoading }" />
                    <span>刷新数据</span>
                </Button>

                <Button
                    @click="sweepStuckTasks"
                    :disabled="isSweeping"
                    variant="outline"
                    size="sm"
                    class="h-8 px-3 text-xs bg-white hover:bg-zinc-50 border-zinc-200 text-zinc-700 shadow-2xs font-medium cursor-pointer rounded-lg transition-all"
                >
                    <RotateCcw class="w-3.5 h-3.5 mr-1.5 text-zinc-500" :class="{ 'animate-spin': isSweeping }" />
                    <span>修复卡住任务</span>
                </Button>
            </div>
        </header>

        <!-- Main Workspace Viewport (Card-on-Canvas Layout) -->
        <main class="flex-1 flex flex-col p-4 sm:p-6 space-y-4 max-w-7xl mx-auto w-full min-h-0 overflow-hidden">
            <!-- Hero Telemetry Metric Tiles (Master/Parent Tasks Only) -->
            <div class="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-3.5">
                <!-- Tile 1: Active Master Tasks -->
                <div class="bg-white border border-zinc-200/80 rounded-xl p-3.5 shadow-2xs transition-all hover:border-zinc-300">
                    <div class="flex items-center justify-between">
                        <span class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">处理中主任务</span>
                        <div class="w-2 h-2 rounded-full bg-blue-600 animate-pulse"></div>
                    </div>
                    <div class="flex items-baseline gap-2 mt-2">
                        <span class="text-2xl font-bold tracking-tight text-zinc-900">{{ stats.tasks.running }}</span>
                        <span class="text-xs text-zinc-500 font-normal truncate">正在执行</span>
                    </div>
                </div>

                <!-- Tile 2: Failed Master Tasks -->
                <div class="bg-white border rounded-xl p-3.5 shadow-2xs transition-all border-zinc-200/80 hover:border-zinc-300">
                    <div class="flex items-center justify-between">
                        <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">失败主任务</span>
                        <AlertTriangle v-if="stats.tasks.failed > 0" class="w-4 h-4 text-rose-500" />
                    </div>
                    <div class="flex items-baseline gap-2 mt-2">
                        <span
                            class="text-2xl font-bold tracking-tight"
                            :class="stats.tasks.failed > 0 ? 'text-rose-600' : 'text-zinc-900'"
                            >{{ stats.tasks.failed }}</span
                        >
                        <span
                            class="text-xs font-normal truncate"
                            :class="stats.tasks.failed > 0 ? 'text-rose-600 font-medium' : 'text-zinc-500'"
                            >需关注/重试</span
                        >
                    </div>
                </div>

                <!-- Tile 3: Completed Master Tasks -->
                <div class="bg-white border border-zinc-200/80 rounded-xl p-3.5 shadow-2xs transition-all hover:border-zinc-300">
                    <div class="flex items-center justify-between">
                        <span class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">已完成主任务</span>
                        <CheckCircle2 class="w-4 h-4 text-emerald-500" />
                    </div>
                    <div class="flex items-baseline gap-2 mt-2">
                        <span class="text-2xl font-bold tracking-tight text-zinc-900">{{ stats.tasks.completed }}</span>
                        <span class="text-xs text-zinc-500 font-normal truncate">成功结束</span>
                    </div>
                </div>

                <!-- Tile 4: Total Master Tasks -->
                <div class="bg-white border border-zinc-200/80 rounded-xl p-3.5 shadow-2xs transition-all hover:border-zinc-300">
                    <div class="flex items-center justify-between">
                        <span class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">主任务总量</span>
                        <Layers class="w-4 h-4 text-zinc-400" />
                    </div>
                    <div class="flex items-baseline gap-2 mt-2">
                        <span class="text-2xl font-bold tracking-tight text-zinc-900">{{ stats.tasks.total }}</span>
                        <span class="text-xs text-zinc-500 font-normal truncate">全量任务记录</span>
                    </div>
                </div>
            </div>

            <!-- Control & Filter Bar -->
            <div
                class="shrink-0 bg-white rounded-xl border border-zinc-200/80 p-2 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 shadow-2xs"
            >
                <!-- Segmented Tab Buttons -->
                <div class="flex items-center p-1 bg-zinc-100/90 rounded-lg text-xs overflow-x-auto whitespace-nowrap max-w-full">
                    <button
                        v-for="st in ['ALL', 'RUNNING', 'PAUSED', 'FAILED', 'COMPLETED', 'CANCELLED']"
                        :key="st"
                        @click="statusFilter = st"
                        class="px-3 py-1.5 rounded-md transition-all cursor-pointer shrink-0 flex items-center gap-1.5 text-xs font-medium"
                        :class="
                            statusFilter === st
                                ? 'bg-zinc-900 text-white shadow-xs font-semibold'
                                : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/70'
                        "
                    >
                        <span>{{ st === "ALL" ? $t("jobs.tabs.all") : formatStatus(st) }}</span>
                        <span
                            v-if="st === 'FAILED' && stats.tasks.failed > 0"
                            class="px-1.5 py-0.2 text-[11px] rounded-full font-semibold"
                            :class="statusFilter === 'FAILED' ? 'bg-rose-500 text-white' : 'bg-rose-100 text-rose-700'"
                        >
                            {{ stats.tasks.failed }}
                        </span>
                    </button>
                </div>

                <!-- Filters & Search Input -->
                <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full md:w-auto">
                    <Select v-model="selectedTaskType">
                        <SelectTrigger
                            class="w-full sm:w-[170px] h-8 text-xs bg-white border-zinc-200 font-medium text-zinc-800 rounded-lg focus:ring-1 focus:ring-zinc-900"
                        >
                            <SelectValue :placeholder="formatTaskType(selectedTaskType)" />
                        </SelectTrigger>
                        <SelectContent class="text-xs rounded-lg">
                            <SelectItem v-for="tType in taskTypeOptions" :key="tType" :value="tType" class="text-xs">
                                {{ formatTaskType(tType) }}
                            </SelectItem>
                        </SelectContent>
                    </Select>

                    <div class="relative w-full sm:w-64">
                        <Search class="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-zinc-400" />
                        <Input
                            v-model="searchQuery"
                            :placeholder="$t('common.search')"
                            class="pl-8 text-xs h-8 bg-zinc-50 border-zinc-200 text-zinc-900 placeholder:text-zinc-400 w-full rounded-lg focus:ring-1 focus:ring-zinc-900"
                        />
                        <button
                            v-if="searchQuery"
                            @click="searchQuery = ''"
                            class="absolute right-2.5 top-2 text-zinc-400 hover:text-zinc-600 text-xs"
                        >
                            ✕
                        </button>
                    </div>
                </div>
            </div>

            <!-- Master Tasks Table Container -->
            <div class="flex-1 flex flex-col bg-white rounded-xl border border-zinc-200/80 overflow-hidden min-h-0 shadow-2xs relative">
                <div class="flex-1 overflow-y-auto w-full min-h-0">
                    <table class="w-full text-left text-xs table-fixed">
                        <thead
                            class="bg-zinc-50/90 backdrop-blur-xs border-b border-zinc-200/80 text-zinc-500 font-semibold uppercase tracking-wider text-[11px] sticky top-0 z-10"
                        >
                            <tr>
                                <th class="py-3 px-3.5 w-10 text-center">
                                    <div class="flex items-center justify-center cursor-pointer" @click.stop="toggleSelectAll">
                                        <Checkbox
                                            :model-value="isAllSelected ? true : selectedTaskIds.length > 0 ? 'indeterminate' : false"
                                            class="w-4 h-4 pointer-events-none"
                                        />
                                    </div>
                                </th>
                                <th class="py-3 px-3.5 w-52 font-semibold">{{ $t("jobs.table.id") }}</th>
                                <th class="py-3 px-3.5 w-56 font-semibold">{{ $t("jobs.table.type") }}</th>
                                <th class="py-3 px-3.5 w-36 font-semibold">{{ $t("jobs.table.status") }}</th>
                                <th class="py-3 px-3.5 font-semibold">{{ $t("jobs.table.progress") }}</th>
                                <th class="py-3 px-3.5 w-40 text-right font-semibold">{{ $t("jobs.table.actions") }}</th>
                            </tr>
                        </thead>

                        <tbody class="divide-y divide-zinc-100">
                            <tr v-if="tasksLoading" class="text-center text-zinc-500 py-12">
                                <td colspan="6" class="p-12">
                                    <div class="flex items-center justify-center gap-2">
                                        <RefreshCw class="w-4 h-4 animate-spin text-zinc-900" />
                                        <span class="font-medium text-zinc-600">加载任务列表中...</span>
                                    </div>
                                </td>
                            </tr>

                            <tr v-else-if="filteredTasks.length === 0" class="text-center text-zinc-500 py-12">
                                <td colspan="6" class="p-12">
                                    <div class="flex flex-col items-center justify-center gap-2">
                                        <CheckCircle2 class="w-8 h-8 text-zinc-300" />
                                        <span class="font-medium text-zinc-600 text-xs">{{ $t("jobs.empty.no_tasks") }}</span>
                                    </div>
                                </td>
                            </tr>

                            <tr
                                v-for="task in filteredTasks"
                                :key="task.id"
                                @click="inspectTask(task)"
                                class="hover:bg-zinc-50/80 transition-colors cursor-pointer group"
                                :class="selectedTaskIds.includes(task.id) ? 'bg-zinc-50/90' : ''"
                            >
                                <!-- Checkbox -->
                                <td class="py-3 px-3.5 text-center" @click.stop="toggleSelectTask(task.id)">
                                    <div class="flex items-center justify-center cursor-pointer">
                                        <Checkbox :model-value="selectedTaskIds.includes(task.id)" class="w-4 h-4 pointer-events-none" />
                                    </div>
                                </td>

                                <!-- Task ID + Copy Action + Relative Time -->
                                <td class="py-3 px-3.5 text-xs">
                                    <div class="flex items-center gap-1.5">
                                        <span class="font-semibold text-zinc-900 truncate" :title="task.id">
                                            {{ task.id }}
                                        </span>
                                        <button
                                            @click="(e) => copyTaskId(task.id, e)"
                                            class="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-400 hover:text-zinc-700 p-0.5 rounded cursor-pointer"
                                            title="复制任务 ID"
                                        >
                                            <Check v-if="copiedId === task.id" class="w-3.5 h-3.5 text-emerald-600" />
                                            <Copy v-else class="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                    <div class="text-[11px] text-zinc-400 mt-0.5">
                                        {{ new Date(task.update_time).toLocaleString() }}
                                    </div>
                                </td>

                                <!-- Type & Target Scope -->
                                <td class="py-3 px-3.5">
                                    <div class="flex items-center gap-2">
                                        <span
                                            class="px-2.5 py-0.5 rounded-md bg-zinc-100 text-zinc-800 font-medium text-xs border border-zinc-200/70"
                                        >
                                            {{ formatTaskType(task.type) }}
                                        </span>
                                        <span class="text-xs text-zinc-500 font-normal">
                                            {{ formatInputScope(task) }}
                                        </span>
                                    </div>
                                </td>

                                <!-- Status Badge (Soft Status Pill) -->
                                <td class="py-3 px-3.5">
                                    <span
                                        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                                        :class="{
                                            'bg-rose-50 text-rose-600 border border-rose-200/60': task.status === 'FAILED',
                                            'bg-amber-50 text-amber-800 border border-amber-200/80': task.status === 'PAUSED',
                                            'bg-blue-50 text-blue-700 border border-blue-200/80': ['RUNNING', 'DISCOVERING'].includes(
                                                task.status,
                                            ),
                                            'bg-emerald-50 text-[#1e7e34] border border-emerald-200/80': task.status === 'COMPLETED',
                                            'bg-zinc-100 text-zinc-600 border border-zinc-200/80': task.status === 'CANCELLED',
                                        }"
                                    >
                                        <span class="relative flex h-1.5 w-1.5" v-if="['RUNNING', 'DISCOVERING'].includes(task.status)">
                                            <span
                                                class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-600 opacity-75"
                                            ></span>
                                            <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-600"></span>
                                        </span>
                                        <span
                                            class="w-1.5 h-1.5 rounded-full"
                                            v-else
                                            :class="{
                                                'bg-rose-500': task.status === 'FAILED',
                                                'bg-amber-500': task.status === 'PAUSED',
                                                'bg-[#27a644]': task.status === 'COMPLETED',
                                                'bg-zinc-400': task.status === 'CANCELLED',
                                            }"
                                        ></span>
                                        {{ formatStatus(task.status) }}
                                    </span>
                                </td>

                                <!-- Progress & Breakdown Column -->
                                <td class="py-3 px-3.5">
                                    <div class="space-y-1 max-w-[240px]">
                                        <div class="flex justify-between items-center text-xs text-zinc-600 font-medium">
                                            <span>{{ task.progress.processed_units }} / {{ task.total_units }} 项</span>
                                            <span class="font-semibold text-zinc-900">{{ task.progress.percentage }}%</span>
                                        </div>
                                        <div class="w-full bg-zinc-100 h-1.5 rounded-full overflow-hidden">
                                            <div
                                                class="h-full rounded-full transition-all duration-300"
                                                :class="
                                                    task.status === 'FAILED'
                                                        ? 'bg-rose-400'
                                                        : task.status === 'COMPLETED'
                                                          ? 'bg-[#27a644]'
                                                          : 'bg-blue-600'
                                                "
                                                :style="{ width: `${task.progress.percentage}%` }"
                                            ></div>
                                        </div>
                                        <div class="flex items-center gap-2.5 text-[11px] font-medium">
                                            <span class="text-[#1e7e34]" title="成功">✓ {{ task.succeeded_units }} 成功</span>
                                            <span class="text-rose-500 font-medium" v-if="task.failed_units > 0" title="失败"
                                                >✗ {{ task.failed_units }} 失败</span
                                            >
                                            <span class="text-zinc-400" v-if="task.cancelled_units > 0" title="取消"
                                                >⊘ {{ task.cancelled_units }} 取消</span
                                            >
                                        </div>
                                    </div>
                                </td>

                                <!-- Actions Column -->
                                <td class="py-3 px-3.5 text-right" @click.stop>
                                    <div class="inline-flex items-center gap-1.5">
                                        <Button
                                            v-if="task.failed_units > 0"
                                            @click.stop="retryTaskFailedUnits(task.id)"
                                            :disabled="actionLoadingId === task.id"
                                            variant="outline"
                                            size="xs"
                                            class="h-7 px-2.5 text-xs bg-white hover:bg-zinc-50 text-zinc-800 border-zinc-200 font-medium cursor-pointer shadow-2xs rounded-lg transition-all"
                                        >
                                            <RotateCcw
                                                class="w-3.5 h-3.5 mr-1 text-zinc-600"
                                                :class="{ 'animate-spin': actionLoadingId === task.id }"
                                            />
                                            <span>重试失败</span>
                                        </Button>

                                        <Button
                                            @click.stop="inspectTask(task)"
                                            variant="outline"
                                            size="xs"
                                            class="h-7 px-2.5 text-xs bg-white hover:bg-zinc-50 text-zinc-700 border-zinc-200 shadow-2xs font-medium cursor-pointer rounded-lg"
                                        >
                                            <FileText class="w-3.5 h-3.5 mr-1 text-zinc-500" />
                                            <span>查看明细</span>
                                        </Button>

                                        <DropdownMenu>
                                            <DropdownMenuTrigger as-child @click.stop>
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    class="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-900 cursor-pointer rounded-lg"
                                                >
                                                    <MoreHorizontal class="w-4 h-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" class="w-44 text-xs rounded-lg">
                                                <DropdownMenuItem
                                                    @click.stop="inspectTask(task)"
                                                    class="cursor-pointer text-xs font-medium"
                                                >
                                                    <FileText class="w-3.5 h-3.5 mr-2 text-zinc-500" />
                                                    <span>查看任务明细</span>
                                                </DropdownMenuItem>

                                                <DropdownMenuItem
                                                    v-if="task.failed_units > 0"
                                                    @click.stop="retryTaskFailedUnits(task.id)"
                                                    class="cursor-pointer text-xs text-zinc-900 font-semibold"
                                                >
                                                    <RotateCcw class="w-3.5 h-3.5 mr-2 text-zinc-600" />
                                                    <span>重试失败子项</span>
                                                </DropdownMenuItem>

                                                <DropdownMenuItem
                                                    v-if="['RUNNING', 'DISCOVERING'].includes(task.status)"
                                                    @click.stop="pauseTask(task.id)"
                                                    class="cursor-pointer text-xs text-amber-800 font-medium"
                                                >
                                                    <Pause class="w-3.5 h-3.5 mr-2 text-amber-600" />
                                                    <span>暂停任务</span>
                                                </DropdownMenuItem>

                                                <DropdownMenuItem
                                                    v-if="task.status === 'PAUSED'"
                                                    @click.stop="resumeTask(task.id)"
                                                    class="cursor-pointer text-xs text-blue-800 font-medium"
                                                >
                                                    <Play class="w-3.5 h-3.5 mr-2 text-blue-600" />
                                                    <span>恢复任务</span>
                                                </DropdownMenuItem>

                                                <DropdownMenuSeparator
                                                    v-if="['RUNNING', 'DISCOVERING', 'PAUSED', 'FAILED'].includes(task.status)"
                                                />

                                                <DropdownMenuItem
                                                    v-if="['RUNNING', 'DISCOVERING', 'PAUSED', 'FAILED'].includes(task.status)"
                                                    @click.stop="cancelTask(task.id)"
                                                    class="cursor-pointer text-xs text-zinc-600 font-medium"
                                                >
                                                    <XCircle class="w-3.5 h-3.5 mr-2 text-zinc-400" />
                                                    <span>标记已解决 / 忽略</span>
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- Floating Bulk Action Bar (Project Standard Dark Pill) -->
                <div
                    v-if="selectedTaskIds.length > 0"
                    class="absolute bottom-12 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur-md text-zinc-900 border border-zinc-200/90 shadow-xl rounded-xl px-4 py-2.5 flex flex-row items-center gap-4 z-30 transition-all animate-in fade-in slide-in-from-bottom-3 whitespace-nowrap"
                >
                    <div class="flex items-center gap-2 text-xs font-medium text-zinc-700">
                        <span class="w-2 h-2 rounded-full bg-zinc-900"></span>
                        <span
                            >已选中 <strong class="font-bold text-zinc-900">{{ selectedTaskIds.length }}</strong> 项任务</span
                        >
                    </div>

                    <div class="h-4 w-px bg-zinc-200"></div>

                    <div class="flex items-center gap-2">
                        <Button
                            @click="handleBulkRetry"
                            :disabled="isBulkLoading"
                            size="xs"
                            class="h-7 text-xs bg-zinc-900 hover:bg-zinc-800 text-white font-medium cursor-pointer rounded-lg shadow-xs transition-all"
                        >
                            <RotateCcw class="w-3.5 h-3.5 mr-1" :class="{ 'animate-spin': isBulkLoading }" />
                            <span>批量重试失败</span>
                        </Button>

                        <Button
                            @click="handleBulkPause"
                            :disabled="isBulkLoading"
                            size="xs"
                            variant="outline"
                            class="h-7 text-xs bg-white hover:bg-zinc-50 text-zinc-700 border-zinc-200 font-medium cursor-pointer rounded-lg"
                        >
                            <Pause class="w-3.5 h-3.5 mr-1 text-zinc-500" />
                            <span>批量暂停</span>
                        </Button>

                        <Button
                            @click="handleBulkResume"
                            :disabled="isBulkLoading"
                            size="xs"
                            variant="outline"
                            class="h-7 text-xs bg-white hover:bg-zinc-50 text-zinc-700 border-zinc-200 font-medium cursor-pointer rounded-lg"
                        >
                            <Play class="w-3.5 h-3.5 mr-1 text-zinc-500" />
                            <span>批量恢复</span>
                        </Button>

                        <Button
                            @click="handleBulkCancel"
                            :disabled="isBulkLoading"
                            size="xs"
                            variant="outline"
                            class="h-7 text-xs bg-white hover:bg-zinc-50 text-zinc-600 border-zinc-200 font-medium cursor-pointer rounded-lg"
                        >
                            <XCircle class="w-3.5 h-3.5 mr-1 text-zinc-400" />
                            <span>批量忽略</span>
                        </Button>
                    </div>

                    <div class="h-4 w-px bg-zinc-200"></div>

                    <Button
                        @click="selectedTaskIds = []"
                        size="xs"
                        variant="ghost"
                        class="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-900 cursor-pointer"
                    >
                        取消选择
                    </Button>
                </div>

                <!-- Pinned Pagination Footer -->
                <div
                    class="shrink-0 bg-zinc-50/80 border-t border-zinc-200/80 px-4 py-3 flex items-center justify-between text-xs text-zinc-600 font-medium"
                >
                    <span>{{ $t("jobs.pagination.showing", { current: tasks.length, total: totalItems }) }}</span>

                    <div class="flex items-center gap-2">
                        <Button
                            @click="
                                page--;
                                fetchTasks();
                            "
                            :disabled="page <= 1 || tasksLoading"
                            variant="outline"
                            size="xs"
                            class="h-7 px-2.5 cursor-pointer bg-white text-zinc-700 border-zinc-300 rounded-lg"
                        >
                            <ChevronLeft class="w-3.5 h-3.5" />
                        </Button>
                        <span class="font-semibold text-zinc-900">{{ $t("jobs.pagination.page", { page: page, pages: totalPages }) }}</span>
                        <Button
                            @click="
                                page++;
                                fetchTasks();
                            "
                            :disabled="page >= totalPages || tasksLoading"
                            variant="outline"
                            size="xs"
                            class="h-7 px-2.5 cursor-pointer bg-white text-zinc-700 border-zinc-300 rounded-lg"
                        >
                            <ChevronRight class="w-3.5 h-3.5" />
                        </Button>
                    </div>
                </div>
            </div>
        </main>

        <!-- Task Inspection & Sub-Units Detail Dialog -->
        <Dialog v-model:open="isDetailOpen">
            <DialogContent
                class="sm:max-w-2xl w-[95vw] sm:w-full max-h-[85vh] overflow-y-auto rounded-xl bg-white text-zinc-900 border-zinc-200"
            >
                <DialogHeader>
                    <DialogTitle class="flex items-center gap-2 text-base font-semibold text-zinc-900">
                        <Terminal class="w-4.5 h-4.5 text-zinc-700" />
                        <span>任务处理明细</span>
                    </DialogTitle>
                    <DialogDescription class="text-xs text-zinc-500 font-medium"> Task ID: {{ activeTask?.id }} </DialogDescription>
                </DialogHeader>

                <div v-if="activeTask" class="space-y-4 text-xs font-sans py-2">
                    <!-- Task Properties Summary Grid -->
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-zinc-50 p-3.5 rounded-lg border border-zinc-200/80">
                        <div>
                            <span class="text-zinc-500">任务类型:</span>
                            <div class="font-semibold text-zinc-900 mt-0.5">{{ formatTaskType(activeTask.type) }}</div>
                        </div>
                        <div>
                            <span class="text-zinc-500">当前状态:</span>
                            <div class="font-semibold text-zinc-900 mt-0.5">{{ formatStatus(activeTask.status) }}</div>
                        </div>
                        <div>
                            <span class="text-zinc-500">完成进度:</span>
                            <div class="font-semibold text-zinc-900 mt-0.5">{{ activeTask.progress.percentage }}%</div>
                        </div>
                        <div>
                            <span class="text-zinc-500">子单元数:</span>
                            <div class="font-semibold text-zinc-900 mt-0.5">{{ activeTask.total_units }}</div>
                        </div>
                    </div>

                    <!-- Master Task Last Error -->
                    <div class="space-y-1.5" v-if="activeTask.last_error">
                        <span class="text-xs font-semibold text-zinc-700 uppercase tracking-wider flex items-center gap-1">
                            <AlertTriangle class="w-3.5 h-3.5 text-amber-500" />
                            <span>最近一次错误日志</span>
                        </span>
                        <pre
                            class="bg-zinc-50 text-zinc-800 p-3 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-40 border border-zinc-200 font-sans"
                            >{{ activeTask.last_error }}</pre>
                    </div>

                    <!-- Child Execution Items Table -->
                    <div class="space-y-2">
                        <div class="flex items-center justify-between text-xs font-semibold text-zinc-800 uppercase tracking-wider">
                            <span>子任务单元明细 ({{ taskUnits.length }})</span>
                            <Button
                                v-if="activeTask.failed_units > 0"
                                @click="retryTaskFailedUnits(activeTask.id)"
                                variant="outline"
                                size="xs"
                                class="text-zinc-800 bg-zinc-100 border-zinc-200 hover:bg-zinc-200 cursor-pointer h-6 px-2.5 text-xs font-medium rounded-lg"
                            >
                                <RotateCcw class="w-3 h-3 mr-1 text-zinc-600" />
                                重试失败子项 ({{ activeTask.failed_units }})
                            </Button>
                        </div>

                        <div class="border border-zinc-200/80 rounded-lg overflow-hidden max-h-60 overflow-y-auto">
                            <table class="w-full text-left text-xs min-w-[500px]">
                                <thead class="bg-zinc-100/80 text-zinc-600 font-semibold sticky top-0">
                                    <tr>
                                        <th class="p-2.5 whitespace-nowrap">子项 Key</th>
                                        <th class="p-2.5 whitespace-nowrap">状态</th>
                                        <th class="p-2.5 whitespace-nowrap text-center">重试次数</th>
                                        <th class="p-2.5 whitespace-nowrap">错误信息</th>
                                        <th class="p-2.5 whitespace-nowrap text-right">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-zinc-100">
                                    <tr v-if="taskUnitsLoading" class="text-center text-zinc-500 py-6">
                                        <td colspan="5" class="p-6">加载子任务单元中...</td>
                                    </tr>
                                    <tr v-else-if="taskUnits.length === 0" class="text-center text-zinc-500 py-6">
                                        <td colspan="5" class="p-6">暂无子任务单元数据</td>
                                    </tr>
                                    <tr v-for="unit in taskUnits" :key="unit.id" class="hover:bg-zinc-50">
                                        <td class="p-2.5 font-medium truncate max-w-[160px] whitespace-nowrap" :title="unit.unit_key">
                                            {{ unit.unit_key }}
                                        </td>
                                        <td
                                            class="p-2.5 font-semibold whitespace-nowrap"
                                            :class="unit.status === 'FAILED' ? 'text-rose-600' : 'text-zinc-800'"
                                        >
                                            {{ formatStatus(unit.status) }}
                                        </td>
                                        <td class="p-2.5 text-center font-medium whitespace-nowrap">
                                            {{ unit.attempt_count }} / {{ unit.max_attempts }}
                                        </td>
                                        <td
                                            class="p-2.5 truncate max-w-[200px] text-zinc-600 whitespace-nowrap"
                                            :title="unit.last_error || ''"
                                        >
                                            {{ unit.last_error || "-" }}
                                        </td>
                                        <td class="p-2.5 text-right whitespace-nowrap">
                                            <Button
                                                v-if="unit.status === 'FAILED'"
                                                @click="retryUnit(unit.id)"
                                                variant="outline"
                                                size="xs"
                                                class="h-6 px-2 text-xs text-zinc-800 bg-zinc-100 border-zinc-200 hover:bg-zinc-200 cursor-pointer font-medium rounded-lg"
                                            >
                                                <RotateCcw class="w-3 h-3 mr-0.5 text-zinc-600" />
                                                重试
                                            </Button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- Input Parameters Snapshot -->
                    <div class="space-y-1.5">
                        <span class="text-xs font-semibold text-zinc-800 uppercase tracking-wider">{{
                            $t("jobs.modal.input_snapshot")
                        }}</span>
                        <pre
                            class="bg-zinc-50 text-zinc-800 p-3 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-36 border border-zinc-200 font-sans"
                            >{{ JSON.stringify(activeTask.input_snapshot, null, 2) }}</pre>
                    </div>
                </div>

                <DialogFooter class="gap-2">
                    <Button
                        @click="isDetailOpen = false"
                        variant="outline"
                        size="sm"
                        class="cursor-pointer text-xs font-medium rounded-lg"
                        >{{ $t("jobs.modal.close") }}</Button
                    >
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>
