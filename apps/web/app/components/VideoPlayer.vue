<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import 'plyr/dist/plyr.css';

interface Props {
    src: string;
    poster?: string;
}


const videoRef = ref<HTMLElement | null>(null);
const player = ref<Plyr | null>(null);


const props = withDefaults(defineProps<Props>(), {
    src: '',
    poster: ''
});

// Watch src changes
watch(() => props.src, (newSrc) => {
    if (player.value && newSrc) {
        // Use Plyr official API to update resources
        player.value.source = {
            type: 'video',
            title: 'Video',
            sources: [
                {
                    src: newSrc,
                    type: 'video/mp4', // Or dynamically determine based on suffix
                },
            ],
            poster: props.poster,
        };
    }
});

onMounted(async () => {
    try {
        const Plyr = (await import('plyr')).default;
        if (videoRef.value) {
            player.value = new Plyr(videoRef.value);
        }
    } catch (error) {
        console.error('Failed to load Plyr:', error);
    }
});

onBeforeUnmount(() => {
    if (player.value) {
        player.value.destroy();
    }
});
</script>

<template>
    <div class="video-player-container relative w-full h-full overflow-hidden flex items-center justify-center">
        <ClientOnly>
            <!-- Do not use native 'controls' when using Plyr to avoid layering issues -->
            <video ref="videoRef" playsinline :data-poster="poster" class="plyr-video w-full h-auto max-h-full">
                <source :src="src" type="video/mp4" />
            </video>
        </ClientOnly>
    </div>
</template>

<style scoped>
/* Ensure Plyr container fills the space provided by swiper */
:deep(.plyr) {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    background: transparent !important;
}

:deep(.plyr__video-wrapper) {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
}

/* Force Plyr controls to be on top within its container */
:deep(.plyr__controls) {
    z-index: 10;
}

/* Ensure the video itself doesn't have an weird stacking context */
:deep(.plyr video) {
    position: relative;
    z-index: 1;
}
</style>