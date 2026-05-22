<script setup lang="ts">
const { isSidebarOpen, closeSidebar } = useLayout();
const route = useRoute();

// Watch the route path to automatically close the mobile sidebar menu on page change
watch(() => route.fullPath, () => {
    closeSidebar();
});
</script>

<template>
    <div class="w-full h-dvh bg-white flex overflow-hidden font-sans text-gray-900">
        <!-- Left Sidebar (Desktop) -->
        <LeftSidebar class="hidden md:flex w-64 shrink-0" />

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
        </div>
    </div>
</template>
