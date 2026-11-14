<script setup lang="ts">
import type { PipelineName, PipelineStatus } from "@/types/pipeline";
import { PIPELINE_GROUPS, PIPELINE_STATE_DOT, formatWait, hasWork, pipelineState, waitingCount, type PipelineState } from "@/utils/pipelines";

const props = defineProps<{
    /** Undefined until the first status arrives. */
    pipelines: PipelineStatus[] | undefined;
    paused: boolean;
    selected: PipelineName | null;
}>();

const emit = defineEmits<{ select: [pipeline: PipelineName] }>();

const { locale } = useI18n();

const groups = computed(() => {
    const byName = new Map((props.pipelines ?? []).map((status) => [status.pipeline, status]));
    return PIPELINE_GROUPS.map((group) => ({
        key: group.key,
        rows: group.pipelines.flatMap((name) => {
            const status = byName.get(name);
            return status ? [{ status, state: pipelineState(status, props.paused) }] : [];
        }),
    }));
});

const legend = computed<PipelineState[]>(() => [props.paused ? "paused" : "active", "blocked", "failed", "idle"]);
</script>

<template>
    <div class="text-xs">
        <table class="w-full border-collapse tabular-nums">
            <caption class="sr-only">{{ $t("jobs.table.caption") }}</caption>
            <thead class="bg-zinc-50/40">
                <tr class="h-9 border-b border-zinc-100 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 whitespace-nowrap">
                    <th scope="col" class="w-full pl-4 md:pl-6 text-left font-semibold">{{ $t("jobs.table.pipeline") }}</th>
                    <th scope="col" class="w-16 sm:w-24 px-2 text-right font-semibold">{{ $t("jobs.table.queued") }}</th>
                    <th scope="col" class="hidden sm:table-cell w-24 px-2 text-right font-semibold">{{ $t("jobs.table.running") }}</th>
                    <th scope="col" class="w-16 sm:w-24 pl-2 pr-4 sm:pr-2 text-right font-semibold">{{ $t("jobs.table.failed") }}</th>
                    <th scope="col" class="hidden sm:table-cell w-32 pl-2 pr-4 md:pr-6 text-right font-semibold">{{ $t("jobs.table.oldest") }}</th>
                </tr>
            </thead>

            <tbody v-if="!pipelines">
                <tr v-for="n in 7" :key="n" class="h-11 border-b border-zinc-100">
                    <td class="pl-4 md:pl-6"><span class="block h-3 w-24 rounded bg-zinc-100 animate-pulse motion-reduce:animate-none" /></td>
                    <td colspan="4" />
                </tr>
            </tbody>

            <tbody v-for="group in groups" v-else :key="group.key">
                <tr>
                    <th scope="rowgroup" colspan="5" class="pl-4 md:pl-6 pt-4 pb-1.5 text-left text-[11px] font-semibold text-zinc-400">
                        {{ $t(`jobs.groups.${group.key}`) }}
                    </th>
                </tr>
                <tr
                    v-for="{ status, state } in group.rows"
                    :key="status.pipeline"
                    class="relative h-11 border-b border-zinc-100 text-zinc-600 transition-colors hover:bg-zinc-50"
                    :class="selected === status.pipeline ? 'bg-zinc-50 shadow-[inset_2px_0_0_var(--color-zinc-800)]' : ''"
                >
                    <th scope="row" class="max-w-0 pl-4 md:pl-6 pr-2 text-left font-normal">
                        <button
                            type="button"
                            class="flex items-center gap-2 min-w-0 max-w-full rounded-sm text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 after:absolute after:inset-0"
                            :aria-pressed="selected === status.pipeline"
                            @click="emit('select', status.pipeline)"
                        >
                            <span class="size-2 shrink-0 rounded-full" :class="PIPELINE_STATE_DOT[state]" aria-hidden="true" />
                            <span class="truncate font-semibold text-zinc-800">{{ $t(`jobs.pipelines.names.${status.pipeline}`) }}</span>
                            <span class="sr-only">{{ $t(`jobs.states.${state}`) }}</span>
                            <span v-if="status.scanning" class="hidden lg:inline shrink-0 font-normal text-zinc-400">{{ $t("jobs.pipelines.scanning") }}</span>
                        </button>
                    </th>
                    <td class="px-2 text-right" :class="{ 'text-zinc-300': waitingCount(status) === 0 }">
                        {{ waitingCount(status) || "—" }}
                    </td>
                    <td class="hidden sm:table-cell px-2 text-right" :class="{ 'text-zinc-300': status.running === 0 }">
                        {{ status.running || "—" }}
                    </td>
                    <td class="pl-2 pr-4 sm:pr-2 text-right" :class="status.failed > 0 ? 'font-semibold text-red-600' : 'text-zinc-300'">
                        {{ status.failed || "—" }}
                    </td>
                    <td class="hidden sm:table-cell pl-2 pr-4 md:pr-6 text-right" :class="{ 'text-zinc-300': !hasWork(status) }">
                        {{ hasWork(status) ? formatWait(status.oldest_seconds, locale) : "—" }}
                    </td>
                </tr>
            </tbody>
        </table>

        <ul v-if="pipelines" class="px-4 md:px-6 py-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400" :aria-label="$t('jobs.states.legend')">
            <li v-for="state in legend" :key="state" class="flex items-center gap-1.5">
                <span class="size-1.5 rounded-full" :class="PIPELINE_STATE_DOT[state]" aria-hidden="true" />
                {{ $t(`jobs.states.${state}`) }}
            </li>
        </ul>
    </div>
</template>
