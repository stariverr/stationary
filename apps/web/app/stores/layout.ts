import { defineStore } from "pinia";
import { ref } from "vue";

export const useLayoutStore = defineStore("layout", () => {
    const isSidebarOpen = ref(false);
    const isSidebarCollapsed = ref(false);

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
        toggleSidebar,
        closeSidebar,
    };
});
