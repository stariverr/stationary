<script setup lang="ts">
import { Loader2, RotateCcw, ChevronDown, X } from "@lucide/vue";
import { toast } from "vue-sonner";
import type { ApiResponse } from "@/types/api";
import type { PipelineFailure, PipelineName, PipelineStatus } from "@/types/pipeline";
import { formatTemporalRelative } from "@/utils/temporal";

const props = defineProps<{ libraryId: string }>();

const POLL_INTERVAL_MS = 5000;
/** Counts shown as plain text; failures get their own control. Zero counts are left out. */
const QUIET_COUNTS = ["queued", "running", "retrying"] as const;
/** Work that has waited this long is worth pointing out. */
const LONG_WAIT_SECONDS = 300;

const { t, locale } = useI18n();

const pipelines = ref<PipelineStatus[]>([]);
const loaded = ref(false);
const retrying = ref<PipelineName | null>(null);
const expanded = ref<PipelineName | null>(null);
const failures = ref<PipelineFailure[]>([]);
const failuresLoading = ref(false);
const minutes = (seconds: number) => Math.ceil(seconds / 60);
const isIdle = (status: PipelineStatus) => !status.scanning && QUIET_COUNTS.every((column) => status[column] === 0) && status.failed === 0;

let timer: ReturnType<typeof setInterval> | null = null;

const fetchStatus = async () => {
    const libraryId = props.libraryId;
    try {
        const res = await useApi<ApiResponse<{ pipelines: PipelineStatus[] }>>("/jobs/pipelines", { query: { library_id: libraryId } });
        if (res?.data && libraryId === props.libraryId) pipelines.value = res.data.pipelines;
    } catch (err) {
        console.error("Failed to load pipeline status:", err);
    } finally {
        loaded.value = true;
    }
};

const fetchFailures = async (pipeline: PipelineName) => {
    failuresLoading.value = true;
    try {
        const res = await useApi<ApiResponse<{ items: PipelineFailure[] }>>(`/jobs/pipelines/${props.libraryId}/${pipeline}/failures`, {
            query: { limit: 50 },
        });
        failures.value = res?.data?.items ?? [];
    } catch {
        failures.value = [];
        toast.error(t("jobs.pipelines.failures_error"));
    } finally {
        failuresLoading.value = false;
    }
};

const toggleFailures = async (pipeline: PipelineName) => {
    if (expanded.value === pipeline) {
        expanded.value = null;
        return;
    }
    expanded.value = pipeline;
    failures.value = [];
    await fetchFailures(pipeline);
};

const retryFailed = async (pipeline: PipelineName) => {
    retrying.value = pipeline;
    try {
        const res = await useApi<ApiResponse<{ retried: number }>>(`/jobs/pipelines/${props.libraryId}/${pipeline}/retry-failed`, {
            method: "POST",
        });
        toast.success(t("jobs.pipelines.retry_done", { count: res?.data?.retried ?? 0 }));
        await fetchStatus();
    } catch {
        toast.error(t("jobs.pipelines.retry_error"));
    } finally {
        retrying.value = null;
    }
};

watch(
    () => props.libraryId,
    () => {
        pipelines.value = [];
        expanded.value = null;
        loaded.value = false;
        fetchStatus();
    },
);

onMounted(() => {
    fetchStatus();
    timer = setInterval(fetchStatus, POLL_INTERVAL_MS);
});
onUnmounted(() => {
    if (timer) clearInterval(timer);
});
</script>

