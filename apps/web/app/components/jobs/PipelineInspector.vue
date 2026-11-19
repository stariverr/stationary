<script setup lang="ts">
import { ExternalLink, Pencil, RotateCcw, TriangleAlert, X } from "@lucide/vue";
import type { PipelineFailureGroup, PipelineStatus } from "@/types/pipeline";
import type { SourceErrorKind } from "@/types/post";
import { usePipelineFailures } from "@/composables/useLibraryPipelines";
import { PIPELINE_STATE_DOT, formatWait, hasWork, pipelineState, waitingCount } from "@/utils/pipelines";
import { isRetryableKind, suggestedAction } from "@/utils/source-errors";
import { formatTemporalRelative } from "@/utils/temporal";

const props = defineProps<{
    libraryId: string;
    status: PipelineStatus;
    paused: boolean;
    retrying: boolean;
}>();

const emit = defineEmits<{
    close: [];
    /** Queue the failures a retry can get past again. */
    retry: [];
    /** Open a failed media in the editor. */
    edit: [mediaId: string];
}>();

const { locale, t } = useI18n();

const state = computed(() => pipelineState(props.status, props.paused));
const failures = usePipelineFailures(
    computed(() => props.libraryId),
    computed(() => props.status.pipeline),
    computed(() => props.status.failed),
);

/**
 * Failures are grouped by kind, each with its fix (docs/failure_handling.zh-Hans.md, 9.2): a retry for the ones a retry
 * can get past or a pipeline does not classify, the post to share again for a link the platform refused, the editor
 * for a file that cannot be read or is not what the import declared.
 */
const groupKind = (group: PipelineFailureGroup) => group.kind as SourceErrorKind | null;
const groupAction = (group: PipelineFailureGroup) => {
    const kind = groupKind(group);
    return kind ? suggestedAction(kind) : "retry";
};
const groupTitle = (group: PipelineFailureGroup) => {
    const kind = groupKind(group);
    return kind ? t(`sync.reason.${kind}`) : t("jobs.inspector.unclassified");
};
const groups = computed(() => failures.data.value ?? []);
/** A pipeline that does not classify its failures has one unnamed group; it needs no heading. */
const showGroupHeadings = computed(() => groups.value.some((group) => group.kind !== null));
const canRetryAny = computed(() => groups.value.some((group) => group.kind === null || isRetryableKind(groupKind(group))));

const stats = computed(() => [
    { key: "queued", value: waitingCount(props.status) },
    { key: "running", value: props.status.running },
    { key: "retrying", value: props.status.retrying },
    { key: "failed", value: props.status.failed },
]);
</script>

