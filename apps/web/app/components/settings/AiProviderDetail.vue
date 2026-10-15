<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { ChevronRight, Eye, EyeOff, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "@lucide/vue";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    NumberField,
    NumberFieldContent,
    NumberFieldDecrement,
    NumberFieldIncrement,
    NumberFieldInput,
} from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AiConnectionStatus from "@/components/settings/AiConnectionStatus.vue";
import AiModelForm from "@/components/settings/AiModelForm.vue";
import AiModelPicker from "@/components/settings/AiModelPicker.vue";
import AiProviderAvatar from "@/components/settings/AiProviderAvatar.vue";
import {
    describeModelSpec,
    type AiCatalogModel,
    type AiConnectionTestResult,
    type AiModel,
    type AiModelCategory,
    type AiProvider,
    type AiProviderTemplate,
} from "@/types/ai";
import type { ApiResponse } from "@/types/api";

const props = defineProps<{
    provider: AiProvider;
    templates: AiProviderTemplate[];
    /** This provider's models. */
    models: AiModel[];
    check?: AiConnectionTestResult;
    checking: boolean;
}>();

const emit = defineEmits<{
    /** Something was saved; the parent reloads providers and models. */
    changed: [];
    /** Run a connection check with the stored settings. */
    check: [];
    deleted: [];
}>();

const { t } = useI18n();

const template = computed(() => props.templates.find((item) => item.id === props.provider.template_id));

// --- Connection settings ---
interface ConnectionDraft {
    templateId: string;
    name: string;
    baseUrl: string;
    /** Empty keeps the stored key. */
    apiKey: string;
    maxConcurrency: number;
    /** Undefined means no per-minute limit. */
    requestsPerMinute: number | undefined;
}

const toDraft = (provider: AiProvider): ConnectionDraft => ({
    templateId: provider.template_id,
    name: provider.name,
    baseUrl: provider.base_url,
    apiKey: "",
    maxConcurrency: provider.max_concurrency,
    requestsPerMinute: provider.requests_per_minute ?? undefined,
});

const draft = ref(toDraft(props.provider));
watch(
    () => props.provider,
    (provider) => (draft.value = toDraft(provider)),
);

const isDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(toDraft(props.provider)));
const showKey = ref(false);
const limitsOpen = ref(false);
const isSaving = ref(false);

const draftTemplate = computed(() => props.templates.find((item) => item.id === draft.value.templateId));

const save = async () => {
    const current = draft.value;
    if (!current.name.trim() || !current.baseUrl.trim()) {
        toast.error(t("settings.ai_config.provider_required"));
        return;
    }
    isSaving.value = true;
    try {
        await useApi<ApiResponse<AiProvider>>(`/ai/providers/${props.provider.id}`, {
            method: "PUT",
            body: {
                template_id: current.templateId,
                name: current.name.trim(),
                base_url: current.baseUrl.trim(),
                ...(current.apiKey.trim() ? { api_key: current.apiKey.trim() } : {}),
                max_concurrency: current.maxConcurrency,
                // A cleared number field reports NaN: both mean no per-minute limit. requests_per_minute: Number.isFinite(current.requestsPerMinute) ? current.requestsPerMinute : null,
            },
        });
        toast.success(t("settings.ai_config.provider_saved"));
        emit("changed");
        emit("check");
    } catch (err) {
        console.error("Failed to save AI provider", err);
        const message = (err as { data?: { message?: string } })?.data?.message;
        toast.error(message || t("settings.ai_config.err_save"));
    } finally {
        isSaving.value = false;
    }
};

// --- Models ---
const CATEGORY_ORDER: AiModelCategory[] = ["generation", "embedding", "rerank"];
const modelGroups = computed(() =>
    CATEGORY_ORDER.map((category) => ({ category, models: props.models.filter((model) => model.category === category) })).filter(
        (group) => group.models.length > 0,
    ),
);

const pickerOpen = ref(false);

/** The model form dialog: editing a model, adding a picked id, or adding a custom one. */
const form = ref<{ key: number; model?: AiModel; initial?: { name: string; definition: AiCatalogModel | null } } | null>(null);
let formKey = 0;
const openForm = (target: { model?: AiModel; initial?: { name: string; definition: AiCatalogModel | null } }) => {
    pickerOpen.value = false;
    form.value = { key: ++formKey, ...target };
};

const onModelSaved = () => {
    form.value = null;
    emit("changed");
};

// --- Deletion ---
const pendingDelete = ref<{ kind: "provider" } | { kind: "model"; model: AiModel } | null>(null);
const isDeleting = ref(false);

const confirmDelete = async () => {
    const target = pendingDelete.value;
    if (!target) return;
    isDeleting.value = true;
    try {
        if (target.kind === "provider") {
            await useApi(`/ai/providers/${props.provider.id}`, { method: "DELETE" });
            toast.success(t("settings.ai_config.provider_deleted"));
            emit("deleted");
        } else {
            await useApi(`/ai/models/${target.model.id}`, { method: "DELETE" });
            toast.success(t("settings.ai_config.model_deleted"));
            emit("changed");
        }
    } catch (err) {
        console.error("Failed to delete", err);
        toast.error(t("settings.ai_config.err_save"));
    } finally {
        isDeleting.value = false;
        pendingDelete.value = null;
    }
};
</script>

