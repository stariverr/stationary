<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { X, Link as LinkIcon, ChevronLeft, Maximize2, Minimize2 } from "@lucide/vue";
import { useUserStore } from "@/stores/user";
import { storeToRefs } from "pinia";

const { selectedPost, selectedPostId } = usePosts();
const userStore = useUserStore();
const { expandDetailByDefault } = storeToRefs(userStore);
const route = useRoute();

const isImmersiveView = ref(false);
const isMediaOnly = ref(false);
const currentIndex = ref(0);

const closeImmersiveView = () => {
    if (isMediaOnly.value) {
        isMediaOnly.value = false;
    } else {
        closeDetail();
    }
};

// Reset expansion state when opening a new post, honoring preference
watch(selectedPostId, (newId) => {
    if (newId) {
        isImmersiveView.value = isMobile.value ? false : expandDetailByDefault.value;
        isMediaOnly.value = false;
        currentIndex.value = 0;
    }
});

watch(expandDetailByDefault, (newVal) => {
    if (!isMobile.value) {
        isImmersiveView.value = newVal;
    }
});

// Reset index when post changes
watch(selectedPostId, () => {
    currentIndex.value = 0;
});

const closeDetail = () => {
    selectedPostId.value = null;

    // Only navigate to home if we are actually on a post detail page
    if (route.params.id) {
        navigateTo("/");
    }
};

const isMobile = ref(false);

const handleResize = () => {
    isMobile.value = window.innerWidth < 768;
};

const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
        if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
            return;
        }
        if (isMediaOnly.value) {
            isMediaOnly.value = false;
        } else if (isImmersiveView.value) {
            closeImmersiveView();
        } else {
            closeDetail();
        }
    }
};

onMounted(() => {
    isMobile.value = window.innerWidth < 768;
    if (isMobile.value) {
        isImmersiveView.value = false;
    } else {
        isImmersiveView.value = expandDetailByDefault.value;
    }
    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("keydown", handleKeydown);
});

const copyLink = () => {
    if (!selectedPost.value) return;
    const url = window.location.origin + "/posts/" + selectedPost.value.id;
    navigator.clipboard.writeText(url);
};
</script>

<template>
    <div
        v-if="selectedPost"
        :class="[
            isImmersiveView || isMediaOnly
                ? 'fixed inset-0 z-[150] flex bg-black/95 pointer-events-auto'
                : 'fixed inset-y-0 right-0 z-60 md:relative md:z-auto h-full bg-[#f8f8f8] border-l border-[#e5e5e5] w-full md:w-[480px] shrink-0 flex flex-col shadow-2xl overflow-hidden lg:overflow-visible',
        ]"
    >
        <!-- IMMERSIVE / MEDIA-ONLY LAYOUT -->
        <template v-if="isImmersiveView || isMediaOnly">
            <!-- Left Side: Large Media Player -->
            <div class="flex-1 h-full relative flex items-center justify-center min-w-0">
                <!-- Close Button Overlay (Top-Left) -->
                <button
                    @click="closeImmersiveView"
                    class="absolute top-4 left-4 p-2 rounded-full bg-black/50 text-white hover:bg-white/20 transition-colors z-[210]"
                >
                    <X class="w-6 h-6" />
                </button>

                <PostMediaCarousel
                    :post="selectedPost"
                    layout="immersive"
                    v-model:currentIndex="currentIndex"
                    @click-media="isMediaOnly = true"
                />
            </div>

            <!-- Right Side: Details Column -->
            <div
                v-if="!isMediaOnly"
                class="w-full md:w-[480px] h-full bg-white border-l border-gray-200 shrink-0 flex flex-col overflow-hidden shadow-2xl pointer-events-auto"
            >
                <!-- Details Header in Immersive Mode -->
                <div class="h-14 border-b border-[#e5e5e5] px-4 flex items-center justify-between bg-white shrink-0 z-10">
                    <div class="flex items-center gap-2 overflow-hidden">
                        <h2 class="font-semibold text-sm text-gray-700">
                            {{ $t("common.post_info") }}
                        </h2>
                    </div>
                    <div class="flex items-center gap-2">
                        <button
                            @click="copyLink"
                            class="p-1 hover:bg-gray-200 rounded-md text-gray-500 transition-colors"
                            :title="$t('common.copy_link')"
                        >
                            <LinkIcon class="w-4 h-4" />
                        </button>
                        <button @click.stop="closeDetail" class="p-1 hover:bg-gray-200 rounded-md text-gray-500 transition-colors">
                            <X class="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <!-- Details Content -->
                <PostDetailInfo :post="selectedPost" :show-media="false" v-model:currentIndex="currentIndex" />
            </div>
        </template>

        <!-- STANDARD LAYOUT -->
        <template v-else>
            <!-- Standard Header -->
            <div class="h-14 border-b border-[#e5e5e5] px-4 flex items-center justify-between bg-white shrink-0 z-10 pointer-events-auto">
                <div class="flex items-center gap-2 overflow-hidden">
                    <!-- Mobile Back Button -->
                    <button
                        v-if="isMobile"
                        @click="closeDetail"
                        class="p-1 -ml-1 hover:bg-gray-100 rounded-md text-gray-700 transition-colors"
                    >
                        <ChevronLeft class="w-6 h-6" />
                    </button>
                    <h2 class="font-semibold text-sm text-gray-700">
                        {{ $t("common.post_info") }}
                    </h2>
                </div>
                <div class="flex items-center gap-2">
                    <button
                        @click="copyLink"
                        class="p-1 hover:bg-gray-200 rounded-md text-gray-500 transition-colors"
                        :title="$t('common.copy_link')"
                    >
                        <LinkIcon class="w-4 h-4" />
                    </button>
                    <button
                        @click.stop="closeDetail"
                        v-if="!isMobile"
                        class="p-1 hover:bg-gray-200 rounded-md text-gray-500 transition-colors"
                    >
                        <X class="w-4 h-4" />
                    </button>
                </div>
            </div>

            <!-- Standard Details Content (with embedded media) -->
            <PostDetailInfo :post="selectedPost" :show-media="true" v-model:currentIndex="currentIndex" @click-media="isMediaOnly = true" />
        </template>
    </div>
</template>
