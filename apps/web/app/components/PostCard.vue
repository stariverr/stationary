<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Post } from '@/types/post';
import { Play } from '@lucide/vue';
import { Checkbox } from '@/components/ui/checkbox';
import { getOptimizedImageUrl, getOptimizedSrcset } from '@/utils/image';

const { post, isSelected, isChecked, showCheckbox } = defineProps<{
    post: Post;
    isSelected?: boolean;
    isChecked?: boolean;
    showCheckbox?: boolean;
}>();

const emit = defineEmits<{
    toggleChecked: [checked: boolean];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const isHovered = ref(false);

watch(isHovered, (hovering) => {
    if (post.type === 'video' && videoRef.value) {
        if (hovering) {
            videoRef.value.play().catch(() => { });
        } else {
            videoRef.value.pause();
            // Reset to first frame or keep where it is? Usually reset feels cleaner for previews.
            videoRef.value.currentTime = 0;
        }
    }
});
</script>

<template>
    <div class="group relative flex flex-col gap-2 p-2 rounded-xl transition-all duration-200 cursor-pointer"
        :class="isSelected ? 'bg-blue-50 ring-2 ring-blue-500' : 'hover:bg-gray-100'" @mouseenter="isHovered = true"
        @mouseleave="isHovered = false">
        <div v-if="showCheckbox || isHovered" class="absolute top-4 left-4 z-20" @click.stop>
            <Checkbox :model-value="isChecked"
                class="size-5 border-white/80 bg-white/90 shadow-sm data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                :aria-label="`Select ${post.title || 'post'}`"
                @update:model-value="emit('toggleChecked', $event === true)" />
        </div>

        <div class="relative aspect-4/3 rounded-lg overflow-hidden border border-gray-100 bg-gray-50">
            <!-- Text Card -->
            <div v-if="post.type === 'text'"
                class="w-full h-full p-4 flex flex-col justify-center items-center bg-gray-50 text-gray-400">
                <span class="text-xs text-center line-clamp-4">{{ post.description || post.title || 'Pure Text'
                    }}</span>
            </div>

            <!-- Image Card -->
            <img v-else-if="post.type === 'image'"
                :src="getOptimizedImageUrl(post.url, { width: 480, height: 360, fit: 'cover', gravity: 'auto' })"
                :srcset="getOptimizedSrcset(post.url, 'list')"
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw" :alt="post.title"
                class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy" />

            <!-- Video Card -->
            <div v-else-if="post.type === 'video'" class="w-full h-full">
                <video ref="videoRef" :src="`${post.url}#t=0.01`"
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
                post.title }}</h3>
            <div class="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                <span v-if="post.type !== 'text'">{{ post.width }}x{{ post.height }}</span>
                <span v-if="post.type !== 'text'">{{ post.size }}</span>
            </div>
            <div class="flex flex-wrap gap-1 mt-2">
                <span v-for="tag in post.tags" :key="tag"
                    class="px-1.5 py-0.5 bg-gray-100 text-xs text-gray-600 rounded-md">
                    #{{ tag }}
                </span>
            </div>
        </div>
    </div>
</template>
