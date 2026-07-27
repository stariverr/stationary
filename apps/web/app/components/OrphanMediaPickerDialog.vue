<script setup lang="ts">
import { ref, watch } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2 } from "@lucide/vue";
import { useApi } from "@/composables/useApi";
import { toast } from "vue-sonner";

const props = defineProps<{
    open: boolean;
    libraryId?: string;
}>();

const emit = defineEmits<{
    (e: "update:open", value: boolean): void;
    (e: "attach", mediaIds: string[]): void;
}>();

const orphanMediaList = ref<any[]>([]);
const selectedOrphanIds = ref<string[]>([]);
const isLoadingOrphans = ref(false);
const isAttaching = ref(false);

const loadOrphans = async () => {
    if (!props.libraryId) return;
    isLoadingOrphans.value = true;
    try {
        const res = await useApi<{ success: boolean; data: { list: any[] } }>(
            `/media/list?library_id=${props.libraryId}&has_no_post=true&count=100`,
        );
        if (res && res.success) {
            orphanMediaList.value = res.data.list;
        }
    } catch (e) {
        console.error("Failed to fetch orphan media:", e);
    } finally {
        isLoadingOrphans.value = false;
    }
};

watch(
    () => props.open,
    (isOpen) => {
        if (isOpen) {
            selectedOrphanIds.value = [];
            loadOrphans();
        }
    },
);

const handleAttachOrphans = async () => {
    if (selectedOrphanIds.value.length === 0) return;
    isAttaching.value = true;
    emit("attach", selectedOrphanIds.value);
    isAttaching.value = false;
};
</script>

<template>
    <Dialog :open="open" @update:open="emit('update:open', $event)">
        <DialogContent class="sm:max-w-150 max-h-[80vh] flex flex-col p-6 bg-white rounded-lg">
            <DialogHeader class="border-b border-zinc-100 pb-3 shrink-0">
                <DialogTitle class="text-sm font-bold text-zinc-950">
                    {{ $t("post_detail.manage.link_orphan_title") }}
                </DialogTitle>
                <DialogDescription class="text-xs text-zinc-500 mt-1">
                    {{ $t("post_detail.manage.link_orphan_desc") }}
                </DialogDescription>
            </DialogHeader>

            <div class="flex-1 overflow-y-auto py-4 min-h-0 divide-y divide-zinc-50 scrollbar-thin">
                <div v-if="isLoadingOrphans" class="flex items-center justify-center p-8 gap-2 text-zinc-500">
                    <Loader2 class="w-4 h-4 animate-spin text-emerald-600" />
                    <span class="text-xs">{{ $t("post_detail.manage.loading_playlist") }}</span>
                </div>
                <div v-else-if="orphanMediaList.length === 0" class="text-center p-8 text-xs text-zinc-400">
                    {{ $t("post_detail.manage.no_orphan_found") }}
                </div>
                <template v-else>
                    <div v-for="orphan in orphanMediaList" :key="orphan.id" class="py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div class="flex items-center gap-3 min-w-0">
                            <Checkbox
                                :checked="selectedOrphanIds.includes(orphan.id)"
                                @update:checked="
                                    (checked: boolean) => {
                                        if (checked) selectedOrphanIds.push(orphan.id);
                                        else selectedOrphanIds = selectedOrphanIds.filter((id) => id !== orphan.id);
                                    }
                                "
                            />
                            <div class="w-10 h-10 bg-zinc-100 rounded-md overflow-hidden shrink-0 flex items-center justify-center">
                                <img
                                    v-if="orphan.cover_url || orphan.url"
                                    :src="orphan.cover_url || orphan.url"
                                    class="w-full h-full object-cover"
                                />
                            </div>
                            <span class="truncate font-medium text-zinc-800">
                                {{ orphan.title || $t("post_detail.manage.untitled_media") }}
                            </span>
                        </div>
                        <span class="font-mono text-[10px] text-zinc-400 uppercase bg-zinc-50 px-1.5 py-0.5 rounded">
                            {{ orphan.type }}
                        </span>
                    </div>
                </template>
            </div>

            <div class="flex items-center justify-end gap-2 border-t border-zinc-100 pt-3 shrink-0">
                <button
                    @click="emit('update:open', false)"
                    class="px-4 py-1.5 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-600 text-xs font-semibold cursor-pointer transition-colors"
                >
                    {{ $t("common.cancel") }}
                </button>
                <button
                    @click="handleAttachOrphans"
                    :disabled="selectedOrphanIds.length === 0 || isAttaching"
                    class="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors shadow-sm"
                >
                    <Loader2 v-if="isAttaching" class="w-3.5 h-3.5 animate-spin" />
                    {{ $t("post_detail.manage.attach_selection") }}
                </button>
            </div>
        </DialogContent>
    </Dialog>
</template>
