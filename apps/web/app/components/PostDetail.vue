<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, type Ref } from 'vue';
import {
    X, Info, Tag, Calendar, User, FileImage, Globe, Hash,
    Link as LinkIcon, ChevronLeft, ChevronRight, Maximize2, Minimize2, Sidebar
} from '@lucide/vue';
import { Swiper, SwiperSlide } from 'swiper/vue';
import 'swiper/css';

const { selectedPost, selectedPostId, selectedPostDetail } = usePosts();
const { expandDetailByDefault } = useUserSettings();
const route = useRoute();

const showLightbox = ref(false);

const closeLightbox = () => {
    if (expandDetailByDefault.value) {
        closeDetail();
    } else {
        showLightbox.value = false;
    }
}

const currentIndex = ref(0);

// Reset expansion state when opening a new post, honoring preference
watch(selectedPostId, (newId) => {
    if (newId) {
        showLightbox.value = expandDetailByDefault.value;
        currentIndex.value = 0;
    }
});

const swiperInstance = ref<any>(null);

const onSwiper = (swiper: any) => {
    swiperInstance.value = swiper;
    currentIndex.value = swiper.activeIndex;
};

const onSlideChange = (swiper: any) => {
    currentIndex.value = swiper.activeIndex;
};

// Reset index when post changes
watch(selectedPostId, () => {
    currentIndex.value = 0;
});

const scrollPrev = () => swiperInstance.value?.slidePrev();
const scrollNext = () => swiperInstance.value?.slideNext();

const closeDetail = () => {
    selectedPostId.value = null;

    // Only navigate to home if we are actually on a post detail page
    if (route.params.id) {
        navigateTo('/');
    }
}

const isMobile = ref(false);

onMounted(() => {
    isMobile.value = window.innerWidth < 768;
    // Mobile defaults to Standard view.
    if (isMobile.value) {
        showLightbox.value = false;
    }
    window.addEventListener('resize', () => {
        isMobile.value = window.innerWidth < 768;
    });
});

const copyLink = () => {
    if (!selectedPost.value) return;
    const url = window.location.origin + '/posts/' + selectedPost.value.id;
    navigator.clipboard.writeText(url);
}
</script>

