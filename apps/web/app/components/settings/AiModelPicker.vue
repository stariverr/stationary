<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import { Check, Loader2, PenLine, Plus, Search, Settings2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    describeModelSpec,
    isGenerationCapabilities,
    type AiCatalogGroup,
    type AiCatalogModel,
    type AiModel,
    type AiModelCategory,
    type AiProvider,
} from "@/types/ai";
import type { ApiResponse } from "@/types/api";

const props = defineProps<{
    provider: AiProvider;
    /** Models already added to the provider. */
    models: AiModel[];
    /** Model ids the provider's API listed in the last connection check; null until a check succeeded. */
    listedIds: string[] | null;
}>();

const emit = defineEmits<{
    added: [];
    /** A listed id without a known definition, or one the user wants to adjust before adding. */
    configure: [initial: { name: string; definition: AiCatalogModel | null }];
    custom: [];
}>();

const { t } = useI18n();

interface Row {
    name: string;
    definition: AiCatalogModel | null;
}

interface RowGroup {
    name: string;
    rows: Row[];
}

const catalog = ref<AiCatalogGroup[]>([]);
const listedDefinitions = ref(new Map<string, AiCatalogModel>());
const isLoading = ref(true);

onMounted(async () => {
    const listedIds = props.listedIds ?? [];
    const [own, listed] = await Promise.allSettled([
        useApi<ApiResponse<AiCatalogGroup[]>>(`/ai/providers/${props.provider.id}/catalog`),
        listedIds.length > 0
            ? useApi<ApiResponse<AiCatalogModel[]>>(`/ai/providers/${props.provider.id}/catalog/match`, {
                  method: "POST",
                  body: { ids: listedIds },
              })
            : Promise.resolve(null),
    ]);
    if (own.status === "fulfilled") catalog.value = own.value?.data ?? [];
    else console.error("Failed to load the model catalog", own.reason);
    if (listed.status === "fulfilled") listedDefinitions.value = new Map((listed.value?.data ?? []).map((model) => [model.name, model]));
    else console.error("Failed to match the provider's models", listed.reason);
    isLoading.value = false;
});

