<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { CircleCheck, Loader2, Play, Save } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import {
    isEmbeddingCapabilities,
    isGenerationCapabilities,
    type AiBindings,
    type AiErrorView,
    type AiLibraryStatus,
    type AiModel,
    type AiProgress,
    type AiProvider,
    type AiRoleKey,
} from "@/types/ai";
import type { ApiResponse } from "@/types/api";
import { formatTemporalDateTime } from "@/utils/temporal";
import { useLibraryStore } from "@/stores/library";

const props = defineProps<{ libraryId: string }>();

const { t, te, locale, locales } = useI18n();
const router = useRouter();
const libraryStore = useLibraryStore();

/** Description languages: the languages the app itself is translated into. */
const languageOptions = computed(() =>
    locales.value.map((locale) =>
        typeof locale === "string" ? { code: locale, name: locale } : { code: locale.code, name: locale.name ?? locale.code },
    ),
);
const language = ref("en-US");
const savedLanguage = ref("en-US");

const NONE = "__NONE__";
const roles: Array<{ key: AiRoleKey; supports: (model: AiModel) => boolean }> = [
    {
        key: "describe",
        supports: (model) =>
            isGenerationCapabilities(model.capabilities) &&
            model.capabilities.inputModalities.includes("image") &&
            model.capabilities.structuredOutput,
    },
    { key: "textEmbedding", supports: (model) => isEmbeddingCapabilities(model.capabilities) },
    { key: "imageEmbedding", supports: (model) => isEmbeddingCapabilities(model.capabilities) && model.capabilities.multimodal },
    { key: "rerank", supports: (model) => model.category === "rerank" },
];
const roleLabels: Record<AiRoleKey, { label: string; hint: string }> = {
    describe: { label: "settings.ai_config.role_describe", hint: "settings.ai_config.role_describe_hint" },
    textEmbedding: { label: "settings.ai_config.role_text_embedding", hint: "settings.ai_config.role_text_embedding_hint" },
    imageEmbedding: { label: "settings.ai_config.role_image_embedding", hint: "settings.ai_config.role_image_embedding_hint" },
    rerank: { label: "settings.ai_config.role_rerank", hint: "settings.ai_config.role_rerank_hint" },
};

const models = ref<AiModel[]>([]);
const providers = ref<AiProvider[]>([]);
const selection = ref<Record<AiRoleKey, string>>({ describe: NONE, textEmbedding: NONE, imageEmbedding: NONE, rerank: NONE });
const savedSelection = ref("");
const savedDescribe = ref(NONE);
const isLoading = ref(false);
const isSaving = ref(false);

const status = ref<AiLibraryStatus | null>(null);
const progress = ref<AiProgress | null>(null);
const isStarting = ref(false);
const isConfirmingUpdate = ref(false);
let statusTimer: ReturnType<typeof setTimeout> | null = null;

const SPACE_ORDER = { ACTIVE: 0, BUILDING: 1, RETIRED: 2 } as const;
const spacesOf = (role: AiRoleKey) =>
    status.value?.spaces.filter((space) => space.role === role).sort((a, b) => SPACE_ORDER[a.status] - SPACE_ORDER[b.status]) ?? [];
/** Model hints shown under a role: a rebuild in progress, or the previous space kept for switching back. */
const hintSpacesOf = (role: AiRoleKey) => spacesOf(role).filter((space) => space.status !== "ACTIVE");
const modelName = (modelId: string) => models.value.find((model) => model.id === modelId)?.display_name ?? modelId;
const issuesOf = (role: AiRoleKey) => status.value?.issues.filter((issue) => issue.role === role) ?? [];
const formatError = (error: AiErrorView) =>
    t("settings.ai_config.status_last_error", { message: error.message, time: formatTemporalDateTime(error.at, locale.value) });
const formatDate = (iso: string) => formatTemporalDateTime(iso, locale.value, { year: "numeric", month: "2-digit", day: "2-digit" });

