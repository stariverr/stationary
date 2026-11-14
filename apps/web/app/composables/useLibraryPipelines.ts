import type { Ref } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import type { ApiResponse } from "@/types/api";
import type { LibraryPipelines, PipelineFailure, PipelineName } from "@/types/pipeline";

const STATUS_POLL_MS = 5000;

const statusKey = (libraryId: string | null) => ["pipelines", libraryId];

/** Pipeline status of a library, polled while the tab is visible, with the actions the jobs page offers on it. */
export function useLibraryPipelines(libraryId: Ref<string | null>) {
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: computed(() => statusKey(libraryId.value)),
        enabled: computed(() => libraryId.value !== null),
        refetchInterval: STATUS_POLL_MS,
        queryFn: async () => {
            const res = await useApi<ApiResponse<LibraryPipelines>>("/jobs/pipelines", { query: { library_id: libraryId.value } });
            if (!res?.data) throw new Error(res?.message);
            return res.data;
        },
    });

    const refresh = () => queryClient.invalidateQueries({ queryKey: statusKey(libraryId.value) });

    const setPaused = async (paused: boolean) => {
        await useApi(`/jobs/pipelines/${libraryId.value}/paused`, { method: "PUT", body: { paused } });
        await refresh();
    };

    /** Queues every current failure of a pipeline again; resolves to how many were queued. */
    const retryFailed = async (pipeline: PipelineName) => {
        const res = await useApi<ApiResponse<{ retried: number }>>(`/jobs/pipelines/${libraryId.value}/${pipeline}/retry-failed`, {
            method: "POST",
        });
        await refresh();
        return res?.data?.retried ?? 0;
    };

    /** Resets work whose worker stopped answering. */
    const sweepStuck = async () => {
        const res = await useApi<ApiResponse<unknown>>("/task/sweep-stuck-library", {
            method: "POST",
            body: { library_id: libraryId.value },
        });
        if (!res?.success) throw new Error(res?.message);
        await refresh();
    };

    return { query, setPaused, retryFailed, sweepStuck };
}

/** Recent failures of one pipeline; refetched whenever the failure count it was loaded for changes. */
export function usePipelineFailures(libraryId: Ref<string | null>, pipeline: Ref<PipelineName | null>, failedCount: Ref<number>) {
    return useQuery({
        queryKey: computed(() => ["pipeline-failures", libraryId.value, pipeline.value, failedCount.value]),
        enabled: computed(() => libraryId.value !== null && pipeline.value !== null && failedCount.value > 0),
        // Keeps the list in place while a changed count reloads it, but not across pipelines.
        placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === pipeline.value ? previous : undefined),
        queryFn: async () => {
            const res = await useApi<ApiResponse<{ items: PipelineFailure[] }>>(
                `/jobs/pipelines/${libraryId.value}/${pipeline.value}/failures`,
                { query: { limit: 50 } },
            );
            return res?.data?.items ?? [];
        },
    });
}
