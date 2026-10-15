<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { Loader2, Plus, Sparkles } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import AiProviderAvatar from "@/components/settings/AiProviderAvatar.vue";
import AiProviderCreateDialog from "@/components/settings/AiProviderCreateDialog.vue";
import AiProviderDetail from "@/components/settings/AiProviderDetail.vue";
import { cn } from "@/lib/utils";
import type { AiConnectionTestResult, AiModel, AiProvider, AiProviderTemplate } from "@/types/ai";
import type { ApiResponse } from "@/types/api";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const templates = ref<AiProviderTemplate[]>([]);
const providers = ref<AiProvider[]>([]);
const models = ref<AiModel[]>([]);
const isLoading = ref(true);
const createOpen = ref(false);

/** Connection checks of this session, by provider id; they also tell the model picker what a provider serves. */
const checks = ref<Record<string, AiConnectionTestResult>>({});
const checking = ref(new Set<string>());

const modelsOf = (providerId: string) => models.value.filter((model) => model.provider_id === providerId);

/** The selected provider lives in the URL, so a reload or a shared link keeps it. */
const selected = computed(() => providers.value.find((provider) => provider.id === route.query.provider) ?? providers.value[0] ?? null);
const select = (id: string) => router.replace({ query: { ...route.query, provider: id } });

const fetchAll = async () => {
    const [templateRes, providerRes, modelRes] = await Promise.all([
        useApi<ApiResponse<AiProviderTemplate[]>>("/ai/provider-templates"),
        useApi<ApiResponse<AiProvider[]>>("/ai/providers"),
        useApi<ApiResponse<AiModel[]>>("/ai/models"),
    ]);
    templates.value = templateRes?.data ?? [];
    providers.value = providerRes?.data ?? [];
    models.value = modelRes?.data ?? [];
};

const refresh = async () => {
    try {
        await fetchAll();
    } catch (err) {
        console.error("Failed to load AI services", err);
        toast.error(t("settings.ai_config.err_load"));
    }
};

onMounted(async () => {
    await refresh();
    isLoading.value = false;
});

const runCheck = async (providerId: string) => {
    checking.value = new Set(checking.value).add(providerId);
    try {
        const res = await useApi<ApiResponse<AiConnectionTestResult>>(`/ai/providers/${providerId}/test`, { method: "POST" });
        if (res?.data) checks.value = { ...checks.value, [providerId]: res.data };
    } catch (err) {
        console.error("Failed to check AI provider", err);
        toast.error(t("settings.ai_config.err_load"));
    } finally {
        const next = new Set(checking.value);
        next.delete(providerId);
        checking.value = next;
    }
};

// Opening a provider checks it once: the status is what users look for first, and the listing feeds the model picker.
watch(
    () => selected.value?.id,
    (id) => {
        if (id && !checks.value[id] && !checking.value.has(id)) void runCheck(id);
    },
    { immediate: true },
);

const onCreated = async (provider: AiProvider) => {
    await refresh();
    await select(provider.id);
};

const onDeleted = async () => {
    await refresh();
    await router.replace({ query: { ...route.query, provider: undefined } });
};

const statusDot = (providerId: string) => {
    if (checking.value.has(providerId)) return "bg-zinc-300 animate-pulse dark:bg-zinc-600";
    const check = checks.value[providerId];
    if (!check) return "bg-zinc-300 dark:bg-zinc-600";
    return check.ok ? "bg-emerald-500" : "bg-red-500";
};
</script>

<template>
    <div class="grid grid-cols-1 gap-6">
        <div v-if="isLoading" class="flex justify-center py-16 text-muted-foreground">
            <Loader2 class="size-6 animate-spin" />
        </div>

        <!-- First run: one clear action instead of an empty two-pane layout. -->
        <div
            v-else-if="providers.length === 0"
            class="grid justify-items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
        >
            <div class="flex size-12 items-center justify-center rounded-full bg-muted">
                <Sparkles class="size-6 text-muted-foreground" />
            </div>
            <div class="grid gap-1">
                <p class="font-medium">{{ t("settings.ai_config.empty_title") }}</p>
                <p class="max-w-sm text-sm text-muted-foreground">{{ t("settings.ai_config.empty_desc") }}</p>
            </div>
            <Button @click="createOpen = true">
                <Plus />
                {{ t("settings.ai_config.provider_add") }}
            </Button>
        </div>

        <div v-else class="grid grid-cols-1 gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
            <nav class="grid content-start gap-1" :aria-label="t('settings.ai_config.providers_title')">
                <div class="mb-1 flex items-center justify-between px-1">
                    <span class="text-xs font-medium text-muted-foreground">{{ t("settings.ai_config.providers_title") }}</span>
                    <Button variant="ghost" size="icon-xs" :aria-label="t('settings.ai_config.provider_add')" @click="createOpen = true">
                        <Plus />
                    </Button>
                </div>
                <Button
                    v-for="provider in providers"
                    :key="provider.id"
                    variant="ghost"
                    :aria-current="selected?.id === provider.id ? 'page' : undefined"
                    :class="
                        cn(
                            'h-auto justify-start gap-3 px-2 py-2 text-left',
                            selected?.id === provider.id && 'bg-accent text-accent-foreground',
                        )
                    "
                    @click="select(provider.id)"
                >
                    <AiProviderAvatar :name="provider.name" />
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium">{{ provider.name }}</span>
                        <span class="block truncate text-xs font-normal text-muted-foreground">
                            {{ t("settings.ai_config.provider_model_count", modelsOf(provider.id).length) }}
                        </span>
                    </span>
                    <span :class="cn('size-2 shrink-0 rounded-full', statusDot(provider.id))" aria-hidden="true" />
                </Button>
            </nav>

            <AiProviderDetail
                v-if="selected"
                :key="selected.id"
                class="min-w-0 md:border-l md:pl-6"
                :provider="selected"
                :templates="templates"
                :models="modelsOf(selected.id)"
                :check="checks[selected.id]"
                :checking="checking.has(selected.id)"
                @changed="refresh"
                @check="runCheck(selected.id)"
                @deleted="onDeleted"
            />
        </div>

        <AiProviderCreateDialog v-model:open="createOpen" :templates="templates" @created="onCreated" />
    </div>
</template>
