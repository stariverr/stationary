<script setup lang="ts">
import { TriangleAlert, X } from "@lucide/vue";
import { useQuery } from "@tanstack/vue-query";
import { useLibraryStore } from "@/stores/library";
import type { ApiResponse } from "@/types/api";
import type { LibraryPipelines } from "@/types/pipeline";

/** Every open tab polls this on every page, so it stays far slower than the jobs page, which shows the same numbers itself. */
const POLL_INTERVAL_MS = 60_000;
/** Shorter waits are normal rate limiting during a backfill; a provider that keeps failing soon stays blocked for longer. */
const MIN_BLOCKED_SECONDS = 120;

const route = useRoute();
const libraryStore = useLibraryStore();
const libraryId = computed(() => libraryStore.activeLibrary?.id ?? null);
const onJobsPage = computed(() => route.path.startsWith("/jobs"));

const { data: blockedSeconds } = useQuery({
    queryKey: computed(() => ["provider-blocked", libraryId.value]),
    enabled: computed(() => libraryId.value !== null && !onJobsPage.value),
    // Stops while the tab is hidden.
    refetchInterval: POLL_INTERVAL_MS,
    retry: false,
    queryFn: async () => {
        const res = await useApi<ApiResponse<LibraryPipelines>>("/jobs/pipelines", { query: { library_id: libraryId.value } });
        return Math.max(0, ...(res?.data?.pipelines ?? []).map((status) => status.blocked_seconds));
    },
});

const isBlocked = computed(() => (blockedSeconds.value ?? 0) >= MIN_BLOCKED_SECONDS);
const dismissed = ref(false);

// A dismissed notice stays away until the block it was about is over.
watch(isBlocked, (blocked) => {
    if (!blocked) dismissed.value = false;
});
</script>

<template>
    <div
        v-if="isBlocked && !dismissed && !onJobsPage"
        role="status"
        class="shrink-0 flex items-center gap-2 border-b border-amber-200/80 bg-amber-50 px-4 md:px-6 py-2 text-xs font-medium text-amber-800"
    >
        <TriangleAlert class="size-3.5 shrink-0" />
        <span class="flex-1 min-w-0">
            {{ $t("jobs.provider_blocked.message", { minutes: Math.ceil((blockedSeconds ?? 0) / 60) }) }}
        </span>
        <NuxtLink
            to="/jobs"
            class="shrink-0 rounded-sm font-semibold underline underline-offset-2 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
        >
            {{ $t("jobs.provider_blocked.view") }}
        </NuxtLink>
        <button
            type="button"
            class="shrink-0 rounded-sm p-0.5 hover:text-amber-950 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
            :aria-label="$t('jobs.provider_blocked.dismiss')"
            @click="dismissed = true"
        >
            <X class="size-3.5" />
        </button>
    </div>
</template>
