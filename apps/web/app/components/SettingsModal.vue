<script setup lang="ts">
import { Temporal } from "@js-temporal/polyfill";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type AcceptableValue } from "reka-ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { authClient, useSession } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { computed, ref, watch } from "vue";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useLibraryStore } from "@/stores/library";
import { useUserStore } from "@/stores/user";
import { storeToRefs } from "pinia";
import { Key, Copy, Plus, Check, Loader2, Trash2, AlertTriangle, Calendar, Layers, Sparkles } from "@lucide/vue";

const props = defineProps({
    open: { type: Boolean, default: false },
});

const emit = defineEmits(["update:open"]);

const isOpen = computed({
    get: () => props.open,
    set: (val) => emit("update:open", val),
});

import { type WritableComputedRef, type ComputedRef } from "vue";

interface NuxtI18nComposer {
    locale: WritableComputedRef<string>;
    setLocale: (locale: string) => Promise<void>;
    locales: ComputedRef<Array<{ code: string; name?: string } | string>>;
    t: (key: string, values?: Record<string, unknown>) => string;
}

const { locale, setLocale, locales, t } = useI18n() as unknown as NuxtI18nComposer;
const session = useSession();

const userStore = useUserStore();
const { userProfile, expandDetailByDefault } = storeToRefs(userStore);
const displayName = computed(() => userProfile.value?.name || "User");
const displayImage = computed(() => userProfile.value?.image || "");
const userEmail = computed(() => userProfile.value?.email || "");

const localeOptions = computed(() => {
    return locales.value.map((l) => ({
        code: typeof l === "string" ? l : l.code,
        name: typeof l === "string" ? l : l.name || l.code,
    }));
});

const handleLocaleChange = (value: AcceptableValue) => {
    if (typeof value === "string") {
        setLocale(value);
    }
};

interface ApiToken {
    id: string;
    name: string;
    prefix: string;
    first_four: string | null;
    last_four: string;
    library_id: string | null;
    expires_at: string | null;
    last_used_at: string | null;
}

interface ApiResponse<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
}

interface FetchErrorLike {
    data?: {
        message?: string;
        error?: string;
        queued?: number;
    };
    response?: {
        _data?: {
            message?: string;
            error?: string;
            queued?: number;
        };
    };
    message?: string;
}

// --- API Token State and Management logic ---
const libraryStore = useLibraryStore();
const apiTokens = ref<ApiToken[]>([]);
const isLoading = ref(false);
const isGenerating = ref(false);
const isRevoking = ref<string | null>(null);

// Form fields for creating a token
const newTokenName = ref("");
const newTokenLibraryId = ref<string>("all");
const newTokenExpiresIn = ref<string>("0");
const generatedToken = ref<string | null>(null);
const justCopied = ref(false);

const isRecovering = ref(false);

const triggerCoverRecovery = async () => {
    try {
        isRecovering.value = true;
        const res = await useApi<ApiResponse<{ queued: number }>>("/task/scan-missing-covers", {
            method: "POST",
            body: {},
        });
        if (res && res.success && res.data) {
            toast.success(t("settings.general.video_cover_recovery_success", { count: res.data.queued }));
        } else {
            throw new Error(res?.message || "Server error");
        }
    } catch (err: unknown) {
        console.error("Failed to run video cover recovery", err);
        const fetchErr = err as FetchErrorLike;
        toast.error(t("settings.general.video_cover_recovery_error"), {
            description: fetchErr?.message || "Unknown error occurred",
        });
    } finally {
        isRecovering.value = false;
    }
};

const fetchTokens = async () => {
    if (!props.open) return;
    isLoading.value = true;
    try {
        const res = await useApi<ApiResponse<ApiToken[]>>("/user/tokens");
        if (res && res.success && res.data) {
            apiTokens.value = res.data;
        }
    } catch (err: unknown) {
        console.error("Failed to fetch tokens", err);
        const fetchErr = err as FetchErrorLike;
        toast.error(t("settings.api_keys.err_load"), {
            description: fetchErr?.data?.message || "Unknown error occurred",
        });
    } finally {
        isLoading.value = false;
    }
};

