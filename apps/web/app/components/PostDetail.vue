<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { X, Link as LinkIcon, ChevronLeft, Maximize2, Minimize2, Layers } from "@lucide/vue";
import { useUserStore } from "@/stores/user";
import { storeToRefs } from "pinia";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/vue-query";
import MediaVariantsManager from "@/components/MediaVariantsManager.vue";

const { selectedPost, selectedPostId } = usePosts();
const userStore = useUserStore();
const { expandDetailByDefault } = storeToRefs(userStore);
const route = useRoute();
const queryClient = useQueryClient();

const isEditingTracks = ref(false);
const trackEditMediaId = ref<string | undefined>(undefined);

const openTrackEditor = (mediaId: string) => {
    trackEditMediaId.value = mediaId;
    isEditingTracks.value = true;
};

const handleDialogClose = (open: boolean) => {
    isEditingTracks.value = open;
    if (!open) {
        if (selectedPost.value?.id) {
            queryClient.invalidateQueries({ queryKey: ["post", selectedPost.value.id] });
        }
        queryClient.invalidateQueries({ queryKey: ["posts"] });
    }
};

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
                <PostDetailInfo
                    :post="selectedPost"
                    :show-media="false"
                    v-model:currentIndex="currentIndex"
                    @manage-tracks="openTrackEditor"
                />
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
            <PostDetailInfo
                :post="selectedPost"
                :show-media="true"
                v-model:currentIndex="currentIndex"
                @click-media="isMediaOnly = true"
                @manage-tracks="openTrackEditor"
            />
        </template>

        <!-- Media Tracks Edit Dialog with Switcher -->
        <Dialog :open="isEditingTracks" @update:open="handleDialogClose">
            <DialogContent class="sm:max-w-[800px] max-h-[85vh] overflow-y-auto flex flex-col p-6 bg-white rounded-lg">
                <DialogHeader class="border-b border-zinc-100 pb-3 shrink-0">
                    <DialogTitle class="text-lg font-bold text-zinc-900 flex items-center gap-2">
                        <Layers class="w-5 h-5 text-indigo-600" />
                        {{ $t("media.manage_tracks") }}
                    </DialogTitle>
                    <DialogDescription class="text-xs text-zinc-500 mt-1">
                        Manage files, subtitles, covers, and resolution variants for this media.
                    </DialogDescription>
                </DialogHeader>

                <!-- Media Switcher (only shown if post has multiple media items) -->
                <div
                    v-if="selectedPost.media && selectedPost.media.length > 1"
                    class="flex flex-col gap-2 border-b border-zinc-100 pb-4 mt-3 shrink-0"
                >
                    <div class="flex items-center justify-between text-xs text-zinc-500 font-medium">
                        <span>Select Media Asset</span>
                        <span class="font-mono text-[10px] bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full">
                            {{ selectedPost.media.findIndex((m) => m.id === trackEditMediaId) + 1 }} / {{ selectedPost.media.length }}
                        </span>
                    </div>
                    <div class="flex items-center gap-2 overflow-x-auto py-1 scrollbar-thin">
                        <button
                            v-for="(med, idx) in selectedPost.media"
                            :key="med.id"
                            type="button"
                            @click="trackEditMediaId = med.id"
                            class="group relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 bg-zinc-50 transition-all duration-300 ease-out hover:scale-105 active:scale-95 cursor-pointer shadow-xs"
                            :class="
                                trackEditMediaId === med.id
                                    ? 'border-indigo-600 ring-4 ring-indigo-50/80 shadow-xs'
                                    : 'border-zinc-200 hover:border-zinc-300'
                            "
                        >
                            <img
                                v-if="med.cover_url || med.url"
                                :src="(med.cover_url || med.url) ?? undefined"
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
                                {{ med.type }}
                            </div>
                            <div
                                v-if="trackEditMediaId === med.id"
                                class="absolute top-1 right-1 w-2 h-2 rounded-full bg-indigo-600 ring-2 ring-white"
                            ></div>
                        </button>
                    </div>
                </div>

                <div class="flex-1 overflow-y-auto min-h-0 pt-4">
                    <MediaVariantsManager v-if="trackEditMediaId" :media-id="trackEditMediaId" />
                </div>
            </DialogContent>
        </Dialog>
    </div>
</template>
