<script setup lang="ts">
import { computed } from "vue";
import { Copy, Loader2, Sparkles } from "@lucide/vue";
import { toast } from "vue-sonner";
import { Temporal } from "@js-temporal/polyfill";
import type { MediaAiView } from "@/types/ai";

const props = defineProps<{ ai: MediaAiView }>();
const emit = defineEmits<{ (e: "search", term: string): void }>();
const { t } = useI18n();

const result = computed(() => props.ai.result);

const chipGroups = computed(() => {
    const r = result.value;
    if (!r) return [];
    return [
        { key: "tags", label: t("media.ai.tags", "AI tags"), values: r.tags, searchable: true },
        { key: "objects", label: t("media.ai.objects", "Objects"), values: r.objects, searchable: true },
        { key: "styles", label: t("media.ai.styles", "Styles"), values: r.styles, searchable: true },
        { key: "colors", label: t("media.ai.colors", "Colors"), values: r.colors, searchable: false },
    ].filter((group) => group.values.length > 0);
});

const generatedTime = computed(() => {
    const value = result.value?.generated_time;
    if (!value) return null;
    return Temporal.Instant.from(value)
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric" });
});

const copyOcr = async () => {
    const text = result.value?.ocr_text;
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        toast.success(t("media.ai.copied", "Copied"));
    } catch {
        toast.error(t("media.ai.copy_failed", "Could not copy"));
    }
};
</script>

<template>
    <section v-if="result || ai.status === 'IN_PROGRESS' || ai.status === 'FAILED'" class="space-y-3">
        <div class="flex items-center justify-between gap-2">
            <label class="text-xs font-bold text-zinc-500 uppercase flex items-center gap-1.5">
                <Sparkles class="w-3.5 h-3.5 text-violet-400" /> {{ $t("media.ai.title", "AI generated") }}
            </label>
            <span v-if="ai.status === 'IN_PROGRESS'" class="text-xs text-zinc-500 flex items-center gap-1">
                <Loader2 class="w-3 h-3 animate-spin" /> {{ $t("media.ai.in_progress", "Generating…") }}
            </span>
        </div>

        <p v-if="ai.status === 'FAILED' && ai.error" class="text-xs text-red-400 leading-relaxed break-words">
            {{ ai.error }}
        </p>

        <template v-if="result">
            <p v-if="result.caption" class="text-sm text-zinc-200 leading-relaxed break-words">{{ result.caption }}</p>

            <div v-if="result.scene" class="space-y-1">
                <div class="text-xs text-zinc-500">{{ $t("media.ai.scene", "Scene") }}</div>
                <div class="text-xs text-zinc-300 leading-relaxed break-words">{{ result.scene }}</div>
            </div>

            <div v-for="group in chipGroups" :key="group.key" class="space-y-1.5">
                <div class="text-xs text-zinc-500">{{ group.label }}</div>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        v-for="value in group.values"
                        :key="value"
                        type="button"
                        :disabled="!group.searchable"
                        :title="group.searchable ? $t('media.ai.search_for', { term: value }, `Search for “${value}”`) : undefined"
                        class="px-2 py-0.5 text-xs rounded-md border border-violet-900/40 bg-violet-950/20 text-violet-200 transition-colors enabled:hover:bg-violet-900/30 enabled:cursor-pointer disabled:cursor-default"
                        @click="emit('search', value)"
                    >
                        {{ value }}
                    </button>
                </div>
            </div>

            <div v-if="result.ocr_text" class="space-y-1">
                <div class="flex items-center justify-between">
                    <div class="text-xs text-zinc-500">{{ $t("media.ai.ocr", "Text in image") }}</div>
                    <button
                        type="button"
                        class="p-1 -m-1 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
                        :aria-label="$t('media.ai.copy', 'Copy')"
                        :title="$t('media.ai.copy', 'Copy')"
                        @click="copyOcr"
                    >
                        <Copy class="w-3.5 h-3.5" />
                    </button>
                </div>
                <pre
                    class="text-xs text-zinc-300 whitespace-pre-wrap break-words font-sans leading-relaxed bg-zinc-900/50 border border-zinc-900 rounded-md p-2 max-h-48 overflow-y-auto custom-scrollbar select-text"
                    >{{ result.ocr_text }}</pre
                >
            </div>

            <div class="text-[11px] text-zinc-600">
                {{ result.model }}<template v-if="generatedTime"> · {{ generatedTime }}</template>
            </div>
        </template>
    </section>
</template>
