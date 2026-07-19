<script setup lang="ts">
import { useUserStore } from "@/stores/user";
import { useSession } from "@/lib/auth-client";
import { watch, onMounted } from "vue";

const { isSidebarOpen, isSidebarCollapsed, closeSidebar } = useAppLayout();
const route = useRoute();

const userStore = useUserStore();
const session = useSession();
watch(
    () => session.value.data?.user,
    (user) => {
        console.log("[Layout Default] session user changed:", user);
        if (user) {
            console.log("[Layout Default] User logged in, fetching business profile...");
            userStore.fetchUserProfile();
        }
    },
    { immediate: true },
);

onMounted(() => {
    const user = session.value.data?.user;
    console.log("[Layout Default] Mounted, current session user:", user);
    if (user) {
        console.log("[Layout Default] Mounting with logged in user, fetching business profile...");
        userStore.fetchUserProfile();
    }
});

// Watch the route path to automatically close the mobile sidebar menu on page change
watch(
    () => route.fullPath,
    () => {
        closeSidebar();
    },
);
</script>

<template>
    <div class="w-full min-h-screen md:h-screen bg-white flex md:overflow-hidden font-sans text-gray-900">
        <!-- Left Sidebar (Desktop) -->
        <LeftSidebar
            class="hidden md:flex shrink-0 transition-all duration-300 ease-in-out"
            :class="isSidebarCollapsed ? 'w-0 !px-0 !border-r-0 opacity-0 overflow-hidden pointer-events-none' : 'w-64'"
        />

        <!-- Left Sidebar (Mobile Overlay) -->
        <div v-if="isSidebarOpen" class="fixed inset-0 z-40 flex md:hidden">
            <div class="fixed inset-0 bg-black/50" @click="closeSidebar"></div>
            <LeftSidebar class="relative z-50 w-64 h-full shadow-xl" />
        </div>

        <!-- Main Content Area -->
        <div class="flex-1 flex flex-col min-w-0 min-h-0 bg-white relative">
            <div class="flex-1 flex w-full min-h-0 relative">
                <!-- Main View Container -->
                <div class="flex-1 min-w-0 min-h-0 flex flex-col relative">
                    <slot />
                </div>

                <!-- Sliding Detail Panel -->
                <PostDetail />
            </div>

            <!-- Global Upload & Draft Tray Box -->
            <GlobalDraftTray />
        </div>
    </div>
</template>