const coverage = computed(() => status.value?.coverage ?? null);
const isProcessing = computed(() => Boolean(progress.value && (progress.value.task || progress.value.queuedVectors > 0)));
/** Items AI search does not cover yet and processing can fill in. */
const incomplete = computed(() => (coverage.value ? coverage.value.missing + coverage.value.failed : 0));
const updatable = computed(() => status.value?.describe?.updatable ?? 0);
/** What the update brings: the current prompt version's improvement, or a newer model. */
const updateReason = computed(() => {
    const describe = status.value?.describe;
    if (!describe) return "";
    if (describe.olderVersion === 0) return t("settings.ai_config.describe_update_reason_other_model");
    const key = `settings.ai_config.describe_update_reason_${describe.promptVersion}`;
    return te(key) ? t(key) : t("settings.ai_config.describe_update_reason_version");
});
/** Per-role numbers shown under each role: descriptions, or the vectors of the space search uses. */
const roleCounts = computed(() => {
    const counts: Partial<Record<AiRoleKey, { done: number; pending: number; failed: number }>> = {};
    const describe = status.value?.describe;
    if (describe) counts.describe = { done: describe.described, pending: describe.pending, failed: describe.failed };
    for (const space of status.value?.spaces ?? []) {
        if (space.status === "ACTIVE") counts[space.role] = { done: space.ready, pending: space.pending, failed: space.failed };
    }
    return counts;
});
/** A rebuilt space that is waiting to replace the current one; its promotion is not part of `progress`. */
const isAwaitingSwitch = computed(() => Boolean(status.value?.spaces.some((space) => space.status === "BUILDING" && !space.blocked)));

const stopPolling = () => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
};
onBeforeUnmount(stopPolling);

/** Full status: counts every item, so it is loaded on demand and once running work ends, never polled while it runs. */
const loadStatus = async () => {
    stopPolling();
    try {
        const res = await useApi<ApiResponse<AiLibraryStatus>>(`/ai/status/${props.libraryId}`);
        status.value = res?.data ?? null;
        progress.value = status.value?.progress ?? null;
    } catch (err) {
        console.error("Failed to load AI status", err);
    }
    schedulePoll();
};

/** While work runs, polls only its progress; when it ends, reloads the full status. */
const pollProgress = async () => {
    statusTimer = null;
    try {
        const res = await useApi<ApiResponse<AiProgress>>(`/ai/status/${props.libraryId}/progress`);
        progress.value = res?.data ?? null;
    } catch (err) {
        console.error("Failed to load AI progress", err);
    }
    if (isProcessing.value) schedulePoll();
    else await loadStatus();
};

const schedulePoll = () => {
    if (isProcessing.value) statusTimer = setTimeout(pollProgress, 5_000);
    else if (isAwaitingSwitch.value) statusTimer = setTimeout(loadStatus, 15_000);
};

const runStatusAction = async (path: "process" | "redescribe", doneMessage: string) => {
    isConfirmingUpdate.value = false;
    isStarting.value = true;
    try {
        await useApi<ApiResponse<null>>(`/ai/status/${props.libraryId}/${path}`, { method: "POST" });
        toast.success(doneMessage);
        await loadStatus();
    } catch (err) {
        console.error(`Failed to start ${path}`, err);
        toast.error((err as { data?: { message?: string } })?.data?.message || t("settings.ai_config.err_save"));
    } finally {
        isStarting.value = false;
    }
};
const startProcessing = () => runStatusAction("process", t("settings.ai_config.process_started"));
const startUpdate = () => runStatusAction("redescribe", t("settings.ai_config.describe_update_started"));

/** Opens the media list of this library filtered to the items in question. */
const showMedia = (filter: "incomplete" | "unprocessable") => {
    libraryStore.setActiveLibrary(props.libraryId);
    router.push({ path: "/", query: { ai_coverage: filter } });
};

const isDirty = computed(() => JSON.stringify(selection.value) !== savedSelection.value || language.value !== savedLanguage.value);

const providerName = (providerId: string) => providers.value.find((provider) => provider.id === providerId)?.name ?? "";
const modelProvider = (modelId: string) => providerName(models.value.find((model) => model.id === modelId)?.provider_id ?? "");
const optionsFor = (role: AiRoleKey) => models.value.filter(roles.find((item) => item.key === role)!.supports);

