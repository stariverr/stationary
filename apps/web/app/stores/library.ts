import { defineStore, skipHydrate } from "pinia";
import { useQuery } from "@tanstack/vue-query";
import { useStorage } from "@vueuse/core";
import { useApi } from "@/composables/useApi";
import { computed, watch } from "vue";

export interface LibraryItem {
    id: string;
    name: string;
    description: string;
    is_public: boolean;
}

export interface MoveItemsPayload {
    postIds: string[];
    mediaIds: string[];
    targetLibraryId: string;
}

export const useLibraryStore = defineStore("library", () => {
    // Persist the selected library ID in localStorage
    const activeLibraryId = useStorage<string | null>("stationary-active-library", null);

    const {
        data: librariesData,
        isLoading,
        refetch,
    } = useQuery({
        queryKey: ["libraries"],
        queryFn: async () => {
            const response = await useApi<{
                success: boolean;
                data: { list: LibraryItem[]; total?: number };
            }>("/library/list");
            if (response && response.success && response.data) {
                return response.data.list;
            }
            return [];
        },
    });

    const libraries = computed(() => librariesData.value || []);

    // Once loaded, fall back to the first library if the stored selection is empty or no longer accessible
    if (import.meta.client) {
        watch(
            librariesData,
            (newLibraries) => {
                if (!newLibraries || newLibraries.some((l) => l.id === activeLibraryId.value)) return;
                activeLibraryId.value = newLibraries[0]?.id ?? null;
            },
            { immediate: true },
        );
    }

    const activeLibrary = computed(() => {
        return libraries.value.find((l) => l.id === activeLibraryId.value) || libraries.value[0] || null;
    });

    const setActiveLibrary = (id: string) => {
        activeLibraryId.value = id;
    };

    /** `aiLanguage` (BCP 47) is the language AI image descriptions are written in, normally the UI locale. */
    const createLibrary = async (name: string, description: string, aiLanguage: string) => {
        const response = await useApi<{ success: boolean; data: LibraryItem }>("/library/create", {
            method: "POST",
            body: { name, description, ai_language: aiLanguage },
        });
        if (response && response.success) {
            await refetch();
            setActiveLibrary(response.data.id);
            return response.data;
        }
        throw new Error("Failed to create library");
    };

    const moveItems = async (payload: MoveItemsPayload) => {
        const response = await useApi<{
            success: boolean;
            message?: string;
            data: { posts: number; media: number; post_media: number };
        }>("/library/move-items", {
            method: "POST",
            body: {
                post_ids: payload.postIds,
                media_ids: payload.mediaIds,
                target_library_id: payload.targetLibraryId,
            },
        });

        if (response && response.success) {
            return response.data;
        }

        throw new Error(response?.message || "Failed to move items");
    };

    return {
        libraries,
        activeLibraryId: skipHydrate(activeLibraryId),
        activeLibrary,
        isLoading,
        setActiveLibrary,
        createLibrary,
        moveItems,
        refetch,
    };
});