watch(
    () => props.open,
    (isOpenVal) => {
        if (isOpenVal) {
            fetchTokens();
            // Reset form fields
            newTokenName.value = "";
            newTokenLibraryId.value = "all";
            newTokenExpiresIn.value = "0";
            generatedToken.value = null;
            justCopied.value = false;

            // Initialize selectedLibraryId for AI configuration
            if (libraryStore.activeLibraryId) {
                selectedLibraryId.value = libraryStore.activeLibraryId;
            } else if (libraryStore.libraries.length > 0) {
                selectedLibraryId.value = libraryStore.libraries[0]?.id || "";
            }
        }
    },
);

const generateToken = async () => {
    if (!newTokenName.value.trim()) return;
    isGenerating.value = true;
    try {
        const payload = {
            name: newTokenName.value.trim(),
            library_id: newTokenLibraryId.value === "all" ? null : newTokenLibraryId.value,
            expires_in_seconds: newTokenExpiresIn.value === "0" ? null : Number(newTokenExpiresIn.value),
        };
        const res = await useApi<ApiResponse<{ token: string }>>("/user/tokens", {
            method: "POST",
            body: payload,
        });
        if (res && res.success && res.data) {
            generatedToken.value = res.data.token;
            toast.success(t("settings.api_keys.copied_toast"));
            await fetchTokens();
        }
    } catch (err: unknown) {
        console.error("Failed to generate token", err);
        const fetchErr = err as FetchErrorLike;
        toast.error(t("settings.api_keys.err_generate"), {
            description: fetchErr?.data?.message || "Unknown error occurred",
        });
    } finally {
        isGenerating.value = false;
    }
};

const revokeToken = async (tokenId: string) => {
    if (confirm(t("settings.api_keys.confirm_revoke"))) {
        isRevoking.value = tokenId;
        try {
            const res = await useApi<ApiResponse>(`/user/tokens/${tokenId}`, {
                method: "DELETE",
            });
            if (res && res.success) {
                toast.success(t("settings.api_keys.revoked_toast"));
                await fetchTokens();
            }
        } catch (err: unknown) {
            console.error("Failed to revoke token", err);
            const fetchErr = err as FetchErrorLike;
            toast.error(t("settings.api_keys.err_revoke"), {
                description: fetchErr?.data?.message || "Unknown error",
            });
        } finally {
            isRevoking.value = null;
        }
    }
};

const copyToClipboard = async (text: string) => {
    try {
        await navigator.clipboard.writeText(text);
        justCopied.value = true;
        toast.success(t("settings.api_keys.copied_toast"));
        setTimeout(() => {
            justCopied.value = false;
        }, 2000);
    } catch (err) {
        console.error("Failed to copy", err);
        toast.error("Failed to copy token");
    }
};

const getLibraryName = (libId: string | null) => {
    if (!libId) return t("settings.api_keys.scope_all");
    const lib = libraryStore.libraries.find((l) => l.id === libId);
    return lib ? t("settings.api_keys.scope_single", { name: lib.name }) : t("settings.api_keys.unknown_library");
};

const formatDate = (dateStr: string | null | undefined) => {
    if (!dateStr) return t("settings.api_keys.exp_never");
    return Temporal.Instant.from(dateStr).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
};

interface AiConfig {
    ai_provider: string | null;
    openai_api_key: string;
    openai_base_url: string;
    openai_model_embedding_text: string;
    openai_model_embedding_text_map_to: string;
    openai_model_embedding_image: string;
    openai_model_embedding_image_map_to: string;
    openai_model_describe_image: string;
    openai_model_describe_image_map_to: string;
    gemini_api_key: string;
    gemini_base_url: string;
}

// --- AI Config State and Management logic ---
const selectedLibraryId = ref<string>("");
const isFetchingConfig = ref(false);
const isSavingConfig = ref(false);

const aiConfig = ref<AiConfig>({
    ai_provider: null,
    openai_api_key: "",
    openai_base_url: "",
    openai_model_embedding_text: "",
    openai_model_embedding_text_map_to: "",
    openai_model_embedding_image: "",
    openai_model_embedding_image_map_to: "",
    openai_model_describe_image: "",
    openai_model_describe_image_map_to: "",
    gemini_api_key: "",
    gemini_base_url: "",
});

