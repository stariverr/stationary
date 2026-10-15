<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { ChevronRight, CircleCheck, CircleX, Info, Loader2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberField, NumberFieldContent, NumberFieldInput } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    AI_REASONING_LEVELS,
    EMBEDDING_DIMENSIONS,
    isEmbeddingCapabilities,
    isGenerationCapabilities,
    type AiCatalogModel,
    type AiModality,
    type AiModel,
    type AiModelCategory,
    type AiModelProbeResult,
    type AiProvider,
    type AiProviderAdapter,
    type AiReasoningLevel,
} from "@/types/ai";
import type { ApiResponse } from "@/types/api";

const props = defineProps<{
    provider: AiProvider;
    adapter: AiProviderAdapter;
    /** Model being edited. Fields that define its identity or vector space stay fixed. */
    model?: AiModel;
    /** A model id picked from the provider's listing, with its known definition if any; the id is then fixed. */
    initial?: { name: string; definition: AiCatalogModel | null };
}>();

const emit = defineEmits<{
    saved: [model: AiModel];
    cancel: [];
}>();

const { t } = useI18n();

const imageFormatChoices = [
    { mimeType: "image/jpeg", label: "JPEG" },
    { mimeType: "image/png", label: "PNG" },
    { mimeType: "image/webp", label: "WebP" },
    { mimeType: "image/gif", label: "GIF" },
    { mimeType: "image/avif", label: "AVIF" },
    { mimeType: "image/heic", label: "HEIC" },
    { mimeType: "image/heif", label: "HEIF" },
    { mimeType: "image/jxl", label: "JXL" },
];
const modalityChoices: AiModality[] = ["text", "image", "audio", "video", "pdf"];

// --- Model definition form ---
interface ModelDraft {
    name: string;
    /** Empty shows the model id. */
    displayName: string;
    category: AiModelCategory;
    contextLimit: number;
    outputLimit: number;
    inputModalities: AiModality[];
    imageFormats: string[];
    structuredOutput: boolean;
    /** Levels the model accepts; null when unknown, then every level is offered. */
    reasoningLevels: AiReasoningLevel[] | null;
    /** Empty leaves the provider's default. */
    reasoning: AiReasoningLevel | "";
    optionsText: string;
    dimension: number;
    mrl: boolean;
    taskPrefix: boolean;
    dimensionChoices: number[];
    /** Search cut-offs; empty uses the server defaults. */
    matchText: number | "";
    matchImage: number | "";
}

const draft = ref<ModelDraft | null>(null);
/** Once edited by hand, the display name no longer follows the matched model. */
const displayNameEdited = ref(false);
const customImageFormat = ref("");
const isSaving = ref(false);

const startCustom = () => {
    draft.value = {
        name: "",
        displayName: "",
        category: props.adapter === "dashscope-native" ? "embedding" : "generation",
        contextLimit: 128000,
        outputLimit: 8192,
        inputModalities: ["text", "image"],
        imageFormats: ["image/jpeg", "image/png", "image/webp"],
        structuredOutput: true,
        reasoningLevels: null,
        reasoning: "",
        optionsText: "",
        dimension: 1024,
        mrl: false,
        taskPrefix: false,
        dimensionChoices: [...EMBEDDING_DIMENSIONS],
        matchText: "",
        matchImage: "",
    };
};