/** Mirrors the server: gateways prefix ids with a vendor namespace and vary their case. */
const normalizeModelId = (id: string) => {
    const trimmed = id.trim().toLowerCase();
    return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

/** What the provider's API listed comes first: it really serves those ids. The catalog fills in the rest. */
const groups = computed<RowGroup[]>(() => {
    const listedIds = props.listedIds ?? [];
    const listedKeys = new Set(listedIds.map(normalizeModelId));
    return [
        {
            name: t("settings.ai_config.catalog_listed"),
            rows: listedIds.map((name) => ({ name, definition: listedDefinitions.value.get(name) ?? null })),
        },
        ...catalog.value.map((group) => ({
            name: group.name,
            rows: group.models
                .filter((model) => !listedKeys.has(normalizeModelId(model.name)))
                .map((model) => ({ name: model.name, definition: model })),
        })),
    ].filter((group) => group.rows.length > 0);
});

const search = ref("");
const category = ref<"all" | AiModelCategory>("all");

const categories = computed(() => {
    const present = new Set(
        groups.value.flatMap((group) => group.rows.flatMap((row) => (row.definition ? [row.definition.category] : []))),
    );
    return (["generation", "embedding", "rerank"] as const).filter((value) => present.has(value));
});

const visibleGroups = computed(() => {
    const query = search.value.trim().toLowerCase();
    return groups.value
        .map((group) => ({
            ...group,
            rows: group.rows.filter(
                (row) =>
                    (category.value === "all" || row.definition?.category === category.value) &&
                    (!query || row.name.toLowerCase().includes(query) || row.definition?.displayName.toLowerCase().includes(query)),
            ),
        }))
        .filter((group) => group.rows.length > 0);
});

/** A typed id that matches no row exactly, offered as a custom model. */
const customId = computed(() => {
    const id = search.value.trim();
    if (!id || /\s/.test(id)) return null;
    const known = groups.value.some((group) => group.rows.some((row) => row.name.toLowerCase() === id.toLowerCase()));
    return known ? null : id;
});

const addedNames = computed(() => new Set(props.models.map((model) => model.name)));

/** Generation models only describe images; a text-only one fits no role. */
const isUnusable = (definition: AiCatalogModel) =>
    isGenerationCapabilities(definition.capabilities) && !definition.capabilities.inputModalities.includes("image");

const addingName = ref<string | null>(null);

const quickAdd = async (row: Row) => {
    const definition = row.definition;
    if (!definition) return;
    addingName.value = row.name;
    try {
        await useApi<ApiResponse<AiModel>>("/ai/models", {
            method: "POST",
            body: {
                provider_id: props.provider.id,
                name: row.name,
                display_name: definition.displayName,
                category: definition.category,
                capabilities: definition.capabilities,
            },
        });
        toast.success(t("settings.ai_config.model_added", { model: definition.displayName }));
        emit("added");
    } catch (err) {
        console.error("Failed to add AI model", err);
        const message = (err as { data?: { message?: string } })?.data?.message;
        toast.error(message || t("settings.ai_config.err_save"));
    } finally {
        addingName.value = null;
    }
};
</script>

<template>
    <DialogHeader class="px-6 pt-6">
        <DialogTitle>{{ t("settings.ai_config.model_picker_title", { provider: provider.name }) }}</DialogTitle>
        <DialogDescription>{{ t("settings.ai_config.model_picker_desc") }}</DialogDescription>
    </DialogHeader>

    <div class="grid gap-3 px-6">
        <div class="relative">
            <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="search" class="pl-9" :placeholder="t('settings.ai_config.catalog_search')" />
        </div>
        <Tabs v-if="categories.length > 1" v-model="category">
            <TabsList>
                <TabsTrigger value="all">{{ t("settings.ai_config.picker_all") }}</TabsTrigger>
                <TabsTrigger v-for="value in categories" :key="value" :value="value">
                    {{ t(`settings.ai_config.category_${value}`) }}
                </TabsTrigger>
            </TabsList>
        </Tabs>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-6">
        <div v-if="isLoading" class="flex justify-center py-12 text-muted-foreground">
            <Loader2 class="size-5 animate-spin" />
        </div>
        <template v-else>
            <p v-if="listedIds === null" class="mb-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                {{ t("settings.ai_config.picker_check_first") }}
            </p>
            <Button
                v-if="customId"
                variant="outline"
                class="mb-4 h-auto w-full justify-start gap-3 border-dashed px-3 py-2.5 text-left"
                @click="emit('configure', { name: customId, definition: null })"
            >
                <PenLine />
                <span class="min-w-0 truncate font-normal">
                    {{ t("settings.ai_config.catalog_use_custom") }}
                    <span class="font-mono font-medium">{{ customId }}</span>
                </span>
            </Button>
            <p v-if="visibleGroups.length === 0 && !customId" class="py-12 text-center text-sm text-muted-foreground">
                {{ t("settings.ai_config.catalog_empty") }}
            </p>
            <section v-for="group in visibleGroups" :key="group.name" class="pb-4">
                <h3 class="sticky top-0 z-10 bg-background py-2 text-xs font-medium text-muted-foreground">
                    {{ group.name }} · {{ group.rows.length }}
                </h3>
                <ul class="divide-y rounded-md border">
                    <li v-for="row in group.rows" :key="row.name" class="flex items-center gap-3 px-3 py-2.5">
                        <div class="min-w-0 flex-1">
                            <template v-if="row.definition">
                                <div class="flex items-center gap-2">
                                    <span class="truncate text-sm font-medium">{{ row.definition.displayName }}</span>
                                    <Badge variant="secondary" class="shrink-0 font-normal">
                                        {{ t(`settings.ai_config.category_${row.definition.category}`) }}
                                    </Badge>
                                </div>
                                <p class="truncate text-xs text-muted-foreground">
                                    <span class="font-mono">{{ row.name }}</span> · {{ describeModelSpec(row.definition.capabilities, t) }}
                                </p>
                            </template>
                            <template v-else>
                                <p class="truncate font-mono text-sm">{{ row.name }}</p>
                                <p class="truncate text-xs text-muted-foreground">{{ t("settings.ai_config.picker_unknown") }}</p>
                            </template>
                        </div>
                        <Button v-if="addedNames.has(row.name)" variant="ghost" size="sm" disabled class="shrink-0">
                            <Check />
                            {{ t("settings.ai_config.picker_added") }}
                        </Button>
                        <span v-else-if="row.definition && isUnusable(row.definition)" class="shrink-0 text-xs text-muted-foreground">
                            {{ t("settings.ai_config.picker_text_only") }}
                        </span>
                        <div v-else-if="row.definition" class="flex shrink-0 items-center gap-1">
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                class="text-muted-foreground"
                                :aria-label="t('settings.ai_config.picker_configure')"
                                :title="t('settings.ai_config.picker_configure')"
                                @click="emit('configure', { name: row.name, definition: row.definition })"
                            >
                                <Settings2 />
                            </Button>
                            <Button variant="outline" size="sm" :disabled="addingName !== null" @click="quickAdd(row)">
                                <Loader2 v-if="addingName === row.name" class="animate-spin" />
                                <Plus v-else />
                                {{ t("settings.ai_config.picker_add") }}
                            </Button>
                        </div>
                        <Button
                            v-else
                            variant="outline"
                            size="sm"
                            class="shrink-0"
                            @click="emit('configure', { name: row.name, definition: null })"
                        >
                            <Settings2 />
                            {{ t("settings.ai_config.picker_set_up") }}
                        </Button>
                    </li>
                </ul>
            </section>
        </template>
    </div>

    <DialogFooter class="border-t px-6 py-4 sm:justify-start">
        <Button variant="outline" @click="emit('custom')">
            <PenLine />
            {{ t("settings.ai_config.model_custom_title") }}
        </Button>
    </DialogFooter>
</template>
