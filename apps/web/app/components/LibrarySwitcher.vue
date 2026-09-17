<script setup lang="ts">
import { ref, computed } from "vue";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChevronsUpDown, LogOut, Settings, Plus, Check } from "@lucide/vue";
import { useLibraryStore } from "@/stores/library";
import { useUserStore } from "@/stores/user";
import { storeToRefs } from "pinia";
import CreateLibraryDialog from "@/components/CreateLibraryDialog.vue";

const { $auth } = useNuxtApp();
const session = $auth.useSession();
const emit = defineEmits(["open-settings"]);

const libraryStore = useLibraryStore();
const { libraries, activeLibrary } = storeToRefs(libraryStore);

const userStore = useUserStore();
const { userProfile } = storeToRefs(userStore);

const displayName = computed(() => userProfile.value?.name || "User");
const displayImage = computed(() => userProfile.value?.image || "");
const userEmail = computed(() => userProfile.value?.email || "");

const showCreateDialog = ref(false);
</script>

<template>
    <DropdownMenu>
        <DropdownMenuTrigger
            class="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-zinc-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 select-none group text-left cursor-pointer"
        >
            <div class="flex items-center gap-2.5 flex-1 overflow-hidden">
                <Avatar class="h-8 w-8 shrink-0">
                    <AvatarImage v-if="displayImage" :src="displayImage" />
                    <AvatarFallback class="text-xs font-medium bg-zinc-100 text-zinc-700">
                        {{ displayName.charAt(0) || "U" }}
                    </AvatarFallback>
                </Avatar>
                <div class="flex flex-col items-start overflow-hidden min-w-0">
                    <span class="text-sm font-semibold truncate w-full text-left leading-tight text-zinc-900">
                        {{ activeLibrary?.name || "Loading..." }}
                    </span>
                    <span class="text-xs text-zinc-500 truncate w-full text-left leading-tight mt-0.5">
                        {{ displayName }}
                    </span>
                </div>
            </div>
            <ChevronsUpDown class="w-4 h-4 text-zinc-400 group-hover:text-zinc-600 transition-colors shrink-0 ml-1" />
        </DropdownMenuTrigger>

        <DropdownMenuContent class="w-60" align="start" :side-offset="8">
            <!-- User Account Section -->
            <div v-if="session.data?.user" class="flex items-center gap-2 p-2">
                <Avatar class="h-8 w-8">
                    <AvatarImage v-if="displayImage" :src="displayImage" />
                    <AvatarFallback>{{ displayName.charAt(0) || "U" }}</AvatarFallback>
                </Avatar>
                <div class="flex flex-col space-y-1 overflow-hidden">
                    <span class="text-sm font-medium leading-none truncate">{{ displayName }}</span>
                    <span class="text-xs text-muted-foreground leading-none truncate">{{ userEmail }}</span>
                </div>
            </div>

            <DropdownMenuSeparator />

            <DropdownMenuLabel class="text-xs text-muted-foreground font-normal">{{
                $t("common.library_switch", "Libraries")
            }}</DropdownMenuLabel>

            <div class="max-h-48 overflow-y-auto custom-scrollbar">
                <DropdownMenuItem
                    v-for="lib in libraries"
                    :key="lib.id"
                    class="cursor-pointer flex items-center justify-between"
                    @click="libraryStore.setActiveLibrary(lib.id)"
                >
                    <div class="flex items-center gap-2 overflow-hidden flex-1">
                        <Avatar class="h-5 w-5 rounded-sm shrink-0">
                            <AvatarFallback class="rounded-sm text-xs bg-primary text-primary-foreground">
                                {{ lib.name.charAt(0).toUpperCase() }}
                            </AvatarFallback>
                        </Avatar>
                        <span class="truncate">{{ lib.name }}</span>
                    </div>
                    <Check v-if="activeLibrary?.id === lib.id" class="w-4 h-4 text-zinc-900 shrink-0" />
                </DropdownMenuItem>
            </div>

            <DropdownMenuSeparator />

            <DropdownMenuItem class="cursor-pointer" @click="showCreateDialog = true">
                <Plus class="mr-2 h-4 w-4" />
                <span>{{ $t("common.create_library", "Create Library") }}</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem class="cursor-pointer" @click="$emit('open-settings')">
                <Settings class="mr-2 h-4 w-4" />
                <span>{{ $t("common.settings", "Settings") }}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
                class="cursor-pointer text-red-600 focus:text-red-600 focus:bg-red-50"
                @click="
                    async () => {
                        await $auth.signOut();
                        navigateTo('/login');
                    }
                "
            >
                <LogOut class="mr-2 h-4 w-4" />
                <span>{{ $t("common.log_out", "Log out") }}</span>
            </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>

    <!-- Create Library Dialog -->
    <CreateLibraryDialog v-model:open="showCreateDialog" />
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
    width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
    background-color: rgba(0, 0, 0, 0.1);
    border-radius: 4px;
}
</style>