/** Fills the form from a known definition, keeping the model id the provider serves. */
const applyDefinition = (model: AiCatalogModel) => {
    const name = draft.value?.name ?? model.name;
    const spec = model.capabilities;
    const base = {
        name,
        displayName: displayNameEdited.value && draft.value ? draft.value.displayName : model.displayName,
        reasoningLevels: null,
        reasoning: "" as const,
        optionsText: "",
        dimension: 1024,
        mrl: false,
        taskPrefix: false,
        dimensionChoices: [...EMBEDDING_DIMENSIONS],
        matchText: "" as const,
        matchImage: "" as const,
    };
    if (!isEmbeddingCapabilities(spec) && !isGenerationCapabilities(spec)) {
        draft.value = {
            ...base,
            category: "rerank",
            contextLimit: spec.maxInputTokens,
            outputLimit: 0,
            inputModalities: ["text"],
            imageFormats: [],
            structuredOutput: false,
        };
    } else if (isEmbeddingCapabilities(spec)) {
        draft.value = {
            ...base,
            category: "embedding",
            contextLimit: spec.maxInputTokens,
            outputLimit: 0,
            inputModalities: spec.multimodal ? ["text", "image"] : ["text"],
            imageFormats: spec.imageFormats ?? ["image/jpeg", "image/png"],
            structuredOutput: false,
            dimension: spec.dimension,
            mrl: spec.mrl,
            taskPrefix: spec.taskPrefixType === "gemini-asymmetric",
            dimensionChoices: model.supportedDimensions ?? [spec.dimension],
            matchText: spec.matchDistance?.text ?? "",
            matchImage: spec.matchDistance?.image ?? "",
        };
    } else {
        draft.value = {
            ...base,
            category: "generation",
            contextLimit: spec.contextWindow,
            outputLimit: spec.maxOutputTokens ?? 0,
            inputModalities: [...spec.inputModalities],
            imageFormats: spec.imageFormats ?? ["image/jpeg", "image/png", "image/webp"],
            structuredOutput: spec.structuredOutput,
            reasoningLevels: spec.reasoningLevels ?? null,
            reasoning: spec.reasoning ?? "",
            optionsText: spec.options ? JSON.stringify(spec.options) : "",
        };
    }
};

/** Editing reuses the definition mapping; the saved model's identity fields are then locked. */
const startEditing = (model: AiModel) => {
    applyDefinition({
        name: model.name,
        displayName: model.display_name,
        category: model.category,
        capabilities: model.capabilities,
        supportedDimensions: isEmbeddingCapabilities(model.capabilities) ? [model.capabilities.dimension] : undefined,
    });
};

if (props.model) {
    startEditing(props.model);
} else {
    startCustom();
    if (props.initial && draft.value) {
        draft.value.name = props.initial.name;
        if (props.initial.definition) applyDefinition(props.initial.definition);
    }
}

// --- Known model definitions ---
/** The known model the current id resolved to; its definition filled the form. */
const matched = ref<AiCatalogModel | null>(props.initial?.definition ?? null);
const lookup = ref<"idle" | "loading" | "done">(props.initial ? "done" : "idle");
let lookupSeq = 0;
/** The id the form was last filled for, so re-blurring the same id does not reset edits. */
let resolvedName = props.initial?.name ?? "";

const resolveName = async () => {
    const id = draft.value?.name.trim() ?? "";
    if (id === resolvedName) return;
    resolvedName = id;
    const seq = ++lookupSeq;
    if (!id) {
        matched.value = null;
        lookup.value = "idle";
        return;
    }

    lookup.value = "loading";
    let definition: AiCatalogModel | null = null;
    try {
        const res = await useApi<ApiResponse<AiCatalogModel[]>>(`/ai/providers/${props.provider.id}/catalog/match`, {
            method: "POST",
            body: { ids: [id] },
        });
        definition = res?.data?.[0] ?? null;
    } catch (err) {
        console.error("Failed to look up the model", err);
    }
    if (seq !== lookupSeq) return;

    lookup.value = "done";
    matched.value = definition;
    if (definition) applyDefinition(definition);
};

const onDisplayNameInput = (value: string | number) => {
    if (!draft.value) return;
    draft.value.displayName = String(value);
    displayNameEdited.value = draft.value.displayName.trim() !== "";
};

/** A matched generation model without image input cannot fill the image description role. */
const matchedWithoutImages = computed(() => {
    const spec = matched.value?.capabilities;
    return spec !== undefined && isGenerationCapabilities(spec) && !spec.inputModalities.includes("image");
});

