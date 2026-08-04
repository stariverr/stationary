import { defineStore, skipHydrate } from "pinia";
import { ref } from "vue";
import { useStorage } from "@vueuse/core";

export type PostItemAspectRatio = "4:3" | "3:4" | "16:9" | "1:1" | "3:2" | "9:16" | "auto";
export type PostLayoutMode = "grid" | "list";

export const useLayoutStore = defineStore("layout", () => {
    const isSidebarOpen = ref(false);
    const isSidebarCollapsed = ref(false);
    const isCreatePostOpen = ref(false);
    const isCreateMediaOpen = ref(false);

    // Persisted view settings for post list cards
    const postItemAspectRatio = useStorage<PostItemAspectRatio>("stationary-post-item-aspect-ratio", "3:4");
    const postItemColumns = useStorage<number>("stationary-post-item-columns", 0);
    const postItemTargetWidth = useStorage<number>("stationary-post-item-target-width", 200);
    const postLayoutMode = useStorage<PostLayoutMode>("stationary-post-layout-mode", "grid");

    const toggleSidebar = () => {
        if (typeof window !== "undefined" && window.innerWidth < 768) {
            isSidebarOpen.value = !isSidebarOpen.value;
        } else {
            isSidebarCollapsed.value = !isSidebarCollapsed.value;
        }
    };

    const closeSidebar = () => {
        isSidebarOpen.value = false;
    };

    return {
        isSidebarOpen,
        isSidebarCollapsed,
        isCreatePostOpen,
        isCreateMediaOpen,
        postItemAspectRatio: skipHydrate(postItemAspectRatio),
        postItemColumns: skipHydrate(postItemColumns),
        postItemTargetWidth: skipHydrate(postItemTargetWidth),
        postLayoutMode: skipHydrate(postLayoutMode),
        toggleSidebar,
        closeSidebar,
    };
});
