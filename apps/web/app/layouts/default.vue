<script setup lang="ts">
import { useUserStore } from "@/stores/user";
import { useSession } from "@/lib/auth-client";
import { watch, onMounted, onBeforeUnmount } from "vue";
import { useWindowSize } from "@vueuse/core";
import { FocusScope } from "reka-ui";
import { X } from "@lucide/vue";

const { isSidebarOpen, isSidebarCollapsed, toggleSidebar, closeSidebar } = useAppLayout();
const route = useRoute();

function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && isSidebarOpen.value) {
        closeSidebar();
        return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        const target = event.target as HTMLElement | null;
        const isInteractive =
            target &&
            (target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable ||
                target.getAttribute("role") === "textbox");

        if (!isInteractive) {
            event.preventDefault();
            toggleSidebar();
        }
    }
}

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
    window.addEventListener("keydown", handleKeydown);
});

onBeforeUnmount(() => {
    window.removeEventListener("keydown", handleKeydown);
});

// Watch the route path to automatically close the mobile sidebar menu on page change
watch(
    () => route.fullPath,
    () => {
        closeSidebar();
    },
);

// Close the mobile sidebar when resizing up to desktop, so focus is never trapped by a hidden overlay
const { width: windowWidth } = useWindowSize();
watch(windowWidth, (width) => {
    if (width >= 768) {
        closeSidebar();
    }
});
</script>

<template>
    <div class="w-full min-h-screen md:h-screen bg-[#f9fafb] flex md:overflow-hidden font-sans text-zinc-900">
        <!-- Skip to main content (first focusable element) -->
        <a
            href="#main-content"
            class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-zinc-900 focus:shadow-lg"
        >
            {{ $t("common.skip_to_content", "Skip to content") }}
        </a>

        <!-- Left Sidebar (Desktop) -->
        <LeftSidebar
            :inert="isSidebarOpen || undefined"
            class="hidden md:flex shrink-0 transition-[width,opacity] duration-300 ease-in-out"
            :class="isSidebarCollapsed ? 'w-0 !px-0 !border-r-0 opacity-0 overflow-hidden pointer-events-none' : 'w-64'"
        />

        <!-- Left Sidebar (Mobile Overlay) -->
        <FocusScope v-if="isSidebarOpen" as-child :trapped="true" :loop="true">
            <div
                class="fixed inset-0 z-40 flex md:hidden"
                role="dialog"
                aria-modal="true"
                :aria-label="$t('common.navigation', 'Navigation')"
            >
                <div class="fixed inset-0 bg-black/50" @click="closeSidebar"></div>
                <LeftSidebar class="relative z-50 w-64 h-full shadow-xl" />
                <button
                    type="button"
                    :aria-label="$t('common.close_navigation', 'Close navigation')"
                    class="absolute left-[calc(16rem+0.75rem)] top-3 z-50 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-zinc-700 shadow-lg hover:bg-white active:scale-95 transition"
                    @click="closeSidebar"
                >
                    <X class="h-4 w-4" />
                </button>
            </div>
        </FocusScope>

        <!-- Main Content Area -->
        <div :inert="isSidebarOpen || undefined" class="flex-1 flex flex-col min-w-0 min-h-0 bg-[#f9fafb] relative">
            <main id="main-content" class="flex-1 flex w-full min-h-0 relative">
                <!-- Main View Container -->
                <div class="flex-1 min-w-0 min-h-0 flex flex-col relative">
                    <slot />
                </div>
            </main>

            <!-- Full-Screen Post Detail Overlay -->
            <PostDetail />

            <!-- Global Upload & Progress Tracker -->
            <GlobalUploadTracker />
        </div>
    </div>
</template>
