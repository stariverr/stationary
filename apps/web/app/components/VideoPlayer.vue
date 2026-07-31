<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
    Play,
    Pause,
    Volume2,
    VolumeX,
    Maximize,
    Minimize,
    RotateCcw,
    RotateCw,
    Subtitles,
    Check,
    Loader2,
    Settings,
    PictureInPicture2,
} from "@lucide/vue";

import "vidstack/player";
import "vidstack/player/ui";
import "vidstack/player/styles/default/theme.css";

interface Subtitle {
    url: string;
    language: string;
    label: string;
    format: string;
}

interface VideoTrackItem {
    id?: string;
    url: string;
    type: string;
    purpose?: string;
    quality?: string;
    priority?: number;
    codec?: string | null;
    display_name?: string;
    mime_type?: string | null;
}

interface Props {
    src: string;
    poster?: string;
    tracks?: VideoTrackItem[];
    subtitles?: Subtitle[];
    width?: number | string;
    height?: number | string;
}

interface PlayerProvider {
    library?: unknown;
    config?: unknown;
}

interface PlayerElement extends HTMLElement {
    poster: string;
    provider: PlayerProvider | null;
    src: unknown;
    currentTime: number;
    duration: number;
    volume: number;
    muted: boolean;
    playbackRate: number;
    play: () => Promise<void>;
    pause: () => Promise<void>;
}

interface VideoSource {
    src: string;
    type: string;
    size?: number;
}

const props = withDefaults(defineProps<Props>(), {
    src: "",
    poster: "",
    tracks: () => [],
    subtitles: () => [],
    width: undefined,
    height: undefined,
});

const { t } = useI18n();

const playerContainerRef = ref<HTMLDivElement | null>(null);
const playerRef = ref<PlayerElement | null>(null);
const processedSubtitles = ref<{ url: string; language: string; label: string; default: boolean }[]>([]);

// Player Core State
const isPlaying = ref(false);
const hasStartedPlaying = ref(false);
const isBuffering = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const bufferedEnd = ref(0);
const volume = ref(1);
const isMuted = ref(false);
const isFullscreen = ref(false);
const isPip = ref(false);
const playbackSpeed = ref(1);
const selectedQualityId = ref<string | null>(null);
const activeSubtitleIndex = ref<number>(-1);
const isSeeking = ref(false);

// UI State
const showControls = ref(true);
const showSettingsMenu = ref(false);
const activeMenuTab = ref<"speed" | "quality">("speed");
const gestureRipple = ref<{ text: string; icon: string; key: number } | null>(null);
const seekSliderRef = ref<HTMLDivElement | null>(null);
const seekPreviewRef = ref<HTMLDivElement | null>(null);
const settingsMenuRef = ref<HTMLDivElement | null>(null);

let controlsTimer: ReturnType<typeof setTimeout> | null = null;
let gestureCounter = 0;
let activeSeekPointerId: number | null = null;

const speedOptions = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

const qualityToSizeMap: Record<string, number> = {
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360,
    HIGH: 1080,
    MEDIUM: 720,
    LOW: 480,
};

const resolveUrl = (url: string) => {
    if (!url || url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:")) {
        return url;
    }
    if (typeof window !== "undefined") {
        return new URL(url, window.location.origin).toString();
    }
    return url;
};

const isDash = computed(() => {
    return /\.mpd($|\?)/i.test(props.src) || props.src.includes("manifest.mpd") || props.src.includes("application/dash+xml");
});

const absoluteSrc = computed(() => resolveUrl(props.src));

const aspectStyle = computed(() => {
    if (props.width && props.height) {
        const width = Number(props.width);
        const height = Number(props.height);
        if (!Number.isNaN(width) && !Number.isNaN(height) && height > 0) {
            return {
                aspectRatio: `${width} / ${height}`,
            };
        }
    }
    return {};
});

// Quality Label Formatting & Deduplication
interface QualityOption {
    id: string;
    label: string;
    track: VideoTrackItem;
}

const formatQualityLabel = (quality?: string, displayName?: string) => {
    if (displayName && !["HIGH", "MEDIUM", "LOW"].includes(displayName.toUpperCase())) {
        return displayName;
    }
    const qUpper = (quality || displayName || "").toUpperCase();
    if (qUpper === "HIGH") return t("post_detail.viewer.player.quality_high");
    if (qUpper === "MEDIUM") return t("post_detail.viewer.player.quality_medium");
    if (qUpper === "LOW") return t("post_detail.viewer.player.quality_low");
    if (qUpper.endsWith("P")) return qUpper;
    return quality || displayName || t("post_detail.viewer.player.quality_high");
};

const uniqueQualityTracks = computed<QualityOption[]>(() => {
    const videoTracks = props.tracks.filter((track) => track.type.toUpperCase() === "VIDEO" && track.purpose?.toUpperCase() !== "COVER");

    if (videoTracks.length === 0) return [];

    const map = new Map<string, QualityOption>();
    videoTracks.forEach((track, idx) => {
        const label = formatQualityLabel(track.quality, track.display_name);
        if (!map.has(label)) {
            map.set(label, {
                id: track.id || `quality-${idx}`,
                label,
                track,
            });
        }
    });

    return Array.from(map.values());
});

