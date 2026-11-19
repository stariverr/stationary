<script setup lang="ts">
import { computed } from "vue";
import { AlertCircle, Clock, Loader2, RotateCcw } from "@lucide/vue";
import type { SourceErrorKind } from "@/types/post";
import { suggestedAction, syncDisplay } from "@/utils/source-errors";

/**
 * The sync state of a source, media or post with the reason of its error and what to do about it
 * (docs/failure_handling.zh-Hans.md, 9.2). Compact: one line for cards. Otherwise the suggested fix follows on a
 * second line. Shows nothing once completed.
 */
const props = withDefaults(
    defineProps<{
        status: string | null | undefined;
        kind: SourceErrorKind | null | undefined;
        compact?: boolean;
        /** Shown after a KIND_MISMATCH reason: the kind the import declared. */
        declaredKind?: string | null;
    }>(),
    { compact: false, declaredKind: null },
);

const { t } = useI18n();

const display = computed(() => syncDisplay(props.status, props.kind));

const reason = computed(() => {
    if (!props.kind) return null;
    const text = t(`sync.reason.${props.kind}`);
    return props.kind === "KIND_MISMATCH" && props.declaredKind
        ? `${text} (${t("sync.declared_kind", { kind: props.declaredKind })})`
        : text;
});

const hint = computed(() => {
    if (!props.kind) return null;
    if (display.value === "retrying") return t("sync.action.retrying");
    return t(`sync.action.${suggestedAction(props.kind)}`);
});

const line = computed(() => {
    const label = t(`sync.status.${display.value}`);
    return reason.value ? `${label} · ${reason.value}` : label;
});

const tone = computed(
    () =>
        ({
            failed: "text-red-500",
            retrying: "text-amber-500",
            syncing: "text-blue-500",
            pending: "text-zinc-500",
            completed: "",
        })[display.value],
);
</script>

<template>
    <div v-if="display !== 'completed'" class="min-w-0" :class="compact ? 'flex items-center gap-1' : 'space-y-0.5'">
        <div
            class="flex items-center gap-1 min-w-0 text-xs font-medium"
            :class="tone"
            :title="compact && hint ? `${line}\n${hint}` : undefined"
        >
            <AlertCircle v-if="display === 'failed'" class="w-3 h-3 shrink-0" />
            <RotateCcw v-else-if="display === 'retrying'" class="w-3 h-3 shrink-0" />
            <Loader2 v-else-if="display === 'syncing'" class="w-3 h-3 shrink-0 animate-spin" />
            <Clock v-else class="w-3 h-3 shrink-0" />
            <span :class="compact ? 'truncate' : ''">{{ line }}</span>
        </div>
        <p v-if="!compact && hint" class="text-xs text-zinc-500 pl-4">{{ hint }}</p>
    </div>
</template>
