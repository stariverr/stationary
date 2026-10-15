<script setup lang="ts">
import { ref, watch } from "vue";
import { toast } from "vue-sonner";
import { ArrowLeft, ChevronRight, Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import AiProviderAvatar from "@/components/settings/AiProviderAvatar.vue";
import type { AiProvider, AiProviderTemplate } from "@/types/ai";
import type { ApiResponse } from "@/types/api";

const props = defineProps<{ templates: AiProviderTemplate[] }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ created: [provider: AiProvider] }>();

const { t } = useI18n();

/** Step one picks a template; step two fills the connection it presets. */
const template = ref<AiProviderTemplate | null>(null);
const name = ref("");
const baseUrl = ref("");
const apiKey = ref("");
const isSaving = ref(false);

watch(open, (value) => {
    if (value) template.value = null;
});

const pick = (picked: AiProviderTemplate) => {
    template.value = picked;
    name.value = picked.name;
    baseUrl.value = picked.defaultBaseUrl;
    apiKey.value = "";
};

const create = async () => {
    if (!template.value) return;
    if (!name.value.trim() || !baseUrl.value.trim()) {
        toast.error(t("settings.ai_config.provider_required"));
        return;
    }
    isSaving.value = true;
    try {
        const res = await useApi<ApiResponse<AiProvider>>("/ai/providers", {
            method: "POST",
            body: {
                template_id: template.value.id,
                name: name.value.trim(),
                base_url: baseUrl.value.trim(),
                ...(apiKey.value.trim() ? { api_key: apiKey.value.trim() } : {}),
            },
        });
        if (res?.data) {
            open.value = false;
            emit("created", res.data);
        }
    } catch (err) {
        console.error("Failed to create AI provider", err);
        const message = (err as { data?: { message?: string } })?.data?.message;
        toast.error(message || t("settings.ai_config.err_save"));
    } finally {
        isSaving.value = false;
    }
};
</script>

<template>
    <Dialog v-model:open="open">
        <DialogContent class="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
            <template v-if="!template">
                <DialogHeader class="p-6 pb-4">
                    <DialogTitle>{{ t("settings.ai_config.provider_add") }}</DialogTitle>
                    <DialogDescription>{{ t("settings.ai_config.provider_pick_template") }}</DialogDescription>
                </DialogHeader>
                <ul class="min-h-0 overflow-y-auto px-3 pb-3">
                    <li v-for="item in props.templates" :key="item.id">
                        <Button variant="ghost" class="h-auto w-full justify-start gap-3 px-3 py-2.5 text-left" @click="pick(item)">
                            <AiProviderAvatar :name="item.name" />
                            <span class="min-w-0 flex-1">
                                <span class="block truncate font-medium">{{ item.name }}</span>
                                <span class="block truncate text-xs font-normal text-muted-foreground">{{ item.description }}</span>
                            </span>
                            <ChevronRight class="text-muted-foreground" />
                        </Button>
                    </li>
                </ul>
            </template>

            <form v-else class="contents" @submit.prevent="create">
                <DialogHeader class="p-6 pb-4">
                    <DialogTitle class="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            class="-ml-2"
                            :aria-label="t('settings.ai_config.back')"
                            @click="template = null"
                        >
                            <ArrowLeft />
                        </Button>
                        {{ template.name }}
                    </DialogTitle>
                    <DialogDescription>{{ t("settings.ai_config.provider_connect_desc") }}</DialogDescription>
                </DialogHeader>
                <div class="grid gap-4 px-6 pb-2">
                    <div class="grid gap-2">
                        <Label for="ai-provider-key">{{ t("settings.ai_config.api_key") }}</Label>
                        <Input
                            id="ai-provider-key"
                            v-model="apiKey"
                            type="password"
                            autocomplete="off"
                            class="font-mono"
                            :placeholder="t('settings.ai_config.api_key_placeholder')"
                        />
                    </div>
                    <div class="grid gap-2">
                        <Label for="ai-provider-url">{{ t("settings.ai_config.base_url") }}</Label>
                        <Input id="ai-provider-url" v-model="baseUrl" class="font-mono" placeholder="https://" />
                    </div>
                    <div class="grid gap-2">
                        <Label for="ai-provider-name">{{ t("settings.ai_config.provider_name") }}</Label>
                        <Input id="ai-provider-name" v-model="name" :placeholder="t('settings.ai_config.provider_name_placeholder')" />
                    </div>
                </div>
                <DialogFooter class="p-6">
                    <Button type="button" variant="ghost" @click="open = false">{{ t("settings.ai_config.cancel") }}</Button>
                    <Button type="submit" :disabled="isSaving">
                        <Loader2 v-if="isSaving" class="animate-spin" />
                        {{ t("settings.ai_config.provider_create") }}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
</template>
