<script setup lang="ts">
import { Temporal } from "@js-temporal/polyfill";
import { toast } from "vue-sonner";
import { Key, Copy, Plus, Check, Loader2, Trash2, AlertTriangle, Calendar, Layers } from "@lucide/vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLibraryStore } from "@/stores/library";
import type { ApiResponse } from "@/types/api";

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

interface FetchErrorLike {
    data?: { message?: string };
}

const { t } = useI18n();
const libraryStore = useLibraryStore();

const apiTokens = ref<ApiToken[]>([]);
const isLoading = ref(false);
const isGenerating = ref(false);
const isRevoking = ref<string | null>(null);
const pendingRevokeId = ref<string | null>(null);

const newTokenName = ref("");
const newTokenLibraryId = ref("all");
const newTokenExpiresIn = ref("0");
const generatedToken = ref<string | null>(null);
const justCopied = ref(false);

const errorDescription = (err: unknown) => (err as FetchErrorLike)?.data?.message || "Unknown error occurred";

const fetchTokens = async () => {
    isLoading.value = true;
    try {
        const res = await useApi<ApiResponse<ApiToken[]>>("/user/tokens");
        if (res?.success && res.data) apiTokens.value = res.data;
    } catch (err) {
        console.error("Failed to fetch tokens", err);
        toast.error(t("settings.api_keys.err_load"), { description: errorDescription(err) });
    } finally {
        isLoading.value = false;
    }
};

onMounted(fetchTokens);

const generateToken = async () => {
    if (!newTokenName.value.trim()) return;
    isGenerating.value = true;
    try {
        const res = await useApi<ApiResponse<{ token: string }>>("/user/tokens", {
            method: "POST",
            body: {
                name: newTokenName.value.trim(),
                library_id: newTokenLibraryId.value === "all" ? null : newTokenLibraryId.value,
                expires_in_seconds: newTokenExpiresIn.value === "0" ? null : Number(newTokenExpiresIn.value),
            },
        });
        if (res?.success && res.data) {
            generatedToken.value = res.data.token;
            newTokenName.value = "";
            await fetchTokens();
        }
    } catch (err) {
        console.error("Failed to generate token", err);
        toast.error(t("settings.api_keys.err_generate"), { description: errorDescription(err) });
    } finally {
        isGenerating.value = false;
    }
};

