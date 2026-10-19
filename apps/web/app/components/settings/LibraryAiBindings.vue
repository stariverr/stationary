<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { Loader2, RotateCcw, Save } from "@lucide/vue";
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
    type AiProvider,
    type AiRoleKey,
} from "@/types/ai";
import type { ApiResponse } from "@/types/api";
import { formatTemporalDateTime } from "@/utils/temporal";

const props = defineProps<{ libraryId: string }>();

const { t, locale, locales } = useI18n();

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
const isRetrying = ref(false);
const isRedescribing = ref(false);
let statusTimer: ReturnType<typeof setTimeout> | null = null;

const SPACE_ORDER = { ACTIVE: 0, BUILDING: 1, RETIRED: 2 } as const;
/** Current space first, then the one being built, then the retained previous one. */
const spacesOf = (role: AiRoleKey) =>
    status.value?.spaces.filter((space) => space.role === role).sort((a, b) => SPACE_ORDER[a.status] - SPACE_ORDER[b.status]) ?? [];
const modelName = (modelId: string) => models.value.find((model) => model.id === modelId)?.display_name ?? modelId;
const issuesOf = (role: AiRoleKey) => status.value?.issues.filter((issue) => issue.role === role) ?? [];
const failedTotal = computed(
    () =>
        (status.value?.spaces.filter((space) => space.status !== "RETIRED").reduce((sum, space) => sum + space.failed, 0) ?? 0) +
        (status.value?.describe?.failed ?? 0),
);
const formatError = (error: AiErrorView) =>
    t("settings.ai_config.status_last_error", { message: error.message, time: formatTemporalDateTime(error.at, locale.value) });
/** Retry also restarts the backfill of a space held back for low coverage. */
const canRetry = computed(() => failedTotal.value > 0 || Boolean(status.value?.spaces.some((space) => space.blocked)));
const formatDate = (iso: string) => formatTemporalDateTime(iso, locale.value, { year: "numeric", month: "2-digit", day: "2-digit" });
const isProgressing = (current: AiLibraryStatus) =>
    (current.describe?.pending ?? 0) > 0 ||
    (isRedescribing.value && (current.describe?.otherModel ?? 0) > 0) ||
    current.spaces.some((space) => space.pending > 0 || (space.status === "BUILDING" && !space.blocked));

/** Polls while embeddings are queued or a space is being rebuilt. */
const loadStatus = async () => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    try {
        const res = await useApi<ApiResponse<AiLibraryStatus>>(`/ai/status/${props.libraryId}`);
        status.value = res?.data ?? null;
    } catch (err) {
        console.error("Failed to load embedding status", err);
    }
    if (status.value && isProgressing(status.value)) {
        statusTimer = setTimeout(loadStatus, 5_000);
    }
};
onBeforeUnmount(() => {
    if (statusTimer) clearTimeout(statusTimer);
});

const retryFailed = async () => {
    isRetrying.value = true;
    try {
        const res = await useApi<ApiResponse<{ requeued: number }>>(`/ai/status/${props.libraryId}/retry-failed`, { method: "POST" });
        toast.success(t("settings.ai_config.retry_failed_done", { count: res?.data?.requeued ?? 0 }));
        await loadStatus();
    } catch (err) {
        console.error("Failed to retry failed embeddings", err);
        toast.error(t("settings.ai_config.err_save"));
    } finally {
        isRetrying.value = false;
    }
};

/** Replaces the descriptions other models wrote; they leave the count as the new ones land. */
const startRedescribe = async () => {
    isRedescribing.value = true;
    try {
        await useApi<ApiResponse<null>>(`/ai/status/${props.libraryId}/redescribe`, { method: "POST" });
        toast.success(t("settings.ai_config.redescribe_started"));
        await loadStatus();
    } catch (err) {
        isRedescribing.value = false;
        console.error("Failed to start re-describing", err);
        toast.error((err as { data?: { message?: string } })?.data?.message || t("settings.ai_config.err_save"));
    }
};

const isDirty = computed(() => JSON.stringify(selection.value) !== savedSelection.value || language.value !== savedLanguage.value);

