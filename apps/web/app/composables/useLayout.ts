import { useLayoutStore } from "@/stores/layout";
import { computed } from "vue";

export const useLayout = () => {
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
        toggleSidebar: store.toggleSidebar,
        closeSidebar: store.closeSidebar,
    };
};