const hasImageInput = computed(() => draft.value?.inputModalities.includes("image") ?? false);
/** The OpenAI embeddings protocol has no image input, so only Gemini and DashScope models embed images. */
const canEmbedImages = computed(() => props.adapter !== "openai-compatible");
const customImageFormats = computed(() => {
    const known = new Set(imageFormatChoices.map((format) => format.mimeType));
    return (draft.value?.imageFormats ?? []).filter((format) => !known.has(format));
});

/** Text input is required, so it stays selected whatever the toggle group reports. */
const setModalities = (value: unknown) => {
    if (!draft.value || !Array.isArray(value)) return;
    draft.value.inputModalities = ["text", ...(value as AiModality[]).filter((modality) => modality !== "text")];
};

const setImageFormats = (value: unknown) => {
    if (!draft.value || !Array.isArray(value)) return;
    draft.value.imageFormats = value as string[];
};

const advancedOpen = ref(false);

const addCustomImageFormat = () => {
    const mimeType = customImageFormat.value.trim().toLowerCase();
    if (!draft.value || !/^image\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType)) {
        toast.error(t("settings.ai_config.image_format_invalid"));
        return;
    }
    if (!draft.value.imageFormats.includes(mimeType)) {
        draft.value.imageFormats = [...draft.value.imageFormats, mimeType];
    }
    customImageFormat.value = "";
};

/** "default" stands for the provider's default: select items cannot carry an empty value. */
const DEFAULT_REASONING = "default";
const reasoningChoices = computed(() => draft.value?.reasoningLevels ?? [...AI_REASONING_LEVELS]);
const setReasoning = (value: unknown) => {
    if (!draft.value) return;
    draft.value.reasoning = AI_REASONING_LEVELS.includes(value as AiReasoningLevel) ? (value as AiReasoningLevel) : "";
};

const setCategory = (value: unknown) => {
    if (!draft.value || (value !== "generation" && value !== "embedding" && value !== "rerank")) return;
    draft.value.category = value;
    draft.value.contextLimit = value === "generation" ? 128000 : 8192;
    draft.value.inputModalities = value === "generation" ? ["text", "image"] : ["text"];
};

/** The definition the form describes, as the API takes it; null (with a toast) when invalid. */
const buildDefinition = () => {
    const current = draft.value;
    if (!current) return null;
    if (!current.name.trim()) {
        toast.error(t("settings.ai_config.model_name_required"));
        return null;
    }
    if (hasImageInput.value && current.imageFormats.length === 0) {
        toast.error(t("settings.ai_config.image_formats_required"));
        return null;
    }

    let options: Record<string, unknown> | undefined;
    if (current.category === "generation" && current.optionsText.trim()) {
        try {
            const parsed: unknown = JSON.parse(current.optionsText);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
            options = parsed as Record<string, unknown>;
        } catch {
            toast.error(t("settings.ai_config.options_invalid"));
            return null;
        }
    }

    const capabilities =
        current.category === "rerank"
            ? { maxInputTokens: current.contextLimit }
            : current.category === "embedding"
              ? {
                    dimension: current.dimension,
                    mrl: current.mrl,
                    maxInputTokens: current.contextLimit,
                    multimodal: hasImageInput.value,
                    ...(hasImageInput.value ? { imageFormats: current.imageFormats } : {}),
                    ...(current.taskPrefix ? { taskPrefixType: "gemini-asymmetric" } : {}),
                    ...(current.matchText !== "" || current.matchImage !== ""
                        ? {
                              matchDistance: {
                                  ...(current.matchText !== "" ? { text: Number(current.matchText) } : {}),
                                  ...(current.matchImage !== "" && hasImageInput.value ? { image: Number(current.matchImage) } : {}),
                              },
                          }
                        : {}),
                }
              : {
                    contextWindow: current.contextLimit,
                    ...(current.outputLimit > 0 ? { maxOutputTokens: current.outputLimit } : {}),
                    inputModalities: current.inputModalities,
                    ...(hasImageInput.value ? { imageFormats: current.imageFormats } : {}),
                    structuredOutput: current.structuredOutput,
                    ...(current.reasoningLevels ? { reasoningLevels: current.reasoningLevels } : {}),
                    ...(current.reasoning ? { reasoning: current.reasoning } : {}),
                    ...(options ? { options } : {}),
                };

    const name = current.name.trim();
    return { name, display_name: current.displayName.trim() || name, category: current.category, capabilities };
};

