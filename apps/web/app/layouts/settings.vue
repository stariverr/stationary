<script setup lang="ts">
import { storeToRefs } from "pinia";
import { ArrowLeft, Globe, Palette, UserRound, Key, Library, Sparkles } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useUserStore } from "@/stores/user";
import { cn } from "@/lib/utils";

/**
 * Settings replace the app sidebar with their own navigation (as in Linear or Slack), so the page
 * never shows the app navigation, a settings menu and the page's own lists side by side.
 */
const route = useRoute();
const returnTo = useState<string>("settings-return-to", () => "/");

const groups = [
    {
        label: "settings.groups.preferences",
        items: [
            { path: "/settings/general", label: "settings.tabs.general", desc: "settings.general.desc", icon: Globe },
            { path: "/settings/appearance", label: "settings.tabs.appearance", desc: "settings.appearance.desc", icon: Palette },
        ],
    },
    {
        label: "settings.groups.account",
        items: [
            { path: "/settings/account", label: "settings.tabs.account", desc: "settings.account.desc", icon: UserRound },
            { path: "/settings/api-keys", label: "settings.tabs.api_keys", desc: "settings.api_keys.desc", icon: Key },
        ],
    },
    {
        label: "settings.groups.workspace",
        items: [
            { path: "/settings/library", label: "settings.tabs.library", desc: "settings.library_config.desc", icon: Library },
            { path: "/settings/ai", label: "settings.tabs.ai_services", desc: "settings.ai_config.desc", icon: Sparkles },
        ],
    },
];

const current = computed(() => groups.flatMap((group) => group.items).find((item) => item.path === route.path));

// On phones the sections scroll sideways; keep the current one in view.
const mobileNav = useTemplateRef<HTMLElement>("mobileNav");
const scrollToCurrent = async () => {
    await nextTick();
    mobileNav.value?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
};
onMounted(scrollToCurrent);
watch(() => route.path, scrollToCurrent);

// The account page shows the business profile, which the app layout loads otherwise.
const userStore = useUserStore();
const { userProfile } = storeToRefs(userStore);
onMounted(() => {
    if (!userProfile.value) userStore.fetchUserProfile();
});
</script>

<template>
    <div class="flex min-h-screen w-full flex-col bg-background font-sans text-foreground md:h-screen md:flex-row md:overflow-hidden">
        <!-- Desktop: settings navigation in place of the app sidebar -->
        <aside
            class="hidden w-64 shrink-0 flex-col border-r border-zinc-200/80 bg-zinc-50/80 text-sm select-none md:flex dark:border-zinc-800 dark:bg-zinc-900/60"
        >
            <div class="flex h-14 shrink-0 items-center border-b border-zinc-200/80 px-3.5 dark:border-zinc-800">
                <Button as-child variant="ghost" size="sm" class="-ml-1 gap-2 text-muted-foreground hover:text-foreground">
                    <NuxtLink :to="returnTo">
                        <ArrowLeft />
                        {{ $t("settings.back_to_app") }}
                    </NuxtLink>
                </Button>
            </div>
            <nav class="flex flex-1 flex-col gap-5 overflow-y-auto px-3.5 py-4" :aria-label="$t('settings.title')">
                <div v-for="group in groups" :key="group.label" class="flex flex-col gap-1">
                    <p class="px-3 pb-1 text-xs font-medium text-muted-foreground">{{ $t(group.label) }}</p>
                    <NuxtLink
                        v-for="item in group.items"
                        :key="item.path"
                        :to="item.path"
                        :aria-current="route.path === item.path ? 'page' : undefined"
                        :class="
                            cn(
                                'group flex h-9 items-center gap-3 rounded-lg border px-3 font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                                route.path === item.path
                                    ? 'border-zinc-200/80 bg-white font-semibold text-zinc-950 shadow-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50'
                                    : 'border-transparent text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
                            )
                        "
                    >
                        <component
                            :is="item.icon"
                            :class="
                                cn(
                                    'size-4.5 shrink-0 transition-colors',
                                    route.path === item.path
                                        ? 'text-zinc-950 dark:text-zinc-50'
                                        : 'text-zinc-400 group-hover:text-zinc-700 dark:group-hover:text-zinc-200',
                                )
                            "
                        />
                        <span class="truncate">{{ $t(item.label) }}</span>
                    </NuxtLink>
                </div>
            </nav>
        </aside>

        <!-- Mobile: back button, then the sections as a scrolling strip -->
        <header class="sticky top-0 z-30 border-b bg-background/95 backdrop-blur-xs md:hidden">
            <div class="flex h-14 items-center gap-2 px-2">
                <Button as-child variant="ghost" size="icon" :aria-label="$t('settings.back_to_app')">
                    <NuxtLink :to="returnTo"><ArrowLeft /></NuxtLink>
                </Button>
                <span class="font-semibold">{{ $t("settings.title") }}</span>
            </div>
            <nav ref="mobileNav" class="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]" :aria-label="$t('settings.title')">
                <Button
                    v-for="item in groups.flatMap((group) => group.items)"
                    :key="item.path"
                    as-child
                    variant="ghost"
                    size="sm"
                    :class="cn('shrink-0 text-muted-foreground', route.path === item.path && 'bg-accent text-accent-foreground')"
                >
                    <NuxtLink :to="item.path">{{ $t(item.label) }}</NuxtLink>
                </Button>
            </nav>
        </header>

        <main id="main-content" class="min-w-0 flex-1 md:overflow-y-auto">
            <div :class="cn('mx-auto w-full px-4 py-6 md:px-10 md:py-10', route.meta.settingsWide ? 'max-w-6xl' : 'max-w-3xl')">
                <header v-if="current" class="mb-8 grid gap-1">
                    <h1 class="text-2xl font-semibold tracking-tight">{{ $t(current.label) }}</h1>
                    <p class="text-sm text-muted-foreground">{{ $t(current.desc) }}</p>
                </header>
                <slot />
            </div>
        </main>

        <GlobalUploadTracker />
    </div>
</template>
