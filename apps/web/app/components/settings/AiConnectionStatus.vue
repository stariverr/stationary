<script setup lang="ts">
import { CircleCheck, CircleDashed, CircleX, Loader2 } from "@lucide/vue";
import type { AiConnectionTestResult } from "@/types/ai";

defineProps<{ check?: AiConnectionTestResult; checking: boolean }>();

const { t } = useI18n();
</script>

<template>
    <p v-if="checking" class="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="size-4 shrink-0 animate-spin" />
        {{ t("settings.ai_config.status_checking") }}
    </p>
    <p v-else-if="check?.ok" class="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <CircleCheck class="size-4 shrink-0" />
        {{ t("settings.ai_config.test_ok", { count: check.models.length }) }}
    </p>
    <div
        v-else-if="check"
        role="alert"
        class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
        <CircleX class="mt-0.5 size-4 shrink-0" />
        <span class="min-w-0 break-words">{{ t("settings.ai_config.test_failed", { message: check.message }) }}</span>
    </div>
    <p v-else class="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleDashed class="size-4 shrink-0" />
        {{ t("settings.ai_config.status_unchecked") }}
    </p>
</template>
