import { useLayoutStore } from '@/stores/layout';

export const useLayout = () => {
    const store = useLayoutStore();

    return {
        isSidebarOpen: computed({
            get: () => store.isSidebarOpen,
            set: (val) => store.isSidebarOpen = val
        }),
        toggleSidebar: store.toggleSidebar,
        closeSidebar: store.closeSidebar
    };
};

