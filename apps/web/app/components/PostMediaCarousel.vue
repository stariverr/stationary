<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { Swiper, SwiperSlide } from "swiper/vue";
import type { Swiper as SwiperClass } from "swiper";
import "swiper/css";
import { getOptimizedImageUrl, getOptimizedSrcset } from "@/utils/image";
import { type Post, type Track } from "@/types/post";

const props = defineProps<{
    post: Post;
    layout: "embedded" | "immersive";
}>();

const currentIndex = defineModel<number>("currentIndex", { default: 0 });
const mappedMedia = ref<any[]>([]);

watch(
    () => props.post?.media,
    (newMedia) => {
        if (!newMedia) {
            mappedMedia.value = [];
            return;
        }
        mappedMedia.value = newMedia.map((m) => {
            const subtitleTracks = (m.tracks || []).filter((t: Track) => t.type === "SUBTITLE");
            return {
                ...m,
                subtitles: subtitleTracks.map((sub: Track) => ({
                    url: sub.url,
                    language: (sub.metadata?.language as string) || "unknown",
                    label: (sub.metadata?.label as string) || (sub.metadata?.language as string) || "unknown",
                    format: sub.metadata?.format === "json" ? "vtt" : (sub.metadata?.format as string) || "vtt",
                })),
            };
        });
    },
    { immediate: true },
);

const swiperInstance = ref<SwiperClass | null>(null);

const onSwiper = (swiper: SwiperClass) => {
    swiperInstance.value = swiper;
    if (swiper.realIndex !== currentIndex.value) {
        swiper.slideTo(currentIndex.value, 0);
    }
};

const onSlideChange = (swiper: SwiperClass) => {
    currentIndex.value = swiper.realIndex;
};

// Sync external slide index updates to Swiper
watch(currentIndex, (newVal) => {
    if (swiperInstance.value && swiperInstance.value.realIndex !== newVal) {
        swiperInstance.value.slideTo(newVal, 300);
    }
});

const emit = defineEmits<{
    (e: "click-media"): void;
}>();

const handleMediaClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest(".plyr__controls") || target.closest("button") || target.closest("a")) {
        return;
    }
    emit("click-media");
};

const scrollPrev = () => swiperInstance.value?.slidePrev();
const scrollNext = () => swiperInstance.value?.slideNext();
</script>

