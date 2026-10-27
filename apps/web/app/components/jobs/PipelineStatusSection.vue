<script setup lang="ts">
import { Loader2, RotateCcw, ChevronDown } from "@lucide/vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApiResponse } from "@/types/api";
import type { PipelineFailure, PipelineName, PipelineStatus } from "@/types/pipeline";
import { formatTemporalRelative } from "@/utils/temporal";

interface LibraryPipelines {
    library_id: string;
    name: string;
    pipelines: PipelineStatus[];
}

const POLL_INTERVAL_MS = 5000;

const { t, locale } = useI18n();

const libraries = ref<LibraryPipelines[]>([]);
const loaded = ref(false);
const retryingKey = ref<string | null>(null);
const expandedKey = ref<string | null>(null);
const failures = ref<PipelineFailure[]>([]);
const failuresLoading = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const rowKey = (libraryId: string, pipeline: PipelineName) => `${libraryId}/${pipeline}`;

const fetchStatus = async () => {
    try {
        const res = await useApi<ApiResponse<{ libraries: LibraryPipelines[] }>>("/jobs/pipelines");
        if (res?.data) libraries.value = res.data.libraries;
    } catch (err) {
        console.error("Failed to load pipeline status:", err);
    } finally {
        loaded.value = true;
    }
};

const fetchFailures = async (libraryId: string, pipeline: PipelineName) => {
    failuresLoading.value = true;
    try {
        const res = await useApi<ApiResponse<{ items: PipelineFailure[] }>>(`/jobs/pipelines/${libraryId}/${pipeline}/failures`, {
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

const toggleFailures = async (libraryId: string, pipeline: PipelineName) => {
    const key = rowKey(libraryId, pipeline);
    if (expandedKey.value === key) {
        expandedKey.value = null;
        return;
    }
    expandedKey.value = key;
    failures.value = [];
    await fetchFailures(libraryId, pipeline);
};

const retryFailed = async (libraryId: string, pipeline: PipelineName) => {
    retryingKey.value = rowKey(libraryId, pipeline);
    try {
        const res = await useApi<ApiResponse<{ retried: number }>>(`/jobs/pipelines/${libraryId}/${pipeline}/retry-failed`, {
            method: "POST",
        });
        toast.success(t("jobs.pipelines.retry_done", { count: res?.data?.retried ?? 0 }));
        await fetchStatus();
    } catch {
        toast.error(t("jobs.pipelines.retry_error"));
    } finally {
        retryingKey.value = null;
    }
};

onMounted(() => {
    fetchStatus();
    timer = setInterval(fetchStatus, POLL_INTERVAL_MS);
});
onUnmounted(() => {
    if (timer) clearInterval(timer);
});
</script>

<template>
    <Card class="py-0 gap-0">
        <CardHeader class="px-5 pt-5 pb-3">
            <CardTitle class="text-sm font-semibold">{{ $t("jobs.pipelines.title") }}</CardTitle>
            <CardDescription class="text-xs">{{ $t("jobs.pipelines.desc") }}</CardDescription>
        </CardHeader>
        <CardContent class="px-0 pb-2">
            <div v-if="!loaded" class="flex items-center gap-2 px-5 py-4 text-xs text-muted-foreground">
                <Loader2 class="size-3.5 animate-spin" />
                {{ $t("jobs.pipelines.loading") }}
            </div>
            <p v-else-if="libraries.length === 0" class="px-5 py-4 text-xs text-muted-foreground">{{ $t("jobs.pipelines.empty") }}</p>
            <div v-else class="overflow-x-auto">
                <table class="w-full text-xs tabular-nums">
                    <thead class="text-muted-foreground">
                        <tr class="border-b border-border">
                            <th class="px-5 py-2 text-left font-medium">{{ $t("jobs.pipelines.library") }}</th>
                            <th class="px-3 py-2 text-left font-medium">{{ $t("jobs.pipelines.pipeline") }}</th>
                            <th class="px-3 py-2 text-right font-medium">{{ $t("jobs.pipelines.queued") }}</th>
                            <th class="px-3 py-2 text-right font-medium">{{ $t("jobs.pipelines.running") }}</th>
                            <th class="px-3 py-2 text-right font-medium">{{ $t("jobs.pipelines.retrying") }}</th>
                            <th class="px-3 py-2 text-right font-medium">{{ $t("jobs.pipelines.failed") }}</th>
                            <th class="px-5 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="library in libraries" :key="library.library_id">
                            <template v-for="(status, index) in library.pipelines" :key="status.pipeline">
                                <tr class="border-b border-border/60">
                                    <td class="px-5 py-2 font-medium text-foreground">{{ index === 0 ? library.name : "" }}</td>
                                    <td class="px-3 py-2">
                                        <span class="flex items-center gap-1.5">
                                            {{ $t(`jobs.pipelines.names.${status.pipeline}`) }}
                                            <span v-if="status.scanning" class="flex items-center gap-1 text-muted-foreground">
                                                <Loader2 class="size-3 animate-spin" />
                                                {{ $t("jobs.pipelines.scanning") }}
                                            </span>
                                        </span>
                                    </td>
                                    <td class="px-3 py-2 text-right">{{ status.queued }}</td>
                                    <td class="px-3 py-2 text-right">{{ status.running }}</td>
                                    <td class="px-3 py-2 text-right">{{ status.retrying }}</td>
                                    <td class="px-3 py-2 text-right" :class="status.failed > 0 ? 'text-destructive font-semibold' : ''">
                                        {{ status.failed }}
                                    </td>
                                    <td class="px-5 py-2">
                                        <div v-if="status.failed > 0" class="flex items-center justify-end gap-1.5">
                                            <Button variant="ghost" size="xs" @click="toggleFailures(library.library_id, status.pipeline)">
                                                {{ $t("jobs.pipelines.show_failures") }}
                                                <ChevronDown
                                                    class="size-3 transition-transform"
                                                    :class="expandedKey === rowKey(library.library_id, status.pipeline) ? 'rotate-180' : ''"
                                                />
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="xs"
                                                :disabled="retryingKey === rowKey(library.library_id, status.pipeline)"
                                                @click="retryFailed(library.library_id, status.pipeline)"
                                            >
                                                <Loader2
                                                    v-if="retryingKey === rowKey(library.library_id, status.pipeline)"
                                                    class="size-3 animate-spin"
                                                />
                                                <RotateCcw v-else class="size-3" />
                                                {{ $t("jobs.pipelines.retry_failed") }}
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                                <tr
                                    v-if="expandedKey === rowKey(library.library_id, status.pipeline)"
                                    class="border-b border-border/60 bg-muted/40"
                                >
                                    <td colspan="7" class="px-5 py-3">
                                        <div v-if="failuresLoading" class="flex items-center gap-2 text-muted-foreground">
                                            <Loader2 class="size-3.5 animate-spin" />
                                            {{ $t("jobs.pipelines.loading") }}
                                        </div>
                                        <ul v-else class="space-y-1.5">
                                            <li
                                                v-for="failure in failures"
                                                :key="failure.subject_id"
                                                class="flex flex-wrap gap-x-3 gap-y-0.5"
                                            >
                                                <span class="font-medium text-foreground">{{ failure.label || failure.subject_id }}</span>
                                                <span class="break-all text-destructive">{{ failure.error }}</span>
                                                <span v-if="failure.time" class="text-muted-foreground">{{
                                                    formatTemporalRelative(failure.time, locale)
                                                }}</span>
                                            </li>
                                        </ul>
                                    </td>
                                </tr>
                            </template>
                        </template>
                    </tbody>
                </table>
            </div>
        </CardContent>
    </Card>
</template>
