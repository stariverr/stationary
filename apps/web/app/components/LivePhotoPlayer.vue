<script setup lang="ts">
import { ref, useAttrs, computed } from "vue";
import { CircleDotDashed } from "@lucide/vue";

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

// Aspect ratio style to shrink-wrap inner container without overflowing
const aspectRatioStyle = computed(() => {
    if (isCover.value) return {};
    const w = Number(props.width);
    const h = Number(props.height);
    if (w && h) {
        return {
            aspectRatio: `${w} / ${h}`,
        };
    }
    return {};
});

const innerContainerClass = computed(() => {
    if (isCover.value) return "w-full h-full";
    const w = Number(props.width);
    const h = Number(props.height);
    if (w && h) {
        return "max-h-full max-w-full";
    }
    return "w-full h-full";
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
        <div class="relative flex items-center justify-center" :class="innerContainerClass" :style="aspectRatioStyle">
            <!-- iOS style Live badge in the top-left corner of the actual image -->
            <div
                class="absolute top-3 left-3 flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full bg-black/30 text-white select-none backdrop-blur-xl z-20 cursor-pointer transition-all duration-300 ease-out active:scale-95 group/live-photo-badge live-badge"
                :class="
                    videoPlaying
                        ? 'opacity-95 scale-105 bg-black/40 live-badge-playing'
                        : 'opacity-80 hover:opacity-100 hover:scale-105 hover:bg-black/40'
                "
                @click.stop="togglePlay"
            >
                <CircleDotDashed class="w-3.5 h-3.5 text-white select-none live-photo-icon" :class="{ 'is-playing': videoPlaying }" />
                <span class="text-[9px] font-bold uppercase tracking-[0.18em] select-none text-white/95 leading-none">{{
                    $t("media.live")
                }}</span>
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

/* Premium Live Photo Badge styles */
.live-badge {
    box-shadow:
        0 4px 12px rgba(0, 0, 0, 0.25),
        0 0 0 1px rgba(255, 255, 255, 0.1);
}

.live-badge-playing {
    box-shadow:
        0 6px 16px rgba(0, 0, 0, 0.35),
        0 0 0 1px rgba(255, 255, 255, 0.2),
        0 0 8px rgba(255, 255, 255, 0.1);
}

.live-photo-icon {
    transform-origin: center;
}
.live-photo-icon.is-playing {
    animation: live-spin 10s linear infinite;
}

@keyframes live-spin {
    from {
        transform: rotate(0deg);
    }
    to {
        transform: rotate(360deg);
    }
}
</style>
