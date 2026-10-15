<script setup lang="ts">
import { toast } from "vue-sonner";
import { Loader2, RefreshCw, Save, Info, Sparkles } from "@lucide/vue";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import LibraryAiBindings from "@/components/settings/LibraryAiBindings.vue";
import { useLibraryStore } from "@/stores/library";
import type { ApiResponse } from "@/types/api";

interface ActiveTask {
    id: string;
    type: string;
    status: string; // DISCOVERING, RUNNING, PAUSED, COMPLETED, CANCELLED, FAILED
    discovery_complete: boolean;
    total_units: number;
    succeeded_units: number;
    failed_units: number;
    cancelled_units: number;
    create_time: string;
    update_time: string;
}

interface FetchErrorLike {
    data?: { message?: string };
}

const DEFAULT_QUALITIES = ["LOW", "MEDIUM"];
const qualityOptions = [
    { key: "LOW", res: "360p", desc: "quality_low_desc", badge: "badge_recommended" },
    { key: "MEDIUM", res: "720p", desc: "quality_medium_desc", badge: "badge_recommended" },
    { key: "HIGH", res: "1440p", desc: "quality_high_desc", badge: "badge_sharp" },
];

const { t } = useI18n();
const libraryStore = useLibraryStore();

const selectedLibraryId = ref(libraryStore.activeLibraryId || libraryStore.libraries[0]?.id || "");

const activeTask = ref<ActiveTask | null>(null);
const isRecovering = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const isTaskBusy = computed(() => activeTask.value !== null && ["DISCOVERING", "RUNNING"].includes(activeTask.value.status));
const isTaskVisible = computed(() => activeTask.value !== null && ["DISCOVERING", "RUNNING", "PAUSED"].includes(activeTask.value.status));

const activeTaskProcessedUnits = computed(() => {
    if (!activeTask.value) return 0;
    return activeTask.value.succeeded_units + activeTask.value.failed_units + activeTask.value.cancelled_units;
});

const activeTaskPercentage = computed(() => {
    if (!activeTask.value || activeTask.value.total_units <= 0) return 0;
    return Math.min(100, Math.floor((activeTaskProcessedUnits.value / activeTask.value.total_units) * 100));
});

const stopPolling = () => {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
};

const startPolling = (libId: string) => {
    stopPolling();
    pollTimer = setInterval(() => fetchCoverConfig(libId), 2000);
};

onUnmounted(stopPolling);

const savedCoverQualities = ref<string[]>([...DEFAULT_QUALITIES]);
const selectedCoverQualities = ref<string[]>([...DEFAULT_QUALITIES]);
const isSavingCoverConfig = ref(false);

const isCoverConfigChanged = computed(
    () => [...savedCoverQualities.value].sort().join(",") !== [...selectedCoverQualities.value].sort().join(","),
);

const fetchCoverConfig = async (libId: string) => {
    try {
        const [configRes, activeJobRes] = await Promise.all([
            useApi<ApiResponse<{ qualities: string[]; config_version: number }>>(`/library/${libId}/cover-config`),
            useApi<ApiResponse<{ reconcile_status: string; active_task: ActiveTask | null }>>(`/library/${libId}/cover-jobs/active`),
        ]);

        if (configRes?.data) {
            const qualities = configRes.data.qualities?.length ? configRes.data.qualities : DEFAULT_QUALITIES;
            if (!isCoverConfigChanged.value) selectedCoverQualities.value = [...qualities];
            savedCoverQualities.value = [...qualities];
        }

        if (activeJobRes?.data) {
            activeTask.value = activeJobRes.data.active_task;
            if (activeJobRes.data.reconcile_status === "IN_PROGRESS" || isTaskBusy.value) {
                if (!pollTimer) startPolling(libId);
            } else {
                stopPolling();
            }
        }
    } catch (e) {
        console.error("Failed to fetch cover config or active job:", e);
    }
};

watch(
    selectedLibraryId,
    (libId) => {
        stopPolling();
        activeTask.value = null;
        if (libId) fetchCoverConfig(libId);
    },
    { immediate: true },
);