const load = async () => {
    isLoading.value = true;
    try {
        const [modelRes, providerRes, bindingRes] = await Promise.all([
            useApi<ApiResponse<AiModel[]>>("/ai/models"),
            useApi<ApiResponse<AiProvider[]>>("/ai/providers"),
            useApi<ApiResponse<AiBindings>>(`/ai/bindings/${props.libraryId}`),
        ]);
        models.value = modelRes?.data ?? [];
        providers.value = providerRes?.data ?? [];
        const bindings = bindingRes?.data ?? {};
        language.value = bindings.language ?? "en-US";
        savedLanguage.value = language.value;
        selection.value = {
            describe: bindings.describe?.modelId ?? NONE,
            textEmbedding: bindings.textEmbedding?.modelId ?? NONE,
            imageEmbedding: bindings.imageEmbedding?.modelId ?? NONE,
            rerank: bindings.rerank?.modelId ?? NONE,
        };
        savedSelection.value = JSON.stringify(selection.value);
        savedDescribe.value = selection.value.describe;
    } catch (err) {
        console.error("Failed to load library AI bindings", err);
        toast.error(t("settings.ai_config.err_load"));
    } finally {
        isLoading.value = false;
    }
};

watch(
    () => props.libraryId,
    async () => {
        await load();
        await loadStatus();
    },
    { immediate: true },
);

const isConfirmingLanguage = ref(false);
const isConfirmingModel = ref(false);

const save = () => {
    const describeBound = selection.value.describe !== NONE;
    // A new description language re-describes every item: the costliest AI operation, so it is confirmed.
    if (language.value !== savedLanguage.value && describeBound) {
        isConfirmingLanguage.value = true;
        return;
    }
    // A new description model only serves new items unless the user also has the existing ones redone.
    if (selection.value.describe !== savedDescribe.value && describeBound && (status.value?.describe?.described ?? 0) > 0) {
        isConfirmingModel.value = true;
        return;
    }
    commit();
};

const commit = async ({ redescribe = false }: { redescribe?: boolean } = {}) => {
    isConfirmingLanguage.value = false;
    isConfirmingModel.value = false;
    isSaving.value = true;
    try {
        const body = {
            ...Object.fromEntries(Object.entries(selection.value).map(([role, modelId]) => [role, modelId === NONE ? null : { modelId }])),
            language: language.value,
            redescribe,
        };
        const res = await useApi<ApiResponse<{ indexingStarted: boolean }>>(`/ai/bindings/${props.libraryId}`, { method: "POST", body });
        if (res?.data?.indexingStarted === false) {
            // Saved, but queuing the indexing failed. The form stays unsaved so saving again retries it.
            toast.warning(t("settings.ai_config.bindings_saved_not_indexed"));
        } else {
            savedSelection.value = JSON.stringify(selection.value);
            savedDescribe.value = selection.value.describe;
            savedLanguage.value = language.value;
            toast.success(t("settings.ai_config.bindings_saved"));
        }
        await loadStatus();
    } catch (err) {
        console.error("Failed to save library AI bindings", err);
        toast.error((err as { data?: { message?: string } })?.data?.message || t("settings.ai_config.err_save"));
    } finally {
        isSaving.value = false;
    }
};
</script>

