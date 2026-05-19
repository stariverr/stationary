import { defineStore } from 'pinia';

export const useLayoutStore = defineStore('layout', () => {
    const isSidebarOpen = ref(false);

    const toggleSidebar = () => {
        isSidebarOpen.value = !isSidebarOpen.value;
    };

    const closeSidebar = () => {
        isSidebarOpen.value = false;
    };

    return {
        isSidebarOpen,
        toggleSidebar,
        closeSidebar
    };
});