<template>
    <div class="h-full flex flex-col bg-white text-xs" :aria-labelledby="`pipeline-${status.pipeline}-title`" role="region">
        <div class="h-11 shrink-0 px-4 flex items-center justify-between gap-2 border-b border-zinc-200/80">
            <h2
                :id="`pipeline-${status.pipeline}-title`"
                class="flex items-center gap-2 min-w-0 text-sm font-semibold tracking-tight text-zinc-800"
            >
                <span class="size-2 shrink-0 rounded-full" :class="PIPELINE_STATE_DOT[state]" aria-hidden="true" />
                <span class="truncate">{{ $t(`jobs.pipelines.names.${status.pipeline}`) }}</span>
            </h2>
            <button
                type="button"
                class="size-7 -mr-1.5 shrink-0 rounded-md flex items-center justify-center text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                :aria-label="$t('jobs.inspector.close')"
                @click="emit('close')"
            >
                <X class="size-4" />
            </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto">
            <div class="px-4 py-3.5 space-y-3 border-b border-zinc-100">
                <p class="text-zinc-500 leading-relaxed">{{ $t(`jobs.pipelines.about.${status.pipeline}`) }}</p>

                <p class="flex items-center gap-1.5 font-medium text-zinc-700">
                    {{ $t(`jobs.states.${state}`) }}
                    <span v-if="status.scanning" class="font-normal text-zinc-400">· {{ $t("jobs.inspector.scanning") }}</span>
                    <span v-if="hasWork(status)" class="font-normal text-zinc-400">
                        · {{ $t("jobs.inspector.oldest", { wait: formatWait(status.oldest_seconds, locale) }) }}
                    </span>
                </p>

                <div
                    v-if="status.blocked_seconds > 0"
                    role="status"
                    class="flex items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50 px-2.5 py-2 font-medium leading-relaxed text-amber-800"
                >
                    <TriangleAlert class="size-3.5 mt-0.5 shrink-0" />
                    {{ $t("jobs.pipelines.blocked", { minutes: Math.ceil(status.blocked_seconds / 60) }) }}
                </div>

                <dl class="grid grid-cols-4 gap-2 tabular-nums">
                    <div v-for="stat in stats" :key="stat.key" class="rounded-lg bg-zinc-50 px-2.5 py-2">
                        <dt class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 truncate">
                            {{ $t(`jobs.table.${stat.key}`) }}
                        </dt>
                        <dd
                            class="mt-0.5 text-sm font-semibold"
                            :class="stat.value === 0 ? 'text-zinc-300' : stat.key === 'failed' ? 'text-red-600' : 'text-zinc-800'"
                        >
                            {{ stat.value }}
                        </dd>
                    </div>
                </dl>
            </div>

            <section :aria-label="$t('jobs.inspector.failures')">
                <div class="h-10 px-4 flex items-center justify-between gap-2">
                    <h3 class="font-semibold text-zinc-700">{{ $t("jobs.inspector.failures") }}</h3>
                    <button
                        v-if="status.failed > 0 && canRetryAny"
                        type="button"
                        class="flex items-center gap-1 rounded-md -mr-1.5 px-1.5 py-1 font-semibold text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 cursor-pointer disabled:opacity-50 disabled:cursor-default active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
                        :disabled="retrying"
                        @click="emit('retry')"
                    >
                        <RotateCcw class="size-3" :class="{ 'animate-spin motion-reduce:animate-none': retrying }" />
                        {{ $t("jobs.inspector.retry_all") }}
                    </button>
                </div>

                <p v-if="status.failed === 0" class="px-4 pb-4 text-zinc-400">{{ $t("jobs.inspector.no_failures") }}</p>
                <div v-else-if="failures.isPending.value" class="px-4 pb-4 space-y-3 animate-pulse motion-reduce:animate-none">
                    <div v-for="n in 3" :key="n" class="space-y-1.5">
                        <div class="h-3 w-1/2 rounded bg-zinc-100" />
                        <div class="h-3 w-3/4 rounded bg-zinc-100" />
                    </div>
                </div>
                <p v-else-if="failures.isError.value" class="px-4 pb-4 text-red-600">{{ $t("jobs.inspector.failures_error") }}</p>
                <div v-else class="border-t border-zinc-100">
                    <section v-for="group in groups" :key="group.kind ?? 'none'" :aria-label="groupTitle(group)">
                        <div v-if="showGroupHeadings" class="px-4 pt-3 pb-1.5 bg-zinc-50/60 border-b border-zinc-100">
                            <h4 class="flex items-baseline justify-between gap-3 font-semibold text-zinc-700">
                                <span class="min-w-0">{{ groupTitle(group) }}</span>
                                <span class="shrink-0 text-zinc-400 tabular-nums">{{ group.count }}</span>
                            </h4>
                            <p v-if="group.kind" class="mt-0.5 text-zinc-500">{{ $t(`sync.action.${groupAction(group)}`) }}</p>
                        </div>
                        <ul>
                            <li
                                v-for="failure in group.items"
                                :key="failure.subject_id"
                                class="px-4 py-2.5 border-b border-zinc-100 select-text"
                            >
                                <div class="flex items-baseline justify-between gap-3">
                                    <span class="min-w-0 truncate font-medium text-zinc-800" :title="failure.label || failure.subject_id">
                                        {{ failure.label || failure.subject_id }}
                                    </span>
                                    <span v-if="failure.time" class="shrink-0 text-zinc-400 tabular-nums">
                                        {{ formatTemporalRelative(failure.time, locale) }}
                                    </span>
                                </div>
                                <p class="mt-0.5 text-zinc-500 leading-relaxed break-words">{{ failure.error }}</p>
                                <div
                                    v-if="groupAction(group) === 'reshare' && failure.post"
                                    class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold"
                                >
                                    <NuxtLink :to="`/posts/${failure.post.id}`" class="text-blue-600 hover:underline">
                                        {{ $t("jobs.inspector.open_post") }}
                                    </NuxtLink>
                                    <a
                                        v-if="failure.post.url"
                                        :href="failure.post.url"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        class="inline-flex items-center gap-1 text-blue-600 hover:underline"
                                    >
                                        <ExternalLink class="size-3" />
                                        {{ $t("sync.open_platform") }}
                                    </a>
                                </div>
                                <button
                                    v-else-if="groupAction(group) === 'replace' || groupAction(group) === 'change_kind'"
                                    type="button"
                                    class="mt-1 inline-flex items-center gap-1 font-semibold text-blue-600 hover:underline cursor-pointer"
                                    @click="emit('edit', failure.subject_id)"
                                >
                                    <Pencil class="size-3" />
                                    {{ $t("sync.edit") }}
                                </button>
                            </li>
                        </ul>
                    </section>
                </div>
            </section>
        </div>
    </div>
</template>