<template>
    <!-- Immersive Layout -->
    <div
        v-if="layout === 'immersive'"
        class="w-full h-full relative flex items-center justify-center group/carousel bg-black select-none pointer-events-auto"
    >
        <!-- Media Counter -->
        <div
            v-if="mappedMedia.length > 1"
            class="absolute top-4 right-4 px-3 py-1 rounded-full bg-black/50 text-white text-sm font-medium z-[100] font-mono"
        >
            {{ currentIndex + 1 }} / {{ mappedMedia.length }}
        </div>

        <!-- Carousel -->
        <div class="w-full h-full overflow-hidden">
            <swiper
                :slides-per-view="1"
                :loop="mappedMedia.length > 1"
                :initial-slide="currentIndex"
                @swiper="onSwiper"
                @slideChange="onSlideChange"
                class="w-full h-full"
            >
                <swiper-slide
                    v-for="(media, index) in mappedMedia"
                    :key="media.id || index"
                    class="flex items-center justify-center bg-transparent"
                >
                    <div class="w-full h-full flex items-center justify-center relative cursor-pointer" @click="handleMediaClick">
                        <VideoPlayer
                            v-if="media.type === 'VIDEO'"
                            :src="media.url || ''"
                            :poster="media.thumbnail || media.poster || ''"
                            :subtitles="media.subtitles"
                            :width="media.width"
                            :height="media.height"
                            class="max-h-full max-w-full h-full w-auto"
                        />
                        <LivePhotoPlayer
                            v-else-if="media.type === 'LIVE_PHOTO'"
                            :src="media.url || ''"
                            :live-src="media.live_url || ''"
                            :mime-type="media.mime_type || undefined"
                            :width="media.width"
                            :height="media.height"
                            class="max-h-full max-w-full object-contain"
                        />
                        <HeicImage
                            v-else
                            :src="media.url || ''"
                            :mime-type="media.mime_type || undefined"
                            class="max-h-full max-w-full object-contain"
                        />
                    </div>
                </swiper-slide>
            </swiper>
        </div>

        <!-- Nav Buttons -->
        <button
            v-if="mappedMedia.length > 1"
            class="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/carousel:opacity-100 transition-opacity hover:bg-black/60 z-[100] pointer-events-auto cursor-pointer"
            @click.stop="scrollPrev"
        >
            <ChevronLeft class="w-6 h-6" />
        </button>
        <button
            v-if="mappedMedia.length > 1"
            class="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/carousel:opacity-100 transition-opacity hover:bg-black/60 z-[100] pointer-events-auto cursor-pointer"
            @click.stop="scrollNext"
        >
            <ChevronRight class="w-6 h-6" />
        </button>
    </div>

    <!-- Embedded Layout -->
    <div
        v-else-if="layout === 'embedded'"
        class="w-[calc(100%+3rem)] -mx-6 md:w-full md:mx-0 md:rounded-lg aspect-square md:aspect-4/3 bg-transparent overflow-hidden my-4 relative group/carousel select-none pointer-events-auto"
    >
        <!-- Media Counter (Embedded) -->
        <div
            v-if="mappedMedia.length > 1"
            class="absolute top-4 right-4 px-2 py-0.5 rounded-full bg-black/50 text-white text-[10px] font-medium z-[100] font-mono"
        >
            {{ currentIndex + 1 }} / {{ mappedMedia.length }}
        </div>

        <swiper
            :slides-per-view="1"
            :loop="mappedMedia.length > 1"
            :initial-slide="currentIndex"
            @swiper="onSwiper"
            @slideChange="onSlideChange"
            class="h-full"
        >
            <swiper-slide
                v-for="(media, index) in mappedMedia"
                :key="media.id || index"
                class="bg-transparent flex items-center justify-center"
            >
                <div class="w-full h-full flex items-center justify-center relative cursor-pointer" @click="handleMediaClick">
                    <VideoPlayer
                        v-if="media.type === 'VIDEO'"
                        :src="media.url || ''"
                        :poster="media.thumbnail || media.poster || ''"
                        :subtitles="media.subtitles"
                        :width="media.width"
                        :height="media.height"
                        class="w-full h-full"
                    />
                    <LivePhotoPlayer
                        v-else-if="media.type === 'LIVE_PHOTO'"
                        :src="
                            getOptimizedImageUrl(media.url || '', {
                                width: 960,
                                fit: 'scale-down',
                            })
                        "
                        :live-src="media.live_url || ''"
                        :mime-type="media.mime_type || undefined"
                        :width="media.width"
                        :height="media.height"
                        class="w-full h-full object-cover"
                    />
                    <HeicImage
                        v-else
                        :src="
                            getOptimizedImageUrl(media.url || '', {
                                width: 960,
                                fit: 'scale-down',
                            })
                        "
                        :srcset="getOptimizedSrcset(media.url || '', 'detail')"
                        sizes="(max-width: 768px) 100vw, 480px"
                        :mime-type="media.mime_type || undefined"
                        class="w-full h-full object-cover"
                    />
                </div>
            </swiper-slide>
        </swiper>

        <!-- Nav Buttons for Embedded -->
        <button
            v-if="mappedMedia.length > 1"
            class="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/carousel:opacity-100 transition-opacity hover:bg-black/60 z-[100] pointer-events-auto cursor-pointer"
            @click.stop="scrollPrev"
        >
            <ChevronLeft class="w-5 h-5" />
        </button>
        <button
            v-if="mappedMedia.length > 1"
            class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/carousel:opacity-100 transition-opacity hover:bg-black/60 z-[100] pointer-events-auto cursor-pointer"
            @click.stop="scrollNext"
        >
            <ChevronRight class="w-5 h-5" />
        </button>
    </div>
</template>
