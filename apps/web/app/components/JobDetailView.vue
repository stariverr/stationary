<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { RotateCcw, Play, Pause, XCircle, Copy, MoreHorizontal, Code, X, Inbox, ChevronLeft, ChevronRight } from "@lucide/vue";
import { Button } from "@/components/ui/button";
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
import TaskStatusLabel from "@/components/jobs/TaskStatusLabel.vue";

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
    /** An action on this task is in flight. */
    busy: boolean;
}>();

const emit = defineEmits<{
    (e: "close"): void;
    (e: "taskChanged"): void;
    (e: "retryFailedUnits", taskId: string): void;
    (e: "pauseTask", taskId: string): void;
    (e: "resumeTask", taskId: string): void;
    (e: "cancelTask", taskId: string): void;
}>();

const UNIT_FILTERS = ["ALL", "FAILED", "RUNNING", "PENDING", "SUCCEEDED", "CANCELLED"] as const;
type UnitFilter = (typeof UNIT_FILTERS)[number];
const UNIT_PAGE_SIZE = 25;
/** Errors longer than this start collapsed. */
const ERROR_PREVIEW_CHARS = 180;
const ACTIVE_STATUSES = ["RUNNING", "DISCOVERING"];
const CANCELLABLE_STATUSES = ["RUNNING", "DISCOVERING", "PAUSED", "FAILED"];

const { t, locale } = useI18n();

const units = ref<TaskUnitItem[]>([]);
const unitsLoading = ref(false);
const unitsFailed = ref(false);
const unitFilter = ref<UnitFilter>("ALL");
const unitCounts = ref<Record<string, number>>({});
const unitPage = ref(1);
const unitTotal = ref(0);
const unitTotalPages = ref(1);
const unitActionId = ref<string | null>(null);
const expandedErrorIds = ref<string[]>([]);

function isApiSuccess(res: any): boolean {
    return Boolean(res && (res.success || res.code === 0 || res.code === "SUCCESS"));
}

function copyText(text: string, message: string) {
    navigator.clipboard.writeText(text);
    toast.success(message);
}

function formatTaskType(type: string): string {
    const key = `jobs.task_types.${type}`;
    const translated = t(key);
    return translated !== key ? translated : type;
}

const scope = computed(() => {
    const mediaIds = props.task.input_snapshot?.media_ids;
    return Array.isArray(mediaIds) ? t("jobs.tasks.scope_media", { count: mediaIds.length }) : t("jobs.tasks.scope_library");
});

const progress = computed(() => {
    const { total_units, succeeded_units, failed_units, cancelled_units, processed_units, percentage } = props.task.progress;
    return {
        total: total_units,
        succeeded: succeeded_units,
        failed: failed_units,
        cancelled: cancelled_units,
        processed: processed_units,
        percentage,
        remaining: Math.max(0, total_units - processed_units),
    };
});

function share(value: number): string {
    return progress.value.total ? `${Math.min(100, (value / progress.value.total) * 100)}%` : "0%";
}

function unitFilterCount(filter: UnitFilter): number {
    if (filter === "ALL") return Object.values(unitCounts.value).reduce((sum, count) => sum + count, 0);
    return unitCounts.value[filter] ?? 0;
}

const visibleUnitFilters = computed(() =>
    UNIT_FILTERS.filter((filter) => filter === "ALL" || filter === unitFilter.value || unitFilterCount(filter) > 0),
);

const unitRange = computed(() => ({
    from: unitTotal.value === 0 ? 0 : (unitPage.value - 1) * UNIT_PAGE_SIZE + 1,
    to: Math.min(unitPage.value * UNIT_PAGE_SIZE, unitTotal.value),
    total: unitTotal.value,
}));

function isLongError(error: string): boolean {
    return error.length > ERROR_PREVIEW_CHARS || error.split("\n").length > 3;
}

function toggleError(unitId: string) {
    expandedErrorIds.value = expandedErrorIds.value.includes(unitId)
        ? expandedErrorIds.value.filter((id) => id !== unitId)
        : [...expandedErrorIds.value, unitId];
}

