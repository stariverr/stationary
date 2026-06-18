<script setup lang="ts">
import { Info, Tag, Calendar, User, FileImage, Globe, Link as LinkIcon } from "@lucide/vue";
import { type Post } from "@/types/post";

const props = withDefaults(
    defineProps<{
        post: Post;
        showMedia?: boolean;
    }>(),
    {
        showMedia: false,
    },
);

const currentIndex = defineModel<number>("currentIndex", { default: 0 });
const emit = defineEmits<{
    (e: "click-media"): void;
}>();
</script>

<template>
    <div class="bg-white flex flex-col shrink-0 relative z-110 flex-1 min-h-0 pointer-events-auto">
        <div class="flex-1 overflow-y-auto p-6 space-y-6">
            <div class="space-y-4">
                <h1 class="text-xl font-bold text-gray-900 leading-tight">
                    {{ post.title }}
                </h1>

                <!-- Media Carousel (Embedded in Content for Standard View) -->
                <PostMediaCarousel
                    v-if="showMedia && post.type !== 'TEXT'"
                    :post="post"
                    layout="embedded"
                    v-model:currentIndex="currentIndex"
                    @click-media="emit('click-media')"
                />

                <p class="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                    {{ post.description || $t("common.no_description") }}
                </p>
            </div>

            <hr class="border-gray-200" />

            <!-- Metadata Grid -->
            <div class="grid grid-cols-2 gap-4">
                <div class="space-y-1">
                    <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">
                        {{ $t("common.author") }}
                    </div>
                    <div class="flex items-center gap-2">
                        <img
                            v-if="post.author_avatar_url"
                            :src="post.author_avatar_url"
                            alt="avatar"
                            class="w-6 h-6 rounded-full object-cover shrink-0"
                            loading="lazy"
                        />
                        <div
                            v-else
                            class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500 shrink-0"
                        >
                            <User class="w-3 h-3" />
                        </div>
                        <span class="text-sm font-medium text-gray-900 truncate">{{ post.author }}</span>
                    </div>
                </div>

                <div class="space-y-1">
                    <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">
                        {{ $t("common.platform") }}
                    </div>
                    <div class="flex items-center gap-2">
                        <Globe class="w-3 h-3 text-gray-400" />
                        <span class="text-sm text-gray-900">{{ $t("platforms." + post.platform) }}</span>
                    </div>
                </div>

                <div class="space-y-1">
                    <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">
                        {{ $t("common.created") }}
                    </div>
                    <div class="flex items-center gap-2">
                        <Calendar class="w-3 h-3 text-gray-400" />
                        <span class="text-sm text-gray-900">{{ post.date }}</span>
                    </div>
                </div>

                <div v-if="post.type !== 'TEXT'" class="space-y-1">
                    <div class="text-[10px] uppercase text-gray-400 font-semibold tracking-wider">
                        {{ $t("common.dimensions") }}
                    </div>
                    <div class="flex items-center gap-2">
                        <FileImage class="w-3 h-3 text-gray-400" />
                        <span class="text-sm text-gray-900">
                            {{ post.media?.[0]?.width || post.width }} x
                            {{ post.media?.[0]?.height || post.height }}
                        </span>
                    </div>
                </div>
            </div>

            <div v-if="post.eid || post.originalUrl" class="space-y-3 pt-2">
                <div v-if="post.eid" class="flex items-center justify-between text-sm py-2 px-3 bg-white border border-gray-200 rounded-lg">
                    <span class="text-gray-500">EID</span>
                    <span class="font-mono text-gray-900">{{ post.eid }}</span>
                </div>
                <div
                    v-if="post.originalUrl"
                    class="flex items-center justify-between text-sm py-2 px-3 bg-white border border-gray-200 rounded-lg"
                >
                    <span class="text-gray-500">Source</span>
                    <a
                        :href="post.originalUrl"
                        target="_blank"
                        class="text-blue-600 hover:underline truncate max-w-[200px] flex items-center gap-1"
                    >
                        Link
                        <LinkIcon class="w-3 h-3" />
                    </a>
                </div>
            </div>

            <hr class="border-gray-200" />

            <!-- Tags -->
            <div class="space-y-3">
                <label class="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1">
                    <Tag class="w-3 h-3" /> {{ $t("common.tags") }}
                </label>
                <div class="flex flex-wrap gap-2">
                    <span
                        v-for="tag in post.tags"
                        :key="tag"
                        class="px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-md text-xs text-gray-700 font-medium hover:bg-gray-100 transition-colors cursor-pointer"
                    >
                        #{{ tag }}
                    </span>
                    <button
                        class="px-3 py-1.5 border border-dashed border-gray-300 rounded-md text-xs text-gray-400 hover:text-gray-600 hover:border-gray-400 transition-colors"
                    >
                        + {{ $t("common.add_tag") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