<template>
    <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
            <div class="space-y-0.5">
                <h5 class="text-sm font-semibold">{{ t("settings.ai_config.bindings_title") }}</h5>
                <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.bindings_desc") }}</p>
            </div>
            <Button v-if="isDirty || isSaving" size="sm" class="shrink-0" :disabled="isSaving" @click="save">
                <Loader2 v-if="isSaving" class="size-3.5 animate-spin" />
                <Save v-else class="size-3.5" />
                {{ t("settings.ai_config.bindings_save") }}
            </Button>
        </div>

        <div v-if="coverage || isProcessing" class="space-y-2 rounded-xl border bg-muted/50 p-3 text-xs">
            <div class="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <p v-if="isProcessing && progress" class="flex min-w-0 items-center gap-1.5 font-medium">
                    <Loader2 class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    <span v-if="progress.task">{{ t("settings.ai_config.progress_task", progress.task) }}</span>
                    <span v-else>{{ t("settings.ai_config.progress_vectors", { count: progress.queuedVectors }) }}</span>
                </p>
                <p v-else-if="coverage && coverage.eligible === 0" class="min-w-0 text-muted-foreground">
                    {{ t("settings.ai_config.coverage_empty") }}
                </p>
                <p
                    v-else-if="coverage && incomplete === 0 && coverage.unprocessable === 0"
                    class="flex min-w-0 items-center gap-1.5 font-medium"
                >
                    <CircleCheck class="size-3.5 shrink-0 text-emerald-600" />
                    {{ t("settings.ai_config.coverage_all", { count: coverage.eligible }) }}
                </p>
                <p v-else-if="coverage" class="min-w-0 font-medium">
                    {{ t("settings.ai_config.coverage_partial", { covered: coverage.covered, eligible: coverage.eligible }) }}
                    <template v-if="incomplete > 0">
                        <span class="text-muted-foreground"> · </span>
                        <button
                            type="button"
                            class="font-normal underline underline-offset-2 hover:text-foreground"
                            @click="showMedia('incomplete')"
                        >
                            {{ t("settings.ai_config.coverage_incomplete", { count: incomplete }) }}
                        </button>
                    </template>
                </p>
                <Button v-if="!isProcessing && incomplete > 0" size="xs" :disabled="isStarting || isDirty" @click="startProcessing">
                    <Loader2 v-if="isStarting" class="size-3.5 animate-spin" />
                    <Play v-else class="size-3.5" />
                    {{ t(coverage && coverage.covered > 0 ? "settings.ai_config.process_continue" : "settings.ai_config.process_start") }}
                </Button>
            </div>
            <template v-if="coverage && !isProcessing">
                <div v-if="coverage.failed > 0 && coverage.lastFailure" class="text-red-600">
                    {{
                        t("settings.ai_config.coverage_failed", {
                            count: coverage.failed,
                            reason: t(`settings.ai_config.failure_${coverage.lastFailure.category}`),
                        })
                    }}
                    <details class="mt-0.5 text-muted-foreground">
                        <summary class="w-fit cursor-pointer select-none hover:text-foreground">
                            {{ t("settings.ai_config.failure_details") }}
                        </summary>
                        <span class="block break-words">{{ formatError(coverage.lastFailure) }}</span>
                    </details>
                </div>
                <i18n-t
                    v-if="coverage.unprocessable > 0"
                    tag="p"
                    keypath="settings.ai_config.coverage_unprocessable"
                    scope="global"
                    class="text-muted-foreground"
                >
                    <template #items>
                        <button
                            type="button"
                            class="underline underline-offset-2 hover:text-foreground"
                            @click="showMedia('unprocessable')"
                        >
                            {{ t("settings.ai_config.coverage_unprocessable_items", { count: coverage.unprocessable }) }}
                        </button>
                    </template>
                </i18n-t>
                <div v-if="updatable > 0" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-muted-foreground">
                    <span class="min-w-0">{{
                        t("settings.ai_config.describe_updatable", { count: updatable, reason: updateReason })
                    }}</span>
                    <Button size="xs" variant="outline" :disabled="isStarting || isDirty" @click="isConfirmingUpdate = true">
                        {{ t("settings.ai_config.describe_update") }}
                    </Button>
                </div>
            </template>
            <p v-if="isDirty && coverage && !isProcessing && (incomplete > 0 || updatable > 0)" class="text-amber-600">
                {{ t("settings.ai_config.process_save_first") }}
            </p>
        </div>

        <div v-if="isLoading" class="flex justify-center py-6 text-muted-foreground">
            <Loader2 class="size-5 animate-spin" />
        </div>
        <div v-else class="divide-y rounded-xl border">
            <div class="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center sm:gap-4">
                <div class="space-y-0.5">
                    <Label class="text-sm">{{ t("settings.ai_config.label_language") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.language_hint") }}</p>
                </div>
                <Select v-model="language">
                    <SelectTrigger size="sm" class="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem v-for="option in languageOptions" :key="option.code" :value="option.code">
                            {{ option.name }}
                        </SelectItem>
                    </SelectContent>
                </Select>
                <p v-if="language !== savedLanguage && selection.describe !== NONE" class="text-xs text-amber-600 sm:col-span-2">
                    {{ t("settings.ai_config.language_change_warning") }}
                </p>
            </div>
            <div v-for="role in roles" :key="role.key" class="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center sm:gap-4">
                <div class="space-y-0.5">
                    <Label class="text-sm">{{ t(roleLabels[role.key].label) }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t(roleLabels[role.key].hint) }}</p>
                    <p v-if="roleCounts[role.key]" class="text-xs tabular-nums text-muted-foreground">
                        {{ t("settings.ai_config.role_done", { count: roleCounts[role.key]!.done }) }}
                        <template v-if="roleCounts[role.key]!.pending > 0">
                            · {{ t("settings.ai_config.role_pending", { count: roleCounts[role.key]!.pending }) }}
                        </template>
                        <span v-if="roleCounts[role.key]!.failed > 0" class="text-red-600">
                            · {{ t("settings.ai_config.role_failed", { count: roleCounts[role.key]!.failed }) }}
                        </span>
                    </p>
                </div>
                <Select v-model="selection[role.key]">
                    <SelectTrigger size="sm" class="w-full">
                        <SelectValue>
                            <span v-if="selection[role.key] === NONE" class="text-muted-foreground">
                                {{ t("settings.ai_config.role_unbound") }}
                            </span>
                            <template v-else>
                                <span class="truncate">{{ modelName(selection[role.key]) }}</span>
                                <span class="truncate text-muted-foreground">{{ modelProvider(selection[role.key]) }}</span>
                            </template>
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem :value="NONE">{{ t("settings.ai_config.role_unbound") }}</SelectItem>
                        <SelectItem v-for="model in optionsFor(role.key)" :key="model.id" :value="model.id">
                            <span>{{ model.display_name }}</span>
                            <span class="text-muted-foreground">{{ providerName(model.provider_id) }}</span>
                        </SelectItem>
                    </SelectContent>
                </Select>
                <p v-for="issue in issuesOf(role.key)" :key="`${issue.role}-${issue.building}`" class="text-xs text-red-600 sm:col-span-2">
                    {{
                        t(issue.building ? "settings.ai_config.status_issue_building" : "settings.ai_config.status_issue", {
                            message: issue.message,
                        })
                    }}
                </p>
                <div v-for="space in hintSpacesOf(role.key)" :key="space.spaceId" class="text-xs text-muted-foreground sm:col-span-2">
                    <template v-if="space.status === 'RETIRED'">
                        {{
                            t("settings.ai_config.status_retired", {
                                model: modelName(space.modelId),
                                date: space.retainedUntil ? formatDate(space.retainedUntil) : "",
                            })
                        }}
                    </template>
                    <template v-else>
                        {{
                            t("settings.ai_config.status_building", {
                                model: modelName(space.modelId),
                                ready: space.ready,
                                total: space.total,
                            })
                        }}
                        <span v-if="space.blocked" class="block text-amber-600">
                            {{
                                space.blocked === "low_coverage"
                                    ? t("settings.ai_config.status_blocked_low_coverage", { ready: space.ready })
                                    : t("settings.ai_config.status_blocked_failures")
                            }}
                        </span>
                        <span v-if="space.blocked === 'too_many_failures' && space.lastError" class="block break-words">
                            {{ formatError(space.lastError) }}
                        </span>
                    </template>
                </div>
            </div>
            <p v-if="models.length === 0" class="p-3 text-xs text-muted-foreground">{{ t("settings.ai_config.role_no_options") }}</p>
        </div>

        <AlertDialog v-model:open="isConfirmingLanguage">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{{ t("settings.ai_config.language_change_title") }}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("settings.ai_config.language_change_confirm", { count: status?.describe?.described ?? 0 }) }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <AlertDialogAction @click="commit()">{{ t("settings.ai_config.language_change_btn") }}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>

        <AlertDialog v-model:open="isConfirmingUpdate">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{{ t("settings.ai_config.describe_update_title") }}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("settings.ai_config.describe_update_confirm", { count: updatable }) }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <AlertDialogAction @click="startUpdate">{{ t("settings.ai_config.describe_update") }}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>

        <AlertDialog v-model:open="isConfirmingModel">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{{ t("settings.ai_config.model_change_title") }}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("settings.ai_config.model_change_confirm", { count: status?.describe?.described ?? 0 }) }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <Button variant="outline" @click="commit({ redescribe: false })">{{
                        t("settings.ai_config.model_change_new_only")
                    }}</Button>
                    <AlertDialogAction @click="commit({ redescribe: true })">{{
                        t("settings.ai_config.model_change_all")
                    }}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </div>
</template>
