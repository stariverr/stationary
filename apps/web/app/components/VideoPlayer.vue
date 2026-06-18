<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from "vue";
import "plyr/dist/plyr.css";
import type Plyr from "plyr";
import type { MediaPlayerClass } from "dashjs";

interface Subtitle {
    url: string;
    language: string;
    label: string;
    format: string;
}

interface Props {
    src: string;
    poster?: string;
    subtitles?: Subtitle[];
    width?: number | string;
    height?: number | string;
}

const videoRef = ref<HTMLVideoElement | null>(null);
const player = ref<Plyr | null>(null);
let dashPlayer: MediaPlayerClass | null = null;

const props = withDefaults(defineProps<Props>(), {
    src: "",
    poster: "",
    subtitles: () => [],
    width: undefined,
    height: undefined,
});

const isDash = computed(() => {
    return props.src.endsWith(".mpd") || props.src.includes("manifest.mpd") || props.src.includes("application/dash+xml");
});

const absoluteSrc = computed(() => {
    if (!props.src) return "";
    if (props.src.startsWith("http://") || props.src.startsWith("https://") || props.src.startsWith("blob:")) {
        return props.src;
    }
    if (typeof window !== "undefined") {
        return window.location.origin + props.src;
    }
    return props.src;
});

const aspectStyle = computed(() => {
    if (props.width && props.height) {
        const w = Number(props.width);
        const h = Number(props.height);
        if (!isNaN(w) && !isNaN(h) && h > 0) {
            return {
                aspectRatio: `${w} / ${h}`,
            };
        }
    }
    return {};
});

const processedSubtitles = ref<{ url: string; language: string; label: string; default: boolean }[]>([]);

const loadSubtitles = async () => {
    // Revoke previous blob URLs to prevent memory leaks
    processedSubtitles.value.forEach((sub) => {
        if (sub.url.startsWith("blob:")) {
            URL.revokeObjectURL(sub.url);
        }
    });

    if (!props.subtitles || props.subtitles.length === 0) {
        processedSubtitles.value = [];
        return;
    }

    const list = await Promise.all(
        props.subtitles.map(async (sub) => {
            try {
                const res = await fetch(sub.url);
                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                let text = await res.text();

                // Convert SRT format to WebVTT if it's SRT
                if (sub.format === "srt" || sub.url.endsWith(".srt")) {
                    text = "WEBVTT\n\n" + text.replace(/(\d+:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
                }

                const blob = new Blob([text], { type: "text/vtt" });
                return {
                    url: URL.createObjectURL(blob),
                    language: sub.language,
                    label: sub.label,
                    default: sub.language === "zh-CN" || sub.language === "zh",
                };
            } catch (err) {
                console.error("Failed to load/convert subtitle:", err);
                return {
                    url: sub.url,
                    language: sub.language,
                    label: sub.label,
                    default: sub.language === "zh-CN" || sub.language === "zh",
                };
            }
        }),
    );
    processedSubtitles.value = list;
};

const destroyPlayer = () => {
    if (player.value) {
        player.value.destroy();
        player.value = null;
    }
    if (dashPlayer) {
        dashPlayer.destroy();
        dashPlayer = null;
    }
};

let plyrInitializingPromise: Promise<void> | null = null;

const initPlyr = async () => {
    if (player.value) return;
    if (plyrInitializingPromise) return plyrInitializingPromise;

    plyrInitializingPromise = (async () => {
        try {
            const Plyr = (await import("plyr")).default;
            if (videoRef.value && !player.value) {
                player.value = new Plyr(videoRef.value, {
                    captions: { update: true },
                });
            }
        } catch (error) {
            console.error("Failed to load Plyr:", error);
        } finally {
            plyrInitializingPromise = null;
        }
    })();

    return plyrInitializingPromise;
};

const updateSource = async () => {
    if (!videoRef.value) return;

    // 1. Load subtitles first
    await loadSubtitles();

    // 2. Ensure Plyr is initialized
    await initPlyr();

    if (!player.value) return;

    const plyrTracks: Plyr.Track[] = processedSubtitles.value.map((sub) => ({
        kind: "captions" as const,
        label: sub.label,
        srcLang: sub.language,
        src: sub.url,
        default: sub.default,
    }));

    if (isDash.value) {
        if (dashPlayer) {
            dashPlayer.destroy();
            dashPlayer = null;
        }

        try {
            console.log("[VideoPlayer] Initializing dash.js for src:", absoluteSrc.value);
            const { MediaPlayer } = await import("dashjs");
            dashPlayer = MediaPlayer().create();
            dashPlayer.updateSettings({
                debug: {
                    logLevel: 2,
                },
                streaming: {
                    cmcd: {
                        enabled: false,
                    },
                },
            });
            dashPlayer.on("error", (e: unknown) => {
                console.error("[VideoPlayer] dash.js error event:", e);
            });

            // Set poster directly on video element
            videoRef.value.poster = props.poster || "";

            // Bind dashjs to native video element
            dashPlayer.initialize(videoRef.value, absoluteSrc.value, false);
        } catch (error) {
            console.error("Failed to load or initialize dash.js:", error);
        }
    } else {
        if (dashPlayer) {
            dashPlayer.destroy();
            dashPlayer = null;
        }

        // Update Plyr source directly
        player.value.source = {
            type: "video",
            sources: [
                {
                    src: absoluteSrc.value,
                    type: "video/mp4",
                },
            ],
            poster: props.poster,
            tracks: plyrTracks,
        };
    }
};

// Watch element and properties to update source reactively
watch(
    [videoRef, () => props.src, () => props.poster, () => props.subtitles],
    async ([el]) => {
        if (el) {
            await updateSource();
        }
    },
    { deep: true, immediate: true },
);

onBeforeUnmount(() => {
    destroyPlayer();
    processedSubtitles.value.forEach((sub) => {
        if (sub.url.startsWith("blob:")) {
            URL.revokeObjectURL(sub.url);
        }
    });
});
</script>

<template>
    <div
        class="video-player-container relative w-full h-full overflow-hidden flex items-center justify-center bg-black"
        :style="aspectStyle"
    >
        <ClientOnly>
            <!-- Do not use native 'controls' when using Plyr to avoid layering issues -->
            <video ref="videoRef" playsinline class="plyr-video w-full h-auto max-h-full" :poster="props.poster">
                <track
                    v-for="track in processedSubtitles"
                    :key="track.url"
                    kind="captions"
                    :label="track.label"
                    :srclang="track.language"
                    :src="track.url"
                    :default="track.default"
                />
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