const revokeToken = async () => {
    const tokenId = pendingRevokeId.value;
    pendingRevokeId.value = null;
    if (!tokenId) return;
    isRevoking.value = tokenId;
    try {
        const res = await useApi<ApiResponse<unknown>>(`/user/tokens/${tokenId}`, { method: "DELETE" });
        if (res?.success) {
            toast.success(t("settings.api_keys.revoked_toast"));
            await fetchTokens();
        }
    } catch (err) {
        console.error("Failed to revoke token", err);
        toast.error(t("settings.api_keys.err_revoke"), { description: errorDescription(err) });
    } finally {
        isRevoking.value = null;
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
</script>

<template>
    <div class="grid gap-6">
        <!-- A new token is shown once; it cannot be read back after this view closes. -->
        <Card v-if="generatedToken" class="border-amber-200 bg-amber-50/20 dark:border-amber-900/60 dark:bg-amber-950/20">
            <CardHeader>
                <CardTitle class="flex items-center gap-2 text-lg font-bold text-amber-800 dark:text-amber-300">
                    <AlertTriangle class="size-5 text-amber-600" />
                    {{ $t("settings.api_keys.copy_title") }}
                </CardTitle>
                <CardDescription class="font-medium text-amber-700 dark:text-amber-400">
                    {{ $t("settings.api_keys.copy_desc") }}
                </CardDescription>
            </CardHeader>
            <CardContent class="grid gap-4">
                <div class="flex items-center gap-2">
                    <Input readonly :model-value="generatedToken" class="select-all font-mono text-sm" />
                    <Button variant="outline" size="icon" @click="copyToClipboard(generatedToken)">
                        <Check v-if="justCopied" class="size-4 text-green-600" />
                        <Copy v-else class="size-4" />
                    </Button>
                </div>
                <Button class="w-full" @click="generatedToken = null">
                    {{ $t("settings.api_keys.copy_done") }}
                </Button>
            </CardContent>
        </Card>

        <template v-else>
            <Card>
                <CardHeader>
                    <CardTitle>{{ $t("settings.api_keys.title") }}</CardTitle>
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

                    <div class="grid gap-4 sm:grid-cols-2">
                        <div class="grid gap-2">
                            <Label>{{ $t("settings.api_keys.scope") }}</Label>
                            <Select v-model="newTokenLibraryId">
                                <SelectTrigger class="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        <SelectItem value="all">{{ $t("settings.api_keys.scope_all") }}</SelectItem>
                                        <SelectItem v-for="lib in libraryStore.libraries" :key="lib.id" :value="lib.id">
                                            {{ $t("settings.api_keys.scope_single", { name: lib.name }) }}
                                        </SelectItem>
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </div>

                        <div class="grid gap-2">
                            <Label>{{ $t("settings.api_keys.expiration") }}</Label>
                            <Select v-model="newTokenExpiresIn">
                                <SelectTrigger class="w-full">
                                    <SelectValue />
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

                    <Button class="mt-2 w-full" :disabled="!newTokenName.trim() || isGenerating" @click="generateToken">
                        <Loader2 v-if="isGenerating" class="size-4 animate-spin" />
                        <Plus v-else class="size-4" />
                        {{ isGenerating ? $t("settings.api_keys.generating") : $t("settings.api_keys.generate_btn") }}
                    </Button>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{{ $t("settings.api_keys.active_title") }}</CardTitle>
                    <CardDescription>{{ $t("settings.api_keys.active_desc") }}</CardDescription>
                </CardHeader>
                <CardContent>
                    <div v-if="isLoading" class="flex flex-col items-center justify-center py-10 text-muted-foreground">
                        <Loader2 class="mb-2 size-8 animate-spin" />
                        <p class="text-sm">{{ $t("settings.api_keys.loading") }}</p>
                    </div>

                    <div
                        v-else-if="apiTokens.length === 0"
                        class="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground"
                    >
                        <Key class="mx-auto mb-2 size-8 opacity-40" />
                        <p>{{ $t("settings.api_keys.empty") }}</p>
                    </div>

                    <div v-else class="divide-y">
                        <div v-for="token in apiTokens" :key="token.id" class="flex items-center justify-between py-4 first:pt-0 last:pb-0">
                            <div class="min-w-0 flex-1 space-y-1 pr-4">
                                <div class="flex items-center gap-2">
                                    <span class="truncate text-sm font-bold">{{ token.name }}</span>
                                    <Badge variant="outline" class="font-mono">
                                        {{ token.prefix }}_{{ token.first_four || "" }}...{{ token.last_four }}
                                    </Badge>
                                </div>
                                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                    <span class="flex items-center gap-1">
                                        <Layers class="size-3.5 opacity-60" />
                                        {{ getLibraryName(token.library_id) }}
                                    </span>
                                    <span class="flex items-center gap-1">
                                        <Calendar class="size-3.5 opacity-60" />
                                        {{ $t("settings.api_keys.expires_label", { date: formatDate(token.expires_at) }) }}
                                    </span>
                                    <span v-if="token.last_used_at">
                                        {{ $t("settings.api_keys.last_used_label", { date: formatDate(token.last_used_at) }) }}
                                    </span>
                                    <span v-else>{{ $t("settings.api_keys.never_used") }}</span>
                                </div>
                            </div>

                            <Button
                                variant="ghost"
                                size="icon"
                                class="shrink-0 text-destructive hover:text-destructive"
                                :disabled="isRevoking === token.id"
                                @click="pendingRevokeId = token.id"
                            >
                                <Loader2 v-if="isRevoking === token.id" class="size-4 animate-spin" />
                                <Trash2 v-else class="size-4" />
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </template>

        <AlertDialog :open="pendingRevokeId !== null" @update:open="(open) => !open && (pendingRevokeId = null)">
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{{ $t("settings.api_keys.revoke_title") }}</AlertDialogTitle>
                    <AlertDialogDescription>{{ $t("settings.api_keys.confirm_revoke") }}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ $t("common.cancel") }}</AlertDialogCancel>
                    <AlertDialogAction class="bg-destructive text-white hover:bg-destructive/90" @click="revokeToken">
                        {{ $t("settings.api_keys.revoke_btn") }}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </div>
</template>
