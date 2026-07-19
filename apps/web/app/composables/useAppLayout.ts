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
        toggleSidebar: store.toggleSidebar,
        closeSidebar: store.closeSidebar,
    };
};
