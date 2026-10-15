<script setup lang="ts">
import { ref, computed, watch } from "vue";
import {
    ChevronLeft,
    RefreshCw,
    RotateCcw,
    CheckCircle2,
    AlertTriangle,
    Play,
    Pause,
    XCircle,
    Copy,
    Check,
    MoreHorizontal,
    Terminal,
    FileText,
    Layers,
    Sparkles,
    Image as ImageIcon,
    Clock,
    Inbox,
    Code,
    ChevronDown,
    ChevronUp,
    ChevronRight,
    ExternalLink,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "vue-sonner";
import { useApi } from "@/composables/useApi";
import { formatTemporalDateTime, formatTemporalRelative, formatTemporalDuration } from "@/utils/temporal";

export interface MasterTaskItem {
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

export interface TaskUnitItem {
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

const props = defineProps<{
    task: MasterTaskItem;
    actionLoadingId: string | null;
    refreshing: boolean;
}>();

const emit = defineEmits<{
    (e: "back"): void;
    (e: "refresh"): void;
    (e: "retryFailedUnits", taskId: string): void;
    (e: "pauseTask", taskId: string): void;
    (e: "resumeTask", taskId: string): void;
    (e: "cancelTask", taskId: string): void;
}>();

const { t, locale } = useI18n();

const activeTab = ref<"units" | "overview">("units");
const UNIT_PAGE_SIZE = 25;

const taskUnits = ref<TaskUnitItem[]>([]);
const taskUnitsLoading = ref(false);
const unitStatusFilter = ref<string>("ALL");
const unitStatusCounts = ref<Record<string, number>>({});
const unitPage = ref(1);
const unitTotal = ref(0);
const unitTotalPages = ref(1);
const unitActionLoadingId = ref<string | null>(null);
const copiedId = ref<string | null>(null);
const expandedErrorUnitIds = ref<string[]>([]);

function isApiSuccess(res: any): boolean {
    return Boolean(res && (res.success || res.code === 0 || res.code === "SUCCESS"));
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

const unitProgress = computed(() => {
    const progress = props.task.progress;
    const total = progress?.total_units || 0;
    const succeeded = progress?.succeeded_units || 0;
    const failed = progress?.failed_units || 0;
    const cancelled = progress?.cancelled_units || 0;
    return {
        total,
        succeeded,
        failed,
        cancelled,
        processed: progress?.processed_units || 0,
        percentage: progress?.percentage || 0,
        remaining: Math.max(0, total - (succeeded + failed + cancelled)),
    };
});

function progressShare(val: number): string {
    if (!unitProgress.value.total) return "0%";
    const pct = Math.min(100, Math.round((val / unitProgress.value.total) * 100));
    return `${pct}%`;
}

const unitStatusChips = computed(() => {
    const counts = unitStatusCounts.value;
    return [
        { value: "ALL", label: "全部", count: unitTotal.value },
        { value: "FAILED", label: "失败", count: counts.FAILED || 0 },
        { value: "RUNNING", label: "执行中", count: counts.RUNNING || 0 },
        { value: "PENDING", label: "等待中", count: counts.PENDING || 0 },
        { value: "SUCCEEDED", label: "成功", count: counts.SUCCEEDED || 0 },
        { value: "CANCELLED", label: "已取消", count: counts.CANCELLED || 0 },
    ];
});

function toggleExpandError(unitId: string) {
    const idx = expandedErrorUnitIds.value.indexOf(unitId);
    if (idx > -1) {
        expandedErrorUnitIds.value.splice(idx, 1);
    } else {
        expandedErrorUnitIds.value.push(unitId);
    }
}

function errorLines(err: string | null): string[] {
    if (!err) return [];
    return err.trim().split("\n");
}

const unitRangeText = computed(() => {
    if (unitTotal.value === 0) return "第 0 项，共 0 项";
    const start = (unitPage.value - 1) * UNIT_PAGE_SIZE + 1;
    const end = Math.min(unitPage.value * UNIT_PAGE_SIZE, unitTotal.value);
    return `显示第 ${start} - ${end} 项，共 ${unitTotal.value} 项`;
});

async function fetchTaskUnits() {
    const taskId = props.task.id;
    if (!taskId) return;
    taskUnitsLoading.value = true;
    try {
        const query: Record<string, any> = {
            page: unitPage.value,
            limit: UNIT_PAGE_SIZE,
        };
        if (unitStatusFilter.value !== "ALL") {
            query.status = unitStatusFilter.value;
        }

        const res: any = await useApi(`/jobs/${taskId}/items`, { query });
        if (!isApiSuccess(res) || !res.data || props.task.id !== taskId) return;

        taskUnits.value = res.data.items || [];
        unitStatusCounts.value = res.data.counts || {};
        unitTotal.value = res.data.pagination?.total || 0;

        const lastPage = Math.max(1, res.data.pagination?.total_pages || 1);
        unitTotalPages.value = lastPage;
        if (unitPage.value > lastPage) {
            unitPage.value = lastPage;
            await fetchTaskUnits();
        }
    } catch (e: any) {
        console.error("Failed to fetch task units:", e);
    } finally {
        taskUnitsLoading.value = false;
    }
}

async function retrySingleUnit(unitId: string) {
    unitActionLoadingId.value = unitId;
    try {
        const res: any = await useApi(`/jobs/units/${unitId}/retry`, { method: "POST" });
        if (isApiSuccess(res)) {
            toast.success("已重新入队该子任务单元");
            emit("refresh");
            await fetchTaskUnits();
        } else {
            toast.error(res?.message || "重试失败");
        }
    } catch (e: any) {
        toast.error(`重试异常: ${e.message || e}`);
    } finally {
        unitActionLoadingId.value = null;
    }
}

function changeUnitPage(next: number) {
    unitPage.value = next;
    fetchTaskUnits();
}

watch(
    () => props.task.id,
    () => {
        unitPage.value = 1;
        unitStatusFilter.value = "ALL";
        fetchTaskUnits();
    },
    { immediate: true },
);

watch(unitStatusFilter, () => {
    unitPage.value = 1;
    fetchTaskUnits();
});

defineExpose({
    fetchTaskUnits,
});
</script>

<template>
    <div class="h-full flex flex-col bg-background text-foreground overflow-hidden font-sans select-none">
        <!-- Top Docked Navigation Header (h-14) -->
        <header
            class="h-14 border-b border-border px-4 md:px-6 shrink-0 flex items-center justify-between gap-3 bg-background/95 backdrop-blur-xs"
        >
            <!-- Left: Breadcrumb / Back Trigger -->
            <div class="flex items-center gap-3 min-w-0">
                <Button
                    @click="emit('back')"
                    variant="ghost"
                    size="sm"
                    class="h-8.5 px-2.5 -ml-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer shrink-0 active:scale-[0.96] transition-transform"
                >
                    <ChevronLeft class="w-4 h-4 mr-1 text-muted-foreground stroke-[1.6]" />
                    <span>{{ $t("jobs.title", "全部任务") }}</span>
                </Button>

                <div class="h-4 w-px bg-border shrink-0"></div>

                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="p-1.5 bg-muted/60 border border-border rounded-lg shrink-0">
                        <component :is="getTaskTypeIcon(task.type)" class="w-4 h-4 text-foreground stroke-[1.6]" />
                    </div>

                    <div class="flex items-center gap-2 min-w-0">
                        <h1 class="text-sm font-semibold tracking-tight text-foreground truncate">
                            {{ formatTaskType(task.type) }}
                        </h1>

                        <!-- Soft Status Badge (No solid screaming red block!) -->
                        <span
                            v-if="task.status === 'FAILED'"
                            class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-400 shrink-0"
                        >
                            <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                            {{ formatStatus(task.status) }}
                        </span>
                        <span
                            v-else-if="['RUNNING', 'DISCOVERING'].includes(task.status)"
                            class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-400 shrink-0"
                        >
                            <span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                            {{ formatStatus(task.status) }}
                        </span>
                        <span
                            v-else-if="task.status === 'COMPLETED'"
                            class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 shrink-0"
                        >
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                            {{ formatStatus(task.status) }}
                        </span>
                        <span
                            v-else
                            class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-border bg-muted/60 text-muted-foreground shrink-0"
                        >
                            <span class="w-1.5 h-1.5 rounded-full bg-muted-foreground"></span>
                            {{ formatStatus(task.status) }}
                        </span>

                        <!-- Copyable ID -->
                        <button
                            @click="copyText(task.id, '已复制任务 ID')"
                            class="hidden sm:inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground hover:text-foreground px-2 py-0.5 rounded-md bg-muted/60 hover:bg-muted transition-all active:scale-[0.96] cursor-pointer shrink-0"
                            title="点击复制任务 ID"
                        >
                            <span>#{{ task.id.slice(0, 8) }}</span>
                            <Check v-if="copiedId === task.id" class="w-3 h-3 text-emerald-500 stroke-[1.6]" />
                            <Copy v-else class="w-3 h-3 opacity-60 stroke-[1.6]" />
                        </button>
                    </div>
                </div>
            </div>

            <!-- Right: Action Controls -->
            <div class="flex items-center gap-2">
                <!-- Highlighted Action: Retry Failed Units if Failures Exist -->
                <Button
                    v-if="task.failed_units > 0"
                    @click="emit('retryFailedUnits', task.id)"
                    :disabled="actionLoadingId === task.id"
                    size="sm"
                    class="h-8.5 px-3 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform"
                >
                    <RotateCcw class="w-3.5 h-3.5 mr-1.5 stroke-[1.6]" :class="{ 'animate-spin': actionLoadingId === task.id }" />
                    <span>{{ $t("jobs.inspector.retry_all_failed") }} ({{ task.failed_units }})</span>
                </Button>

                <!-- Pause/Resume button -->
                <Button
                    v-if="['RUNNING', 'DISCOVERING'].includes(task.status)"
                    @click="emit('pauseTask', task.id)"
                    variant="outline"
                    size="sm"
                    class="h-8.5 px-3 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform"
                >
                    <Pause class="w-3.5 h-3.5 mr-1.5 text-muted-foreground stroke-[1.6]" />
                    <span>{{ $t("jobs.actions.pause") }}</span>
                </Button>

                <Button
                    v-else-if="task.status === 'PAUSED'"
                    @click="emit('resumeTask', task.id)"
                    variant="outline"
                    size="sm"
                    class="h-8.5 px-3 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform"
                >
                    <Play class="w-3.5 h-3.5 mr-1.5 text-muted-foreground stroke-[1.6]" />
                    <span>{{ $t("jobs.actions.resume") }}</span>
                </Button>

                <!-- Refresh button -->
                <Button
                    @click="emit('refresh')"
                    :disabled="refreshing || taskUnitsLoading"
                    variant="outline"
                    size="sm"
                    class="h-8.5 px-3 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform"
                >
                    <RefreshCw
                        class="w-3.5 h-3.5 mr-1.5 text-muted-foreground stroke-[1.6]"
                        :class="{ 'animate-spin': refreshing || taskUnitsLoading }"
                    />
                    <span>{{ $t("jobs.actions.refresh") }}</span>
                </Button>

                <!-- More dropdown -->
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button
                            variant="outline"
                            size="icon-sm"
                            class="h-8.5 w-8.5 text-muted-foreground hover:text-foreground cursor-pointer active:scale-[0.96] transition-transform"
                        >
                            <MoreHorizontal class="w-4 h-4 stroke-[1.6]" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="w-44 text-xs">
                        <DropdownMenuItem @click="copyText(task.id, '已复制任务 ID')" class="cursor-pointer text-xs font-medium">
                            <Copy class="w-3.5 h-3.5 mr-2 text-muted-foreground stroke-[1.6]" />
                            <span>复制完整任务 ID</span>
                        </DropdownMenuItem>

                        <DropdownMenuItem
                            v-if="task.input_snapshot"
                            @click="copyText(JSON.stringify(task.input_snapshot, null, 2), '已复制参数快照')"
                            class="cursor-pointer text-xs font-medium"
                        >
                            <Code class="w-3.5 h-3.5 mr-2 text-muted-foreground stroke-[1.6]" />
                            <span>复制参数快照 JSON</span>
                        </DropdownMenuItem>

                        <DropdownMenuSeparator v-if="['RUNNING', 'DISCOVERING', 'PAUSED', 'FAILED'].includes(task.status)" />

                        <DropdownMenuItem
                            v-if="['RUNNING', 'DISCOVERING', 'PAUSED', 'FAILED'].includes(task.status)"
                            @click="emit('cancelTask', task.id)"
                            class="cursor-pointer text-xs text-muted-foreground"
                        >
                            <XCircle class="w-3.5 h-3.5 mr-2 stroke-[1.6]" />
                            <span>{{ $t("jobs.actions.cancel") }}</span>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </header>

        <!-- Main Workspace Area -->
        <main class="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 min-h-0 space-y-6">
            <div class="max-w-6xl mx-auto space-y-6">
                <!-- 1. Hero Overview Metric Cards (Clean neutral cards) -->
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <!-- Card 1: Progress & Total Units -->
                    <Card class="p-4.5 gap-2 border-border shadow-2xs">
                        <div class="flex items-center justify-between text-xs text-muted-foreground">
                            <span class="font-semibold uppercase tracking-wider text-[10px]">任务执行进度</span>
                            <span class="font-bold text-foreground tabular-nums font-mono text-xs">{{ unitProgress.percentage }}%</span>
                        </div>
                        <div class="flex items-baseline gap-1.5 tabular-nums font-mono">
                            <span class="text-2xl font-bold tracking-tight text-foreground">{{ task.progress.processed_units }}</span>
                            <span class="text-xs text-muted-foreground font-sans">/ {{ task.progress.total_units }} 项子单元</span>
                        </div>
                        <!-- Segmented Progress Bar -->
                        <div class="h-1.5 w-full rounded-full bg-secondary/80 overflow-hidden flex gap-0.5 mt-1.5">
                            <div
                                class="bg-emerald-500 h-full transition-all duration-300"
                                :style="{ width: progressShare(unitProgress.succeeded) }"
                                title="已成功"
                            ></div>
                            <div
                                class="bg-rose-500 h-full transition-all duration-300"
                                :style="{ width: progressShare(unitProgress.failed) }"
                                title="已失败"
                            ></div>
                            <div
                                class="bg-muted-foreground/20 h-full transition-all duration-300"
                                :style="{ width: progressShare(unitProgress.cancelled) }"
                                title="已取消"
                            ></div>
                        </div>
                    </Card>

                    <!-- Card 2: Units Breakdown -->
                    <Card class="p-4.5 gap-2 border-border shadow-2xs">
                        <span class="font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">子任务分布</span>
                        <div class="grid grid-cols-2 gap-2 pt-1 text-xs tabular-nums font-mono">
                            <div class="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
                                <span>成功 {{ unitProgress.succeeded }}</span>
                            </div>
                            <div
                                class="flex items-center gap-1.5 font-medium"
                                :class="unitProgress.failed > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'"
                            >
                                <span
                                    class="w-1.5 h-1.5 rounded-full shrink-0"
                                    :class="unitProgress.failed > 0 ? 'bg-rose-500' : 'bg-muted-foreground/40'"
                                ></span>
                                <span>失败 {{ unitProgress.failed }}</span>
                            </div>
                            <div class="flex items-center gap-1.5 text-muted-foreground font-medium">
                                <span class="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0"></span>
                                <span>已取消 {{ unitProgress.cancelled }}</span>
                            </div>
                            <div class="flex items-center gap-1.5 text-muted-foreground font-medium">
                                <span class="w-1.5 h-1.5 rounded-full bg-muted-foreground/20 shrink-0"></span>
                                <span>待处理 {{ unitProgress.remaining }}</span>
                            </div>
                        </div>
                    </Card>

                    <!-- Card 3: Execution Time & Duration -->
                    <Card class="p-4.5 gap-2 border-border shadow-2xs">
                        <span class="font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">耗时</span>
                        <div class="flex items-baseline gap-1.5 font-mono">
                            <span class="text-2xl font-bold tracking-tight text-foreground tabular-nums">
                                {{ formatTemporalDuration(task.create_time, task.complete_time) }}
                            </span>
                        </div>
                        <div class="text-xs text-muted-foreground truncate font-mono tabular-nums">
                            创建于
                            {{
                                formatTemporalDateTime(task.create_time, locale, {
                                    month: "2-digit",
                                    day: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                })
                            }}
                        </div>
                    </Card>

                    <!-- Card 4: Scope & Discovery -->
                    <Card class="p-4.5 gap-2 border-border shadow-2xs">
                        <span class="font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">目标范围</span>
                        <div class="flex items-baseline gap-1.5">
                            <span class="text-base font-bold text-foreground truncate">
                                {{ formatInputScope(task) }}
                            </span>
                        </div>
                        <div class="text-xs text-muted-foreground flex items-center gap-1.5">
                            <span
                                class="w-1.5 h-1.5 rounded-full"
                                :class="task.discovery_complete ? 'bg-emerald-500' : 'bg-blue-500'"
                            ></span>
                            <span>{{ task.discovery_complete ? "扫描已完成" : "扫描中..." }}</span>
                        </div>
                    </Card>
                </div>

                <!-- Navigation Tabs in shadcn Style -->
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
                    <div class="inline-flex h-9 items-center justify-start rounded-lg bg-muted p-1 text-muted-foreground">
                        <button
                            @click="activeTab = 'units'"
                            class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all focus-visible:outline-none cursor-pointer gap-1.5 active:scale-[0.96]"
                            :class="
                                activeTab === 'units'
                                    ? 'bg-background text-foreground shadow-xs font-semibold'
                                    : 'hover:text-foreground text-muted-foreground'
                            "
                        >
                            <span>{{ $t("jobs.inspector.units_tab", "子任务") }}</span>
                            <span
                                class="rounded-full px-1.5 py-0.2 text-[10px] font-mono tabular-nums font-semibold"
                                :class="activeTab === 'units' ? 'bg-muted text-foreground' : 'text-muted-foreground'"
                            >
                                {{ unitProgress.total }}
                            </span>
                        </button>

                        <button
                            @click="activeTab = 'overview'"
                            class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all focus-visible:outline-none cursor-pointer gap-1.5 active:scale-[0.96]"
                            :class="
                                activeTab === 'overview'
                                    ? 'bg-background text-foreground shadow-xs font-semibold'
                                    : 'hover:text-foreground text-muted-foreground'
                            "
                        >
                            <span>{{ $t("jobs.inspector.overview_tab", "详细信息") }}</span>
                        </button>
                    </div>

                    <!-- Right: Sub-task Unit Status Filter Pills (When on Units Tab) -->
                    <div v-if="activeTab === 'units'" class="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
                        <button
                            v-for="chip in unitStatusChips"
                            :key="chip.value"
                            @click="unitStatusFilter = chip.value"
                            class="h-7 px-2.5 rounded-full text-xs font-medium border transition-all cursor-pointer flex items-center gap-1.5 shrink-0 active:scale-[0.96]"
                            :class="
                                unitStatusFilter === chip.value
                                    ? 'bg-primary border-primary text-primary-foreground shadow-2xs font-semibold'
                                    : 'bg-background border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                            "
                        >
                            <span>{{ chip.label }}</span>
                            <span
                                class="tabular-nums font-mono text-[11px]"
                                :class="unitStatusFilter === chip.value ? 'text-primary-foreground/80' : 'text-muted-foreground'"
                            >
                                {{ chip.count }}
                            </span>
                        </button>
                    </div>
                </div>

                <!-- 4. Tab Contents -->
                <!-- TAB 1: Sub-tasks Stream -->
                <div v-if="activeTab === 'units'" class="space-y-4">
                    <!-- Loading Skeleton -->
                    <template v-if="taskUnitsLoading && taskUnits.length === 0">
                        <Card v-for="i in 5" :key="'unit-skel-' + i" class="p-4 animate-pulse gap-3 border-border">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <div class="w-16 h-5 bg-muted rounded-full"></div>
                                    <div class="w-40 h-4 bg-muted rounded"></div>
                                </div>
                                <div class="w-20 h-6 bg-muted rounded"></div>
                            </div>
                        </Card>
                    </template>

                    <!-- Empty State -->
                    <Card v-else-if="taskUnits.length === 0" class="py-16 text-center border-dashed">
                        <CardContent class="flex flex-col items-center justify-center max-w-sm mx-auto text-center space-y-3 p-0">
                            <div class="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground">
                                <Inbox class="w-6 h-6 stroke-[1.5]" />
                            </div>
                            <CardTitle class="text-sm font-semibold">
                                {{ unitStatusFilter === "ALL" ? $t("jobs.inspector.no_units") : $t("jobs.inspector.no_units_filtered") }}
                            </CardTitle>
                            <Button
                                v-if="unitStatusFilter !== 'ALL'"
                                @click="unitStatusFilter = 'ALL'"
                                variant="outline"
                                size="sm"
                                class="h-8 text-xs font-medium cursor-pointer"
                            >
                                {{ $t("jobs.inspector.view_all_units") }}
                            </Button>
                        </CardContent>
                    </Card>

                    <!-- Unit Cards (Clean neutral card border, no red card outlines!) -->
                    <div v-else class="space-y-3">
                        <Card
                            v-for="unit in taskUnits"
                            :key="unit.id"
                            class="p-4 gap-3 border-border transition-all duration-150 group shadow-2xs hover:shadow-xs hover:border-zinc-300 dark:hover:border-zinc-700"
                        >
                            <!-- Top line: Status, Identifier, Attempts, Action -->
                            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                <div class="flex items-center gap-3 min-w-0">
                                    <!-- Soft Status Badge -->
                                    <span
                                        v-if="unit.status === 'FAILED'"
                                        class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-400 shrink-0"
                                    >
                                        <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                                        {{ formatStatus(unit.status) }}
                                    </span>
                                    <span
                                        v-else-if="unit.status === 'SUCCEEDED'"
                                        class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 shrink-0"
                                    >
                                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                                        {{ formatStatus(unit.status) }}
                                    </span>
                                    <span
                                        v-else
                                        class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border border-border bg-muted/60 text-muted-foreground shrink-0"
                                    >
                                        <span class="w-1.5 h-1.5 rounded-full bg-muted-foreground"></span>
                                        {{ formatStatus(unit.status) }}
                                    </span>

                                    <div class="flex items-center gap-1.5 min-w-0">
                                        <span class="font-mono text-xs font-semibold text-foreground truncate" :title="unit.unit_key">
                                            {{ unit.unit_key }}
                                        </span>
                                        <button
                                            @click="copyText(unit.unit_key, '已复制子项标识')"
                                            class="opacity-0 group-hover:opacity-100 transition-all p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer active:scale-[0.92]"
                                            title="复制子项标识"
                                        >
                                            <Check v-if="copiedId === unit.unit_key" class="w-3.5 h-3.5 text-emerald-500 stroke-[1.6]" />
                                            <Copy v-else class="w-3.5 h-3.5 stroke-[1.6]" />
                                        </button>
                                    </div>

                                    <span
                                        v-if="unit.kind || unit.subject_type"
                                        class="hidden md:inline-block text-xs text-muted-foreground font-sans"
                                    >
                                        ({{ unit.kind || unit.subject_type }})
                                    </span>
                                </div>

                                <div class="flex items-center gap-3 shrink-0 self-end sm:self-center">
                                    <span class="text-xs text-muted-foreground font-mono tabular-nums">
                                        {{ unit.attempt_count }} / {{ unit.max_attempts }} 次尝试
                                    </span>

                                    <span
                                        v-if="unit.complete_time"
                                        class="text-xs text-muted-foreground font-mono tabular-nums hidden sm:inline"
                                    >
                                        {{ formatTemporalRelative(unit.complete_time, locale) }}
                                    </span>

                                    <Button
                                        v-if="unit.status === 'FAILED'"
                                        @click="retrySingleUnit(unit.id)"
                                        :disabled="unitActionLoadingId === unit.id"
                                        size="sm"
                                        variant="outline"
                                        class="h-7 px-2.5 text-xs font-medium cursor-pointer active:scale-[0.96] transition-transform rounded-md"
                                    >
                                        <RotateCcw
                                            class="w-3 h-3 mr-1 text-muted-foreground stroke-[1.6]"
                                            :class="{ 'animate-spin': unitActionLoadingId === unit.id }"
                                        />
                                        <span>{{ $t("jobs.inspector.retry_unit", "重试") }}</span>
                                    </Button>
                                </div>
                            </div>

                            <!-- Developer Log Output (Clean Header, Authentic Typography) -->
                            <div
                                v-if="unit.last_error"
                                class="rounded-lg bg-zinc-950 border border-zinc-800/80 overflow-hidden shadow-xs mt-2"
                            >
                                <!-- Terminal Header -->
                                <div
                                    class="bg-zinc-900/80 border-b border-zinc-800/80 px-3 py-1.5 flex items-center justify-between text-[11px] text-zinc-400 font-mono select-none"
                                >
                                    <div class="flex items-center gap-2">
                                        <Terminal class="w-3.5 h-3.5 text-zinc-400 stroke-[1.6]" />
                                        <span class="text-zinc-200 font-medium">stderr</span>
                                        <span
                                            v-if="errorLines(unit.last_error).length > 0"
                                            class="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 font-mono tabular-nums"
                                        >
                                            {{ errorLines(unit.last_error).length }} 行
                                        </span>
                                    </div>

                                    <div class="flex items-center gap-2">
                                        <button
                                            @click="copyText(unit.last_error, '已复制错误详情')"
                                            class="hover:text-zinc-100 hover:bg-zinc-800 transition-all flex items-center gap-1 cursor-pointer px-2 py-0.5 rounded text-[11px] active:scale-[0.94]"
                                            title="复制错误详情"
                                        >
                                            <Check v-if="copiedId === unit.last_error" class="w-3 h-3 text-emerald-400 stroke-[1.6]" />
                                            <Copy v-else class="w-3 h-3 text-zinc-400 stroke-[1.6]" />
                                            <span>{{ copiedId === unit.last_error ? "已复制" : "复制" }}</span>
                                        </button>

                                        <span v-if="errorLines(unit.last_error).length > 3" class="text-zinc-700">|</span>

                                        <button
                                            v-if="errorLines(unit.last_error).length > 3"
                                            @click="toggleExpandError(unit.id)"
                                            class="hover:text-zinc-100 hover:bg-zinc-800 transition-all flex items-center gap-1 cursor-pointer px-2 py-0.5 rounded text-[11px] active:scale-[0.94]"
                                        >
                                            <span>{{ expandedErrorUnitIds.includes(unit.id) ? "收起" : "展开全部" }}</span>
                                            <component
                                                :is="expandedErrorUnitIds.includes(unit.id) ? ChevronUp : ChevronDown"
                                                class="w-3 h-3 stroke-[1.6]"
                                            />
                                        </button>
                                    </div>
                                </div>

                                <!-- Terminal Output Body -->
                                <pre
                                    class="p-3 text-xs font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap break-all select-text overflow-x-auto"
                                    >{{
                                        expandedErrorUnitIds.includes(unit.id)
                                            ? unit.last_error
                                            : errorLines(unit.last_error).slice(0, 3).join("\n")
                                    }}</pre>
                            </div>
                        </Card>
                    </div>

                    <!-- Sub-tasks Pagination -->
                    <div class="flex items-center justify-between text-xs text-muted-foreground pt-4 border-t border-border">
                        <span class="tabular-nums font-mono">{{ unitRangeText }}</span>

                        <div class="flex items-center gap-2">
                            <Button
                                @click="changeUnitPage(unitPage - 1)"
                                :disabled="unitPage <= 1 || taskUnitsLoading"
                                variant="outline"
                                size="sm"
                                class="h-8 px-2.5 active:scale-[0.96]"
                            >
                                <ChevronLeft class="w-4 h-4 mr-1 stroke-[1.6]" />
                                <span>上一页</span>
                            </Button>
                            <span class="text-xs font-mono tabular-nums px-2"> {{ unitPage }} / {{ unitTotalPages }} </span>
                            <Button
                                @click="changeUnitPage(unitPage + 1)"
                                :disabled="unitPage >= unitTotalPages || taskUnitsLoading"
                                variant="outline"
                                size="sm"
                                class="h-8 px-2.5 active:scale-[0.96]"
                            >
                                <span>下一页</span>
                                <ChevronRight class="w-4 h-4 ml-1 stroke-[1.6]" />
                            </Button>
                        </div>
                    </div>
                </div>

                <!-- TAB 2: Task Snapshot & Metadata Overview -->
                <div v-else-if="activeTab === 'overview'" class="space-y-6">
                    <Card class="p-6 gap-4 border-border shadow-2xs">
                        <CardTitle class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
                            >任务基础配置与元信息</CardTitle
                        >
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs pt-1">
                            <div class="space-y-1">
                                <span class="text-muted-foreground">完整任务 ID</span>
                                <div class="flex items-center gap-2">
                                    <span class="font-mono font-semibold text-foreground break-all select-all">{{ task.id }}</span>
                                    <button
                                        @click="copyText(task.id, '已复制任务 ID')"
                                        class="text-muted-foreground hover:text-foreground cursor-pointer p-0.5 active:scale-[0.94] transition-transform"
                                    >
                                        <Copy class="w-3.5 h-3.5 stroke-[1.6]" />
                                    </button>
                                </div>
                            </div>

                            <div class="space-y-1">
                                <span class="text-muted-foreground">所属媒体库 ID</span>
                                <div class="font-mono text-foreground">{{ task.library_id || "全局 / 系统默认" }}</div>
                            </div>

                            <div class="space-y-1">
                                <span class="text-muted-foreground">发起用户 ID</span>
                                <div class="font-mono text-foreground">{{ task.owner_id || "系统触发" }}</div>
                            </div>

                            <div class="space-y-1">
                                <span class="text-muted-foreground">配置版本</span>
                                <div class="font-mono text-foreground">v{{ task.config_version }}</div>
                            </div>

                            <div class="space-y-1">
                                <span class="text-muted-foreground">创建时间</span>
                                <div class="font-mono text-foreground">{{ formatTemporalDateTime(task.create_time, locale) }}</div>
                            </div>

                            <div class="space-y-1">
                                <span class="text-muted-foreground">最后更新</span>
                                <div class="font-mono text-foreground">{{ formatTemporalDateTime(task.update_time, locale) }}</div>
                            </div>
                        </div>
                    </Card>

                    <Card class="p-6 gap-4 border-border shadow-2xs">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2">
                                <Code class="w-4 h-4 text-muted-foreground stroke-[1.6]" />
                                <CardTitle class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
                                    >执行输入参数快照 (JSON)</CardTitle
                                >
                            </div>
                            <Button
                                v-if="task.input_snapshot"
                                @click="copyText(JSON.stringify(task.input_snapshot, null, 2), '已复制参数快照')"
                                variant="outline"
                                size="sm"
                                class="h-8 text-xs font-medium cursor-pointer active:scale-[0.96]"
                            >
                                <Copy class="w-3.5 h-3.5 mr-1.5 stroke-[1.6]" />
                                <span>复制 JSON</span>
                            </Button>
                        </div>

                        <!-- Code Window for JSON -->
                        <div class="rounded-lg bg-zinc-950 border border-zinc-800/80 overflow-hidden shadow-xs">
                            <div
                                class="bg-zinc-900/80 border-b border-zinc-800/80 px-3.5 py-2 flex items-center justify-between text-[11px] text-zinc-400 font-mono select-none"
                            >
                                <div class="flex items-center gap-2">
                                    <Code class="w-3.5 h-3.5 text-zinc-400 stroke-[1.6]" />
                                    <span class="text-zinc-300 font-medium">input_snapshot.json</span>
                                </div>
                            </div>
                            <div class="p-3.5 text-xs font-mono select-text overflow-x-auto text-zinc-200">
                                <pre class="leading-relaxed">{{ JSON.stringify(task.input_snapshot || {}, null, 2) }}</pre>
                            </div>
                        </div>
                    </Card>
                </div>
            </div>
        </main>
    </div>
</template>