async function fetchUnits(isSilent = false) {
    const taskId = props.task.id;
    if (!isSilent) unitsLoading.value = true;
    try {
        const res: any = await useApi(`/jobs/${taskId}/items`, {
            query: {
                page: unitPage.value,
                limit: UNIT_PAGE_SIZE,
                status: unitFilter.value === "ALL" ? undefined : unitFilter.value,
            },
        });
        if (!isApiSuccess(res) || !res.data) throw new Error(res?.message);
        if (props.task.id !== taskId) return;

        units.value = res.data.items || [];
        unitCounts.value = res.data.counts || {};
        unitTotal.value = res.data.pagination?.total || 0;
        unitTotalPages.value = Math.max(1, res.data.pagination?.total_pages || 1);
        unitsFailed.value = false;
        if (unitPage.value > unitTotalPages.value) {
            unitPage.value = unitTotalPages.value;
            await fetchUnits(isSilent);
        }
    } catch (e) {
        console.error("Failed to fetch task units:", e);
        unitsFailed.value = true;
    } finally {
        if (!isSilent) unitsLoading.value = false;
    }
}

async function retryUnit(unitId: string) {
    unitActionId.value = unitId;
    try {
        const res: any = await useApi(`/jobs/units/${unitId}/retry`, { method: "POST" });
        if (!isApiSuccess(res)) throw new Error(res?.message);
        toast.success(t("jobs.inspector.unit_retried"));
        emit("taskChanged");
        await fetchUnits(true);
    } catch (e) {
        toast.error(t("jobs.toast.action_failed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
        unitActionId.value = null;
    }
}

function changeUnitPage(next: number) {
    unitPage.value = next;
    fetchUnits();
}

watch(
    () => props.task.id,
    () => {
        units.value = [];
        unitCounts.value = {};
        unitPage.value = 1;
        unitFilter.value = "ALL";
        expandedErrorIds.value = [];
        fetchUnits();
    },
    { immediate: true },
);

watch(unitFilter, () => {
    unitPage.value = 1;
    fetchUnits();
});

defineExpose({
    /** Re-reads the current unit page without a loading state; the jobs page calls this on its poll. */
    refreshUnits: () => fetchUnits(true),
});
</script>

<template>
    <div class="h-full flex flex-col bg-white">
        <header class="h-14 ps-4 pe-2 border-b border-zinc-200/80 flex items-center justify-between gap-2 shrink-0">
            <div class="min-w-0">
                <h2 class="text-sm font-bold tracking-tight text-zinc-900 truncate">{{ scope }}</h2>
                <p class="mt-0.5 flex items-center gap-1.5 text-xs font-medium min-w-0">
                    <TaskStatusLabel :status="task.status" />
                    <span class="text-zinc-300" aria-hidden="true">·</span>
                    <span class="truncate text-zinc-500">{{ formatTaskType(task.type) }}</span>
                </p>
            </div>

            <div class="flex items-center gap-1 shrink-0">
                <Button
                    v-if="task.failed_units > 0"
                    size="sm"
                    class="h-8 gap-1.5 px-2.5 text-xs font-bold rounded-lg active:scale-[0.96]"
                    :disabled="busy"
                    @click="emit('retryFailedUnits', task.id)"
                >
                    <RotateCcw class="w-3.5 h-3.5" :class="{ 'animate-spin': busy }" />
                    {{ $t("jobs.inspector.retry_failed", { count: task.failed_units }) }}
                </Button>
                <Button
                    v-else-if="ACTIVE_STATUSES.includes(task.status)"
                    variant="outline"
                    size="sm"
                    class="h-8 gap-1.5 px-2.5 text-xs font-bold rounded-lg active:scale-[0.96]"
                    :disabled="busy"
                    @click="emit('pauseTask', task.id)"
                >
                    <Pause class="w-3.5 h-3.5" />
                    {{ $t("jobs.actions.pause") }}
                </Button>
                <Button
                    v-else-if="task.status === 'PAUSED'"
                    variant="outline"
                    size="sm"
                    class="h-8 gap-1.5 px-2.5 text-xs font-bold rounded-lg active:scale-[0.96]"
                    :disabled="busy"
                    @click="emit('resumeTask', task.id)"
                >
                    <Play class="w-3.5 h-3.5" />
                    {{ $t("jobs.actions.resume") }}
                </Button>

                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            class="text-zinc-500 hover:text-zinc-900 data-[state=open]:bg-zinc-100"
                            :aria-label="$t('jobs.inspector.more')"
                        >
                            <MoreHorizontal class="w-4 h-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="w-52">
                        <DropdownMenuItem
                            v-if="task.failed_units > 0 && ACTIVE_STATUSES.includes(task.status)"
                            @click="emit('pauseTask', task.id)"
                        >
                            <Pause />
                            {{ $t("jobs.actions.pause") }}
                        </DropdownMenuItem>
                        <DropdownMenuItem v-if="task.failed_units > 0 && task.status === 'PAUSED'" @click="emit('resumeTask', task.id)">
                            <Play />
                            {{ $t("jobs.actions.resume") }}
                        </DropdownMenuItem>
                        <DropdownMenuItem @click="copyText(task.id, $t('jobs.tasks.id_copied'))">
                            <Copy />
                            {{ $t("jobs.tasks.copy_id") }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            v-if="task.input_snapshot"
                            @click="copyText(JSON.stringify(task.input_snapshot, null, 2), $t('jobs.inspector.input_copied'))"
                        >
                            <Code />
                            {{ $t("jobs.inspector.copy_input") }}
                        </DropdownMenuItem>
                        <template v-if="CANCELLABLE_STATUSES.includes(task.status)">
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" @click="emit('cancelTask', task.id)">
                                <XCircle />
                                {{ $t("jobs.actions.cancel") }}
                            </DropdownMenuItem>
                        </template>
                    </DropdownMenuContent>
                </DropdownMenu>

                <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-zinc-500 hover:text-zinc-900"
                    :aria-label="$t('jobs.inspector.close')"
                    @click="emit('close')"
                >
                    <X class="w-4 h-4" />
                </Button>
            </div>
        </header>

        <div class="flex-1 min-h-0 overflow-y-auto">
            <!-- Summary: where the task stands, why it stopped, when it ran -->
            <section class="px-4 py-4 space-y-4 border-b border-zinc-200/80">
                <div class="space-y-2">
                    <p class="flex items-baseline justify-between gap-3 text-xs">
                        <span class="text-zinc-600">
                            {{ $t("jobs.inspector.processed", { done: progress.processed, total: progress.total }) }}
                        </span>
                        <span class="text-sm font-semibold text-zinc-900 tabular-nums">{{ progress.percentage }}%</span>
                    </p>
                    <div
                        class="h-1.5 w-full rounded-full bg-zinc-100 overflow-hidden flex"
                        role="progressbar"
                        :aria-valuenow="progress.percentage"
                        aria-valuemin="0"
                        aria-valuemax="100"
                    >
                        <div class="h-full bg-zinc-800 transition-[width] duration-200" :style="{ width: share(progress.succeeded) }" />
                        <div class="h-full bg-red-500 transition-[width] duration-200" :style="{ width: share(progress.failed) }" />
                        <div class="h-full bg-zinc-300 transition-[width] duration-200" :style="{ width: share(progress.cancelled) }" />
                    </div>
                    <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                        <li class="flex items-center gap-1.5 text-zinc-600">
                            <span class="size-1.5 rounded-full bg-zinc-800" aria-hidden="true" />
                            {{ $t("jobs.inspector.legend_succeeded", { count: progress.succeeded }) }}
                        </li>
                        <li v-if="progress.failed > 0" class="flex items-center gap-1.5 font-medium text-red-600">
                            <span class="size-1.5 rounded-full bg-red-500" aria-hidden="true" />
                            {{ $t("jobs.inspector.legend_failed", { count: progress.failed }) }}
                        </li>
                        <li v-if="progress.cancelled > 0" class="flex items-center gap-1.5 text-zinc-600">
                            <span class="size-1.5 rounded-full bg-zinc-300" aria-hidden="true" />
                            {{ $t("jobs.inspector.legend_cancelled", { count: progress.cancelled }) }}
                        </li>
                        <li v-if="progress.remaining > 0" class="flex items-center gap-1.5 text-zinc-600">
                            <span class="size-1.5 rounded-full bg-zinc-100 ring-1 ring-zinc-300" aria-hidden="true" />
                            {{ $t("jobs.inspector.legend_remaining", { count: progress.remaining }) }}
                        </li>
                    </ul>
                </div>

                <div v-if="task.last_error" class="rounded-lg border border-red-200 bg-red-50/70 px-3 py-2.5 text-xs">
                    <div class="flex items-center justify-between gap-2">
                        <h3 class="font-semibold text-red-700">{{ $t("jobs.inspector.last_error") }}</h3>
                        <button
                            class="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-red-700 hover:bg-red-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                            @click="copyText(task.last_error, $t('jobs.inspector.error_copied'))"
                        >
                            <Copy class="w-3 h-3" />
                            {{ $t("jobs.inspector.copy_error") }}
                        </button>
                    </div>
                    <p class="mt-1 max-h-40 overflow-y-auto text-red-800 leading-relaxed whitespace-pre-wrap break-words select-text">
                        {{ task.last_error }}
                    </p>
                </div>

                <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                    <dt class="text-zinc-500">{{ $t("jobs.inspector.created_at") }}</dt>
                    <dd class="text-zinc-800 tabular-nums">{{ formatTemporalDateTime(task.create_time, locale) }}</dd>
                    <template v-if="task.complete_time">
                        <dt class="text-zinc-500">{{ $t("jobs.inspector.completed_at") }}</dt>
                        <dd class="text-zinc-800 tabular-nums">
                            {{ formatTemporalDateTime(task.complete_time, locale) }}
                            <span class="text-zinc-500">· {{ formatTemporalDuration(task.create_time, task.complete_time, locale) }}</span>
                        </dd>
                    </template>
                    <template v-else>
                        <dt class="text-zinc-500">{{ $t("jobs.inspector.updated_at") }}</dt>
                        <dd class="text-zinc-800 tabular-nums">{{ formatTemporalRelative(task.update_time, locale) }}</dd>
                    </template>
                    <dt class="text-zinc-500">{{ $t("jobs.inspector.task_id") }}</dt>
                    <dd class="flex items-center gap-1 min-w-0">
                        <span class="font-mono text-zinc-800 truncate select-text">{{ task.id }}</span>
                        <button
                            class="size-6 shrink-0 rounded-md flex items-center justify-center text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                            :aria-label="$t('jobs.tasks.copy_id')"
                            @click="copyText(task.id, $t('jobs.tasks.id_copied'))"
                        >
                            <Copy class="w-3 h-3" />
                        </button>
                    </dd>
                </dl>
            </section>

            <!-- Units -->
            <section :aria-label="$t('jobs.inspector.items')">
                <div
                    class="sticky top-0 z-10 h-11 px-4 border-b border-zinc-200/80 bg-white flex items-center gap-4 overflow-x-auto scrollbar-none"
                    role="tablist"
                    :aria-label="$t('jobs.inspector.unit_filter_label')"
                >
                    <button
                        v-for="filter in visibleUnitFilters"
                        :key="filter"
                        role="tab"
                        :aria-selected="unitFilter === filter"
                        class="relative h-full px-0.5 text-xs font-bold tracking-tight flex items-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-inset"
                        :class="unitFilter === filter ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'"
                        @click="unitFilter = filter"
                    >
                        {{ $t(`jobs.tabs.${filter.toLowerCase()}`) }}
                        <span class="tabular-nums" :class="unitFilter === filter ? 'text-zinc-600' : 'text-zinc-500'">
                            {{ unitFilterCount(filter) }}
                        </span>
                        <span v-if="unitFilter === filter" class="absolute bottom-0 inset-x-0 h-[2px] bg-zinc-800 rounded-full" />
                    </button>
                </div>

                <div v-if="unitsLoading && units.length === 0" class="animate-pulse motion-reduce:animate-none">
                    <div v-for="n in 5" :key="n" class="px-4 py-3.5 border-b border-zinc-100 space-y-2">
                        <div class="h-3 w-2/3 rounded bg-zinc-100" />
                        <div class="h-2.5 w-1/3 rounded bg-zinc-100" />
                    </div>
                </div>

                <p v-else-if="unitsFailed && units.length === 0" class="px-4 py-8 text-center text-xs text-zinc-500">
                    {{ $t("jobs.inspector.units_failed") }}
                </p>

                <div v-else-if="units.length === 0" class="px-6 py-10 flex flex-col items-center gap-3 text-center">
                    <div class="w-10 h-10 rounded-xl bg-zinc-50 border border-zinc-200 flex items-center justify-center">
                        <Inbox class="w-4 h-4 text-zinc-400" />
                    </div>
                    <div class="space-y-1">
                        <p class="text-xs font-semibold text-zinc-800">
                            {{ unitFilter === "ALL" ? $t("jobs.inspector.no_units") : $t("jobs.inspector.no_units_filtered") }}
                        </p>
                        <p v-if="unitFilter === 'ALL'" class="text-xs text-zinc-500 text-pretty">
                            {{ $t("jobs.inspector.no_units_desc") }}
                        </p>
                    </div>
                </div>

                <ul v-else>
                    <li v-for="unit in units" :key="unit.id" class="px-4 py-3 border-b border-zinc-100 text-xs">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0 space-y-1">
                                <p class="font-mono text-zinc-800 break-all select-text">{{ unit.unit_key }}</p>
                                <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-zinc-500 tabular-nums">
                                    <TaskStatusLabel :status="unit.status" class="font-medium" />
                                    <span v-if="unit.attempt_count > 0">
                                        {{ $t("jobs.inspector.attempts", { attempt: unit.attempt_count, max: unit.max_attempts }) }}
                                    </span>
                                    <span v-if="unit.complete_time">{{ formatTemporalRelative(unit.complete_time, locale) }}</span>
                                </p>
                            </div>
                            <Button
                                v-if="unit.status === 'FAILED'"
                                variant="outline"
                                size="sm"
                                class="h-7 gap-1 px-2 text-xs font-bold rounded-md shrink-0 active:scale-[0.96]"
                                :disabled="unitActionId === unit.id"
                                @click="retryUnit(unit.id)"
                            >
                                <RotateCcw class="w-3 h-3" :class="{ 'animate-spin': unitActionId === unit.id }" />
                                {{ $t("jobs.inspector.retry_unit") }}
                            </Button>
                        </div>

                        <div v-if="unit.last_error" class="mt-2">
                            <div class="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-2">
                                <pre
                                    class="font-mono text-[11px] leading-relaxed text-zinc-700 whitespace-pre-wrap break-words select-text"
                                    :class="{ 'line-clamp-3': isLongError(unit.last_error) && !expandedErrorIds.includes(unit.id) }"
                                    >{{ unit.last_error }}</pre>
                            </div>
                            <div class="mt-1 flex items-center gap-3">
                                <button
                                    v-if="isLongError(unit.last_error)"
                                    class="rounded-sm font-medium text-zinc-600 hover:text-zinc-900 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                                    :aria-expanded="expandedErrorIds.includes(unit.id)"
                                    @click="toggleError(unit.id)"
                                >
                                    {{
                                        expandedErrorIds.includes(unit.id) ? $t("jobs.inspector.show_less") : $t("jobs.inspector.show_more")
                                    }}
                                </button>
                                <button
                                    class="rounded-sm font-medium text-zinc-600 hover:text-zinc-900 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                                    @click="copyText(unit.last_error, $t('jobs.inspector.error_copied'))"
                                >
                                    {{ $t("jobs.inspector.copy_error") }}
                                </button>
                            </div>
                        </div>
                    </li>
                </ul>
            </section>
        </div>

        <nav
            v-if="unitTotalPages > 1"
            class="h-12 px-4 border-t border-zinc-200/80 flex items-center justify-between gap-3 shrink-0 text-xs"
            :aria-label="$t('jobs.inspector.unit_pages')"
        >
            <span class="text-zinc-500 font-medium tabular-nums">{{ $t("jobs.pagination.range", unitRange) }}</span>
            <div class="flex items-center gap-1">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-zinc-600"
                    :disabled="unitPage <= 1 || unitsLoading"
                    :aria-label="$t('jobs.pagination.prev')"
                    @click="changeUnitPage(unitPage - 1)"
                >
                    <ChevronLeft class="w-4 h-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-zinc-600"
                    :disabled="unitPage >= unitTotalPages || unitsLoading"
                    :aria-label="$t('jobs.pagination.next')"
                    @click="changeUnitPage(unitPage + 1)"
                >
                    <ChevronRight class="w-4 h-4" />
                </Button>
            </div>
        </nav>
    </div>
</template>
