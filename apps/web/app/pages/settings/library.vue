<script setup lang="ts">
import { toast } from "vue-sonner";
import { Loader2, Pause, RefreshCw, RotateCcw } from "@lucide/vue";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import LibraryAiBindings from "@/components/settings/LibraryAiBindings.vue";
import { useLibraryStore } from "@/stores/library";
import type { ApiResponse } from "@/types/api";
import type { LibraryPipelines, PipelineStatus } from "@/types/pipeline";

interface FetchErrorLike {
    data?: { message?: string };
}

const { t } = useI18n();
const libraryStore = useLibraryStore();

const selectedLibraryId = ref(libraryStore.activeLibraryId || libraryStore.libraries[0]?.id || "");

const previewStatus = ref<PipelineStatus | null>(null);
const libraryPaused = ref(false);
const isRegenerating = ref(false);
const isRetryingPreviews = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const isPreviewBusy = computed(() => previewStatus.value !== null && (previewStatus.value.scanning || previewStatus.value.queued > 0));

const stopPolling = () => {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
};

const startPolling = (libId: string) => {
    stopPolling();
    pollTimer = setInterval(() => fetchPreviewStatus(libId), 2000);
};

onUnmounted(stopPolling);

const fetchPreviewStatus = async (libId: string) => {
    try {
        const statusRes = await useApi<ApiResponse<LibraryPipelines>>("/jobs/pipelines", {
            query: { library_id: libId },
        });

        if (statusRes?.data && libId === selectedLibraryId.value) {
            previewStatus.value = statusRes.data.pipelines.find((item) => item.pipeline === "preview") ?? null;
            libraryPaused.value = statusRes.data.paused;
            if (isPreviewBusy.value) {
                if (!pollTimer) startPolling(libId);
            } else {
                stopPolling();
            }
        }
    } catch (e) {
        console.error("Failed to fetch preview status:", e);
    }
};

watch(
    selectedLibraryId,
    (libId) => {
        stopPolling();
        previewStatus.value = null;
        if (libId) fetchPreviewStatus(libId);
    },
    { immediate: true },
);

const regeneratePreviews = async () => {
    const libId = selectedLibraryId.value;
    if (!libId) return;
    isRegenerating.value = true;
    try {
        const res = await useApi<ApiResponse<{ library_id: string }>>(`/library/${libId}/preview-jobs`, { method: "POST", body: {} });
        if (!res?.success) throw new Error(res?.message || "Server error");
        toast.success(t("settings.library_config.preview_regenerate_success"));
        await fetchPreviewStatus(libId);
        startPolling(libId);
    } catch (err) {
        console.error("Failed to regenerate previews", err);
        toast.error(t("settings.library_config.preview_regenerate_error"), {
            description: (err as FetchErrorLike)?.data?.message || "Unknown error occurred",
        });
    } finally {
        isRegenerating.value = false;
    }
};

const retryFailedPreviews = async () => {
    const libId = selectedLibraryId.value;
    if (!libId) return;
    isRetryingPreviews.value = true;
    try {
        const res = await useApi<ApiResponse<{ retried: number }>>(`/jobs/pipelines/${libId}/preview/retry-failed`, { method: "POST" });
        toast.success(t("settings.library_config.preview_retry_done", { count: res?.data?.retried ?? 0 }));
        await fetchPreviewStatus(libId);
    } catch {
        toast.error(t("settings.library_config.preview_retry_error"));
    } finally {
        isRetryingPreviews.value = false;
    }
};
</script>

<template>
    <Card class="py-0">
        <CardContent class="grid gap-6 p-5">
            <div class="grid gap-2">
                <Label>{{ $t("settings.library_config.library_select") }}</Label>
                <Select v-model="selectedLibraryId">
                    <SelectTrigger class="w-full sm:w-72">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectItem v-for="lib in libraryStore.libraries" :key="lib.id" :value="lib.id">
                                {{ lib.name }}
                            </SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
            </div>

            <template v-if="selectedLibraryId">
                <Separator />

                <div class="space-y-3">
                    <div class="flex items-center justify-between gap-3">
                        <div class="space-y-0.5">
                            <h5 class="text-sm font-semibold">{{ $t("settings.library_config.preview_regenerate_title") }}</h5>
                            <p class="text-xs text-muted-foreground">{{ $t("settings.library_config.preview_regenerate_desc") }}</p>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            class="shrink-0"
                            :disabled="isRegenerating || isPreviewBusy"
                            @click="regeneratePreviews"
                        >
                            <Loader2 v-if="isRegenerating || isPreviewBusy" class="size-3.5 animate-spin" />
                            <RefreshCw v-else class="size-3.5" />
                            {{
                                isRegenerating || isPreviewBusy
                                    ? $t("settings.library_config.preview_regenerate_loading")
                                    : $t("settings.library_config.preview_regenerate_btn")
                            }}
                        </Button>
                    </div>

                    <div
                        v-if="previewStatus && (isPreviewBusy || previewStatus.failed > 0)"
                        class="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/50 p-3 text-xs"
                    >
                        <span v-if="isPreviewBusy" class="flex items-center gap-1.5 font-semibold">
                            <Pause v-if="libraryPaused" class="size-3.5 shrink-0" />
                            <Loader2 v-else class="size-3.5 shrink-0 animate-spin" />
                            <span v-if="libraryPaused">{{ $t("jobs.pipelines.paused") }}</span>
                            <span v-if="previewStatus.queued > 0" class="tabular-nums">{{
                                $t("settings.library_config.preview_progress", {
                                    queued: previewStatus.queued,
                                    running: previewStatus.running,
                                })
                            }}</span>
                            <template v-else-if="!libraryPaused">{{ $t("settings.library_config.preview_counting") }}</template>
                        </span>
                        <span v-if="previewStatus.failed > 0" class="flex items-center gap-2 text-destructive">
                            <span class="tabular-nums">{{
                                $t("settings.library_config.preview_failed", { count: previewStatus.failed })
                            }}</span>
                            <Button variant="outline" size="xs" :disabled="isRetryingPreviews" @click="retryFailedPreviews">
                                <Loader2 v-if="isRetryingPreviews" class="size-3 animate-spin" />
                                <RotateCcw v-else class="size-3" />
                                {{ $t("settings.library_config.preview_retry") }}
                            </Button>
                        </span>
                    </div>
                </div>

                <Separator />

                <LibraryAiBindings :library-id="selectedLibraryId" />
            </template>
        </CardContent>
    </Card>
</template>
