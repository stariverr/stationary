import { useLayoutStore } from "@/stores/layout";
import { computed } from "vue";

export const useAppLayout = () => {
    const store = useLayoutStore();

    return {
        isSidebarOpen: computed({
            get: () => store.isSidebarOpen,
            set: (val) => (store.isSidebarOpen = val),
        }),
        isSidebarCollapsed: computed({
            get: () => store.isSidebarCollapsed,
            set: (val) => (store.isSidebarCollapsed = val),
        }),
        isCreatePostOpen: computed({
            get: () => store.isCreatePostOpen,
            set: (val) => (store.isCreatePostOpen = val),
        }),
        isCreateMediaOpen: computed({
            get: () => store.isCreateMediaOpen,
            set: (val) => (store.isCreateMediaOpen = val),
        }),
        postItemAspectRatio: computed({
            get: () => store.postItemAspectRatio,
            set: (val) => (store.postItemAspectRatio = val),
        }),
        postItemSize: computed({
            get: () => store.postItemSize,
            set: (val) => (store.postItemSize = val),
        }),
        postLayoutMode: computed({
            get: () => store.postLayoutMode,
            set: (val) => (store.postLayoutMode = val),
        }),
        postItemSizePx: computed(() => store.postItemSizePx),
        toggleSidebar: store.toggleSidebar,
        closeSidebar: store.closeSidebar,
    };
};
