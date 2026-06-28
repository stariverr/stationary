import { defineStore } from "pinia";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import { useLibraryStore } from "./library";
import { useApi } from "@/composables/useApi";
import { computed } from "vue";

export interface TagItem {
    id: string;
    name: string;
    normalized_name: string;
    aliases: string[];
    color: string | null;
    status: "ACTIVE" | "CANDIDATE" | "IGNORED";
    source: "SCRAPER" | "AI" | "USER" | "IMPORT";
    post_count: number;
    media_count: number;
}

export const useTagStore = defineStore("tags", () => {
    const libraryStore = useLibraryStore();
    const queryClient = useQueryClient();

    const activeLibraryId = computed(() => libraryStore.activeLibraryId);

    // TanStack Query to fetch tags for the active library
    const {
        data: tagsData,
        isLoading,
        refetch,
    } = useQuery({
        queryKey: computed(() => ["tags", activeLibraryId.value]),
        enabled: computed(() => !!activeLibraryId.value),
        queryFn: async () => {
            if (!activeLibraryId.value) return [];
            const response = await useApi<{
                success: boolean;
                data: TagItem[];
            }>("/tag/list", {
                query: {
                    library_id: activeLibraryId.value,
                },
            });
            if (response && response.success && response.data) {
                return response.data;
            }
            return [];
        },
    });

    const tags = computed(() => tagsData.value || []);

    // Filter tags into active, candidate, and ignored based on query results
    const activeTags = computed(() => tags.value.filter((t) => t.status === "ACTIVE"));
    const candidateTags = computed(() => tags.value.filter((t) => t.status === "CANDIDATE"));
    const ignoredTags = computed(() => tags.value.filter((t) => t.status === "IGNORED"));

    // Mutation: Create Tag
    const createTagMutation = useMutation({
        mutationFn: async (payload: { name: string; color?: string; aliases?: string[] }) => {
            if (!activeLibraryId.value) throw new Error("No active library selected");
            const response = await useApi<{ success: boolean; data: TagItem }>("/tag/create", {
                method: "POST",
                body: {
                    library_id: activeLibraryId.value,
                    name: payload.name,
                    color: payload.color || undefined,
                    aliases: payload.aliases || undefined,
                },
            });
            if (response && response.success) {
                return response.data;
            }
            throw new Error("Failed to create tag");
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tags", activeLibraryId.value] });
            // Also invalidate post queries to reflect tag changes
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            queryClient.invalidateQueries({ queryKey: ["post"] });
        },
    });

    // Mutation: Update Tag (renaming, color change, promotion, ignore, aliases)
    const updateTagMutation = useMutation({
        mutationFn: async (payload: {
            id: string;
            name?: string;
            color?: string | null;
            status?: "ACTIVE" | "CANDIDATE" | "IGNORED";
            aliases?: string[];
        }) => {
            const response = await useApi<{ success: boolean; data: TagItem }>("/tag/update", {
                method: "POST",
                body: payload,
            });
            if (response && response.success) {
                return response.data;
            }
            throw new Error("Failed to update tag");
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tags", activeLibraryId.value] });
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            queryClient.invalidateQueries({ queryKey: ["post"] });
        },
    });

    // Mutation: Delete Tag
    const deleteTagMutation = useMutation({
        mutationFn: async (tagId: string) => {
            const response = await useApi<{ success: boolean }>("/tag/delete/" + tagId, {
                method: "POST",
            });
            if (response && response.success) {
                return response;
            }
            throw new Error("Failed to delete tag");
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tags", activeLibraryId.value] });
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            queryClient.invalidateQueries({ queryKey: ["post"] });
        },
    });

    // Mutation: Merge Tags
    const mergeTagsMutation = useMutation({
        mutationFn: async (payload: { sourceTagId: string; targetTagId: string; retainAsAlias: boolean }) => {
            if (!activeLibraryId.value) throw new Error("No active library selected");
            const response = await useApi<{ success: boolean }>("/tag/merge", {
                method: "POST",
                body: {
                    library_id: activeLibraryId.value,
                    source_tag_id: payload.sourceTagId,
                    target_tag_id: payload.targetTagId,
                    retain_as_alias: payload.retainAsAlias,
                },
            });
            if (response && response.success) {
                return response;
            }
            throw new Error("Failed to merge tags");
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tags", activeLibraryId.value] });
            queryClient.invalidateQueries({ queryKey: ["posts"] });
            queryClient.invalidateQueries({ queryKey: ["post"] });
        },
    });

    return {
        tags,
        activeTags,
        candidateTags,
        ignoredTags,
        isLoading,
        refetch,

        createTag: createTagMutation.mutateAsync,
        isCreating: computed(() => createTagMutation.isPending.value),

        updateTag: updateTagMutation.mutateAsync,
        isUpdating: computed(() => updateTagMutation.isPending.value),

        deleteTag: deleteTagMutation.mutateAsync,
        isDeleting: computed(() => deleteTagMutation.isPending.value),

        mergeTags: mergeTagsMutation.mutateAsync,
        isMerging: computed(() => mergeTagsMutation.isPending.value),
    };
});