const setCoverQualities = (value: unknown) => {
    const qualities = value as string[];
    if (qualities.length === 0) {
        toast.warning(t("settings.general.cover_qualities_min_err"));
        return;
    }
    selectedCoverQualities.value = qualities;
};

const saveCoverConfig = async () => {
    const libId = selectedLibraryId.value;
    if (!libId) return;
    isSavingCoverConfig.value = true;
    try {
        const res = await useApi<ApiResponse<{ qualities: string[]; is_changed: boolean; active_task: ActiveTask | null }>>(
            `/library/${libId}/cover-config`,
            { method: "PUT", body: { qualities: selectedCoverQualities.value } },
        );
        if (res?.success) {
            savedCoverQualities.value = [...selectedCoverQualities.value];
            if (res.data?.active_task) {
                activeTask.value = res.data.active_task;
                toast.success(t("settings.library_config.quality_saved_rebuilding"));
            } else {
                toast.success(t("settings.library_config.quality_saved"));
            }
            await fetchCoverConfig(libId);
            startPolling(libId);
        }
    } catch {
        toast.error(t("settings.library_config.quality_save_failed"));
        await fetchCoverConfig(libId);
    } finally {
        isSavingCoverConfig.value = false;
    }
};

const triggerCoverRecovery = async () => {
    const libId = selectedLibraryId.value;
    if (!libId) return;
    isRecovering.value = true;
    try {
        const res = await useApi<ApiResponse<{ task_id: string; active_task?: ActiveTask }>>(`/library/${libId}/cover-jobs`, {
            method: "POST",
            body: { type: "RECONCILE" },
        });
        if (!res?.success) throw new Error(res?.message || "Server error");
        toast.success(t("settings.general.video_cover_recovery_success"));
        if (res.data?.active_task) activeTask.value = res.data.active_task;
        await fetchCoverConfig(libId);
        startPolling(libId);
    } catch (err) {
        console.error("Failed to run video cover recovery", err);
        toast.error(t("settings.general.video_cover_recovery_error"), {
            description: (err as FetchErrorLike)?.data?.message || "Unknown error occurred",
        });
    } finally {
        isRecovering.value = false;
    }
};

