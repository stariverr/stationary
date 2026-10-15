<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import {
    Activity,
    RefreshCw,
    RotateCcw,
    Search,
    ChevronLeft,
    ChevronRight,
    Terminal,
    AlertTriangle,
    Layers,
    MoreHorizontal,
    FileText,
    Copy,
    Check,
    Sidebar,
    X,
    Inbox,
    Sparkles,
    Image as ImageIcon,
    Play,
    Pause,
    XCircle,
    CheckCircle2,
    Clock,
    Code,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "vue-sonner";
import { useAppLayout } from "@/composables/useAppLayout";
import { useApi } from "@/composables/useApi";
import { formatTemporalDateTime, formatTemporalRelative, formatTemporalDuration } from "@/utils/temporal";
import JobDetailView, { type MasterTaskItem } from "@/components/JobDetailView.vue";

const { toggleSidebar, isSidebarCollapsed } = useAppLayout();
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();

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

// Active Task drill-down state
const activeTask = ref<MasterTaskItem | null>(null);
const activeTaskRefreshing = ref(false);
const jobDetailViewRef = ref<InstanceType<typeof JobDetailView> | null>(null);

// Action loading states
const actionLoadingId = ref<string | null>(null);
const isBulkLoading = ref(false);
const isSweeping = ref(false);
const copiedId = ref<string | null>(null);

let timer: NodeJS.Timeout | null = null;

const taskTypeOptions = ["ALL", "COVER_BATCH", "COVER_RECONCILE", "AI_ENRICH", "POST_PROCESS", "AVATAR_COPY"];

function formatTaskType(type: string): string {
    if (!type || type.toUpperCase() === "ALL") {
        return t("jobs.task_types.all", "全部任务类型");
    }
    const key = `jobs.task_types.${type}`;
    const translated = t(key);
    return translated !== key ? translated : type;
}

function getTaskTypeIcon(type: string) {
    switch (type) {
        case "COVER_BATCH":
        case "COVER_RECONCILE":
            return ImageIcon;
        case "AI_ENRICH":
            return Sparkles;
        case "POST_PROCESS":
            return FileText;
        case "AVATAR_COPY":
            return Layers;
        default:
            return Terminal;
    }
}

function formatStatus(status: string): string {
    switch (status) {
        case "RUNNING":
            return t("jobs.tabs.running", "处理中");
        case "DISCOVERING":
            return t("jobs.tabs.discovering", "扫描中");
        case "PENDING":
            return t("jobs.tabs.pending", "等待处理");
        case "PAUSED":
            return t("jobs.tabs.paused", "已暂停");
        case "COMPLETED":
            return t("jobs.tabs.completed", "已完成");
        case "FAILED":
            return t("jobs.tabs.failed", "异常/需关注");
        case "CANCELLED":
            return t("jobs.tabs.cancelled", "已取消");
        case "SUCCEEDED":
            return t("jobs.tabs.succeeded", "处理成功");
        default:
            return status;
    }
}

function formatInputScope(task: MasterTaskItem): string {
    if (task.input_snapshot?.media_ids && Array.isArray(task.input_snapshot.media_ids)) {
        return `${task.input_snapshot.media_ids.length} 个媒体文件`;
    }
    return "全局批处理";
}

function copyTaskId(id: string, e?: Event) {
    if (e) e.stopPropagation();
    copyText(id, "已复制任务 ID 到剪贴板");
}

function copyText(text: string, message = "已复制到剪贴板") {
    navigator.clipboard.writeText(text);
    copiedId.value = text;
    toast.success(message);
    setTimeout(() => {
        if (copiedId.value === text) {
            copiedId.value = null;
        }
    }, 2000);
}

function isApiSuccess(res: any): boolean {
    return Boolean(res && (res.success || res.code === 0 || res.code === "SUCCESS"));
}

// Multi-select Logic
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
        const res: any = await useApi("/jobs/stats");
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

        const res: any = await useApi("/jobs/list", { query: queryParams });
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

async function fetchTaskDetail(taskId: string, isSilent = false) {
    if (!isSilent) activeTaskRefreshing.value = true;
    try {
        const res: any = await useApi(`/jobs/${taskId}`);
        if (isApiSuccess(res) && res.data && activeTask.value?.id === taskId) {
            activeTask.value = res.data as MasterTaskItem;
        }
    } catch (e: any) {
        if (!isSilent) toast.error(`加载任务详情失败: ${e.message || e}`);
    } finally {
        if (!isSilent) activeTaskRefreshing.value = false;
    }
}

async function refreshAll() {
    await Promise.all([fetchStats(), fetchTasks()]);
}

async function refreshActiveTask() {
    if (activeTask.value) {
        await Promise.all([fetchTaskDetail(activeTask.value.id), jobDetailViewRef.value?.fetchTaskUnits()]);
    }
}

// Single Task Actions
async function retryTaskFailedUnits(taskId: string) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await useApi(`/jobs/${taskId}/retry-failed`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success(`已重试 ${res.data?.requeued_count || 0} 项失败子任务`);
            await refreshAll();
            if (activeTask.value?.id === taskId) {
                await refreshActiveTask();
            }
        } else {
            toast.error(res?.message || "重试失败");
        }
    } catch (e: any) {
        toast.error(`重试操作异常: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

async function pauseTask(taskId: string) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await useApi(`/jobs/${taskId}/pause`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("任务暂停已就绪");
            await refreshAll();
            if (activeTask.value?.id === taskId) {
                await refreshActiveTask();
            }
        } else {
            toast.error(res?.message || "暂停失败");
        }
    } catch (e: any) {
        toast.error(`暂停操作异常: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

async function resumeTask(taskId: string) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await useApi(`/jobs/${taskId}/resume`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("任务已恢复执行");
            await refreshAll();
            if (activeTask.value?.id === taskId) {
                await refreshActiveTask();
            }
        } else {
            toast.error(res?.message || "恢复失败");
        }
    } catch (e: any) {
        toast.error(`恢复操作异常: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

async function cancelTask(taskId: string) {
    actionLoadingId.value = taskId;
    try {
        const res: any = await useApi(`/jobs/${taskId}/cancel`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("任务已标记取消/忽略");
            await refreshAll();
            if (activeTask.value?.id === taskId) {
                await refreshActiveTask();
            }
        } else {
            toast.error(res?.message || "取消失败");
        }
    } catch (e: any) {
        toast.error(`取消操作异常: ${e.message || e}`);
    } finally {
        actionLoadingId.value = null;
    }
}

// Bulk Actions
async function handleBulkRetry() {
    if (selectedTaskIds.value.length === 0) return;
    isBulkLoading.value = true;
    try {
        const res: any = await useApi("/jobs/batch-retry", {
            method: "POST",
            body: { task_ids: selectedTaskIds.value },
        });
        if (isApiSuccess(res)) {
            toast.success(`已批量重试 ${res.data?.count || 0} 项任务`);
            selectedTaskIds.value = [];
            await refreshAll();
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
        const res: any = await useApi("/jobs/batch-pause", {
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
        const res: any = await useApi("/jobs/batch-resume", {
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
        const res: any = await useApi("/jobs/batch-cancel", {
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
        const res: any = await useApi("/task/sweep-stuck-tasks", { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("停滞的任务已诊断并修复完成");
            await refreshAll();
        } else {
            toast.error(res?.message || "诊断修复失败");
        }
    } catch (e: any) {
        toast.error(`修复异常: ${e.message || e}`);
    } finally {
        isSweeping.value = false;
    }
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
    fetchTaskDetail(task.id, true);
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
        if (isApiSuccess(res) && res.data) {
            openTaskDetail(res.data as MasterTaskItem);
        } else {
            toast.error("未找到该任务");
            syncTaskQuery(null);
        }
    } catch (e: any) {
        toast.error(`加载任务详情失败: ${e.message || e}`);
        syncTaskQuery(null);
    }
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

const TABS = [
    { key: "ALL", label: "jobs.tabs.all" },
    { key: "RUNNING", label: "jobs.tabs.running" },
    { key: "FAILED", label: "jobs.tabs.failed" },
    { key: "PAUSED", label: "jobs.tabs.paused" },
    { key: "COMPLETED", label: "jobs.tabs.completed" },
    { key: "CANCELLED", label: "jobs.tabs.cancelled" },
];

function getTabCount(key: string): number {
    switch (key) {
        case "ALL":
            return stats.value.tasks.total;
        case "RUNNING":
            return stats.value.tasks.running;
        case "FAILED":
            return stats.value.tasks.failed;
        case "COMPLETED":
            return stats.value.tasks.completed;
        case "PAUSED":
            return tasks.value.filter((t) => t.status === "PAUSED").length;
        case "CANCELLED":
            return tasks.value.filter((t) => t.status === "CANCELLED").length;
        default:
            return 0;
    }
}

function taskUnitPercentage(task: MasterTaskItem, type: "succeeded" | "failed" | "cancelled"): number {
    if (!task.total_units) return 0;
    const val = type === "succeeded" ? task.succeeded_units : type === "failed" ? task.failed_units : task.cancelled_units;
    return Math.min(100, Math.round((val / task.total_units) * 100));
}

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

function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
        if (activeTask.value) {
            closeTaskDetail();
        } else if (selectedTaskIds.value.length > 0) {
            selectedTaskIds.value = [];
        }
    }
}

onMounted(() => {
    refreshAll();
    window.addEventListener("keydown", handleKeydown);

    const sharedTaskId = typeof route.query.task === "string" ? route.query.task : null;
    if (sharedTaskId) {
        openTaskById(sharedTaskId);
    }

    timer = setInterval(() => {
        fetchStats(true);
        if (!activeTask.value) {
            fetchTasks(true);
        } else {
            fetchTaskDetail(activeTask.value.id, true);
        }
    }, 5000);
});

onUnmounted(() => {
    if (timer) clearInterval(timer);
    window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
    <div class="h-full flex flex-col bg-background text-foreground overflow-hidden font-sans select-none">
        <!-- Transition wrapper between All Tasks list and Task Detail Drill-Down View -->
        <transition name="view-fade" mode="out-in">
            <!-- VIEW 1: Task Execution Detail Drill-Down View -->
            <JobDetailView
                v-if="activeTask"
                ref="jobDetailViewRef"
                :task="activeTask"
                :action-loading-id="actionLoadingId"
                :refreshing="activeTaskRefreshing"
                @back="closeTaskDetail"
                @refresh="refreshActiveTask"
                @retry-failed-units="retryTaskFailedUnits"
                @pause-task="pauseTask"
                @resume-task="resumeTask"
                @cancel-task="cancelTask"
            />

            <!-- VIEW 2: All Tasks Full-Bleed shadcn/ui Dashboard -->
            <div v-else class="h-full flex flex-col min-h-0 bg-background relative overflow-hidden">
                <!-- Top Docked Navigation Header (h-14) -->
                <header
                    class="h-14 border-b border-border px-4 md:px-6 shrink-0 flex items-center justify-between gap-3 md:gap-4 bg-background/95 backdrop-blur-xs"
                >
                    <!-- Left: Sidebar toggle, page icon, title & calm living status badge -->
                    <div class="flex items-center gap-3 min-w-0">
                        <button
                            @click="toggleSidebar"
                            class="h-8 w-8 rounded-lg -ml-1 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-transform cursor-pointer"
                            :class="isSidebarCollapsed ? 'flex' : 'flex md:hidden'"
                            :title="$t('common.toggle_sidebar', 'Toggle sidebar')"
                            :aria-label="$t('common.toggle_sidebar', 'Toggle sidebar')"
                        >
                            <Sidebar class="w-4.5 h-4.5 stroke-[1.6]" />
                        </button>

                        <div class="p-1.5 bg-muted/60 border border-border rounded-lg shrink-0">
                            <Activity class="w-4 h-4 text-foreground stroke-[1.6]" />
                        </div>

                        <div class="flex items-center gap-2.5 min-w-0">
                            <h1 class="text-sm font-semibold tracking-tight text-foreground leading-none truncate">
                                {{ $t("jobs.title", "后台任务中心") }}
                            </h1>

                            <!-- Status Indicator Badge (Shown when there is activity or failure) -->
                            <Badge
                                v-if="stats.tasks.running > 0"
                                variant="outline"
                                class="hidden sm:inline-flex gap-1.5 font-mono text-[11px] whitespace-nowrap border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                            >
                                <span class="w-1.5 h-1.5 rounded-full bg-blue-600"></span>
                                <span class="tabular-nums">{{ stats.tasks.running }} 个任务执行中 · {{ stats.units.running }} 子单元</span>
                            </Badge>

                            <Badge
                                v-else-if="stats.tasks.failed > 0"
                                @click="statusFilter = 'FAILED'"
                                variant="outline"
                                class="hidden sm:inline-flex cursor-pointer hover:bg-muted gap-1.5 text-[11px] whitespace-nowrap text-muted-foreground border-border/80"
                                title="点击筛选异常主任务"
                            >
                                <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                                <span class="font-medium text-foreground">{{ stats.tasks.failed }} 个任务需关注</span>
                                <span class="font-mono text-muted-foreground text-[10px]">({{ stats.units.failed }} 错误)</span>
                            </Badge>
                        </div>
                    </div>

                    <!-- Right: Search bar, sweep button and refresh -->
                    <div class="flex items-center gap-2 sm:gap-2.5 shrink-0">
                        <div class="relative w-36 sm:w-60">
                            <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground stroke-[1.6]" />
                            <Input
                                v-model="searchQuery"
                                type="text"
                                :placeholder="$t('common.search', '搜索任务 ID 或类型...')"
                                class="pl-8 pr-7 text-xs h-8.5 bg-muted/40 hover:bg-muted/70 focus:bg-background border-border/70"
                            />
                            <button
                                v-if="searchQuery"
                                @click="searchQuery = ''"
                                class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs p-0.5 cursor-pointer"
                            >
                                ✕
                            </button>
                        </div>

                        <Button
                            @click="sweepStuckTasks"
                            :disabled="isSweeping"
                            variant="outline"
                            size="sm"
                            class="h-8.5 px-2.5 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform rounded-lg"
                            :title="$t('jobs.actions.sweep', '清理停滞任务')"
                        >
                            <RotateCcw
                                class="w-3.5 h-3.5 sm:mr-1.5 text-muted-foreground stroke-[1.6]"
                                :class="{ 'animate-spin': isSweeping }"
                            />
                            <span class="hidden sm:inline">{{ $t("jobs.actions.sweep", "诊断修复") }}</span>
                        </Button>

                        <Button
                            @click="refreshAll"
                            :disabled="tasksLoading || statsLoading"
                            variant="outline"
                            size="icon-sm"
                            class="h-8.5 w-8.5 text-muted-foreground hover:text-foreground cursor-pointer active:scale-[0.96] transition-transform rounded-lg"
                            :title="$t('jobs.actions.refresh', '刷新')"
                        >
                            <RefreshCw class="w-3.5 h-3.5 stroke-[1.6]" :class="{ 'animate-spin': tasksLoading || statsLoading }" />
                        </Button>
                    </div>
                </header>

                <!-- Main Scrollable Dashboard Content (Structured shadcn Layout) -->
                <main class="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 min-h-0 space-y-6">
                    <div class="max-w-6xl mx-auto space-y-6">
                        <!-- 1. Top Section: 4 High-Density shadcn KPI Metric Cards -->
                        <div class="grid gap-4 grid-cols-2 lg:grid-cols-4">
                            <!-- Card 1: Running -->
                            <Card class="p-4.5 gap-2 border-border/70 shadow-2xs hover:shadow-xs transition-shadow">
                                <div class="flex items-center justify-between">
                                    <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">执行中任务</span>
                                    <div class="p-1 rounded-md bg-blue-500/10 text-blue-600">
                                        <Activity class="h-3.5 w-3.5 stroke-[1.6]" />
                                    </div>
                                </div>
                                <div class="text-2xl font-bold tracking-tight font-mono tabular-nums text-foreground">
                                    {{ stats.tasks.running }}
                                </div>
                                <p class="text-xs text-muted-foreground font-mono tabular-nums">{{ stats.units.running }} 个子单元运行中</p>
                            </Card>

                            <!-- Card 2: Attention / Issues -->
                            <Card
                                @click="statusFilter = 'FAILED'"
                                class="p-4.5 gap-2 border-border/70 shadow-2xs hover:shadow-xs hover:border-zinc-300 dark:hover:border-zinc-700 transition-all cursor-pointer"
                            >
                                <div class="flex items-center justify-between">
                                    <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">异常需关注</span>
                                    <div class="p-1 rounded-md bg-muted text-muted-foreground">
                                        <AlertTriangle
                                            class="h-3.5 w-3.5 stroke-[1.6]"
                                            :class="stats.tasks.failed > 0 ? 'text-amber-500' : 'text-muted-foreground'"
                                        />
                                    </div>
                                </div>
                                <div
                                    class="text-2xl font-bold tracking-tight font-mono tabular-nums text-foreground flex items-center gap-2"
                                >
                                    <span>{{ stats.tasks.failed }}</span>
                                    <span v-if="stats.tasks.failed > 0" class="w-2 h-2 rounded-full bg-rose-500"></span>
                                </div>
                                <p class="text-xs font-mono tabular-nums text-muted-foreground">
                                    {{ stats.units.failed > 0 ? `${stats.units.failed} 项子单元报错` : "无异常记录" }}
                                </p>
                            </Card>

                            <!-- Card 3: Completed -->
                            <Card class="p-4.5 gap-2 border-border/70 shadow-2xs hover:shadow-xs transition-shadow">
                                <div class="flex items-center justify-between">
                                    <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">已完成任务</span>
                                    <div class="p-1 rounded-md bg-emerald-500/10 text-emerald-600">
                                        <CheckCircle2 class="h-3.5 w-3.5 stroke-[1.6]" />
                                    </div>
                                </div>
                                <div class="text-2xl font-bold tracking-tight font-mono tabular-nums text-foreground">
                                    {{ stats.tasks.completed }}
                                </div>
                                <p class="text-xs text-muted-foreground font-mono tabular-nums">{{ stats.units.succeeded }} 项已执行成功</p>
                            </Card>

                            <!-- Card 4: Units Throughput -->
                            <Card class="p-4.5 gap-2 border-border/70 shadow-2xs hover:shadow-xs transition-shadow">
                                <div class="flex items-center justify-between">
                                    <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">子项总量</span>
                                    <div class="p-1 rounded-md bg-muted text-muted-foreground">
                                        <Layers class="h-3.5 w-3.5 stroke-[1.6]" />
                                    </div>
                                </div>
                                <div class="text-2xl font-bold tracking-tight font-mono tabular-nums text-foreground">
                                    {{ stats.units.total }}
                                </div>
                                <p class="text-xs text-muted-foreground font-mono tabular-nums">{{ stats.units.pending }} 项待调度</p>
                            </Card>
                        </div>

                        <!-- 2. Middle Section: Filter & Status Tabs Toolbar (shadcn pill tabs, neutral counts) -->
                        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
                            <!-- shadcn Pill Tabs List -->
                            <div
                                class="inline-flex h-9 items-center justify-start rounded-lg bg-muted p-1 text-muted-foreground overflow-x-auto max-w-full"
                            >
                                <button
                                    v-for="tab in TABS"
                                    :key="tab.key"
                                    @click="statusFilter = tab.key"
                                    class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all focus-visible:outline-none cursor-pointer gap-1.5"
                                    :class="[
                                        statusFilter === tab.key
                                            ? 'bg-background text-foreground shadow-xs font-semibold'
                                            : 'hover:text-foreground text-muted-foreground',
                                    ]"
                                >
                                    <span>{{ $t(tab.label) }}</span>
                                    <span
                                        class="rounded-full px-1.5 py-0.2 text-[10px] font-mono tabular-nums font-semibold"
                                        :class="statusFilter === tab.key ? 'bg-muted text-foreground' : 'text-muted-foreground'"
                                    >
                                        {{ getTabCount(tab.key) }}
                                    </span>
                                </button>
                            </div>

                            <!-- Right: Task Type Selector & Select All -->
                            <div class="flex items-center gap-3 shrink-0 self-end sm:self-center">
                                <div
                                    v-if="filteredTasks.length > 0"
                                    class="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors"
                                    @click="toggleSelectAll"
                                >
                                    <Checkbox
                                        :model-value="isAllSelected ? true : selectedTaskIds.length > 0 ? 'indeterminate' : false"
                                        class="w-4 h-4 pointer-events-none"
                                    />
                                    <span class="font-medium">全选</span>
                                </div>

                                <Select v-model="selectedTaskType">
                                    <SelectTrigger class="w-[145px] h-9 text-xs">
                                        <SelectValue :placeholder="formatTaskType(selectedTaskType)" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem v-for="tType in taskTypeOptions" :key="tType" :value="tType" class="text-xs">
                                            {{ formatTaskType(tType) }}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <!-- 3. Main Tasks Card Stream (Neutral card border, subtle status pills, elegant error snippet) -->
                        <div class="space-y-3">
                            <!-- Loading Skeleton -->
                            <template v-if="tasksLoading && tasks.length === 0">
                                <Card v-for="i in 4" :key="'skel-' + i" class="p-5 animate-pulse gap-3 border-border">
                                    <div class="flex items-center justify-between">
                                        <div class="flex items-center gap-3">
                                            <div class="w-8 h-8 rounded-lg bg-muted"></div>
                                            <div class="space-y-1.5">
                                                <div class="w-36 h-4 bg-muted rounded"></div>
                                                <div class="w-24 h-3 bg-muted rounded"></div>
                                            </div>
                                        </div>
                                        <div class="w-20 h-6 bg-muted rounded-full"></div>
                                    </div>
                                    <div class="w-full h-2 bg-muted rounded-full"></div>
                                </Card>
                            </template>

                            <!-- Modern Minimalist Empty State -->
                            <Card v-else-if="filteredTasks.length === 0" class="py-16 text-center border-dashed">
                                <CardContent class="flex flex-col items-center justify-center max-w-sm mx-auto text-center space-y-3 p-0">
                                    <div class="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground">
                                        <Inbox class="w-6 h-6 stroke-[1.5]" />
                                    </div>
                                    <CardTitle class="text-sm font-semibold">
                                        {{
                                            searchQuery || statusFilter !== "ALL" || selectedTaskType !== "ALL"
                                                ? "未找到匹配的任务"
                                                : $t("jobs.empty.no_tasks", "暂无后台任务")
                                        }}
                                    </CardTitle>
                                    <CardDescription class="text-xs">
                                        {{
                                            searchQuery || statusFilter !== "ALL" || selectedTaskType !== "ALL"
                                                ? "请尝试重置筛选条件或调整搜索关键词。"
                                                : "系统执行媒体封面补全、AI 分析与数据同步时将在此处创建记录。"
                                        }}
                                    </CardDescription>
                                    <Button
                                        v-if="searchQuery || statusFilter !== 'ALL' || selectedTaskType !== 'ALL'"
                                        @click="
                                            statusFilter = 'ALL';
                                            selectedTaskType = 'ALL';
                                            searchQuery = '';
                                        "
                                        variant="outline"
                                        size="sm"
                                        class="h-8 text-xs font-medium cursor-pointer"
                                    >
                                        重置全部筛选
                                    </Button>
                                </CardContent>
                            </Card>

                            <!-- Task Card Stream (Clean neutral border, no red border coating!) -->
                            <Card
                                v-for="task in filteredTasks"
                                :key="task.id"
                                @click="openTaskDetail(task)"
                                class="p-4 sm:p-5 gap-3.5 border-border/70 transition-all duration-150 cursor-pointer group shadow-2xs hover:shadow-xs hover:border-zinc-300 dark:hover:border-zinc-700"
                                :class="[selectedTaskIds.includes(task.id) ? 'border-primary/50 bg-accent/30' : '']"
                            >
                                <!-- Row 1: Checkbox, Icon, Title, Badges, ID, Action buttons -->
                                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                    <div class="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                                        <div class="pt-0.5 sm:pt-0 shrink-0" @click.stop="toggleSelectTask(task.id)">
                                            <Checkbox :model-value="selectedTaskIds.includes(task.id)" class="w-4 h-4" />
                                        </div>

                                        <div class="p-2 rounded-lg bg-muted/60 text-foreground border border-border/60 shrink-0">
                                            <component :is="getTaskTypeIcon(task.type)" class="w-4 h-4 stroke-[1.6]" />
                                        </div>

                                        <div class="min-w-0 flex-1">
                                            <div class="flex flex-wrap items-center gap-2">
                                                <h3
                                                    class="text-sm font-semibold text-foreground group-hover:text-primary transition-colors truncate"
                                                >
                                                    {{ formatTaskType(task.type) }}
                                                </h3>

                                                <!-- Status Badge (Soft tinted pill, NOT solid screaming red!) -->
                                                <span
                                                    v-if="task.status === 'FAILED'"
                                                    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-400"
                                                >
                                                    <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                                                    {{ formatStatus(task.status) }}
                                                </span>
                                                <span
                                                    v-else-if="['RUNNING', 'DISCOVERING'].includes(task.status)"
                                                    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                                                >
                                                    <span class="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse"></span>
                                                    {{ formatStatus(task.status) }}
                                                </span>
                                                <span
                                                    v-else-if="task.status === 'COMPLETED'"
                                                    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                                >
                                                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                                                    {{ formatStatus(task.status) }}
                                                </span>
                                                <span
                                                    v-else
                                                    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-border bg-muted/60 text-muted-foreground"
                                                >
                                                    <span class="w-1.5 h-1.5 rounded-full bg-muted-foreground"></span>
                                                    {{ formatStatus(task.status) }}
                                                </span>

                                                <!-- Scope Badge -->
                                                <span
                                                    class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-normal border border-border/60 bg-muted/40 text-muted-foreground font-mono"
                                                >
                                                    {{ formatInputScope(task) }}
                                                </span>
                                            </div>

                                            <!-- Subtext line -->
                                            <div
                                                class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-muted-foreground font-mono"
                                            >
                                                <button
                                                    @click="(e) => copyTaskId(task.id, e)"
                                                    class="hover:text-foreground transition-colors flex items-center gap-1 cursor-pointer active:scale-[0.96]"
                                                    title="点击复制任务 ID"
                                                >
                                                    <span>#{{ task.id.slice(0, 8) }}</span>
                                                    <Check v-if="copiedId === task.id" class="w-3 h-3 text-emerald-500 stroke-[1.6]" />
                                                    <Copy
                                                        v-else
                                                        class="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity stroke-[1.6]"
                                                    />
                                                </button>
                                                <span>·</span>
                                                <span class="font-sans">创建于 {{ formatTemporalRelative(task.create_time, locale) }}</span>
                                                <template v-if="task.complete_time">
                                                    <span>·</span>
                                                    <span class="font-sans"
                                                        >用时 {{ formatTemporalDuration(task.create_time, task.complete_time) }}</span
                                                    >
                                                </template>
                                                <template v-if="task.status === 'COMPLETED'">
                                                    <span>·</span>
                                                    <span class="text-foreground/80 font-sans">{{ task.total_units }} 项已完成</span>
                                                </template>
                                            </div>
                                        </div>
                                    </div>

                                    <!-- Right: Action Buttons -->
                                    <div class="flex items-center gap-2 shrink-0 self-end sm:self-center" @click.stop>
                                        <Button
                                            v-if="task.failed_units > 0"
                                            @click.stop="retryTaskFailedUnits(task.id)"
                                            :disabled="actionLoadingId === task.id"
                                            variant="outline"
                                            size="sm"
                                            class="h-8 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform rounded-lg"
                                        >
                                            <RotateCcw
                                                class="w-3.5 h-3.5 mr-1 text-muted-foreground stroke-[1.6]"
                                                :class="{ 'animate-spin': actionLoadingId === task.id }"
                                            />
                                            <span>重试失败</span>
                                        </Button>

                                        <Button
                                            @click.stop="openTaskDetail(task)"
                                            variant="outline"
                                            size="sm"
                                            class="h-8 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform rounded-lg"
                                        >
                                            <span>查看详情</span>
                                            <ChevronRight
                                                class="w-3.5 h-3.5 ml-1 text-muted-foreground group-hover:translate-x-0.5 transition-transform stroke-[1.6]"
                                            />
                                        </Button>

                                        <DropdownMenu>
                                            <DropdownMenuTrigger as-child @click.stop>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    class="h-8 w-8 text-muted-foreground hover:text-foreground cursor-pointer active:scale-[0.96] transition-transform rounded-lg"
                                                >
                                                    <MoreHorizontal class="w-4 h-4 stroke-[1.6]" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" class="w-44 text-xs">
                                                <DropdownMenuItem @click.stop="openTaskDetail(task)" class="cursor-pointer text-xs">
                                                    <FileText class="w-3.5 h-3.5 mr-2 text-muted-foreground stroke-[1.6]" />
                                                    <span>查看任务明细</span>
                                                </DropdownMenuItem>

                                                <DropdownMenuItem
                                                    v-if="task.failed_units > 0"
                                                    @click.stop="retryTaskFailedUnits(task.id)"
                                                    class="cursor-pointer text-xs font-medium"
                                                >
                                                    <RotateCcw class="w-3.5 h-3.5 mr-2 text-muted-foreground stroke-[1.6]" />
                                                    <span>重试失败子项</span>
                                                </DropdownMenuItem>

                                                <DropdownMenuItem
                                                    v-if="['RUNNING', 'DISCOVERING'].includes(task.status)"
                                                    @click.stop="pauseTask(task.id)"
                                                    class="cursor-pointer text-xs text-amber-600"
                                                >
                                                    <Pause class="w-3.5 h-3.5 mr-2 stroke-[1.6]" />
                                                    <span>暂停任务</span>
                                                </DropdownMenuItem>

                                                <DropdownMenuItem
                                                    v-if="task.status === 'PAUSED'"
                                                    @click.stop="resumeTask(task.id)"
                                                    class="cursor-pointer text-xs text-blue-600"
                                                >
                                                    <Play class="w-3.5 h-3.5 mr-2 stroke-[1.6]" />
                                                    <span>恢复任务</span>
                                                </DropdownMenuItem>

                                                <DropdownMenuSeparator
                                                    v-if="['RUNNING', 'DISCOVERING', 'PAUSED', 'FAILED'].includes(task.status)"
                                                />

                                                <DropdownMenuItem
                                                    v-if="['RUNNING', 'DISCOVERING', 'PAUSED', 'FAILED'].includes(task.status)"
                                                    @click.stop="cancelTask(task.id)"
                                                    class="cursor-pointer text-xs text-muted-foreground"
                                                >
                                                    <XCircle class="w-3.5 h-3.5 mr-2 stroke-[1.6]" />
                                                    <span>标记已解决 / 忽略</span>
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </div>

                                <!-- Row 2: Progress Bar & Detailed Telemetry (Rendered when running, paused, or with failures) -->
                                <div
                                    v-if="
                                        ['RUNNING', 'DISCOVERING', 'PAUSED'].includes(task.status) ||
                                        task.failed_units > 0 ||
                                        (task.status !== 'COMPLETED' && task.total_units > 0)
                                    "
                                    class="space-y-2 pt-1 border-t border-border/60"
                                >
                                    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
                                        <div class="flex items-center gap-2 font-mono tabular-nums text-muted-foreground">
                                            <span class="font-medium text-foreground"
                                                >{{ task.progress.processed_units }} / {{ task.total_units }} 项已处理</span
                                            >
                                            <span>·</span>
                                            <span class="font-bold text-foreground">{{ task.progress.percentage }}%</span>
                                        </div>

                                        <div class="flex items-center gap-3 text-xs font-mono tabular-nums">
                                            <span class="text-emerald-600 dark:text-emerald-400 font-medium"
                                                >✓ {{ task.succeeded_units }} 成功</span
                                            >
                                            <span v-if="task.failed_units > 0" class="text-rose-600 dark:text-rose-400 font-medium"
                                                >✕ {{ task.failed_units }} 失败</span
                                            >
                                            <span v-if="task.cancelled_units > 0" class="text-muted-foreground"
                                                >⊘ {{ task.cancelled_units }} 取消</span
                                            >
                                        </div>
                                    </div>

                                    <!-- Segmented Progress Bar -->
                                    <div class="h-1.5 w-full rounded-full bg-secondary/80 overflow-hidden flex gap-0.5">
                                        <div
                                            class="bg-emerald-500 h-full transition-all duration-300"
                                            :style="{ width: `${taskUnitPercentage(task, 'succeeded')}%` }"
                                        ></div>
                                        <div
                                            class="bg-rose-500 h-full transition-all duration-300"
                                            :style="{ width: `${taskUnitPercentage(task, 'failed')}%` }"
                                        ></div>
                                        <div
                                            class="bg-muted-foreground/20 h-full transition-all duration-300"
                                            :style="{ width: `${taskUnitPercentage(task, 'cancelled')}%` }"
                                        ></div>
                                    </div>

                                    <!-- Refined Technical Diagnostic Snippet Bar (Mini Terminal Pill Bar) -->
                                    <div
                                        v-if="task.last_error"
                                        class="flex items-center gap-2 pt-2 border-t border-border/40 text-xs text-muted-foreground"
                                    >
                                        <div
                                            class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted/80 border border-border/60 text-[11px] font-mono text-muted-foreground shrink-0"
                                        >
                                            <Terminal class="w-3 h-3 text-zinc-500 stroke-[1.6]" />
                                            <span>stderr</span>
                                        </div>
                                        <code
                                            class="font-mono text-[11px] text-muted-foreground flex-1 truncate select-all px-2.5 py-0.5 rounded-md bg-muted/30 border border-border/40 group-hover:text-foreground transition-colors"
                                        >
                                            {{ task.last_error }}
                                        </code>
                                    </div>
                                </div>
                            </Card>
                        </div>

                        <!-- 4. Docked Pagination Footer inside main flow -->
                        <div class="flex items-center justify-between text-xs text-muted-foreground pt-4 border-t border-border">
                            <span class="font-mono tabular-nums">
                                {{
                                    totalItems > 0
                                        ? `显示第 ${(page - 1) * limit + 1} - ${Math.min(page * limit, totalItems)} 项，共 ${totalItems} 项任务`
                                        : "共 0 项任务"
                                }}
                            </span>

                            <div class="flex items-center gap-2">
                                <Button
                                    @click="
                                        page--;
                                        fetchTasks();
                                    "
                                    :disabled="page <= 1 || tasksLoading"
                                    variant="outline"
                                    size="sm"
                                    class="h-8 px-2.5 active:scale-[0.96] transition-transform rounded-lg"
                                >
                                    <ChevronLeft class="w-4 h-4 mr-1 stroke-[1.6]" />
                                    <span>上一页</span>
                                </Button>
                                <span class="text-xs font-mono tabular-nums px-2"> {{ page }} / {{ totalPages }} </span>
                                <Button
                                    @click="
                                        page++;
                                        fetchTasks();
                                    "
                                    :disabled="page >= totalPages || tasksLoading"
                                    variant="outline"
                                    size="sm"
                                    class="h-8 px-2.5 active:scale-[0.96] transition-transform rounded-lg"
                                >
                                    <span>下一页</span>
                                    <ChevronRight class="w-4 h-4 ml-1 stroke-[1.6]" />
                                </Button>
                            </div>
                        </div>
                    </div>
                </main>

                <!-- Floating Bulk Action Bar (Docked when items selected) -->
                <div
                    v-if="selectedTaskIds.length > 0"
                    class="fixed bottom-6 left-1/2 -translate-x-1/2 bg-card/95 backdrop-blur-md text-card-foreground border border-border shadow-xl rounded-full px-4 py-2 flex items-center gap-3 z-50 transition-all animate-in fade-in slide-in-from-bottom-2 whitespace-nowrap ring-1 ring-black/5 dark:ring-white/10"
                >
                    <div class="flex items-center gap-2 text-xs font-semibold pl-1">
                        <span class="w-2 h-2 rounded-full bg-primary"></span>
                        <span>已选择 {{ selectedTaskIds.length }} 项</span>
                    </div>

                    <div class="h-4 w-px bg-border"></div>

                    <div class="flex items-center gap-2">
                        <Button
                            @click="handleBulkRetry"
                            :disabled="isBulkLoading"
                            size="sm"
                            class="h-7.5 px-3 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform rounded-full"
                        >
                            <RotateCcw class="w-3.5 h-3.5 mr-1 stroke-[1.6]" :class="{ 'animate-spin': isBulkLoading }" />
                            <span>批量重试</span>
                        </Button>
                        <Button
                            @click="handleBulkPause"
                            :disabled="isBulkLoading"
                            variant="outline"
                            size="sm"
                            class="h-7.5 px-3 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform rounded-full"
                        >
                            <Pause class="w-3.5 h-3.5 mr-1 stroke-[1.6]" />
                            <span>批量暂停</span>
                        </Button>
                        <Button
                            @click="handleBulkResume"
                            :disabled="isBulkLoading"
                            variant="outline"
                            size="sm"
                            class="h-7.5 px-3 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform rounded-full"
                        >
                            <Play class="w-3.5 h-3.5 mr-1 stroke-[1.6]" />
                            <span>批量恢复</span>
                        </Button>
                        <Button
                            @click="handleBulkCancel"
                            :disabled="isBulkLoading"
                            variant="outline"
                            size="sm"
                            class="h-7.5 px-3 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform rounded-full"
                        >
                            <XCircle class="w-3.5 h-3.5 mr-1 stroke-[1.6]" />
                            <span>批量忽略</span>
                        </Button>
                    </div>

                    <div class="h-4 w-px bg-border"></div>

                    <button
                        @click="selectedTaskIds = []"
                        class="text-xs text-muted-foreground hover:text-foreground cursor-pointer p-1 rounded-full hover:bg-muted active:scale-[0.92] transition-all"
                        title="取消选择 (Esc)"
                    >
                        ✕
                    </button>
                </div>
            </div>
        </transition>
    </div>
</template>

<style scoped>
.view-fade-enter-active,
.view-fade-leave-active {
    transition:
        opacity 0.15s ease,
        transform 0.15s ease;
}

.view-fade-enter-from {
    opacity: 0;
    transform: translateY(4px);
}

.view-fade-leave-to {
    opacity: 0;
    transform: translateY(-4px);
}
</style>