<template>
    <div class="grid grid-cols-1 gap-8">
        <!-- Header -->
        <div class="flex items-start gap-3">
            <AiProviderAvatar :name="provider.name" class="size-10 text-base" />
            <div class="min-w-0 flex-1">
                <h3 class="truncate text-lg font-semibold">{{ provider.name }}</h3>
                <p class="truncate text-sm text-muted-foreground">{{ template?.name ?? provider.template_id }}</p>
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="icon-sm" :aria-label="t('settings.ai_config.more_actions')">
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" @click="pendingDelete = { kind: 'provider' }">
                        <Trash2 />
                        {{ t("settings.ai_config.provider_delete") }}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>

        <!-- Connection -->
        <section class="grid grid-cols-1 gap-4">
            <div class="flex items-center justify-between gap-3">
                <h4 class="text-sm font-semibold">{{ t("settings.ai_config.connection") }}</h4>
                <Button variant="outline" size="sm" :disabled="checking || isDirty" @click="emit('check')">
                    <Loader2 v-if="checking" class="animate-spin" />
                    <RefreshCw v-else />
                    {{ t("settings.ai_config.test") }}
                </Button>
            </div>
            <AiConnectionStatus :check="check" :checking="checking" />

            <form class="grid gap-4 rounded-lg border p-4" @submit.prevent="save">
                <div class="grid gap-2">
                    <Label for="ai-provider-key">{{ t("settings.ai_config.api_key") }}</Label>
                    <div class="relative">
                        <Input
                            id="ai-provider-key"
                            v-model="draft.apiKey"
                            :type="showKey ? 'text' : 'password'"
                            autocomplete="off"
                            class="pr-10 font-mono placeholder:font-sans"
                            :placeholder="
                                provider.api_key_hint
                                    ? t('settings.ai_config.api_key_keep', { hint: provider.api_key_hint })
                                    : t('settings.ai_config.api_key_placeholder')
                            "
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            class="absolute top-1/2 right-1 size-7 -translate-y-1/2 text-muted-foreground"
                            :aria-label="t('settings.ai_config.api_key_toggle')"
                            @click="showKey = !showKey"
                        >
                            <EyeOff v-if="showKey" />
                            <Eye v-else />
                        </Button>
                    </div>
                </div>

                <div class="grid gap-2">
                    <div class="flex items-center justify-between gap-2">
                        <Label for="ai-provider-url">{{ t("settings.ai_config.base_url") }}</Label>
                        <Button
                            v-if="draftTemplate?.defaultBaseUrl && draft.baseUrl !== draftTemplate.defaultBaseUrl"
                            type="button"
                            variant="link"
                            size="xs"
                            class="h-auto p-0 text-xs"
                            @click="draft.baseUrl = draftTemplate.defaultBaseUrl"
                        >
                            {{ t("settings.ai_config.base_url_reset") }}
                        </Button>
                    </div>
                    <Input id="ai-provider-url" v-model="draft.baseUrl" class="font-mono" placeholder="https://" />
                </div>

                <div class="grid gap-4 sm:grid-cols-2">
                    <div class="grid gap-2">
                        <Label for="ai-provider-name">{{ t("settings.ai_config.provider_name") }}</Label>
                        <Input
                            id="ai-provider-name"
                            v-model="draft.name"
                            :placeholder="t('settings.ai_config.provider_name_placeholder')"
                        />
                    </div>
                    <div class="grid gap-2">
                        <Label>{{ t("settings.ai_config.provider_template") }}</Label>
                        <Select v-model="draft.templateId">
                            <SelectTrigger class="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem v-for="item in templates" :key="item.id" :value="item.id">{{ item.name }}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <Collapsible v-model:open="limitsOpen">
                    <CollapsibleTrigger as-child>
                        <Button type="button" variant="ghost" size="sm" class="-ml-2 text-muted-foreground">
                            <ChevronRight class="transition-transform" :class="limitsOpen && 'rotate-90'" />
                            {{ t("settings.ai_config.limits_title") }}
                            <span class="font-normal">
                                ·
                                {{
                                    draft.requestsPerMinute
                                        ? t("settings.ai_config.spec_limits_rpm", {
                                              concurrency: draft.maxConcurrency,
                                              rpm: draft.requestsPerMinute,
                                          })
                                        : t("settings.ai_config.spec_limits", { concurrency: draft.maxConcurrency })
                                }}
                            </span>
                        </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent class="mt-3 grid gap-3">
                        <div class="grid gap-4 sm:grid-cols-2">
                            <NumberField v-model="draft.maxConcurrency" :min="1" :max="256" class="grid gap-2">
                                <Label>{{ t("settings.ai_config.label_max_concurrency") }}</Label>
                                <NumberFieldContent>
                                    <NumberFieldDecrement />
                                    <NumberFieldInput />
                                    <NumberFieldIncrement />
                                </NumberFieldContent>
                            </NumberField>
                            <NumberField v-model="draft.requestsPerMinute" :min="1" class="grid gap-2">
                                <Label>{{ t("settings.ai_config.label_rpm") }}</Label>
                                <NumberFieldContent>
                                    <NumberFieldInput class="px-3 text-left" :placeholder="t('settings.ai_config.rpm_unlimited')" />
                                </NumberFieldContent>
                            </NumberField>
                        </div>
                        <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.limits_hint") }}</p>
                    </CollapsibleContent>
                </Collapsible>

                <div v-if="isDirty" class="flex items-center justify-end gap-2 border-t pt-4">
                    <Button type="button" variant="ghost" @click="draft = toDraft(provider)">{{ t("settings.ai_config.discard") }}</Button>
                    <Button type="submit" :disabled="isSaving">
                        <Loader2 v-if="isSaving" class="animate-spin" />
                        {{ t("settings.ai_config.save_and_check") }}
                    </Button>
                </div>
            </form>
        </section>

        <!-- Models -->
        <section class="grid grid-cols-1 gap-4">
            <div class="flex items-center justify-between gap-3">
                <div>
                    <h4 class="text-sm font-semibold">
                        {{ t("settings.ai_config.models_title") }}
                        <span class="font-normal text-muted-foreground">· {{ models.length }}</span>
                    </h4>
                    <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.models_desc") }}</p>
                </div>
                <Button size="sm" @click="pickerOpen = true">
                    <Plus />
                    {{ t("settings.ai_config.model_add") }}
                </Button>
            </div>

            <div v-if="models.length === 0" class="grid justify-items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
                <p class="text-sm text-muted-foreground">{{ t("settings.ai_config.models_empty") }}</p>
                <Button variant="outline" size="sm" @click="pickerOpen = true">
                    <Plus />
                    {{ t("settings.ai_config.model_add") }}
                </Button>
            </div>

            <div v-for="group in modelGroups" :key="group.category" class="grid gap-2">
                <p class="text-xs font-medium text-muted-foreground">{{ t(`settings.ai_config.category_${group.category}`) }}</p>
                <ul class="divide-y rounded-lg border">
                    <li v-for="model in group.models" :key="model.id" class="group flex items-center gap-3 px-3 py-2.5">
                        <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-medium">{{ model.display_name }}</p>
                            <p class="truncate text-xs text-muted-foreground">
                                <span v-if="model.display_name !== model.name" class="font-mono">{{ model.name }} · </span>
                                {{ describeModelSpec(model.capabilities, t) }}
                            </p>
                        </div>
                        <div
                            class="flex shrink-0 items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                        >
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                :aria-label="t('settings.ai_config.model_edit')"
                                @click="openForm({ model })"
                            >
                                <Pencil />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                class="text-muted-foreground hover:text-destructive"
                                :aria-label="t('settings.ai_config.model_delete')"
                                @click="pendingDelete = { kind: 'model', model }"
                            >
                                <Trash2 />
                            </Button>
                        </div>
                    </li>
                </ul>
            </div>
        </section>

        <Dialog v-model:open="pickerOpen">
            <DialogContent class="flex h-[85vh] max-h-[720px] flex-col gap-4 p-0 sm:max-w-2xl">
                <AiModelPicker
                    :provider="provider"
                    :models="models"
                    :listed-ids="check?.ok ? check.models : null"
                    @added="emit('changed')"
                    @configure="(initial) => openForm({ initial })"
                    @custom="openForm({})"
                />
            </DialogContent>
        </Dialog>

        <Dialog :open="form !== null" @update:open="(open) => open || (form = null)">
            <DialogContent class="flex max-h-[90vh] flex-col gap-4 p-0 sm:max-w-xl">
                <AiModelForm
                    v-if="form"
                    :key="form.key"
                    :provider="provider"
                    :adapter="template?.adapter ?? 'openai-compatible'"
                    :model="form.model"
                    :initial="form.initial"
                    @saved="onModelSaved"
                    @cancel="form = null"
                />
            </DialogContent>
        </Dialog>

        <AlertDialog :open="pendingDelete !== null" @update:open="(open) => open || (pendingDelete = null)">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {{
                            pendingDelete?.kind === "model"
                                ? t("settings.ai_config.model_delete_title", { name: pendingDelete.model.display_name })
                                : t("settings.ai_config.provider_delete_title", { name: provider.name })
                        }}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {{
                            pendingDelete?.kind === "model"
                                ? t("settings.ai_config.model_delete_desc")
                                : t("settings.ai_config.provider_delete_desc", { count: models.length })
                        }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("settings.ai_config.cancel") }}</AlertDialogCancel>
                    <AlertDialogAction
                        class="bg-destructive text-white hover:bg-destructive/90"
                        :disabled="isDeleting"
                        @click="confirmDelete"
                    >
                        {{ t("settings.ai_config.delete") }}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </div>
</template>
