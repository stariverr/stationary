<script setup lang="ts">
import { ref, watch } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Layers } from "@lucide/vue";
import MediaVariantsManager from "@/components/MediaVariantsManager.vue";

const props = defineProps<{
    open: boolean;
    mediaList: any[];
    initialMediaId?: string | null;
}>();

const emit = defineEmits<{
    (e: "update:open", value: boolean): void;
    (e: "change-media", mediaId: string): void;
}>();

const trackEditMediaId = ref<string | undefined>(undefined);

watch(
    () => props.open,
    (isOpen) => {
        if (isOpen) {
            trackEditMediaId.value = props.initialMediaId || props.mediaList[0]?.id;
        }
    },
);

watch(
    () => props.initialMediaId,
    (newId) => {
        if (props.open && newId) {
            trackEditMediaId.value = newId;
        }
    },
);

const { t } = useI18n();
const formatMediaType = (type?: string | null) => getMediaTypeLabel(type, t);
const getMediaThumb = (med: any) => {
    if (!med) return null;
    return (
        med.cover_url ||
        med.thumbnail_url ||
        med.url ||
        med.preview_url ||
        med.tracks?.[0]?.url ||
        med.tracks?.[0]?.file?.url ||
        med.file?.url ||
        null
    );
};
</script>

<template>
    <Dialog :open="open" @update:open="emit('update:open', $event)">
        <DialogContent class="sm:max-w-[800px] max-h-[85vh] overflow-y-auto flex flex-col p-6 bg-white rounded-lg">
            <DialogHeader class="border-b border-zinc-100 pb-3 shrink-0">
                <DialogTitle class="text-lg font-bold text-zinc-900 flex items-center gap-2">
                    <Layers class="w-5 h-5 text-emerald-600" />
                    {{ $t("post_detail.manage.manage_tracks") }}
                </DialogTitle>
                <DialogDescription class="text-xs text-zinc-500 mt-1">
                    {{ $t("post_detail.manage.manage_tracks_desc") }}
                </DialogDescription>
            </DialogHeader>

            <!-- Media Switcher (only shown if post has multiple media items) -->
            <div v-if="mediaList && mediaList.length > 1" class="flex flex-col gap-2 border-b border-zinc-100 pb-4 mt-3 shrink-0">
                <div class="flex items-center justify-between text-xs text-zinc-500 font-medium">
                    <span>{{ $t("post_detail.manage.select_media_asset") }}</span>
                    <span class="font-mono text-[10px] bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full">
                        {{ mediaList.findIndex((m) => m.id === trackEditMediaId) + 1 }} / {{ mediaList.length }}
                    </span>
                </div>
                <div class="flex items-center gap-2 overflow-x-auto py-1 scrollbar-thin">
                    <button
                        v-for="(med, idx) in mediaList"
                        :key="med.id"
                        type="button"
                        @click="trackEditMediaId = med.id"
                        class="group relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 bg-zinc-50 transition-all duration-300 ease-out hover:scale-105 active:scale-95 cursor-pointer shadow-xs"
                        :class="
                            trackEditMediaId === med.id
                                ? 'border-emerald-600 ring-4 ring-emerald-50/80 shadow-xs'
                                : 'border-zinc-200 hover:border-zinc-300'
                        "
                    >
                        <img
                            v-if="getMediaThumb(med)"
                            :src="getMediaThumb(med)"
                            class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                        />
                        <div
                            v-else
                            class="w-full h-full flex items-center justify-center bg-zinc-100 text-[10px] text-zinc-400 font-semibold font-mono"
                        >
                            #{{ idx + 1 }}
                        </div>
                        <div class="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <div
                            class="absolute bottom-1 right-1 bg-black/60 backdrop-blur-xs text-[8px] font-bold text-white px-1 py-0.2 rounded-md font-mono scale-90 origin-bottom-right"
                        >
                            {{ formatMediaType(med.type) }}
                        </div>
                        <div
                            v-if="trackEditMediaId === med.id"
                            class="absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-600 ring-2 ring-white"
                        ></div>
                    </button>
                </div>
            </div>

            <div class="flex-1 overflow-y-auto min-h-0 pt-4">
                <MediaVariantsManager v-if="trackEditMediaId" :media-id="trackEditMediaId" />
            </div>
        </DialogContent>
    </Dialog>
</template>