<template>
    <div v-if="selectedPost" :class="[
        showLightbox ? 'fixed inset-0 z-[200] pointer-events-none' : 'fixed inset-y-0 right-0 z-60 md:relative md:z-auto h-full bg-[#f8f8f8] border-l border-[#e5e5e5] w-full md:w-[480px] shrink-0 flex flex-col shadow-2xl overflow-hidden lg:overflow-visible'
    ]">

        <!-- Standard Header (Desktop Sidebar or Mobile Detail View) -->
        <div v-if="!showLightbox"
            class="h-14 border-b border-[#e5e5e5] px-4 flex items-center justify-between bg-white shrink-0 z-10 pointer-events-auto">
            <div class="flex items-center gap-2 overflow-hidden">
                <!-- Mobile Back Button -->
                <button v-if="isMobile" @click="closeDetail"
                    class="p-1 -ml-1 hover:bg-gray-100 rounded-md text-gray-700 transition-colors">
                    <ChevronLeft class="w-6 h-6" />
                </button>
                <h2 class="font-semibold text-sm truncate max-w-[200px]">{{ selectedPost.title }}</h2>
            </div>
            <div class="flex items-center gap-2">
                <button @click="copyLink" class="p-1 hover:bg-gray-200 rounded-md text-gray-500 transition-colors"
                    :title="$t('common.copy_link')">
                    <LinkIcon class="w-4 h-4" />
                </button>
                <button @click.stop="closeDetail" v-if="!isMobile"
                    class="p-1 hover:bg-gray-200 rounded-md text-gray-500 transition-colors">
                    <X class="w-4 h-4" />
                </button>
            </div>
        </div>

        <!-- Media Section (Immersive Lightbox) -->
        <div v-if="showLightbox" class="fixed inset-0 z-[200] bg-black flex items-center justify-center group/carousel pointer-events-auto">

            <!-- Close Button Overlay (Top-Left) -->
            <button @click="closeLightbox"
                class="absolute top-4 left-4 p-2 rounded-full bg-black/50 text-white hover:bg-white/20 transition-colors z-[210]">
                <X class="w-6 h-6" />
            </button>

            <!-- Media Counter -->
            <div v-if="(selectedPost.media?.length || 0) > 1"
                class="absolute top-4 right-4 px-3 py-1 rounded-full bg-black/50 text-white text-sm font-medium z-100 font-mono">
                {{ currentIndex + 1 }} / {{ selectedPost.media?.length }}
            </div>

            <!-- Carousel -->
            <!-- Carousel -->
            <div class="w-full h-full overflow-hidden">
                <swiper :slides-per-view="1" :loop="(selectedPost.media?.length || 0) > 1" @swiper="onSwiper"
                    @slideChange="onSlideChange" class="w-full h-full">
                    <swiper-slide v-for="(media, index) in selectedPost.media" :key="index"
                        class="flex items-center justify-center bg-transparent">
                        <div class="w-full h-full flex items-center justify-center relative">
                            <VideoPlayer v-if="media.type === 'VIDEO'" :src="media.url"
                                :poster="media.thumbnail || media.poster" class="max-h-full max-w-full h-full w-auto" />
                            <img v-else :src="media.url" class="max-h-full max-w-full object-contain" />
                        </div>
                    </swiper-slide>
                </swiper>
            </div>

            <!-- Nav Buttons -->
            <button v-if="(selectedPost.media?.length || 0) > 1"
                class="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/carousel:opacity-100 transition-opacity hover:bg-black/60 z-100 pointer-events-auto"
                @click.stop="scrollPrev">
                <ChevronLeft class="w-6 h-6" />
            </button>
            <button v-if="(selectedPost.media?.length || 0) > 1"
                class="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/carousel:opacity-100 transition-opacity hover:bg-black/60 z-100 pointer-events-auto"
                @click.stop="scrollNext">
                <ChevronRight class="w-6 h-6" />
            </button>
        </div>

        <!-- Info Section -->
        <div v-if="!showLightbox" class="bg-white flex flex-col shrink-0 relative z-110 flex-1 min-h-0 pointer-events-auto">

            <div class="flex-1 overflow-y-auto p-6 space-y-6">
                <!-- Content -->
                <div class="space-y-4">
                    <div class="flex items-start justify-between">
                        <h1 class="text-xl font-bold text-gray-900 leading-tight">{{ selectedPost.title }}</h1>
                        <span class="px-2 py-1 bg-gray-100 rounded text-xs font-medium text-gray-500 uppercase">{{
                            selectedPost.type }}</span>
                    </div>

                    <!-- Media Carousel (Embedded in Content for Standard/Mobile View) -->
                    <div v-if="selectedPost.type !== 'text'" class="w-[calc(100%+3rem)] -mx-6 md:w-full md:mx-0 md:rounded-lg aspect-square md:aspect-4/3 bg-black overflow-hidden my-4 cursor-pointer relative group/carousel"
                        @click="showLightbox = true">

                        <!-- Media Counter (Embedded) -->
                        <div v-if="(selectedPost.media?.length || 0) > 1"
                            class="absolute top-4 right-4 px-2 py-0.5 rounded-full bg-black/50 text-white text-[10px] font-medium z-100 font-mono">
                            {{ currentIndex + 1 }} / {{ selectedPost.media?.length }}
                        </div>

                        <swiper :slides-per-view="1" :loop="(selectedPost.media?.length || 0) > 1" @swiper="onSwiper"
                            @slideChange="onSlideChange" class="h-full">
                            <swiper-slide v-for="(media, index) in selectedPost.media" :key="index"
                                class="bg-transparent flex items-center justify-center">
                                <div class="w-full h-full flex items-center justify-center relative">
                                    <VideoPlayer v-if="media.type === 'VIDEO'" :src="media.url"
                                        :poster="media.thumbnail || media.poster" class="w-full h-full" />
                                    <img v-else :src="media.url" class="w-full h-full object-cover" />
                                </div>
                            </swiper-slide>
                        </swiper>

                        <!-- Nav Buttons for Embedded -->
                        <button v-if="(selectedPost.media?.length || 0) > 1"
                            class="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/carousel:opacity-100 transition-opacity hover:bg-black/60 z-100 pointer-events-auto"
                            @click.stop="scrollPrev">
                            <ChevronLeft class="w-5 h-5" />
                        </button>
                        <button v-if="(selectedPost.media?.length || 0) > 1"
                            class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/40 text-white backdrop-blur-sm md:opacity-0 md:group-hover/carousel:opacity-100 transition-opacity hover:bg-black/60 z-100 pointer-events-auto"
                            @click.stop="scrollNext">
                            <ChevronRight class="w-5 h-5" />
                        </button>
                    </div>

                    <p class="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{{ selectedPost.description ||
                        $t('common.no_description') }}
                    </p>
                </div>

                <hr class="border-gray-200" />

                <!-- Metadata Grid -->
                <div class="grid grid-cols-2 gap-4">
                    <div class="space-y-1">
                        <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">{{
                            $t('common.author') }}</div>
                        <div class="flex items-center gap-2">
                            <div
                                class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500">
                                <User class="w-3 h-3" />
                            </div>
                            <span class="text-sm font-medium text-gray-900">{{ selectedPost.author }}</span>
                        </div>
                    </div>

                    <div class="space-y-1">
                        <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">{{
                            $t('common.platform') }}</div>
                        <div class="flex items-center gap-2">
                            <Globe class="w-3 h-3 text-gray-400" />
                            <span class="text-sm text-gray-900">{{ $t('platforms.' + selectedPost.platform) }}</span>
                        </div>
                    </div>

                    <div class="space-y-1">
                        <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">{{
                            $t('common.created') }}</div>
                        <div class="flex items-center gap-2">
                            <Calendar class="w-3 h-3 text-gray-400" />
                            <span class="text-sm text-gray-900">{{ selectedPost.date }}</span>
                        </div>
                    </div>

                    <div v-if="selectedPost.type !== 'text'" class="space-y-1">
                        <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">{{
                            $t('common.dimensions') }}</div>
                        <div class="flex items-center gap-2">
                            <FileImage class="w-3 h-3 text-gray-400" />
                            <span class="text-sm text-gray-900">{{ selectedPost.width }} x {{ selectedPost.height
                            }}</span>
                        </div>
                    </div>
                </div>

                <div v-if="selectedPost.eid || selectedPost.originalUrl" class="space-y-3 pt-2">
                    <div v-if="selectedPost.eid"
                        class="flex items-center justify-between text-sm py-2 px-3 bg-white border border-gray-200 rounded-lg">
                        <span class="text-gray-500">EID</span>
                        <span class="font-mono text-gray-900">{{ selectedPost.eid }}</span>
                    </div>
                    <div v-if="selectedPost.originalUrl"
                        class="flex items-center justify-between text-sm py-2 px-3 bg-white border border-gray-200 rounded-lg">
                        <span class="text-gray-500">Source</span>
                        <a :href="selectedPost.originalUrl" target="_blank"
                            class="text-blue-600 hover:underline truncate max-w-[200px] flex items-center gap-1">
                            Link
                            <LinkIcon class="w-3 h-3" />
                        </a>
                    </div>
                </div>

                <hr class="border-gray-200" />

                <!-- Tags -->
                <div class="space-y-3">
                    <label class="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                        <Tag class="w-3 h-3" /> {{ $t('common.tags') }}
                    </label>
                    <div class="flex flex-wrap gap-2">
                        <span v-for="tag in selectedPost.tags" :key="tag"
                            class="px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-md text-xs text-gray-700 font-medium hover:bg-gray-100 transition-colors cursor-pointer">
                            #{{ tag }}
                        </span>
                        <button
                            class="px-3 py-1.5 border border-dashed border-gray-300 rounded-md text-xs text-gray-400 hover:text-gray-600 hover:border-gray-400 transition-colors">
                            + {{ $t('common.add_tag') }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