const fetchAiConfig = async () => {
    if (!selectedLibraryId.value) return;
    isFetchingConfig.value = true;
    try {
        const res = await useApi<ApiResponse<AiConfig>>(`/library/${selectedLibraryId.value}/ai-config`);
        if (res && res.success && res.data) {
            aiConfig.value = {
                ai_provider: res.data.ai_provider || null,
                openai_api_key: res.data.openai_api_key || "",
                openai_base_url: res.data.openai_base_url || "",
                openai_model_embedding_text: res.data.openai_model_embedding_text || "",
                openai_model_embedding_text_map_to: res.data.openai_model_embedding_text_map_to || "",
                openai_model_embedding_image: res.data.openai_model_embedding_image || "",
                openai_model_embedding_image_map_to: res.data.openai_model_embedding_image_map_to || "",
                openai_model_describe_image: res.data.openai_model_describe_image || "",
                openai_model_describe_image_map_to: res.data.openai_model_describe_image_map_to || "",
                gemini_api_key: res.data.gemini_api_key || "",
                gemini_base_url: res.data.gemini_base_url || "",
            };
        }
    } catch (err: unknown) {
        console.error("Failed to fetch AI configuration", err);
        toast.error(t("settings.ai_config.err_load"));
    } finally {
        isFetchingConfig.value = false;
    }
};

const saveAiConfig = async () => {
    if (!selectedLibraryId.value) return;
    isSavingConfig.value = true;
    try {
        const payload: Record<string, string | null> = { ...aiConfig.value };
        for (const key in payload) {
            if (payload[key] === "") {
                payload[key] = null;
            }
        }
        const res = await useApi<ApiResponse<AiConfig>>(`/library/${selectedLibraryId.value}/ai-config`, {
            method: "POST",
            body: payload,
        });
        if (res && res.success) {
            toast.success(t("settings.ai_config.save_success"));
            await fetchAiConfig();
        }
    } catch (err: unknown) {
        console.error("Failed to save AI configuration", err);
        toast.error(t("settings.ai_config.err_save"));
    } finally {
        isSavingConfig.value = false;
    }
};

watch(
    () => selectedLibraryId.value,
    (newId) => {
        if (newId) {
            fetchAiConfig();
        }
    },
);
</script>

