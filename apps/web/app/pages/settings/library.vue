<script setup lang="ts">
import { toast } from "vue-sonner";
import { Loader2, RefreshCw, RotateCcw, Save, Info, Sparkles } from "@lucide/vue";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import LibraryAiBindings from "@/components/settings/LibraryAiBindings.vue";
import { useLibraryStore } from "@/stores/library";
import type { ApiResponse } from "@/types/api";
import type { PipelineStatus } from "@/types/pipeline";

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

const coverStatus = ref<PipelineStatus | null>(null);
const isRecovering = ref(false);
const isRetryingCovers = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const isCoverBusy = computed(() => coverStatus.value !== null && (coverStatus.value.scanning || coverStatus.value.queued > 0));

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
        const [configRes, statusRes] = await Promise.all([
            useApi<ApiResponse<{ qualities: string[] }>>(`/library/${libId}/cover-config`),
            useApi<ApiResponse<{ libraries: { library_id: string; pipelines: PipelineStatus[] }[] }>>("/jobs/pipelines", {
                query: { library_id: libId },
            }),
        ]);

        if (configRes?.data) {
            const qualities = configRes.data.qualities?.length ? configRes.data.qualities : DEFAULT_QUALITIES;
            if (!isCoverConfigChanged.value) selectedCoverQualities.value = [...qualities];
            savedCoverQualities.value = [...qualities];
        }

        if (statusRes?.data && libId === selectedLibraryId.value) {
            const library = statusRes.data.libraries.find((item) => item.library_id === libId);
            coverStatus.value = library?.pipelines.find((item) => item.pipeline === "cover") ?? null;
            if (isCoverBusy.value) {
                if (!pollTimer) startPolling(libId);
            } else {
                stopPolling();
            }
        }
    } catch (e) {
        console.error("Failed to fetch cover config or status:", e);
    }
};

watch(
    selectedLibraryId,
    (libId) => {
        stopPolling();
        coverStatus.value = null;
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
        const res = await useApi<ApiResponse<{ qualities: string[]; is_changed: boolean }>>(`/library/${libId}/cover-config`, {
            method: "PUT",
            body: { qualities: selectedCoverQualities.value },
        });
        if (res?.success) {
            savedCoverQualities.value = [...selectedCoverQualities.value];
            toast.success(
                res.data?.is_changed ? t("settings.library_config.quality_saved_rebuilding") : t("settings.library_config.quality_saved"),
            );
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
        const res = await useApi<ApiResponse<{ library_id: string }>>(`/library/${libId}/cover-jobs`, { method: "POST", body: {} });
        if (!res?.success) throw new Error(res?.message || "Server error");
        toast.success(t("settings.general.video_cover_recovery_success"));
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

const retryFailedCovers = async () => {
    const libId = selectedLibraryId.value;
    if (!libId) return;
    isRetryingCovers.value = true;
    try {
        const res = await useApi<ApiResponse<{ retried: number }>>(`/jobs/pipelines/${libId}/cover/retry-failed`, { method: "POST" });
        toast.success(t("settings.library_config.cover_retry_done", { count: res?.data?.retried ?? 0 }));
        await fetchCoverConfig(libId);
    } catch {
        toast.error(t("settings.library_config.cover_retry_error"));
    } finally {
        isRetryingCovers.value = false;
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
                            :disabled="isRecovering || isCoverBusy"
                            @click="triggerCoverRecovery"
                        >
                            <Loader2 v-if="isRecovering || isCoverBusy" class="size-3.5 animate-spin" />
                            <RefreshCw v-else class="size-3.5" />
                            {{
                                isRecovering || isCoverBusy
                                    ? $t("settings.general.video_cover_recovery_loading")
                                    : $t("settings.general.video_cover_recovery_btn")
                            }}
                        </Button>
                    </div>

                    <div
                        v-if="coverStatus && (isCoverBusy || coverStatus.failed > 0)"
                        class="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/50 p-3 text-xs"
                    >
                        <span v-if="isCoverBusy" class="flex items-center gap-1.5 font-semibold">
                            <Loader2 class="size-3.5 shrink-0 animate-spin" />
                            <template v-if="coverStatus.queued === 0">{{ $t("settings.library_config.cover_counting") }}</template>
                            <span v-else class="tabular-nums">{{
                                $t("settings.library_config.cover_progress", { queued: coverStatus.queued, running: coverStatus.running })
                            }}</span>
                        </span>
                        <span v-if="coverStatus.failed > 0" class="flex items-center gap-2 text-destructive">
                            <span class="tabular-nums">{{
                                $t("settings.library_config.cover_failed", { count: coverStatus.failed })
                            }}</span>
                            <Button variant="outline" size="xs" :disabled="isRetryingCovers" @click="retryFailedCovers">
                                <Loader2 v-if="isRetryingCovers" class="size-3 animate-spin" />
                                <RotateCcw v-else class="size-3" />
                                {{ $t("settings.library_config.cover_retry") }}
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
