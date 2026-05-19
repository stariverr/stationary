<script setup lang="ts">
import { ref } from "vue";
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
import { authClient, useSession } from "@/lib/auth-client";
import { useLibraryStore } from "@/stores/library";
import { storeToRefs } from "pinia";
import CreateLibraryDialog from "@/components/CreateLibraryDialog.vue";

const session = useSession();
const emit = defineEmits(["open-settings"]);

const libraryStore = useLibraryStore();
const { libraries, activeLibrary } = storeToRefs(libraryStore);

const showCreateDialog = ref(false);
</script>

<template>
    <DropdownMenu>
        <DropdownMenuTrigger
            class="w-full flex items-center justify-between px-2 py-2 rounded-md hover:bg-[#e8e8e8] transition-colors focus:outline-none select-none"
        >
            <div class="flex items-center gap-2.5 flex-1 overflow-hidden">
                <Avatar class="h-8 w-8">
                    <AvatarImage
                        v-if="session.data?.user?.image"
                        :src="session.data?.user?.image"
                    />
                    <AvatarFallback
                        class="text-xs font-medium bg-blue-50 text-blue-600"
                    >
                        {{ session.data?.user?.name?.charAt(0) || "U" }}
                    </AvatarFallback>
                </Avatar>
                <div class="flex flex-col items-start overflow-hidden min-w-0">
                    <span
                        class="text-sm font-semibold truncate w-full text-left leading-tight text-gray-900"
                    >
                        {{ activeLibrary?.name || "Loading..." }}
                    </span>
                    <span
                        class="text-xs text-gray-500 truncate w-full text-left leading-tight mt-0.5"
                    >
                        {{ session.data?.user?.name || "User" }}
                    </span>
                </div>
            </div>
            <ChevronsUpDown class="w-4 h-4 text-[#808080] shrink-0 ml-1" />
        </DropdownMenuTrigger>

        <DropdownMenuContent class="w-60" align="start" :side-offset="8">
            <!-- User Account Section -->
            <div v-if="session.data?.user" class="flex items-center gap-2 p-2">
                <Avatar class="h-8 w-8">
                    <AvatarImage
                        v-if="session.data.user?.image"
                        :src="session.data.user?.image"
                    />
                    <AvatarFallback>{{
                        session.data.user?.name?.charAt(0) || "U"
                    }}</AvatarFallback>
                </Avatar>
                <div class="flex flex-col space-y-1 overflow-hidden">
                    <span class="text-sm font-medium leading-none truncate">{{
                        session.data.user?.name || "User"
                    }}</span>
                    <span
                        class="text-xs text-muted-foreground leading-none truncate"
                        >{{ session.data.user?.email || "" }}</span
                    >
                </div>
            </div>

            <DropdownMenuSeparator />

            <DropdownMenuLabel class="text-xs text-muted-foreground font-normal"
                >Workspaces</DropdownMenuLabel
            >

            <div class="max-h-48 overflow-y-auto custom-scrollbar">
                <DropdownMenuItem
                    v-for="lib in libraries"
                    :key="lib.id"
                    class="cursor-pointer flex items-center justify-between"
                    @click="libraryStore.setActiveLibrary(lib.id)"
                >
                    <div class="flex items-center gap-2 overflow-hidden flex-1">
                        <Avatar class="h-5 w-5 rounded-sm shrink-0">
                            <AvatarFallback
                                class="rounded-sm text-[8px] bg-primary text-primary-foreground"
                            >
                                {{ lib.name.charAt(0).toUpperCase() }}
                            </AvatarFallback>
                        </Avatar>
                        <span class="truncate">{{ lib.name }}</span>
                    </div>
                    <Check
                        v-if="activeLibrary?.id === lib.id"
                        class="w-4 h-4 text-blue-600 shrink-0"
                    />
                </DropdownMenuItem>
            </div>

            <DropdownMenuSeparator />

            <DropdownMenuItem
                class="cursor-pointer"
                @click="showCreateDialog = true"
            >
                <Plus class="mr-2 h-4 w-4" />
                <span>Create Workspace</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
                class="cursor-pointer"
                @click="$emit('open-settings')"
            >
                <Settings class="mr-2 h-4 w-4" />
                <span>Settings</span>
            </DropdownMenuItem>
            <DropdownMenuItem
                class="cursor-pointer text-red-600 focus:text-red-600 focus:bg-red-50"
                @click="authClient.signOut()"
            >
                <LogOut class="mr-2 h-4 w-4" />
                <span>Log out</span>
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
