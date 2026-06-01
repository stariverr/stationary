<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MediaListItem } from '@/stores/media';
import { Play, Layers, Loader2, FileImage, Trash } from '@lucide/vue';
import { Checkbox } from '@/components/ui/checkbox';
import { getOptimizedImageUrl, getOptimizedSrcset } from '@/utils/image';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from '@/components/ui/sonner';
import { useApi } from '@/composables/useApi';
import { useMediaStore } from '@/stores/media';

const { media, isSelected, isChecked, canMove, showCheckbox } = defineProps<{
    media: any; // Using any for now to handle both UI mapped and raw, ideally MediaListItem mapped
    isSelected?: boolean;
    isChecked?: boolean;
    canMove?: boolean;
    showCheckbox?: boolean;
}>();

const emit = defineEmits<{
    toggleChecked: [checked: boolean];
    click: [event: MouseEvent];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const isHovered = ref(false);

watch(isHovered, (hovering) => {
    if (media.type?.toLowerCase() === 'video' && videoRef.value) {
        if (hovering) {
            videoRef.value.play().catch(() => { });
        } else {
            videoRef.value.pause();
            videoRef.value.currentTime = 0;
        }
    }
});

const mediaStore = useMediaStore();
const isRegenerating = ref(false);

const handleRegenerateCover = async () => {
    if (!media.id) return;
    
    isRegenerating.value = true;
    try {
        const response = await useApi<any>(`/media/${media.id}/regenerate-cover`, {
            method: "POST",
        });
        if (response && response.success) {
            toast.success("Cover regeneration queued.");
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to queue cover regeneration.");
    } finally {
        isRegenerating.value = false;
    }
};

const handleDelete = async () => {
    try {
        const response = await useApi<any>(`/media/trash/${media.id}`, { method: 'POST' });
        if (response && response.success) {
            toast.success("Media moved to trash.");
            mediaStore.refetchMedia();
        } else {
            throw new Error();
        }
    } catch {
        toast.error("Failed to move media to trash.");
    }
};
</script>

<template>
    <ContextMenu>
        <ContextMenuTrigger as-child>
            <div class="group relative flex flex-col gap-2 p-2 rounded-xl transition-all duration-200 cursor-pointer"
                :class="isSelected ? 'bg-blue-50 ring-2 ring-blue-500' : 'hover:bg-gray-100'" @mouseenter="isHovered = true"
                @mouseleave="isHovered = false" @click="emit('click', $event)">
                <div v-if="canMove !== false && (showCheckbox || isHovered)" class="absolute top-4 left-4 z-20" @click.stop>
                    <Checkbox
                        :model-value="isChecked"
                        class="size-5 border-white/80 bg-white/90 shadow-sm data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                        :aria-label="`Select ${media.title || 'media'}`"
                        @update:model-value="emit('toggleChecked', $event === true)"
                    />
                </div>

                <div class="relative aspect-4/3 rounded-lg overflow-hidden border border-gray-100 bg-gray-50">
                    <!-- Stack Indicator (1/N) -->
                    <div v-if="media.media_count > 1" class="absolute top-2 right-2 z-10 bg-black/60 text-white text-[10px] font-medium px-1.5 py-0.5 rounded flex items-center gap-1 backdrop-blur-sm">
                        <Layers class="w-3 h-3" />
                        {{ media.media_count }}
                    </div>

                    <!-- Image Card -->
                    <img v-if="media.type?.toLowerCase() === 'image' || !media.type" 
                        :src="getOptimizedImageUrl(media.url, { width: 480, height: 360, fit: 'cover', gravity: 'auto' })" 
                        :srcset="getOptimizedSrcset(media.url, 'list')"
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                        :alt="media.title || 'Image'"
                        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                        loading="lazy" />

                    <!-- Video Card -->
                    <div v-else-if="media.type?.toLowerCase() === 'video'" class="w-full h-full">
                        <video ref="videoRef" :src="`${media.url}#t=0.01`"
                            class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" muted
                            playsinline loop preload="metadata"></video>

                        <div
                            class="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-transparent transition-colors pointer-events-none">
                            <div v-if="!isHovered" class="bg-white/90 p-2 rounded-full shadow-sm backdrop-blur-sm">
                                <Play class="w-4 h-4 text-black fill-black ml-0.5" />
                            </div>
                        </div>
                    </div>
                </div>

                <div class="flex flex-col px-1">
                    <h3 class="text-sm font-medium text-gray-900 line-clamp-1 group-hover:text-blue-600 transition-colors">{{
                        media.title || 'Untitled' }}</h3>
                    <div class="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                        <span>{{ media.date }}</span>
                    </div>
                </div>
            </div>
        </ContextMenuTrigger>
        <ContextMenuContent class="w-52">
            <ContextMenuItem 
                v-if="media.type?.toLowerCase() === 'video'" 
                :disabled="isRegenerating"
                class="flex items-center gap-2"
                @click.stop="handleRegenerateCover"
            >
                <Loader2 v-if="isRegenerating" class="w-4 h-4 animate-spin" />
                <FileImage v-else class="w-4 h-4" />
                <span>{{ $t('media.actions.regenerate_cover', 'Regenerate Cover') }}</span>
            </ContextMenuItem>
            <ContextMenuItem class="flex items-center gap-2 text-red-600 focus:text-red-600 focus:bg-red-50" @click.stop="handleDelete">
                <Trash class="w-4 h-4" />
                <span>{{ $t('common.delete', 'Delete') }}</span>
            </ContextMenuItem>
        </ContextMenuContent>
    </ContextMenu>
</template>