<template>
    <section class="shrink-0 border-b border-zinc-200/80 bg-white text-xs" :aria-label="$t('jobs.pipelines.label')">
        <div class="px-4 md:px-6 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-2">
            <span class="font-semibold text-zinc-500">{{ $t("jobs.pipelines.label") }}</span>

            <template v-if="!loaded">
                <span v-for="n in 3" :key="n" class="h-3 w-28 rounded bg-zinc-100 animate-pulse motion-reduce:animate-none" />
            </template>

            <template v-else>
                <div v-for="status in pipelines" :key="status.pipeline" class="flex items-center gap-2 min-w-0 tabular-nums">
                    <span class="font-semibold text-zinc-800">{{ $t(`jobs.pipelines.names.${status.pipeline}`) }}</span>
                    <span v-if="isIdle(status)" class="text-zinc-500">{{ $t("jobs.pipelines.up_to_date") }}</span>
                    <span v-if="status.scanning" class="flex items-center gap-1 text-zinc-500">
                        <Loader2 class="size-3 animate-spin motion-reduce:animate-none" />
                        {{ $t("jobs.pipelines.scanning") }}
                    </span>
                    <template v-for="column in QUIET_COUNTS" :key="column">
                        <span v-if="status[column] > 0" class="text-zinc-500">
                            {{ $t(`jobs.pipelines.count_${column}`, { count: status[column] }) }}
                        </span>
                    </template>
                    <span v-if="status.blocked_seconds > 0" class="font-medium text-amber-700">
                        {{ $t("jobs.pipelines.blocked", { minutes: minutes(status.blocked_seconds) }) }}
                    </span>
                    <span v-if="status.oldest_seconds >= LONG_WAIT_SECONDS" class="text-zinc-500">
                        {{ $t("jobs.pipelines.oldest", { minutes: minutes(status.oldest_seconds) }) }}
                    </span>
                    <template v-if="status.failed > 0">
                        <button
                            class="flex items-center gap-0.5 rounded-sm font-medium text-red-600 hover:text-red-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                            :aria-expanded="expanded === status.pipeline"
                            @click="toggleFailures(status.pipeline)"
                        >
                            {{ $t("jobs.pipelines.count_failed", { count: status.failed }) }}
                            <ChevronDown
                                class="size-3 transition-transform duration-150"
                                :class="expanded === status.pipeline ? 'rotate-180' : ''"
                            />
                        </button>
                        <button
                            class="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 cursor-pointer disabled:opacity-50 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                            :disabled="retrying === status.pipeline"
                            @click="retryFailed(status.pipeline)"
                        >
                            <RotateCcw class="size-3" :class="{ 'animate-spin': retrying === status.pipeline }" />
                            {{ $t("jobs.pipelines.retry_failed") }}
                        </button>
                    </template>
                </div>
            </template>
        </div>

        <div v-if="expanded" class="border-t border-zinc-100 bg-zinc-50/60">
            <div class="h-9 px-4 md:px-6 flex items-center justify-between gap-3">
                <h2 class="font-semibold text-zinc-700">
                    {{ $t("jobs.pipelines.failures_title", { name: $t(`jobs.pipelines.names.${expanded}`) }) }}
                </h2>
                <button
                    class="size-6 rounded-md flex items-center justify-center text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                    :aria-label="$t('jobs.pipelines.hide_failures')"
                    @click="expanded = null"
                >
                    <X class="size-3.5" />
                </button>
            </div>
            <div class="max-h-56 overflow-y-auto">
                <div v-if="failuresLoading" class="px-4 md:px-6 pb-3 space-y-2 animate-pulse motion-reduce:animate-none">
                    <div v-for="n in 3" :key="n" class="h-3 w-2/3 rounded bg-zinc-200/60" />
                </div>
                <p v-else-if="failures.length === 0" class="px-4 md:px-6 pb-3 text-zinc-500">{{ $t("jobs.pipelines.no_failures") }}</p>
                <ul v-else>
                    <li
                        v-for="failure in failures"
                        :key="failure.subject_id"
                        class="px-4 md:px-6 py-2 border-t border-zinc-100 select-text"
                    >
                        <div class="flex items-baseline justify-between gap-3">
                            <span class="font-medium text-zinc-800 break-all">{{ failure.label || failure.subject_id }}</span>
                            <span v-if="failure.time" class="shrink-0 text-zinc-500 tabular-nums">
                                {{ formatTemporalRelative(failure.time, locale) }}
                            </span>
                        </div>
                        <p class="mt-0.5 text-zinc-500 break-words">{{ failure.error }}</p>
                    </li>
                </ul>
            </div>
        </div>
    </section>
</template>