const selectedQualityObj = computed(() => {
    if (!selectedQualityId.value) return null;
    return uniqueQualityTracks.value.find((q) => q.id === selectedQualityId.value) || null;
});

const videoSources = computed<VideoSource[]>(() => {
    const videoTracks = props.tracks.filter((track) => track.type.toUpperCase() === "VIDEO" && track.purpose?.toUpperCase() !== "COVER");

    if (videoTracks.length === 0) {
        return [{ src: absoluteSrc.value, type: "video/mp4" }];
    }

    if (selectedQualityObj.value) {
        const track = selectedQualityObj.value.track;
        return [
            {
                src: resolveUrl(track.url),
                type: track.mime_type || "video/mp4",
                size: qualityToSizeMap[track.quality || ""],
            },
        ];
    }

    return videoTracks.map((track) => ({
        src: resolveUrl(track.url),
        type: track.mime_type || "video/mp4",
        size: qualityToSizeMap[track.quality || ""] || undefined,
    }));
});

const mediaSource = computed<VideoSource | VideoSource[]>(() => {
    if (isDash.value) {
        return {
            src: absoluteSrc.value,
            type: "application/dash+xml",
        };
    }
    return videoSources.value;
});

const tracksSignature = computed(() =>
    props.tracks
        .map((track) => [track.id, track.url, track.type, track.purpose, track.quality, track.codec, track.mime_type].join(":"))
        .join("|"),
);

const areSubtitlesEqual = (first: Subtitle[], second: Subtitle[]) => {
    if (first.length !== second.length) return false;
    return first.every((item, index) => {
        const other = second[index];
        return (
            item?.url === other?.url && item?.language === other?.language && item?.label === other?.label && item?.format === other?.format
        );
    });
};