<template>
    <Dialog :open="isOpen" @update:open="isOpen = $event">
        <DialogContent class="sm:max-w-[600px] flex flex-col p-0 overflow-hidden bg-white">
            <DialogHeader class="px-6 py-4 border-b shrink-0">
                <DialogTitle class="text-xl font-bold">{{ $t("settings.title") }}</DialogTitle>
                <DialogDescription>
                    {{ $t("settings.description") }}
                </DialogDescription>
            </DialogHeader>

            <div class="p-6 overflow-y-auto max-h-[80vh]">
                <Tabs default-value="general" class="w-full">
                    <TabsList class="grid w-full grid-cols-5 mb-6">
                        <TabsTrigger value="general">
                            {{ $t("settings.tabs.general") }}
                        </TabsTrigger>
                        <TabsTrigger value="appearance">
                            {{ $t("settings.tabs.appearance") }}
                        </TabsTrigger>
                        <TabsTrigger value="account">
                            {{ $t("settings.tabs.account") }}
                        </TabsTrigger>
                        <TabsTrigger value="apikeys">
                            {{ $t("settings.tabs.api_keys") }}
                        </TabsTrigger>
                        <TabsTrigger value="aiconfig">
                            {{ $t("settings.tabs.ai_config") }}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="general">
                        <div class="grid gap-6">
                            <Card>
                                <CardHeader>
                                    <CardTitle>{{ $t("settings.general.title") }}</CardTitle>
                                    <CardDescription>
                                        {{ $t("settings.general.desc") }}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent class="grid gap-6">
                                    <div class="flex items-center justify-between">
                                        <div class="space-y-0.5">
                                            <Label class="text-base">{{ $t("settings.general.expand_detail") }}</Label>
                                            <p class="text-sm text-muted-foreground">
                                                {{ $t("settings.general.expand_detail_desc") }}
                                            </p>
                                        </div>
                                        <Switch v-model="expandDetailByDefault" />
                                    </div>

                                    <div class="grid gap-3">
                                        <div class="space-y-0.5">
                                            <Label class="text-base">{{ $t("settings.general.language") }}</Label>
                                            <p class="text-sm text-muted-foreground">
                                                {{ $t("settings.general.language_desc") }}
                                            </p>
                                        </div>
                                        <Select :model-value="locale" @update:model-value="handleLocaleChange">
                                            <SelectTrigger class="w-[200px]">
                                                <SelectValue placeholder="Select a language" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectGroup>
                                                    <SelectItem v-for="l in localeOptions" :key="l.code" :value="l.code">
                                                        {{ l.name }}
                                                    </SelectItem>
                                                </SelectGroup>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>{{ $t("settings.general.other_title") }}</CardTitle>
                                    <CardDescription>
                                        {{ $t("settings.general.other_desc") }}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent class="grid gap-4">
                                    <div class="flex flex-col gap-1.5">
                                        <h4 class="text-sm font-semibold text-gray-900">
                                            {{ $t("settings.general.video_cover_recovery") }}
                                        </h4>
                                        <p class="text-xs text-muted-foreground">
                                            {{ $t("settings.general.video_cover_recovery_desc") }}
                                        </p>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        class="w-full mt-2"
                                        :disabled="isRecovering"
                                        @click="triggerCoverRecovery"
                                    >
                                        <Loader2 v-if="isRecovering" class="w-4 h-4 mr-2 animate-spin" />
                                        <Check v-else class="w-4 h-4 mr-2" />
                                        {{
                                            isRecovering
                                                ? $t("settings.general.video_cover_recovery_loading")
                                                : $t("settings.general.video_cover_recovery_btn")
                                        }}
                                    </Button>
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    <TabsContent value="appearance">
                        <Card>
                            <CardHeader>
                                <CardTitle>{{ $t("settings.appearance.title") }}</CardTitle>
                                <CardDescription>
                                    {{ $t("settings.appearance.desc") }}
                                </CardDescription>
                            </CardHeader>
                            <CardContent class="py-20 text-center text-gray-400">
                                {{ $t("settings.appearance.coming_soon") }}
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="account">
                        <Card>
                            <CardHeader>
                                <CardTitle>{{ $t("settings.account.title") }}</CardTitle>
                                <CardDescription>
                                    {{ $t("settings.account.desc") }}
                                </CardDescription>
                            </CardHeader>
                            <CardContent class="space-y-6">
                                <div v-if="session.data?.user" class="flex items-center gap-4 p-4 border rounded-xl bg-gray-50/30">
                                    <Avatar class="w-16 h-16 border-2 border-white shadow-sm">
                                        <AvatarImage v-if="displayImage" :src="displayImage" :alt="displayName" />
                                        <AvatarFallback class="bg-blue-100 text-blue-700 text-xl font-bold">
                                            {{ displayName.charAt(0)?.toUpperCase() || "U" }}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div class="space-y-1">
                                        <h4 class="text-lg font-bold leading-none">
                                            {{ displayName }}
                                        </h4>
                                        <p class="text-sm text-muted-foreground">
                                            {{ userEmail }}
                                        </p>
                                        <div
                                            class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 uppercase tracking-wider"
                                        >
                                            {{ $t("settings.account.verified") }}
                                        </div>
                                    </div>
                                </div>
                                <div v-else class="py-10 text-center text-gray-400">
                                    {{ $t("settings.account.not_signed_in") }}
                                </div>

                                <div class="grid gap-4">
                                    <div class="grid gap-2">
                                        <Label>{{ $t("settings.account.user_id") }}</Label>
                                        <div class="p-2 bg-gray-50 border rounded text-xs font-mono text-gray-500 truncate">
                                            {{ session.data?.user?.id || "N/A" }}
                                        </div>
                                    </div>
                                    <Button
                                        variant="outline"
                                        class="w-full text-red-600 hover:text-red-700 hover:bg-red-50"
                                        @click="authClient.signOut()"
                                    >
                                        {{ $t("settings.account.sign_out") }}
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="apikeys">
                        <div class="grid gap-6">
                            <!-- Case 1: Display newly generated token (Copy once view) -->
                            <Card v-if="generatedToken" class="border-amber-200 bg-amber-50/20">
                                <CardHeader>
                                    <CardTitle class="flex items-center gap-2 text-amber-800 text-lg font-bold">
                                        <AlertTriangle class="w-5 h-5 text-amber-600" />
                                        {{ $t("settings.api_keys.copy_title") }}
                                    </CardTitle>
                                    <CardDescription class="text-amber-700 font-medium">
                                        {{ $t("settings.api_keys.copy_desc") }}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent class="grid gap-4">
                                    <div class="flex items-center gap-2">
                                        <Input
                                            readonly
                                            v-model="generatedToken"
                                            class="font-mono text-sm bg-white border-amber-200 text-amber-900 focus-visible:ring-amber-400 select-all"
                                        />
                                        <Button
                                            variant="outline"
                                            class="border-amber-300 hover:bg-amber-100 text-amber-800"
                                            @click="copyToClipboard(generatedToken)"
                                        >
                                            <Check v-if="justCopied" class="w-4 h-4 text-green-600" />
                                            <Copy v-else class="w-4 h-4" />
                                        </Button>
                                    </div>
                                    <Button class="w-full bg-amber-600 hover:bg-amber-700 text-white mt-2" @click="generatedToken = null">
                                        {{ $t("settings.api_keys.copy_done") }}
                                    </Button>
                                </CardContent>
                            </Card>

                            <!-- Case 2: Standard API Key Form & Management List -->
                            <template v-else>
                                <Card>
                                    <CardHeader>
                                        <CardTitle>{{ $t("settings.api_keys.title") }}</CardTitle>
                                        <CardDescription>
                                            {{ $t("settings.api_keys.desc") }}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent class="grid gap-4">
                                        <div class="grid gap-2">
                                            <Label for="token-name">{{ $t("settings.api_keys.key_name") }}</Label>
                                            <Input
                                                id="token-name"
                                                v-model="newTokenName"
                                                :placeholder="$t('settings.api_keys.key_name_placeholder')"
                                                :disabled="isGenerating"
                                            />
                                        </div>

                                        <div class="grid grid-cols-2 gap-4">
                                            <div class="grid gap-2">
                                                <Label>{{ $t("settings.api_keys.scope") }}</Label>
                                                <Select v-model="newTokenLibraryId">
                                                    <SelectTrigger>
                                                        <SelectValue placeholder="Select scope" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectGroup>
                                                            <SelectItem value="all">
                                                                {{ $t("settings.api_keys.scope_all") }}
                                                            </SelectItem>
                                                            <SelectItem v-for="lib in libraryStore.libraries" :key="lib.id" :value="lib.id">
                                                                {{
                                                                    $t("settings.api_keys.scope_single", {
                                                                        name: lib.name,
                                                                    })
                                                                }}
                                                            </SelectItem>
                                                        </SelectGroup>
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            <div class="grid gap-2">
                                                <Label>{{ $t("settings.api_keys.expiration") }}</Label>
                                                <Select v-model="newTokenExpiresIn">
                                                    <SelectTrigger>
                                                        <SelectValue placeholder="Select expiration" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectGroup>
                                                            <SelectItem value="0">{{ $t("settings.api_keys.exp_never") }}</SelectItem>
                                                            <SelectItem value="604800">{{ $t("settings.api_keys.exp_7d") }}</SelectItem>
                                                            <SelectItem value="2592000">{{ $t("settings.api_keys.exp_30d") }}</SelectItem>
                                                            <SelectItem value="7776000">{{ $t("settings.api_keys.exp_90d") }}</SelectItem>
                                                        </SelectGroup>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        </div>

                                        <Button class="w-full mt-2" :disabled="!newTokenName.trim() || isGenerating" @click="generateToken">
                                            <Loader2 v-if="isGenerating" class="w-4 h-4 mr-2 animate-spin" />
                                            <Plus v-else class="w-4 h-4 mr-2" />
                                            {{ isGenerating ? $t("settings.api_keys.generating") : $t("settings.api_keys.generate_btn") }}
                                        </Button>
                                    </CardContent>
                                </Card>

                                <Card>
                                    <CardHeader class="pb-3">
                                        <CardTitle>{{ $t("settings.api_keys.active_title") }}</CardTitle>
                                        <CardDescription>
                                            {{ $t("settings.api_keys.active_desc") }}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <div v-if="isLoading" class="flex flex-col items-center justify-center py-10 text-muted-foreground">
                                            <Loader2 class="w-8 h-8 animate-spin mb-2" />
                                            <p class="text-sm">
                                                {{ $t("settings.api_keys.loading") }}
                                            </p>
                                        </div>

                                        <div
                                            v-else-if="apiTokens.length === 0"
                                            class="text-center py-10 text-sm text-muted-foreground border border-dashed rounded-xl bg-gray-50/20"
                                        >
                                            <Key class="w-8 h-8 text-gray-300 mx-auto mb-2" />
                                            <p>{{ $t("settings.api_keys.empty") }}</p>
                                        </div>

                                        <div v-else class="divide-y">
                                            <div
                                                v-for="token in apiTokens"
                                                :key="token.id"
                                                class="flex items-center justify-between py-4 first:pt-0 last:pb-0"
                                            >
                                                <div class="space-y-1 min-w-0 flex-1 pr-4">
                                                    <div class="flex items-center gap-2">
                                                        <span class="font-bold text-sm text-gray-900 truncate">{{ token.name }}</span>
                                                        <span
                                                            class="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-gray-100 border text-gray-600"
                                                        >
                                                            {{ token.prefix }}_{{ token.first_four || "" }}...{{ token.last_four }}
                                                        </span>
                                                    </div>

                                                    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                                        <span class="flex items-center gap-1">
                                                            <Layers class="w-3.5 h-3.5 opacity-60" />
                                                            {{ getLibraryName(token.library_id) }}
                                                        </span>
                                                        <span class="flex items-center gap-1">
                                                            <Calendar class="w-3.5 h-3.5 opacity-60" />
                                                            {{
                                                                $t("settings.api_keys.expires_label", {
                                                                    date: formatDate(token.expires_at),
                                                                })
                                                            }}
                                                        </span>
                                                        <span v-if="token.last_used_at">
                                                            {{
                                                                $t("settings.api_keys.last_used_label", {
                                                                    date: formatDate(token.last_used_at),
                                                                })
                                                            }}
                                                        </span>
                                                        <span v-else>
                                                            {{ $t("settings.api_keys.never_used") }}
                                                        </span>
                                                    </div>
                                                </div>

                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    class="text-red-500 hover:text-red-700 hover:bg-red-50 shrink-0"
                                                    :disabled="isRevoking === token.id"
                                                    @click="revokeToken(token.id)"
                                                >
                                                    <Loader2 v-if="isRevoking === token.id" class="w-4 h-4 animate-spin" />
                                                    <Trash2 v-else class="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            </template>
                        </div>
                    </TabsContent>

                    <TabsContent value="aiconfig">
                        <div class="grid gap-6">
                            <Card>
                                <CardHeader>
                                    <CardTitle>{{ $t("settings.ai_config.title") }}</CardTitle>
                                    <CardDescription>
                                        {{ $t("settings.ai_config.desc") }}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent class="grid gap-4">
                                    <div class="grid gap-2">
                                        <Label>{{ $t("settings.ai_config.library_select") }}</Label>
                                        <Select v-model="selectedLibraryId">
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select target library" />
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

                                    <div
                                        v-if="isFetchingConfig"
                                        class="flex flex-col items-center justify-center py-10 text-muted-foreground"
                                    >
                                        <Loader2 class="w-8 h-8 animate-spin mb-2" />
                                        <p class="text-sm">
                                            {{ $t("settings.ai_config.loading") }}
                                        </p>
                                    </div>

                                    <template v-else-if="selectedLibraryId">
                                        <div class="grid gap-2">
                                            <Label>{{ $t("settings.ai_config.provider") }}</Label>
                                            <Select v-model="aiConfig.ai_provider">
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Select AI provider" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectGroup>
                                                        <SelectItem :value="null">
                                                            {{ $t("settings.ai_config.provider_disabled") }}
                                                        </SelectItem>
                                                        <SelectItem value="gemini">
                                                            {{ $t("settings.ai_config.provider_gemini") }}
                                                        </SelectItem>
                                                        <SelectItem value="openai">
                                                            {{ $t("settings.ai_config.provider_openai") }}
                                                        </SelectItem>
                                                    </SelectGroup>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div v-if="aiConfig.ai_provider === 'gemini'" class="grid gap-4 border-t pt-4 mt-2">
                                            <div class="grid gap-2">
                                                <Label>{{ $t("settings.ai_config.api_key") }}</Label>
                                                <Input
                                                    type="password"
                                                    v-model="aiConfig.gemini_api_key"
                                                    :placeholder="$t('settings.ai_config.api_key_placeholder')"
                                                />
                                            </div>
                                            <div class="grid gap-2">
                                                <Label>{{ $t("settings.ai_config.base_url") }}</Label>
                                                <Input
                                                    v-model="aiConfig.gemini_base_url"
                                                    :placeholder="$t('settings.ai_config.base_url_placeholder')"
                                                />
                                            </div>
                                        </div>

                                        <div v-else-if="aiConfig.ai_provider === 'openai'" class="grid gap-4 border-t pt-4 mt-2">
                                            <div class="grid gap-2">
                                                <Label>{{ $t("settings.ai_config.api_key") }}</Label>
                                                <Input
                                                    type="password"
                                                    v-model="aiConfig.openai_api_key"
                                                    :placeholder="$t('settings.ai_config.api_key_placeholder')"
                                                />
                                            </div>
                                            <div class="grid gap-2">
                                                <Label>{{ $t("settings.ai_config.base_url") }}</Label>
                                                <Input
                                                    v-model="aiConfig.openai_base_url"
                                                    :placeholder="$t('settings.ai_config.base_url_placeholder')"
                                                />
                                            </div>

                                            <div class="grid grid-cols-2 gap-4">
                                                <div class="grid gap-2">
                                                    <Label>{{ $t("settings.ai_config.text_embedding_model") }}</Label>
                                                    <Input
                                                        v-model="aiConfig.openai_model_embedding_text"
                                                        :placeholder="$t('settings.ai_config.text_embedding_model_placeholder')"
                                                    />
                                                </div>
                                                <div class="grid gap-2">
                                                    <Label>{{ $t("settings.ai_config.text_embedding_dim") }}</Label>
                                                    <Input
                                                        v-model="aiConfig.openai_model_embedding_text_map_to"
                                                        :placeholder="$t('settings.ai_config.text_embedding_dim_placeholder')"
                                                    />
                                                </div>
                                            </div>

                                            <div class="grid grid-cols-2 gap-4">
                                                <div class="grid gap-2">
                                                    <Label>{{ $t("settings.ai_config.image_embedding_model") }}</Label>
                                                    <Input
                                                        v-model="aiConfig.openai_model_embedding_image"
                                                        :placeholder="$t('settings.ai_config.image_embedding_model_placeholder')"
                                                    />
                                                </div>
                                                <div class="grid gap-2">
                                                    <Label>{{ $t("settings.ai_config.image_embedding_dim") }}</Label>
                                                    <Input
                                                        v-model="aiConfig.openai_model_embedding_image_map_to"
                                                        :placeholder="$t('settings.ai_config.image_embedding_dim_placeholder')"
                                                    />
                                                </div>
                                            </div>

                                            <div class="grid grid-cols-2 gap-4">
                                                <div class="grid gap-2">
                                                    <Label>{{ $t("settings.ai_config.describe_image_model") }}</Label>
                                                    <Input
                                                        v-model="aiConfig.openai_model_describe_image"
                                                        :placeholder="$t('settings.ai_config.describe_image_model_placeholder')"
                                                    />
                                                </div>
                                                <div class="grid gap-2">
                                                    <Label>{{ $t("settings.ai_config.describe_image_dim") }}</Label>
                                                    <Input
                                                        v-model="aiConfig.openai_model_describe_image_map_to"
                                                        :placeholder="$t('settings.ai_config.describe_image_dim_placeholder')"
                                                    />
                                                </div>
                                            </div>
                                        </div>

                                        <Button class="w-full mt-4" :disabled="isSavingConfig" @click="saveAiConfig">
                                            <Loader2 v-if="isSavingConfig" class="w-4 h-4 mr-2 animate-spin" />
                                            <Sparkles v-else class="w-4 h-4 mr-2" />
                                            {{ isSavingConfig ? $t("settings.ai_config.saving") : $t("settings.ai_config.save_btn") }}
                                        </Button>
                                    </template>
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>
                </Tabs>
            </div>
        </DialogContent>
    </Dialog>
</template>