const providerName = (providerId: string) => providers.value.find((provider) => provider.id === providerId)?.name ?? "";
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
    if (selection.value.describe !== savedDescribe.value && describeBound && (status.value?.mediaTotal ?? 0) > 0) {
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
    <div class="grid gap-3">
        <div>
            <p class="text-sm font-semibold">{{ t("settings.ai_config.bindings_title") }}</p>
            <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.bindings_desc") }}</p>
        </div>

        <div v-if="isLoading" class="flex justify-center py-6 text-muted-foreground">
            <Loader2 class="h-5 w-5 animate-spin" />
        </div>
        <template v-else>
            <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3">
                <div>
                    <Label class="text-xs">{{ t("settings.ai_config.label_language") }}</Label>
                    <p class="text-[11px] text-muted-foreground">{{ t("settings.ai_config.language_hint") }}</p>
                </div>
                <Select v-model="language">
                    <SelectTrigger class="h-8 text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem v-for="option in languageOptions" :key="option.code" :value="option.code" class="text-xs">
                            {{ option.name }}
                        </SelectItem>
                    </SelectContent>
                </Select>
                <p v-if="language !== savedLanguage && selection.describe !== NONE" class="col-span-2 -mt-1 text-[11px] text-amber-600">
                    {{ t("settings.ai_config.language_change_warning") }}
                </p>
            </div>
            <div v-for="role in roles" :key="role.key" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3">
                <div>
                    <Label class="text-xs">{{ t(roleLabels[role.key].label) }}</Label>
                    <p class="text-[11px] text-muted-foreground">{{ t(roleLabels[role.key].hint) }}</p>
                </div>
                <Select v-model="selection[role.key]">
                    <SelectTrigger class="h-8 text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem :value="NONE" class="text-xs">{{ t("settings.ai_config.role_unbound") }}</SelectItem>
                        <SelectItem v-for="model in optionsFor(role.key)" :key="model.id" :value="model.id" class="text-xs">
                            <span>{{ model.display_name }}</span>
                            <span class="ml-1.5 text-muted-foreground">{{ providerName(model.provider_id) }}</span>
                        </SelectItem>
                    </SelectContent>
                </Select>
                <p v-for="issue in issuesOf(role.key)" :key="`${issue.role}-${issue.building}`" class="col-span-2 -mt-1 text-[11px] text-red-600">
                    {{ t(issue.building ? "settings.ai_config.status_issue_building" : "settings.ai_config.status_issue", { message: issue.message }) }}
                </p>
                <div v-if="role.key === 'describe' && status?.describe" class="col-span-2 -mt-1 text-[11px] text-muted-foreground">
                    {{ t("settings.ai_config.status_described", { ready: status.describe.completed, total: status.mediaTotal }) }}
                    <template v-if="status.describe.pending > 0">
                        · {{ t("settings.ai_config.status_pending", { count: status.describe.pending }) }}</template
                    >
                    <span v-if="status.describe.failed > 0" class="text-red-600">
                        · {{ t("settings.ai_config.status_failed", { count: status.describe.failed }) }}</span
                    >
                    <template v-if="status.describe.otherModel > 0">
                        · {{ t("settings.ai_config.status_other_model", { count: status.describe.otherModel }) }}
                        <button
                            type="button"
                            class="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                            :disabled="isRedescribing"
                            @click="startRedescribe"
                        >
                            {{ t("settings.ai_config.redescribe") }}
                        </button>
                    </template>
                    <span v-if="status.describe.lastError" class="block break-words">{{ formatError(status.describe.lastError) }}</span>
                </div>
                <div v-for="space in spacesOf(role.key)" :key="space.spaceId" class="col-span-2 -mt-1 text-[11px] text-muted-foreground">
                    <template v-if="space.status === 'RETIRED'">
                        {{
                            t("settings.ai_config.status_retired", {
                                model: modelName(space.modelId),
                                date: space.retainedUntil ? formatDate(space.retainedUntil) : "",
                            })
                        }}
                    </template>
                    <template v-else-if="space.status === 'BUILDING'">
                        {{
                            t("settings.ai_config.status_building", {
                                model: modelName(space.modelId),
                                ready: space.ready,
                                total: status?.mediaTotal ?? 0,
                            })
                        }}
                    </template>
                    <template v-else>
                        {{ t("settings.ai_config.status_indexed", { ready: space.ready, total: status?.mediaTotal ?? 0 }) }}
                    </template>
                    <template v-if="space.status !== 'RETIRED' && space.pending > 0">
                        · {{ t("settings.ai_config.status_pending", { count: space.pending }) }}</template
                    >
                    <span v-if="space.status !== 'RETIRED' && space.failed > 0" class="text-red-600">
                        · {{ t("settings.ai_config.status_failed", { count: space.failed }) }}</span
                    >
                    <span v-if="space.blocked" class="block text-amber-600">
                        {{
                            space.blocked === "low_coverage"
                                ? t("settings.ai_config.status_blocked_low_coverage", { ready: space.ready })
                                : t("settings.ai_config.status_blocked_failures")
                        }}
                    </span>
                    <span v-if="space.lastError" class="block break-words">{{ formatError(space.lastError) }}</span>
                </div>
            </div>
            <p v-if="models.length === 0" class="text-xs text-muted-foreground">{{ t("settings.ai_config.role_no_options") }}</p>

            <div class="flex items-center gap-2">
                <Button size="sm" class="w-fit text-xs" :disabled="!isDirty || isSaving" @click="save">
                    <Loader2 v-if="isSaving" class="h-3.5 w-3.5 animate-spin" />
                    <Save v-else class="h-3.5 w-3.5" />
                    {{ t("settings.ai_config.bindings_save") }}
                </Button>
                <Button
                    v-if="canRetry"
                    size="sm"
                    variant="outline"
                    class="w-fit text-xs"
                    :disabled="isRetrying"
                    @click="retryFailed"
                >
                    <Loader2 v-if="isRetrying" class="h-3.5 w-3.5 animate-spin" />
                    <RotateCcw v-else class="h-3.5 w-3.5" />
                    {{ t("settings.ai_config.retry_failed") }}
                </Button>
            </div>
        </template>

        <AlertDialog v-model:open="isConfirmingLanguage">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{{ t("settings.ai_config.language_change_title") }}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("settings.ai_config.language_change_confirm", { count: status?.mediaTotal ?? 0 }) }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <AlertDialogAction @click="commit()">{{ t("settings.ai_config.language_change_btn") }}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>

        <AlertDialog v-model:open="isConfirmingModel">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{{ t("settings.ai_config.model_change_title") }}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("settings.ai_config.model_change_confirm", { count: status?.mediaTotal ?? 0 }) }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <Button variant="outline" @click="commit({ redescribe: false })">{{ t("settings.ai_config.model_change_new_only") }}</Button>
                    <AlertDialogAction @click="commit({ redescribe: true })">{{ t("settings.ai_config.model_change_all") }}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </div>
</template>
