import { defineStore, skipHydrate } from "pinia";
import { ref, computed } from "vue";
import { useStorage } from "@vueuse/core";

export type PostItemAspectRatio = "4:3" | "3:4" | "16:9" | "1:1" | "3:2" | "9:16" | "auto";
export type PostItemSize = "sm" | "md" | "lg" | "xl";
export type PostLayoutMode = "grid" | "list";

export const useLayoutStore = defineStore("layout", () => {
    const isSidebarOpen = ref(false);
    const isSidebarCollapsed = ref(false);
    const isCreatePostOpen = ref(false);
    const isCreateMediaOpen = ref(false);

    // Persisted view settings for post list cards
    const postItemAspectRatio = useStorage<PostItemAspectRatio>("stationary-post-item-aspect-ratio", "4:3");
    const postItemSize = useStorage<PostItemSize>("stationary-post-item-size", "md");
    const postLayoutMode = useStorage<PostLayoutMode>("stationary-post-layout-mode", "grid");

    const postItemSizePx = computed(() => {
        switch (postItemSize.value) {
            case "sm":
                return 150;
            case "lg":
                return 260;
            case "xl":
                return 320;
            case "md":
            default:
                return 200;
        }
    });

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
        postItemSize: skipHydrate(postItemSize),
        postLayoutMode: skipHydrate(postLayoutMode),
        postItemSizePx,
        toggleSidebar,
        closeSidebar,
    };
});