const loadSubtitles = async () => {
    processedSubtitles.value.forEach((subtitle) => {
        if (subtitle.url.startsWith("blob:")) {
            URL.revokeObjectURL(subtitle.url);
        }
    });

    if (props.subtitles.length === 0) {
        processedSubtitles.value = [];
        return;
    }

    processedSubtitles.value = await Promise.all(
        props.subtitles.map(async (subtitle) => {
            try {
                const response = await fetch(resolveUrl(subtitle.url));
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                let text = await response.text();
                if (subtitle.format === "srt" || subtitle.url.endsWith(".srt")) {
                    text = `WEBVTT\n\n${text.replace(/(\d+:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
                }

                return {
                    url: URL.createObjectURL(new Blob([text], { type: "text/vtt" })),
                    language: subtitle.language,
                    label: subtitle.label,
                    default: subtitle.language === "zh-CN" || subtitle.language === "zh",
                };
            } catch (error) {
                console.error("Failed to load/convert subtitle:", error);
                return {
                    url: resolveUrl(subtitle.url),
                    language: subtitle.language,
                    label: subtitle.label,
                    default: subtitle.language === "zh-CN" || subtitle.language === "zh",
                };
            }
        }),
    );

    const defaultIdx = processedSubtitles.value.findIndex((s) => s.default);
    if (defaultIdx !== -1) {
        activeSubtitleIndex.value = defaultIdx;
    }
};

const loadDashLibrary = async () => {
    const { MediaPlayer } = await import("dashjs");
    return { default: MediaPlayer };
};

const configureProvider = (provider: PlayerProvider | null) => {
    if (!provider || !isDash.value) return;

    provider.library = loadDashLibrary;
    provider.config = {
        debug: { logLevel: 2 },
        streaming: {
            cmcd: { enabled: false },
        },
    };
};

// Robust HTML5 Video Event Binding for 60fps Smooth Progress Tracking
let unbindVideoListeners: (() => void) | null = null;

const bindVideoEvents = () => {
    if (unbindVideoListeners) {
        unbindVideoListeners();
        unbindVideoListeners = null;
    }

    if (!playerRef.value) return;
    const video = playerRef.value.querySelector("video");
    if (!video) return;

    const syncTime = () => {
        if (isSeeking.value) return;
        currentTime.value = video.currentTime || 0;
        if (video.duration && !Number.isNaN(video.duration) && video.duration > 0) {
            duration.value = video.duration;
        }
    };

    const handlePlay = () => {
        isPlaying.value = true;
        hasStartedPlaying.value = true;
        isBuffering.value = false;
        startControlsTimer();
    };

    const handlePause = () => {
        isPlaying.value = false;
        showControls.value = true;
    };

    const handleProgress = () => {
        if (video.buffered.length > 0) {
            bufferedEnd.value = video.buffered.end(video.buffered.length - 1);
        }
    };

    const handleWaiting = () => {
        isBuffering.value = true;
    };

    const handleCanPlay = () => {
        isBuffering.value = false;
    };

    video.addEventListener("timeupdate", syncTime);
    video.addEventListener("durationchange", syncTime);
    video.addEventListener("loadedmetadata", syncTime);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("progress", handleProgress);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("playing", handleCanPlay);
    video.addEventListener("canplay", handleCanPlay);

    unbindVideoListeners = () => {
        video.removeEventListener("timeupdate", syncTime);
        video.removeEventListener("durationchange", syncTime);
        video.removeEventListener("loadedmetadata", syncTime);
        video.removeEventListener("play", handlePlay);
        video.removeEventListener("pause", handlePause);
        video.removeEventListener("progress", handleProgress);
        video.removeEventListener("waiting", handleWaiting);
        video.removeEventListener("playing", handleCanPlay);
        video.removeEventListener("canplay", handleCanPlay);
    };

    syncTime();
};

const handleProviderChange = (event: Event) => {
    const provider = (event as CustomEvent<PlayerProvider | null>).detail ?? null;
    configureProvider(provider);
    nextTick(() => bindVideoEvents());
};

let activeSrc = "";
let activePoster = "";
let activeSubtitles: Subtitle[] = [];
let activeTracksSignature = "";

const waitForPlayer = async () => {
    await nextTick();
    if (typeof customElements !== "undefined") {
        await customElements.whenDefined("media-player");
    }
    return playerRef.value;
};

const updateSource = async () => {
    const sourceChanged = absoluteSrc.value !== activeSrc;
    const posterChanged = props.poster !== activePoster;
    const subtitlesChanged = !areSubtitlesEqual(props.subtitles, activeSubtitles);
    const tracksChanged = tracksSignature.value !== activeTracksSignature;

    if (!sourceChanged && !posterChanged && !subtitlesChanged && !tracksChanged && playerRef.value) {
        return;
    }

    if (sourceChanged) {
        hasStartedPlaying.value = false;
        isPlaying.value = false;
    }

    activeSrc = absoluteSrc.value;
    activePoster = props.poster;
    activeSubtitles = [...props.subtitles];
    activeTracksSignature = tracksSignature.value;

    await loadSubtitles();

    const player = await waitForPlayer();
    if (!player) return;

    player.poster = props.poster || "";
    player.src = mediaSource.value;
    configureProvider(player.provider);

    await nextTick();
    bindVideoEvents();
};

// --- Controls Actions ---

const startControlsTimer = () => {
    if (controlsTimer) clearTimeout(controlsTimer);
    showControls.value = true;
    if (isPlaying.value && !showSettingsMenu.value) {
        controlsTimer = setTimeout(() => {
            showControls.value = false;
        }, 3000);
    }
};

const cancelControlsTimer = () => {
    if (controlsTimer) {
        clearTimeout(controlsTimer);
        controlsTimer = null;
    }
    showControls.value = true;
};

const handleMouseMove = () => {
    startControlsTimer();
};

const triggerRipple = (text: string, iconName: string) => {
    gestureCounter++;
    gestureRipple.value = { text, icon: iconName, key: gestureCounter };
    setTimeout(() => {
        if (gestureRipple.value?.key === gestureCounter) {
            gestureRipple.value = null;
        }
    }, 600);
};

const togglePlay = () => {
    if (!playerRef.value) return;
    const video = playerRef.value.querySelector("video");
    if (video) {
        if (video.paused) {
            video.play();
        } else {
            video.pause();
        }
    } else {
        if (isPlaying.value) playerRef.value.pause();
        else playerRef.value.play();
    }
    startControlsTimer();
};

const handleVideoOverlayClick = () => {
    if (showSettingsMenu.value) {
        showSettingsMenu.value = false;
        return;
    }
    if (isPlaying.value) {
        showControls.value = !showControls.value;
        if (showControls.value) {
            startControlsTimer();
        } else if (controlsTimer) {
            clearTimeout(controlsTimer);
            controlsTimer = null;
        }
    } else {
        togglePlay();
    }
};

const handleDocumentClick = (e: MouseEvent) => {
    if (showSettingsMenu.value && settingsMenuRef.value) {
        if (!settingsMenuRef.value.contains(e.target as Node)) {
            showSettingsMenu.value = false;
        }
    }

    if (isPlaying.value && playerContainerRef.value) {
        if (!playerContainerRef.value.contains(e.target as Node)) {
            showControls.value = false;
            if (controlsTimer) {
                clearTimeout(controlsTimer);
                controlsTimer = null;
            }
        }
    }
};

const seekTo = (seconds: number) => {
    const maxDur = duration.value > 0 ? duration.value : 99999;
    const target = Math.max(0, Math.min(maxDur, seconds));
    currentTime.value = target;

    if (playerRef.value) {
        const video = playerRef.value.querySelector("video");
        if (video) video.currentTime = target;
        else playerRef.value.currentTime = target;
    }
    startControlsTimer();
};

const seekRelative = (delta: number) => {
    seekTo(currentTime.value + delta);
    triggerRipple(delta > 0 ? `+${delta}s` : `${delta}s`, delta > 0 ? "forward" : "replay");
};

const setPlaybackSpeed = (speed: number) => {
    playbackSpeed.value = speed;
    if (playerRef.value) {
        const video = playerRef.value.querySelector("video");
        if (video) video.playbackRate = speed;
        else playerRef.value.playbackRate = speed;
    }
    showSettingsMenu.value = false;
    triggerRipple(`${speed}×`, "speed");
    startControlsTimer();
};

const selectQualityOption = (id: string | null) => {
    selectedQualityId.value = id;
    showSettingsMenu.value = false;
    if (playerRef.value) {
        playerRef.value.src = mediaSource.value;
    }
    startControlsTimer();
};

const toggleSubtitle = () => {
    if (processedSubtitles.value.length === 0) return;
    if (activeSubtitleIndex.value === -1) {
        activeSubtitleIndex.value = 0;
    } else {
        activeSubtitleIndex.value = -1;
    }
    startControlsTimer();
};

const toggleMute = () => {
    isMuted.value = !isMuted.value;
    if (playerRef.value) {
        const video = playerRef.value.querySelector("video");
        if (video) video.muted = isMuted.value;
        else playerRef.value.muted = isMuted.value;
    }
    startControlsTimer();
};

const handleVolumeInput = (e: Event) => {
    const val = Number((e.target as HTMLInputElement).value);
    volume.value = val;
    isMuted.value = val === 0;
    if (playerRef.value) {
        const video = playerRef.value.querySelector("video");
        if (video) {
            video.volume = val;
            video.muted = val === 0;
        } else {
            playerRef.value.volume = val;
            playerRef.value.muted = val === 0;
        }
    }
};

const toggleFullscreen = async () => {
    if (!playerContainerRef.value) return;
    try {
        if (!document.fullscreenElement) {
            await playerContainerRef.value.requestFullscreen();
            isFullscreen.value = true;
        } else {
            await document.exitFullscreen();
            isFullscreen.value = false;
        }
    } catch (err) {
        console.error("Fullscreen error:", err);
    }
};

const togglePip = async () => {
    if (!playerRef.value) return;
    const video = playerRef.value.querySelector("video");
    if (!video) return;

    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            isPip.value = false;
        } else {
            await video.requestPictureInPicture();
            isPip.value = true;
        }
    } catch (err) {
        console.error("PiP error:", err);
    }
};

// --- Time Slider Pointer Interaction ---
const getSeekPosition = (clientX: number) => {
    const slider = seekSliderRef.value;
    if (!slider || duration.value <= 0) return null;

    const rect = slider.getBoundingClientRect();
    if (rect.width <= 0) return null;

    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return {
        ratio,
        seconds: ratio * duration.value,
    };
};

const updateSeekPreview = (clientX: number) => {
    const preview = seekPreviewRef.value;
    const position = getSeekPosition(clientX);
    if (!preview || !position) {
        preview?.classList.remove("is-visible");
        return;
    }

    preview.style.left = `${position.ratio * 100}%`;
    preview.textContent = formatTime(position.seconds);
    preview.classList.add("is-visible");
};

const updateSeekValue = (clientX: number) => {
    const position = getSeekPosition(clientX);
    if (!position) return null;

    currentTime.value = position.seconds;
    return position.seconds;
};

const handleSeekPointerMove = (event: PointerEvent) => {
    if (isSeeking.value && activeSeekPointerId === event.pointerId) {
        event.preventDefault();
        updateSeekValue(event.clientX);
    }
    updateSeekPreview(event.clientX);
};

const handleSeekPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || duration.value <= 0) return;

    event.preventDefault();
    activeSeekPointerId = event.pointerId;
    const slider = event.currentTarget as HTMLDivElement;
    slider.setPointerCapture(event.pointerId);
    isSeeking.value = true;
    cancelControlsTimer();
    updateSeekValue(event.clientX);
    updateSeekPreview(event.clientX);
};

const finishSeek = (event: PointerEvent) => {
    if (!isSeeking.value || activeSeekPointerId !== event.pointerId) return;

    event.preventDefault();
    const target = updateSeekValue(event.clientX) ?? currentTime.value;
    const slider = event.currentTarget as HTMLDivElement;
    if (slider.hasPointerCapture(event.pointerId)) {
        slider.releasePointerCapture(event.pointerId);
    }
    activeSeekPointerId = null;
    isSeeking.value = false;
    seekTo(target);
};

const handleSeekPointerLeave = () => {
    if (!isSeeking.value) {
        seekPreviewRef.value?.classList.remove("is-visible");
    }
};

const handleSeekKeyDown = (event: KeyboardEvent) => {
    if (duration.value <= 0) return;

    const step = event.shiftKey ? 10 : 5;
    let target: number | null = null;
    if (event.key === "ArrowLeft") target = currentTime.value - step;
    if (event.key === "ArrowRight") target = currentTime.value + step;
    if (event.key === "Home") target = 0;
    if (event.key === "End") target = duration.value;
    if (target === null) return;

    event.preventDefault();
    event.stopPropagation();
    seekTo(target);
};

// Format Time Helper
const formatTime = (secs: number) => {
    if (Number.isNaN(secs) || secs < 0) return "00:00";
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;

    const pad = (n: number) => n.toString().padStart(2, "0");
    if (hours > 0) {
        return `${hours}:${pad(remMin)}:${pad(seconds)}`;
    }
    return `${pad(remMin)}:${pad(seconds)}`;
};

const timeDisplay = computed(() => {
    const currentStr = formatTime(currentTime.value);
    if (duration.value > 0) {
        return `${currentStr} / ${formatTime(duration.value)}`;
    }
    return currentStr;
});

// Keyboard Shortcuts
const handleKeyDown = (e: KeyboardEvent) => {
    if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;

    if (e.code === "Space" || e.code === "KeyK") {
        e.preventDefault();
        togglePlay();
    } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        seekRelative(-5);
    } else if (e.code === "ArrowRight") {
        e.preventDefault();
        seekRelative(5);
    } else if (e.code === "ArrowUp") {
        e.preventDefault();
        const nextVol = Math.min(1, volume.value + 0.1);
        volume.value = nextVol;
        if (playerRef.value) {
            const v = playerRef.value.querySelector("video");
            if (v) v.volume = nextVol;
        }
    } else if (e.code === "ArrowDown") {
        e.preventDefault();
        const nextVol = Math.max(0, volume.value - 0.1);
        volume.value = nextVol;
        if (playerRef.value) {
            const v = playerRef.value.querySelector("video");
            if (v) v.volume = nextVol;
        }
    } else if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
    } else if (e.code === "KeyM") {
        e.preventDefault();
        toggleMute();
    }
};

onMounted(async () => {
    await updateSource();
    if (typeof window !== "undefined") {
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("click", handleDocumentClick);
    }
});

watch(
    [() => props.src, () => props.poster, () => props.subtitles, () => props.tracks],
    async () => {
        await updateSource();
    },
    { deep: true },
);

onBeforeUnmount(() => {
    if (controlsTimer) clearTimeout(controlsTimer);
    if (unbindVideoListeners) unbindVideoListeners();
    if (typeof window !== "undefined") {
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("click", handleDocumentClick);
    }
    processedSubtitles.value.forEach((subtitle) => {
        if (subtitle.url.startsWith("blob:")) {
            URL.revokeObjectURL(subtitle.url);
        }
    });
    playerRef.value = null;
});
</script>

<template>
    <div
        ref="playerContainerRef"
        class="video-player-root relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-black group select-none"
        :style="aspectStyle"
        @mousemove="handleMouseMove"
        @mouseleave="startControlsTimer"
    >
        <ClientOnly>
            <!-- Vidstack Engine -->
            <media-player
                ref="playerRef"
                class="vidstack-player-core relative z-10 w-full h-full"
                :style="aspectStyle"
                :poster="props.poster || undefined"
                playsinline
                aria-label="Video player"
                @provider-change="handleProviderChange"
            >
                <media-poster
                    v-if="props.poster"
                    :src="props.poster"
                    alt="Poster"
                    class="vds-poster absolute inset-0 w-full h-full object-contain pointer-events-none z-0"
                />
                <media-provider>
                    <track
                        v-for="(track, idx) in processedSubtitles"
                        :key="track.url"
                        kind="subtitles"
                        :label="track.label"
                        :srclang="track.language"
                        :src="track.url"
                        :default="idx === activeSubtitleIndex"
                    />
                </media-provider>
            </media-player>

            <!-- Video Poster Cover Layer (Guarantees poster image is visible immediately before play starts, avoiding black screen) -->
            <div
                v-if="props.poster && !hasStartedPlaying"
                class="absolute inset-0 z-15 flex items-center justify-center bg-black overflow-hidden pointer-events-none transition-opacity duration-300"
                :class="{ 'opacity-0': isPlaying }"
            >
                <img :src="props.poster" alt="Cover" class="w-full h-full object-contain" />
            </div>

            <!-- Gesture Ripple Center Overlay -->
            <Transition name="ripple">
                <div
                    v-if="gestureRipple"
                    :key="gestureRipple.key"
                    class="absolute inset-0 z-30 flex items-center justify-center pointer-events-none"
                >
                    <div
                        class="flex items-center gap-2 px-4 py-2 rounded-xl bg-black/75 border border-white/10 backdrop-blur-md shadow-xl text-white text-xs font-semibold"
                    >
                        <RotateCcw v-if="gestureRipple.icon === 'replay'" class="w-4 h-4 text-emerald-400" />
                        <RotateCw v-else-if="gestureRipple.icon === 'forward'" class="w-4 h-4 text-emerald-400" />
                        <span>{{ gestureRipple.text }}</span>
                    </div>
                </div>
            </Transition>

            <!-- Center Buffering Spinner -->
            <div v-if="isBuffering" class="absolute inset-0 z-25 flex items-center justify-center pointer-events-none">
                <div class="p-3 rounded-full bg-black/60 border border-white/10 backdrop-blur-md text-white/90 shadow-lg">
                    <Loader2 class="w-7 h-7 animate-spin" />
                </div>
            </div>

            <!-- Video Canvas Click Overlay (Handles Click to Toggle Play / Toggle Controls) -->
            <div
                class="absolute inset-0 z-20 flex items-center justify-center cursor-pointer transition-opacity duration-300"
                :class="{ 'bg-black/25': !isPlaying && !isBuffering }"
                @click="handleVideoOverlayClick"
            >
                <button
                    v-if="!isPlaying && !isBuffering"
                    class="w-14 h-14 rounded-full bg-black/50 border border-white/20 backdrop-blur-md text-white shadow-xl flex items-center justify-center transition-transform duration-200 hover:scale-105 hover:bg-black/70 pointer-events-none"
                    :aria-label="$t('post_detail.viewer.player.play')"
                >
                    <Play class="w-6 h-6 fill-white translate-x-0.5" />
                </button>
            </div>

            <!-- Full-Bleed Professional Bottom Gradient Controls -->
            <div
                class="absolute bottom-0 left-0 right-0 z-30 flex flex-col justify-end pt-10 pb-3 px-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300"
                :class="{
                    'opacity-100 pointer-events-auto': showControls || !isPlaying || showSettingsMenu,
                    'opacity-0 pointer-events-none': !showControls && isPlaying && !showSettingsMenu,
                }"
                @mouseenter="cancelControlsTimer"
                @mousemove.stop="cancelControlsTimer"
                @mouseleave="startControlsTimer"
            >
                <!-- Sleek Interactive Progress Slider (Fixed 20px Hit Box, 0px Layout Shift) -->
                <div
                    ref="seekSliderRef"
                    class="seek-slider relative w-full h-5 flex items-center mb-1 z-20"
                    role="slider"
                    tabindex="0"
                    :aria-valuemin="0"
                    :aria-valuemax="duration || 0"
                    :aria-valuenow="currentTime"
                    @pointerdown="handleSeekPointerDown"
                    @pointermove="handleSeekPointerMove"
                    @pointerup="finishSeek"
                    @pointercancel="finishSeek"
                    @pointerleave="handleSeekPointerLeave"
                    @keydown="handleSeekKeyDown"
                >
                    <!-- Hover Time Tooltip -->
                    <div
                        ref="seekPreviewRef"
                        class="seek-slider-preview absolute -top-7 -translate-x-1/2 px-2 py-0.5 rounded bg-black/90 border border-white/20 text-[11px] tabular-nums font-medium text-white shadow backdrop-blur-sm pointer-events-none z-40"
                    ></div>

                    <!-- Visual Track Container -->
                    <div class="seek-slider-track relative w-full h-1.5 rounded-full bg-white/25 overflow-hidden">
                        <!-- Buffered Segment -->
                        <div
                            class="absolute top-0 bottom-0 left-0 bg-white/40 rounded-full"
                            :style="{ width: `${duration ? (bufferedEnd / duration) * 100 : 0}%` }"
                        ></div>
                        <!-- Current Playback Position -->
                        <div
                            class="absolute top-0 bottom-0 left-0 bg-white rounded-full transition-all duration-75"
                            :style="{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }"
                        ></div>
                    </div>

                    <!-- Minimal Drag Thumb -->
                    <div
                        class="seek-slider-thumb absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white shadow pointer-events-none z-20"
                        :style="{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }"
                    ></div>
                </div>

                <!-- Bottom Control Buttons Row (Streamlined & Coordinated) -->
                <div class="flex items-center justify-between gap-3 text-white">
                    <!-- Left Control Group: Play/Pause, Volume, Time -->
                    <div class="flex items-center gap-1.5">
                        <!-- Play/Pause Toggle -->
                        <button
                            class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/15 text-white/90 hover:text-white transition-colors"
                            :aria-label="isPlaying ? $t('post_detail.viewer.player.pause') : $t('post_detail.viewer.player.play')"
                            @click="togglePlay"
                        >
                            <Pause v-if="isPlaying" class="w-4.5 h-4.5 fill-current" />
                            <Play v-else class="w-4.5 h-4.5 fill-current translate-x-0.5" />
                        </button>

                        <!-- Volume Controls (Smooth Hover Expand) -->
                        <div class="relative flex items-center group/vol py-0.5 px-0.5 rounded-lg transition-colors hover:bg-white/10">
                            <button
                                class="w-8 h-8 rounded-lg flex items-center justify-center text-white/80 hover:text-white transition-colors"
                                :title="isMuted ? $t('post_detail.viewer.player.unmute') : $t('post_detail.viewer.player.mute')"
                                @click="toggleMute"
                            >
                                <VolumeX v-if="isMuted || volume === 0" class="w-4.5 h-4.5 text-red-400" />
                                <Volume2 v-else class="w-4.5 h-4.5" />
                            </button>

                            <!-- Custom Volume Slider Bar -->
                            <div
                                class="relative flex items-center shrink-0 w-0 opacity-0 pointer-events-none group-hover/vol:w-16 group-hover/vol:opacity-100 group-hover/vol:pointer-events-auto group-hover/vol:ml-1.5 transition-all duration-200 overflow-hidden py-1"
                            >
                                <!-- Visual Track -->
                                <div class="relative w-full h-1 rounded-full bg-white/25 overflow-hidden">
                                    <div
                                        class="absolute top-0 bottom-0 left-0 bg-white rounded-full transition-all duration-75"
                                        :style="{ width: `${(isMuted ? 0 : volume) * 100}%` }"
                                    ></div>
                                </div>

                                <!-- Invisible Mouse/Touch Handler -->
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.05"
                                    :value="isMuted ? 0 : volume"
                                    class="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                    @input="handleVolumeInput"
                                />
                            </div>
                        </div>

                        <!-- Time Counter -->
                        <div class="ml-1 text-xs tabular-nums font-medium text-white/80 tracking-tight select-none">
                            {{ timeDisplay }}
                        </div>
                    </div>

                    <!-- Right Control Group: Subtitles, Settings, PiP, Fullscreen -->
                    <div class="flex items-center gap-1">
                        <!-- Subtitles Button -->
                        <button
                            v-if="processedSubtitles.length > 0"
                            class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/15 text-white/80 hover:text-white transition-colors relative"
                            :title="$t('post_detail.viewer.player.subtitles')"
                            :class="{ 'text-white font-bold bg-white/10': activeSubtitleIndex !== -1 }"
                            @click="toggleSubtitle"
                        >
                            <Subtitles class="w-4 h-4" />
                            <span
                                v-if="activeSubtitleIndex !== -1"
                                class="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400"
                            ></span>
                        </button>

                        <!-- Settings Quick Popover (Speed & Quality) -->
                        <div ref="settingsMenuRef" class="relative">
                            <button
                                class="w-8 h-8 rounded-lg flex items-center justify-center text-white/80 hover:text-white hover:bg-white/15 transition-colors relative"
                                :class="{ 'bg-white/20 text-white': showSettingsMenu }"
                                :title="$t('common.settings')"
                                @click="showSettingsMenu = !showSettingsMenu"
                            >
                                <Settings class="w-4 h-4" />
                                <span
                                    v-if="playbackSpeed !== 1 || selectedQualityObj"
                                    class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400"
                                ></span>
                            </button>

                            <!-- Glassmorphism Settings Dropdown Menu (Segmented Pill Card) -->
                            <Transition name="fade-slide">
                                <div
                                    v-if="showSettingsMenu"
                                    class="absolute bottom-10 right-0 w-44 p-1.5 rounded-2xl bg-zinc-950/85 border border-white/15 backdrop-blur-2xl shadow-2xl z-50 overflow-hidden text-xs text-white"
                                >
                                    <!-- Segmented Pill Header -->
                                    <div class="flex p-1 gap-1 bg-white/5 rounded-xl border border-white/10 mb-1.5">
                                        <button
                                            class="flex-1 py-1 text-center font-medium transition-all rounded-lg"
                                            :class="
                                                activeMenuTab === 'speed'
                                                    ? 'bg-white/20 text-white font-semibold shadow-sm'
                                                    : 'text-white/60 hover:text-white/90'
                                            "
                                            @click="activeMenuTab = 'speed'"
                                        >
                                            {{ $t("post_detail.viewer.player.speed") }}
                                        </button>
                                        <button
                                            v-if="uniqueQualityTracks.length > 0"
                                            class="flex-1 py-1 text-center font-medium transition-all rounded-lg"
                                            :class="
                                                activeMenuTab === 'quality'
                                                    ? 'bg-white/20 text-white font-semibold shadow-sm'
                                                    : 'text-white/60 hover:text-white/90'
                                            "
                                            @click="activeMenuTab = 'quality'"
                                        >
                                            {{ $t("post_detail.viewer.player.quality") }}
                                        </button>
                                    </div>

                                    <!-- Speed Options Tab -->
                                    <div v-if="activeMenuTab === 'speed'" class="space-y-0.5 max-h-48 overflow-y-auto pr-0.5">
                                        <button
                                            v-for="spd in speedOptions"
                                            :key="spd"
                                            class="w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-left transition-all"
                                            :class="
                                                playbackSpeed === spd
                                                    ? 'bg-white/15 text-white font-semibold'
                                                    : 'text-white/70 hover:text-white hover:bg-white/10'
                                            "
                                            @click="setPlaybackSpeed(spd)"
                                        >
                                            <span>{{ spd === 1 ? $t("post_detail.viewer.player.normal_speed") : `${spd}×` }}</span>
                                            <Check v-if="playbackSpeed === spd" class="w-3.5 h-3.5 text-white stroke-[2.5]" />
                                        </button>
                                    </div>

                                    <!-- Quality Options Tab -->
                                    <div v-else-if="activeMenuTab === 'quality'" class="space-y-0.5 max-h-48 overflow-y-auto pr-0.5">
                                        <button
                                            class="w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-left transition-all"
                                            :class="
                                                selectedQualityId === null
                                                    ? 'bg-white/15 text-white font-semibold'
                                                    : 'text-white/70 hover:text-white hover:bg-white/10'
                                            "
                                            @click="selectQualityOption(null)"
                                        >
                                            <span>{{ $t("post_detail.viewer.player.auto_quality") }}</span>
                                            <Check v-if="selectedQualityId === null" class="w-3.5 h-3.5 text-white stroke-[2.5]" />
                                        </button>
                                        <button
                                            v-for="item in uniqueQualityTracks"
                                            :key="item.id"
                                            class="w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-left transition-all"
                                            :class="
                                                selectedQualityId === item.id
                                                    ? 'bg-white/15 text-white font-semibold'
                                                    : 'text-white/70 hover:text-white hover:bg-white/10'
                                            "
                                            @click="selectQualityOption(item.id)"
                                        >
                                            <span>{{ item.label }}</span>
                                            <Check v-if="selectedQualityId === item.id" class="w-3.5 h-3.5 text-white stroke-[2.5]" />
                                        </button>
                                    </div>
                                </div>
                            </Transition>
                        </div>

                        <!-- Picture-in-Picture Button -->
                        <button
                            class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/15 text-white/80 hover:text-white transition-colors hidden sm:flex"
                            :title="$t('post_detail.viewer.player.pip')"
                            @click="togglePip"
                        >
                            <PictureInPicture2 class="w-4 h-4" />
                        </button>

                        <!-- Fullscreen Button -->
                        <button
                            class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/15 text-white/80 hover:text-white transition-colors"
                            :title="
                                isFullscreen ? $t('post_detail.viewer.player.exit_fullscreen') : $t('post_detail.viewer.player.fullscreen')
                            "
                            @click="toggleFullscreen"
                        >
                            <Minimize v-if="isFullscreen" class="w-4 h-4" />
                            <Maximize v-else class="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            <!-- Fallback Loader -->
            <template #fallback>
                <div class="video-player-fallback flex flex-col items-center justify-center gap-3 w-full h-full bg-black text-white/60">
                    <img
                        v-if="props.poster"
                        :src="props.poster"
                        alt=""
                        class="absolute inset-0 w-full h-full object-cover opacity-30 blur-sm"
                    />
                    <div
                        class="relative z-10 flex items-center gap-2.5 px-4 py-2 rounded-full bg-black/80 border border-white/10 backdrop-blur-md shadow-lg"
                    >
                        <Loader2 class="w-4 h-4 text-white animate-spin" />
                        <span class="text-xs font-medium text-white/90">{{ $t("post_detail.viewer.player.loading") }}</span>
                    </div>
                </div>
            </template>
        </ClientOnly>
    </div>
</template>

<style scoped>
.video-player-root {
    isolation: isolate;
    min-height: 200px;
    background: #000000;
}

:deep([data-media-player]) {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    cursor: default !important;
}

:deep([data-media-provider]) {
    background: #000000;
}

:deep([data-media-provider] video) {
    display: block;
    width: 100%;
    height: 100%;
    background: #000000;
    object-fit: contain;
}

.seek-slider,
.seek-slider *,
.seek-slider input::-webkit-slider-runnable-track,
.seek-slider input::-webkit-slider-thumb,
.seek-slider input::-moz-range-track,
.seek-slider input::-moz-range-thumb {
    cursor: ew-resize !important;
}

.seek-slider {
    touch-action: none;
}

.seek-slider-preview {
    opacity: 0;
    white-space: nowrap;
    transition: opacity 0.12s ease-out;
}

.seek-slider-preview.is-visible {
    opacity: 1;
}

.seek-slider-thumb {
    opacity: 0;
    transition: opacity 0.15s ease-out;
}

.seek-slider:hover .seek-slider-thumb {
    opacity: 1;
}

/* Custom Range Input Styling (100% Flat & Flicker-Free) */
.range-input {
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
    border: none;
    outline: none;
    cursor: pointer;
}

.range-input::-webkit-slider-runnable-track {
    background: transparent;
    border: none;
    height: 100%;
    cursor: pointer;
}

.range-input::-moz-range-track {
    background: transparent;
    border: none;
    height: 100%;
    cursor: pointer;
}

.range-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    background: transparent;
    border: none;
    cursor: pointer;
    box-shadow: none;
    transform: none;
}

.range-input::-moz-range-thumb {
    width: 16px;
    height: 16px;
    background: transparent;
    border: none;
    cursor: pointer;
    box-shadow: none;
    transform: none;
}

/* Animations */
.fade-slide-enter-active,
.fade-slide-leave-active {
    transition: all 0.15s ease-out;
}

.fade-slide-enter-from,
.fade-slide-leave-to {
    opacity: 0;
    transform: translateY(4px);
}

.ripple-enter-active {
    transition: all 0.2s ease-out;
}

.ripple-leave-active {
    transition: all 0.25s ease-in;
}

.ripple-enter-from {
    opacity: 0;
    transform: scale(0.85);
}

.ripple-leave-to {
    opacity: 0;
    transform: scale(1.05);
}
</style>