// --- Live verification ---
const probeResults = ref<AiModelProbeResult[] | null>(null);
const isProbing = ref(false);

// Results describe the definition that was tested; any edit makes them stale.
watch(draft, () => (probeResults.value = null), { deep: true });

const probe = async () => {
    const definition = buildDefinition();
    if (!definition) return;
    isProbing.value = true;
    try {
        const res = await useApi<ApiResponse<AiModelProbeResult[]>>(`/ai/providers/${props.provider.id}/probe`, {
            method: "POST",
            body: definition,
        });
        probeResults.value = res?.data ?? null;
    } catch (err) {
        console.error("Failed to test AI model", err);
        const message = (err as { data?: { message?: string } })?.data?.message;
        toast.error(message || t("settings.ai_config.probe_failed"));
    } finally {
        isProbing.value = false;
    }
};

const save = async () => {
    const definition = buildDefinition();
    if (!definition) return;

    isSaving.value = true;
    try {
        const res = props.model
            ? await useApi<ApiResponse<AiModel>>(`/ai/models/${props.model.id}`, {
                  method: "PUT",
                  body: { display_name: definition.display_name, capabilities: definition.capabilities },
              })
            : await useApi<ApiResponse<AiModel>>("/ai/models", { method: "POST", body: { provider_id: props.provider.id, ...definition } });
        if (res?.data) {
            toast.success(t("settings.ai_config.model_saved"));
            emit("saved", res.data);
        }
    } catch (err) {
        console.error("Failed to save AI model", err);
        // The server explains rejected edits (e.g. a change that would alter the vector space).
        const message = (err as { data?: { message?: string } })?.data?.message;
        toast.error(message || t("settings.ai_config.err_save"));
    } finally {
        isSaving.value = false;
    }
};
</script>

