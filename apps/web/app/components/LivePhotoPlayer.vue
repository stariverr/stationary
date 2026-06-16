<script setup lang="ts">
import { ref, useAttrs, computed } from "vue";

defineOptions({
    inheritAttrs: false,
});

const props = defineProps<{
    src: string;
    liveSrc: string;
    mimeType?: string;
    width?: number | string;
    height?: number | string;
    alt?: string;
}>();

const attrs = useAttrs();

const videoRef = ref<HTMLVideoElement | null>(null);
const videoPlaying = ref(false);
const isInteracting = ref(false);
const isVideoVisible = ref(false);
let stopTimeout: ReturnType<typeof setTimeout> | null = null;
let playPromise: Promise<void> | null = null;

const startPlayback = () => {
    isInteracting.value = true;
    isVideoVisible.value = true; // Show video element immediately for transition
    if (stopTimeout) {
        clearTimeout(stopTimeout);
        stopTimeout = null;
    }
    if (videoRef.value) {
        // Handle race conditions and prevent AbortError by tracking the play Promise
        playPromise = videoRef.value.play();
        playPromise.catch((err) => {
            if (err.name !== "AbortError") {
                console.warn("Failed to play Live Photo video:", err);
            }
        });
    }
};

const stopPlayback = () => {
    isInteracting.value = false;
    videoPlaying.value = false;

    if (stopTimeout) {
        clearTimeout(stopTimeout);
    }

    // Wait for the video to fade out completely (300ms) before pausing, resetting, and hiding.
    // This avoids seeking back to 0 while the video is still semi-transparent/visible.
    stopTimeout = setTimeout(() => {
        if (videoRef.value && !isInteracting.value) {
            const pauseAndReset = () => {
                if (videoRef.value && !isInteracting.value) {
                    videoRef.value.pause();
                    videoRef.value.currentTime = 0;
                    isVideoVisible.value = false; // Hide video element completely (display: none)
                }
            };
            if (playPromise) {
                playPromise.then(pauseAndReset).catch(pauseAndReset);
            } else {
                pauseAndReset();
            }
        }
    }, 350);
};

const togglePlay = (e: Event) => {
    e.stopPropagation();
    if (videoPlaying.value) {
        stopPlayback();
    } else {
        startPlayback();
    }
};

const onVideoPlaying = () => {
    // Only transition opacity when we have active playback frames rendered and the user is still interacting
    if (videoRef.value && videoRef.value.currentTime > 0 && isInteracting.value) {
        videoPlaying.value = true;
    }
};

const onVideoTimeUpdate = () => {
    // Only transition opacity when we have active playback frames rendered and the user is still interacting
    if (videoRef.value && videoRef.value.currentTime > 0 && !videoPlaying.value && isInteracting.value) {
        videoPlaying.value = true;
    }
};

const onVideoPause = () => {
    if (!isInteracting.value) {
        videoPlaying.value = false;
    }
};

const onVideoEnded = () => {
    videoPlaying.value = false;
    // Let the video fade out completely (300ms) before pausing and resetting it to 0
    setTimeout(() => {
        if (videoRef.value) {
            videoRef.value.pause();
            videoRef.value.currentTime = 0;
            if (!isInteracting.value) {
                isVideoVisible.value = false;
            }
        }
    }, 350);
};

const hasClass = (classVal: any, target: string): boolean => {
    if (!classVal) return false;
    if (typeof classVal === "string") {
        return classVal.split(/\s+/).includes(target);
    }
    if (Array.isArray(classVal)) {
        return classVal.some((c) => hasClass(c, target));
    }
    if (typeof classVal === "object") {
        return !!classVal[target];
    }
    return false;
};

// Check if the component is being rendered in cover/fill layout mode to prevent circular sizing dependencies
const isCover = computed(() => {
    const className = attrs.class;
    return hasClass(className, "object-cover") || hasClass(className, "w-full");
});
</script>

<template>
    <div
        class="relative flex items-center justify-center select-none w-full h-full"
        :style="attrs.style"
        @mouseenter="startPlayback"
        @mouseleave="stopPlayback"
        @touchstart="startPlayback"
        @touchend="stopPlayback"
    >
        <!-- Inner container that matches the image size exactly to align video, image, and badge -->
        <div class="relative flex items-center justify-center" :class="isCover ? 'w-full h-full' : 'max-h-full max-w-full'">
            <!-- iOS style Live badge in the bottom-left corner of the actual image -->
            <div
                class="absolute bottom-3 left-3 px-2 py-1 rounded-md bg-black/60 text-white font-medium text-[10px] flex items-center gap-1.5 backdrop-blur-md z-20 border border-white/10 select-none shadow-sm uppercase tracking-wider transition-opacity duration-200 cursor-pointer"
                :class="videoPlaying ? 'opacity-95' : 'opacity-70 group-hover/live-photo:opacity-100'"
                @click.stop="togglePlay"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-3.5 h-3.5 text-white fill-white/10">
                    <circle cx="12" cy="12" r="3" fill="currentColor" />
                    <circle cx="12" cy="12" r="6" stroke-dasharray="2 2" />
                    <circle cx="12" cy="12" r="9" />
                </svg>
                <span>Live</span>
            </div>

            <!-- Static Cover Image (Supports HEIC via HeicImage wrapper, inherits dimensions/fit from parent) -->
            <!-- We keep the static image at opacity-100 always to prevent transparency gaps/flashes during cross-fades -->
            <HeicImage
                v-bind="attrs"
                :src="props.src"
                :mime-type="props.mimeType"
                :alt="props.alt"
                class="select-none opacity-100 block live-photo-image"
            />

            <!-- Live Video Element overlaid (pixel-perfectly covers the static image) -->
            <video
                v-show="isVideoVisible"
                ref="videoRef"
                :src="props.liveSrc"
                muted
                playsinline
                preload="auto"
                class="absolute inset-0 w-full h-full pointer-events-none live-video-player bg-transparent"
                :class="[videoPlaying ? 'opacity-100 visible' : 'opacity-0 invisible', attrs.class]"
                @playing="onVideoPlaying"
                @timeupdate="onVideoTimeUpdate"
                @pause="onVideoPause"
                @ended="onVideoEnded"
            />
        </div>
    </div>
</template>

<style scoped>
.live-video-player {
    /* Transitions for fading in and out smoothly */
    transition:
        opacity 300ms cubic-bezier(0.4, 0, 0.2, 1),
        visibility 300ms cubic-bezier(0.4, 0, 0.2, 1);

    /* Hardware acceleration to prevent flickering and black flashes */
    -webkit-transform: translateZ(0);
    transform: translateZ(0);
    will-change: opacity;
    backface-visibility: hidden;

    /* Ensure the browser does not draw a default black background behind the video source */
    background-color: transparent !important;

    /* Disable shadows, borders, filters and outlines to prevent subpixel rendering artifacts */
    filter: none !important;
    box-shadow: none !important;
    border: none !important;
    outline: none !important;
}

:deep(.live-photo-image) {
    /* Apply identical hardware acceleration to the image to align subpixel rendering */
    -webkit-transform: translateZ(0) !important;
    transform: translateZ(0) !important;
    backface-visibility: hidden !important;
}
</style>