const runJobAction = async (action: "pause" | "resume" | "cancel") => {
    const libId = selectedLibraryId.value;
    if (!activeTask.value || !libId) return;
    try {
        await useApi(`/jobs/${activeTask.value.id}/${action}`, { method: "POST" });
        toast.success(t(`settings.library_config.job_${action}_done`));
        await fetchCoverConfig(libId);
        if (action === "resume") startPolling(libId);
    } catch {
        toast.error(t(`settings.library_config.job_${action}_failed`));
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
                            <Label class="flex items-center gap-1.5 text-sm font-semibold">
                                <Sparkles class="size-4 shrink-0 text-amber-500" />
                                {{ $t("settings.general.cover_qualities_title") }}
                            </Label>
                            <p class="text-xs text-muted-foreground">{{ $t("settings.general.cover_qualities_desc") }}</p>
                        </div>
                        <Button v-if="isCoverConfigChanged" size="sm" :disabled="isSavingCoverConfig" @click="saveCoverConfig">
                            <Loader2 v-if="isSavingCoverConfig" class="size-3.5 animate-spin" />
                            <Save v-else class="size-3.5" />
                            {{ $t("settings.library_config.quality_save") }}
                        </Button>
                    </div>

                    <ToggleGroup
                        type="multiple"
                        variant="outline"
                        :spacing="3"
                        class="grid w-full grid-cols-1 sm:grid-cols-3"
                        :model-value="selectedCoverQualities"
                        @update:model-value="setCoverQualities"
                    >
                        <ToggleGroupItem
                            v-for="item in qualityOptions"
                            :key="item.key"
                            :value="item.key"
                            class="h-auto flex-col items-stretch gap-1.5 p-3.5 text-left font-normal data-[state=on]:ring-1 data-[state=on]:ring-foreground"
                        >
                            <span class="flex items-center justify-between">
                                <span class="text-xs font-bold">{{ item.key }}</span>
                                <span class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">{{ item.res }}</span>
                            </span>
                            <span class="text-xs leading-snug text-muted-foreground whitespace-normal">{{
                                $t(`settings.library_config.${item.desc}`)
                            }}</span>
                            <span class="text-xs text-muted-foreground">{{ $t(`settings.library_config.${item.badge}`) }}</span>
                        </ToggleGroupItem>
                    </ToggleGroup>

                    <Alert v-if="isCoverConfigChanged">
                        <Info class="size-4" />
                        <AlertDescription>{{ $t("settings.library_config.quality_changed_notice") }}</AlertDescription>
                    </Alert>
                </div>

                <Separator />

                <div class="space-y-3">
                    <div class="flex items-center justify-between gap-3">
                        <div class="space-y-0.5">
                            <h5 class="text-sm font-semibold">{{ $t("settings.general.video_cover_recovery") }}</h5>
                            <p class="text-xs text-muted-foreground">{{ $t("settings.general.video_cover_recovery_desc") }}</p>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            class="shrink-0"
                            :disabled="isRecovering || isTaskBusy"
                            @click="triggerCoverRecovery"
                        >
                            <Loader2 v-if="isRecovering || isTaskBusy" class="size-3.5 animate-spin" />
                            <RefreshCw v-else class="size-3.5" />
                            {{
                                isRecovering || isTaskBusy
                                    ? $t("settings.general.video_cover_recovery_loading")
                                    : $t("settings.general.video_cover_recovery_btn")
                            }}
                        </Button>
                    </div>

                    <div v-if="activeTask && isTaskVisible" class="space-y-2.5 rounded-xl border bg-muted/50 p-3">
                        <div class="flex items-center justify-between gap-2 text-xs">
                            <span class="flex items-center gap-1.5 font-semibold">
                                <Loader2 v-if="isTaskBusy" class="size-3.5 shrink-0 animate-spin" />
                                {{
                                    activeTask.status === "DISCOVERING"
                                        ? $t("settings.library_config.job_discovering")
                                        : activeTask.status === "PAUSED"
                                          ? $t("settings.library_config.job_paused")
                                          : $t("settings.library_config.job_running")
                                }}
                            </span>
                            <div class="flex items-center gap-2">
                                <span class="font-mono font-bold">
                                    <span
                                        v-if="!activeTask.discovery_complete && activeTask.total_units === 0"
                                        class="font-normal text-muted-foreground"
                                    >
                                        {{ $t("settings.library_config.job_counting") }}
                                    </span>
                                    <template v-else>
                                        {{ activeTaskProcessedUnits }} / {{ activeTask.total_units }} ({{ activeTaskPercentage }}%)
                                        <span v-if="!activeTask.discovery_complete" class="ml-1 font-normal text-muted-foreground"
                                            >({{ $t("settings.library_config.job_still_counting") }})</span
                                        >
                                    </template>
                                </span>
                                <Button v-if="isTaskBusy" variant="outline" size="xs" @click="runJobAction('pause')">{{
                                    $t("settings.library_config.job_pause")
                                }}</Button>
                                <Button v-if="activeTask.status === 'PAUSED'" variant="outline" size="xs" @click="runJobAction('resume')">{{
                                    $t("settings.library_config.job_resume")
                                }}</Button>
                                <Button
                                    variant="outline"
                                    size="xs"
                                    class="text-destructive hover:text-destructive"
                                    @click="runJobAction('cancel')"
                                >
                                    {{ $t("settings.library_config.job_cancel") }}
                                </Button>
                            </div>
                        </div>
                        <Progress
                            :model-value="activeTaskPercentage"
                            :class="!activeTask.discovery_complete && activeTask.total_units === 0 ? 'animate-pulse' : undefined"
                        />
                    </div>
                </div>

                <Separator />

                <LibraryAiBindings :library-id="selectedLibraryId" />
            </template>
        </CardContent>
    </Card>
</template>