<template>
    <template v-if="draft">
        <DialogHeader class="px-6 pt-6">
            <DialogTitle>
                {{
                    model
                        ? t("settings.ai_config.model_edit_title", { model: model.display_name })
                        : initial
                          ? t("settings.ai_config.model_add_title", { model: initial.definition?.displayName ?? initial.name })
                          : t("settings.ai_config.model_custom_title")
                }}
            </DialogTitle>
            <DialogDescription>{{ provider.name }}</DialogDescription>
        </DialogHeader>

        <div class="grid min-h-0 gap-5 overflow-y-auto px-6 py-1">
            <div class="grid gap-2">
                <Label for="ai-model-id">{{ t("settings.ai_config.model_name") }}</Label>
                <div class="flex items-center gap-2">
                    <Input
                        id="ai-model-id"
                        v-model="draft.name"
                        class="font-mono"
                        autocomplete="off"
                        :disabled="Boolean(model || initial)"
                        :placeholder="t('settings.ai_config.model_name_placeholder')"
                        @blur="resolveName"
                        @keydown.enter.prevent="resolveName"
                    />
                    <Badge v-if="model || matched" variant="secondary" class="shrink-0">
                        {{ t(`settings.ai_config.category_${draft.category}`) }}
                    </Badge>
                </div>
                <p v-if="!model" class="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <template v-if="lookup === 'loading'">
                        <Loader2 class="mt-px size-3.5 shrink-0 animate-spin" />
                        {{ t("settings.ai_config.model_lookup_loading") }}
                    </template>
                    <template v-else-if="matchedWithoutImages && matched">
                        <Info class="mt-px size-3.5 shrink-0 text-amber-600" />
                        {{ t("settings.ai_config.model_lookup_text_only", { model: matched.displayName }) }}
                    </template>
                    <template v-else-if="matched">
                        <CircleCheck class="mt-px size-3.5 shrink-0 text-emerald-600" />
                        {{ t("settings.ai_config.model_lookup_matched", { model: matched.displayName }) }}
                    </template>
                    <template v-else-if="lookup === 'done' && draft.name.trim()">
                        <Info class="mt-px size-3.5 shrink-0 text-amber-600" />
                        {{ t("settings.ai_config.model_lookup_unknown") }}
                    </template>
                    <template v-else>{{ t("settings.ai_config.model_lookup_hint") }}</template>
                </p>
            </div>

            <div class="grid gap-4" :class="!model && !matched && 'sm:grid-cols-[minmax(0,1fr)_13rem]'">
                <div class="grid gap-2">
                    <Label for="ai-model-display-name">{{ t("settings.ai_config.model_display_name") }}</Label>
                    <Input
                        id="ai-model-display-name"
                        :model-value="draft.displayName"
                        :placeholder="draft.name.trim() || t('settings.ai_config.model_display_name_placeholder')"
                        @update:model-value="onDisplayNameInput"
                    />
                </div>
                <div v-if="!model && !matched" class="grid gap-2">
                    <Label>{{ t("settings.ai_config.label_category") }}</Label>
                    <Select :model-value="draft.category" :disabled="adapter === 'dashscope-native'" @update:model-value="setCategory">
                        <SelectTrigger class="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="generation">{{ t("settings.ai_config.category_generation") }}</SelectItem>
                            <SelectItem value="embedding">{{ t("settings.ai_config.category_embedding") }}</SelectItem>
                            <SelectItem v-if="adapter === 'openai-compatible'" value="rerank">
                                {{ t("settings.ai_config.category_rerank") }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <Separator />

            <div v-if="draft.category === 'embedding'" class="grid gap-4 sm:grid-cols-2">
                <div class="grid gap-2">
                    <Label>{{ t("settings.ai_config.label_dimension") }}</Label>
                    <Select
                        :model-value="String(draft.dimension)"
                        :disabled="Boolean(model)"
                        @update:model-value="(value) => draft && (draft.dimension = Number(value))"
                    >
                        <SelectTrigger class="w-full font-mono">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem
                                v-for="dimension in draft.dimensionChoices"
                                :key="dimension"
                                :value="String(dimension)"
                                class="font-mono"
                            >
                                {{ dimension }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <NumberField v-model="draft.contextLimit" :min="1" class="grid gap-2">
                    <Label>{{ t("settings.ai_config.label_max_input") }}</Label>
                    <NumberFieldContent>
                        <NumberFieldInput class="px-3 text-left font-mono" />
                    </NumberFieldContent>
                </NumberField>
                <p class="text-xs text-muted-foreground sm:col-span-2">{{ t("settings.ai_config.dimension_hint") }}</p>
            </div>
            <div v-else-if="draft.category === 'rerank'" class="grid gap-2">
                <NumberField v-model="draft.contextLimit" :min="1" class="grid gap-2">
                    <Label>{{ t("settings.ai_config.label_max_input") }}</Label>
                    <NumberFieldContent>
                        <NumberFieldInput class="px-3 text-left font-mono" />
                    </NumberFieldContent>
                </NumberField>
                <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.rerank_hint") }}</p>
            </div>
            <div v-else class="grid gap-4 sm:grid-cols-2">
                <NumberField v-model="draft.contextLimit" :min="1" class="grid gap-2">
                    <Label>{{ t("settings.ai_config.label_context") }}</Label>
                    <NumberFieldContent>
                        <NumberFieldInput class="px-3 text-left font-mono" />
                    </NumberFieldContent>
                </NumberField>
                <NumberField v-model="draft.outputLimit" :min="0" class="grid gap-2">
                    <Label>{{ t("settings.ai_config.label_output") }}</Label>
                    <NumberFieldContent>
                        <NumberFieldInput class="px-3 text-left font-mono" />
                    </NumberFieldContent>
                </NumberField>
            </div>

            <div v-if="draft.category === 'generation' || (draft.category === 'embedding' && canEmbedImages)" class="grid gap-2">
                <Label>{{ t("settings.ai_config.label_modalities") }}</Label>
                <ToggleGroup
                    type="multiple"
                    variant="outline"
                    size="sm"
                    :spacing="1"
                    class="flex-wrap justify-start"
                    :model-value="draft.inputModalities"
                    @update:model-value="setModalities"
                >
                    <ToggleGroupItem
                        v-for="modality in draft.category === 'embedding' ? (['text', 'image'] as AiModality[]) : modalityChoices"
                        :key="modality"
                        :value="modality"
                        :disabled="modality === 'text'"
                        class="font-mono text-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                    >
                        {{ modality }}
                    </ToggleGroupItem>
                </ToggleGroup>
            </div>

            <template v-if="draft.category === 'generation'">
                <div class="flex items-center justify-between gap-4">
                    <div class="grid gap-1">
                        <Label for="ai-model-structured">{{ t("settings.ai_config.cap_structured") }}</Label>
                        <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.cap_structured_hint") }}</p>
                    </div>
                    <Switch
                        id="ai-model-structured"
                        :model-value="draft.structuredOutput"
                        @update:model-value="(value) => draft && (draft.structuredOutput = value)"
                    />
                </div>
                <div class="flex items-center justify-between gap-4">
                    <div class="grid gap-1">
                        <Label>{{ t("settings.ai_config.label_reasoning") }}</Label>
                        <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.reasoning_hint") }}</p>
                    </div>
                    <Select :model-value="draft.reasoning || DEFAULT_REASONING" @update:model-value="setReasoning">
                        <SelectTrigger class="w-44 shrink-0">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem :value="DEFAULT_REASONING">{{ t("settings.ai_config.reasoning_default") }}</SelectItem>
                            <SelectItem v-for="level in reasoningChoices" :key="level" :value="level">
                                {{ t(`settings.ai_config.reasoning_${level}`) }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </template>
            <template v-else-if="draft.category === 'embedding'">
                <div class="flex items-center justify-between gap-4">
                    <Label for="ai-model-mrl">{{ t("settings.ai_config.cap_mrl") }}</Label>
                    <Switch id="ai-model-mrl" :model-value="draft.mrl" @update:model-value="(value) => draft && (draft.mrl = value)" />
                </div>
                <div v-if="adapter === 'gemini'" class="flex items-center justify-between gap-4">
                    <Label for="ai-model-task-prefix">{{ t("settings.ai_config.cap_task_prefix") }}</Label>
                    <Switch
                        id="ai-model-task-prefix"
                        :model-value="draft.taskPrefix"
                        :disabled="Boolean(model)"
                        @update:model-value="(value) => draft && (draft.taskPrefix = value)"
                    />
                </div>
            </template>

            <!-- Tuning that catalog definitions already fill in; kept out of the way of the common path. -->
            <Collapsible v-if="draft.category !== 'rerank'" v-model:open="advancedOpen" class="pb-2">
                <CollapsibleTrigger as-child>
                    <Button variant="ghost" size="sm" class="-ml-2 text-muted-foreground">
                        <ChevronRight class="transition-transform" :class="advancedOpen && 'rotate-90'" />
                        {{ t("settings.ai_config.advanced") }}
                    </Button>
                </CollapsibleTrigger>
                <CollapsibleContent class="mt-3 grid gap-5">
                    <div v-if="hasImageInput" class="grid gap-2">
                        <Label>{{ t("settings.ai_config.label_image_formats") }}</Label>
                        <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.image_formats_hint") }}</p>
                        <ToggleGroup
                            type="multiple"
                            variant="outline"
                            size="sm"
                            :spacing="1"
                            class="flex-wrap justify-start"
                            :model-value="draft.imageFormats"
                            @update:model-value="setImageFormats"
                        >
                            <ToggleGroupItem
                                v-for="format in imageFormatChoices"
                                :key="format.mimeType"
                                :value="format.mimeType"
                                class="text-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                            >
                                {{ format.label }}
                            </ToggleGroupItem>
                            <ToggleGroupItem
                                v-for="format in customImageFormats"
                                :key="format"
                                :value="format"
                                class="font-mono text-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                            >
                                {{ format }}
                            </ToggleGroupItem>
                        </ToggleGroup>
                        <div class="flex gap-2">
                            <Input
                                v-model="customImageFormat"
                                class="font-mono"
                                placeholder="image/heic"
                                @keydown.enter.prevent="addCustomImageFormat"
                            />
                            <Button variant="outline" @click="addCustomImageFormat">{{ t("settings.ai_config.image_format_add") }}</Button>
                        </div>
                    </div>

                    <div v-if="draft.category === 'embedding'" class="grid gap-2">
                        <Label>{{ t("settings.ai_config.label_match_distance") }}</Label>
                        <div class="grid grid-cols-2 gap-3">
                            <NumberField
                                :model-value="draft.matchText === '' ? undefined : draft.matchText"
                                :min="0"
                                :max="2"
                                :step="0.05"
                                @update:model-value="(value) => draft && (draft.matchText = value ?? '')"
                            >
                                <NumberFieldContent>
                                    <NumberFieldInput
                                        class="px-3 text-left font-mono"
                                        :placeholder="t('settings.ai_config.match_text_placeholder')"
                                    />
                                </NumberFieldContent>
                            </NumberField>
                            <NumberField
                                v-if="hasImageInput"
                                :model-value="draft.matchImage === '' ? undefined : draft.matchImage"
                                :min="0"
                                :max="2"
                                :step="0.05"
                                @update:model-value="(value) => draft && (draft.matchImage = value ?? '')"
                            >
                                <NumberFieldContent>
                                    <NumberFieldInput
                                        class="px-3 text-left font-mono"
                                        :placeholder="t('settings.ai_config.match_image_placeholder')"
                                    />
                                </NumberFieldContent>
                            </NumberField>
                        </div>
                        <p class="text-xs text-muted-foreground">{{ t("settings.ai_config.match_distance_hint") }}</p>
                    </div>
                    <div v-else-if="draft.category === 'generation'" class="grid gap-2">
                        <Label for="ai-model-options">{{ t("settings.ai_config.label_options") }}</Label>
                        <Textarea
                            id="ai-model-options"
                            v-model="draft.optionsText"
                            rows="3"
                            class="font-mono text-xs"
                            :placeholder="t('settings.ai_config.options_placeholder')"
                        />
                    </div>
                </CollapsibleContent>
            </Collapsible>
        </div>

        <div class="grid gap-3 border-t px-6 py-4">
            <div v-if="probeResults" class="grid gap-1.5 rounded-md bg-muted/50 p-3">
                <p v-if="probeResults.length === 0" class="text-xs text-muted-foreground">{{ t("settings.ai_config.probe_nothing") }}</p>
                <div v-for="result in probeResults" :key="result.check" class="flex items-start gap-2 text-xs">
                    <CircleCheck v-if="result.ok" class="mt-px size-4 shrink-0 text-emerald-600" />
                    <CircleX v-else class="mt-px size-4 shrink-0 text-destructive" />
                    <span class="min-w-0">
                        <span class="font-medium">{{ t(`settings.ai_config.probe_check_${result.check}`) }}</span>
                        <span v-if="result.message" class="block break-words text-muted-foreground">{{ result.message }}</span>
                    </span>
                </div>
            </div>
            <DialogFooter class="sm:justify-between">
                <Button variant="outline" :disabled="isProbing" @click="probe">
                    <Loader2 v-if="isProbing" class="animate-spin" />
                    {{ isProbing ? t("settings.ai_config.probe_running") : t("settings.ai_config.probe") }}
                </Button>
                <div class="flex flex-col-reverse gap-2 sm:flex-row">
                    <Button variant="ghost" @click="emit('cancel')">{{ t("settings.ai_config.cancel") }}</Button>
                    <Button :disabled="isSaving" @click="save">
                        <Loader2 v-if="isSaving" class="animate-spin" />
                        {{ t("settings.ai_config.model_save") }}
                    </Button>
                </div>
            </DialogFooter>
        </div>
    </template>
</template>
