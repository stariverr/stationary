<script setup lang="ts">
import {
    ChevronLeft,
    ChevronRight,
    Gauge,
    Loader2,
    Maximize,
    Minimize,
    Network,
    Pause,
    PictureInPicture2,
    Play,
    Settings,
    ShieldAlert,
    Subtitles,
    Volume2,
    VolumeX,
    X,
} from "@lucide/vue";
import type { DashSource, DashVideoElement } from "@videojs/html/media/dash-video";
import type { HlsSource } from "@videojs/html/media/hlsjs-video";
import type { VideoPlayerElement } from "@videojs/html/video";

import "@videojs/html/video/player";
import "@videojs/html/ui/container";
import "@videojs/html/ui/controls";
import "@videojs/html/ui/controls-group";
import "@videojs/html/ui/play-button";
import "@videojs/html/ui/mute-button";
import "@videojs/html/ui/pip-button";
import "@videojs/html/ui/fullscreen-button";
import "@videojs/html/ui/time";
import "@videojs/html/ui/time-slider";
import "@videojs/html/ui/slider-track";
import "@videojs/html/ui/slider-buffer";
import "@videojs/html/ui/slider-fill";
import "@videojs/html/ui/slider-thumb";
import "@videojs/html/ui/gesture";
import "@videojs/html/ui/hotkey";
import "@videojs/html/media/dash-video";
import "@videojs/html/media/hlsjs-video";
import { useStorage } from "@vueuse/core";
import type { MediaPlayback } from "@/types/post";
import { bridgeDashAudioTracks } from "@/utils/dash-audio-tracks";
import { isCodecSupported } from "@/utils/media";

interface Props {
    playback: MediaPlayback;
    poster?: string;
    width?: number | string;
    height?: number | string;
    autoplay?: boolean;
}

interface LoadedCaption {
    id: string;
    url: string;
    language: string;
    label: string;
    default: boolean;
}

interface SettingsOption {
    key: string;
    label: string;
    hint?: string;
    selected: boolean;
    select: () => void;
}

type PlayerState = VideoPlayerElement["store"]["state"];
type PlayerAudioTrack = PlayerState["audioTrackList"][number];
type PlayerTextTrack = PlayerState["textTrackList"][number];
type SettingsTab = "all" | "volume" | "speed" | "subtitles" | "audio" | "protocol";
type StreamingProtocol = "HLS" | "DASH";
type SubtitleFontSize = "small" | "normal" | "large" | "xlarge";
type SubtitleBgStyle = "shadow" | "box";

const props = withDefaults(defineProps<Props>(), {
    poster: "",
    width: undefined,
    height: undefined,
    autoplay: true,
});

const emit = defineEmits<{
    (e: "play"): void;
    (e: "pause"): void;
}>();

const { t } = useI18n();

// Player state comes from the Video.js store; every store change re-syncs this snapshot.
const playerRef = ref<VideoPlayerElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const playerState = shallowRef<PlayerState | null>(null);

watch(playerRef, (player, _previous, onCleanup) => {
    if (!player) {
        playerState.value = null;
        return;
    }
    const sync = () => {
        playerState.value = player.store.state;
        triggerRef(playerState);
    };
    sync();
    onCleanup(player.store.subscribe(sync));
});

const isPlaying = computed(() => (playerState.value ? !playerState.value.paused : false));
const isBuffering = computed(() => Boolean(playerState.value?.waiting));
const isMuted = computed(() => Boolean(playerState.value?.muted) || playerState.value?.volume === 0);
const volumeLevel = computed(() => Math.round((playerState.value?.volume ?? 1) * 100));
const isFullscreen = computed(() => Boolean(playerState.value?.isFullscreen));
const currentSpeed = computed(() => playerState.value?.playbackRate ?? 1);

/**
 * The video can report `canplay` before the decoder paints its first frame. The poster overlay stays until
 * playback produces `playing` or currentTime > 0, then fades out over 300ms to avoid a black flash.
 */
const isFirstFramePainted = ref(false);
const isAutoplayAttempting = ref(props.autoplay);

watch(
    () => props.playback.direct_url,
    () => {
        isFirstFramePainted.value = false;
    },
);

const handleMediaPlay = () => {
    isAutoplayAttempting.value = false;
    emit("play");
};

const handleMediaPause = () => {
    isAutoplayAttempting.value = false;
    emit("pause");
};

const handleMediaPlaying = () => {
    isAutoplayAttempting.value = false;
    isFirstFramePainted.value = true;
};

const handleMediaTimeUpdate = () => {
    if ((videoRef.value?.currentTime ?? 0) > 0) isFirstFramePainted.value = true;
};

const isSettingsOpen = ref(false);
const activeSettingsTab = ref<SettingsTab>("all");

const toggleSettings = (tab: SettingsTab = "all") => {
    if (isSettingsOpen.value && activeSettingsTab.value === tab) {
        isSettingsOpen.value = false;
    } else {
        activeSettingsTab.value = tab;
        isSettingsOpen.value = true;
    }
};

const closeSettings = () => {
    isSettingsOpen.value = false;
};

// Keep the controls on screen while the settings drawer is open.
let releaseControlsLock: (() => void) | null = null;

watch(isSettingsOpen, (open) => {
    releaseControlsLock?.();
    releaseControlsLock = open && playerRef.value ? playerRef.value.store.requestControlsLock() : null;
});

const settingsTitle = computed(() => {
    switch (activeSettingsTab.value) {
        case "volume":
            return t("post_detail.viewer.player.volume");
        case "speed":
            return t("post_detail.viewer.player.speed");
        case "subtitles":
            return t("post_detail.viewer.player.subtitles");
        case "audio":
            return t("post_detail.viewer.player.audio_tracks");
        case "protocol":
            return t("post_detail.viewer.player.protocol");
        default:
            return t("common.more");
    }
});

const subtitleFontSize = ref<SubtitleFontSize>("normal");
const subtitleBgStyle = ref<SubtitleBgStyle>("box");

const subtitleSizeOptions = computed<{ value: SubtitleFontSize; label: string }[]>(() => [
    { value: "small", label: t("post_detail.viewer.player.subtitle_size_small") },
    { value: "normal", label: t("post_detail.viewer.player.subtitle_size_normal") },
    { value: "large", label: t("post_detail.viewer.player.subtitle_size_large") },
    { value: "xlarge", label: t("post_detail.viewer.player.subtitle_size_xlarge") },
]);

const subtitleBgOptions = computed<{ value: SubtitleBgStyle; label: string }[]>(() => [
    { value: "box", label: t("post_detail.viewer.player.subtitle_bg_box") },
    { value: "shadow", label: t("post_detail.viewer.player.subtitle_bg_shadow") },
]);

const resolveUrl = (url: string) => {
    if (!url || /^(https?:|blob:)/i.test(url)) return url;
    return import.meta.client ? new URL(url, window.location.origin).toString() : url;
};

// A media that needs a manifest (separate video and audio, or several audio tracks) streams over HLS or DASH;
// anything else plays its original directly.
const protocolUrls = computed<Partial<Record<StreamingProtocol, string>>>(() => ({
    ...(props.playback.hls_url ? { HLS: resolveUrl(props.playback.hls_url) } : {}),
    ...(props.playback.dash_url ? { DASH: resolveUrl(props.playback.dash_url) } : {}),
}));
const availableProtocols = computed(() => (["HLS", "DASH"] as const).filter((protocol) => Boolean(protocolUrls.value[protocol])));
const isStreaming = computed(() => availableProtocols.value.length > 0);
const directSrc = computed(() => resolveUrl(props.playback.direct_url));

// HLS plays through hls.js everywhere (Safari included); DASH is chosen from the player settings. A protocol that
// fails to play is not swapped for the other one automatically.
const DEFAULT_PROTOCOL: StreamingProtocol = "HLS";
// Only an explicit choice is stored, so a later change of the default reaches everyone who never picked one.
const storedProtocol = useStorage<StreamingProtocol>("stationary-player-protocol", DEFAULT_PROTOCOL, undefined, {
    writeDefaults: false,
});
const preferredProtocol = computed<StreamingProtocol>({
    get: () => (storedProtocol.value === "HLS" || storedProtocol.value === "DASH" ? storedProtocol.value : DEFAULT_PROTOCOL),
    set: (protocol) => {
        storedProtocol.value = protocol;
    },
});

const canChooseProtocol = computed(() => availableProtocols.value.length > 1);
const activeProtocol = computed<StreamingProtocol>(() =>
    availableProtocols.value.includes(preferredProtocol.value)
        ? preferredProtocol.value
        : (availableProtocols.value[0] ?? DEFAULT_PROTOCOL),
);

const hlsSource = computed<HlsSource>(() => ({
    src: protocolUrls.value.HLS ?? "",
    type: "application/x-mpegURL",
    preferPlayback: "mse",
    // Captions come from <track> elements under both protocols, so hls.js skips the manifest's subtitle group.
    engine: { hlsJs: { enableWebVTT: false, enableIMSC1: false } },
}));

const dashSource = computed<DashSource>(() => ({
    src: protocolUrls.value.DASH ?? "",
    engine: { dashJs: { streaming: { cmcd: { enabled: false } } } },
}));

const engineRef = ref<HTMLElement | null>(null);

watch(engineRef, (engine, _previous, onCleanup) => {
    if (engine?.localName === "dash-video") onCleanup(bridgeDashAudioTracks(engine as DashVideoElement));
});

// The server reports every stream's codec and leaves support to the client. A video stream this browser cannot
// decode is not played at all; audio tracks it cannot decode are left out of the audio menu.
const isVideoSupported = computed(() => {
    const { video, audio_tracks } = props.playback;
    if (video) return isCodecSupported("video", video.codec_string);
    return audio_tracks.length === 0 || audio_tracks.some((track) => isCodecSupported("audio", track.codec_string));
});

/** The label each audio track carries in the manifests (apps/server/src/features/playback/manifests.ts). */
const manifestAudioLabel = (track: MediaPlayback["audio_tracks"][number], index: number) =>
    track.label || track.language || `Audio ${index + 1}`;

const supportedAudioLabels = computed(
    () =>
        new Set(
            props.playback.audio_tracks
                .map((track, index) => ({ track, label: manifestAudioLabel(track, index) }))
                .filter(({ track }) => isCodecSupported("audio", track.codec_string))
                .map(({ label }) => label),
        ),
);

// Switching the streaming protocol resumes where the old engine was.
let pendingSourceRestore: { time: number; paused: boolean; rate: number } | null = null;

const rememberPlaybackPosition = () => {
    const video = videoRef.value;
    if (video) pendingSourceRestore = { time: video.currentTime, paused: video.paused, rate: video.playbackRate };
};

const handleLoadedMetadata = () => {
    const video = videoRef.value;
    const restore = pendingSourceRestore;
    pendingSourceRestore = null;
    if (!video || !restore) return;
    video.currentTime = restore.time;
    video.playbackRate = restore.rate;
    if (!restore.paused) video.play().catch(() => {});
};

const formatLanguageLabel = (lang?: string | null, label?: string | null): string => {
    if (
        label &&
        label !== "Subtitle" &&
        label !== "Audio" &&
        label !== "unknown" &&
        label !== "und" &&
        !/^[a-z]{2}(-[a-z]{2,4})?$/i.test(label)
    ) {
        return label;
    }
    const code = (lang || label || "").toLowerCase().replace("_", "-");
    const langMap: Record<string, string> = {
        zh: "中文",
        "zh-cn": "简体中文",
        "zh-hans": "简体中文",
        "zh-tw": "繁体中文",
        "zh-hant": "繁体中文",
        "zh-hk": "繁体中文",
        en: "English",
        "en-us": "English (US)",
        "en-gb": "English (UK)",
        ja: "日语",
        ko: "韩语",
        fr: "法语",
        de: "德语",
        es: "西班牙语",
        ru: "俄语",
        it: "意大利语",
        pt: "葡萄牙语",
    };
    const primaryCode = code.split("-")[0] || "";
    return (
        langMap[code] || langMap[primaryCode] || (label && label !== "Subtitle" ? label : t("post_detail.viewer.player.default_subtitle"))
    );
};

// Captions load into same-origin blob URLs: a native <track> needs CORS mode on the video for a cross-origin file.
const loadedCaptions = ref<LoadedCaption[]>([]);
let captionLoadVersion = 0;

const revokeCaptions = (captions = loadedCaptions.value) => {
    for (const caption of captions) {
        if (caption.url.startsWith("blob:")) URL.revokeObjectURL(caption.url);
    }
};

const loadCaptions = async (captions: MediaPlayback["captions"]) => {
    const loadVersion = ++captionLoadVersion;
    const previous = loadedCaptions.value;
    loadedCaptions.value = [];
    if (!import.meta.client) return;
    revokeCaptions(previous);

    const loaded = await Promise.all(
        captions.map(async (caption): Promise<LoadedCaption> => {
            const loadedCaption = {
                id: caption.id,
                url: resolveUrl(caption.vtt_url),
                language: caption.language || "und",
                label: formatLanguageLabel(caption.language, caption.label),
                default: caption.is_default,
            };
            try {
                const response = await fetch(loadedCaption.url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = new Blob([await response.text()], { type: "text/vtt" });
                return { ...loadedCaption, url: URL.createObjectURL(blob) };
            } catch (error) {
                console.error("Failed to load caption:", error);
                return loadedCaption;
            }
        }),
    );

    if (loadVersion !== captionLoadVersion) {
        revokeCaptions(loaded);
        return;
    }
    loadedCaptions.value = loaded;
};

watch(() => props.playback.captions, loadCaptions, { deep: true, immediate: true });

const audioOptions = computed<SettingsOption[]>(() => {
    const tracks = (playerState.value?.audioTrackList ?? []).filter((track: PlayerAudioTrack) =>
        supportedAudioLabels.value.has(track.label),
    );
    const prefix = t("post_detail.viewer.player.audio_tracks");
    return tracks.map((track: PlayerAudioTrack, index: number) => {
        const languageName = track.language ? formatLanguageLabel(track.language) : "";
        const isGenerated = /^Audio \d+$/.test(track.label) || track.label === track.language;
        const label = !isGenerated ? track.label : languageName ? `${prefix} ${index + 1} (${languageName})` : `${prefix} ${index + 1}`;
        return {
            key: track.id,
            label,
            selected: track.enabled,
            select: () => playerRef.value?.store.selectAudioTrack(track.id),
        };
    });
});

const audioAvailable = computed(() => audioOptions.value.length > 1);

const subtitleOptions = computed<SettingsOption[]>(() => {
    const tracks: PlayerTextTrack[] = playerState.value?.textTrackList ?? [];
    return tracks
        .filter((track) => track.kind === "subtitles" || track.kind === "captions")
        .map((track) => ({
            key: track.id,
            label: track.label || formatLanguageLabel(track.language),
            selected: track.mode === "showing",
            select: () => playerRef.value?.store.selectSubtitlesTrack(track.id),
        }));
});

const selectProtocol = (protocol: StreamingProtocol) => {
    if (protocol === activeProtocol.value) return;
    rememberPlaybackPosition();
    preferredProtocol.value = protocol;
};

const protocolOptions = computed<SettingsOption[]>(() =>
    (["HLS", "DASH"] as const).map((protocol) => ({
        key: protocol,
        label: protocol,
        selected: activeProtocol.value === protocol,
        select: () => selectProtocol(protocol),
    })),
);

const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];

const formatSpeed = (rate: number) => (rate === 1 ? "1.0x" : `${rate}x`);

const speedSettingsOptions = computed<SettingsOption[]>(() =>
    speedOptions.map((rate) => ({
        key: String(rate),
        label: rate === 1 ? t("post_detail.viewer.player.normal_speed") : `${rate}x`,
        selected: currentSpeed.value === rate,
        select: () => playerRef.value?.store.setPlaybackRate(rate),
    })),
);

const settingsOptions = computed<SettingsOption[] | null>(() => {
    switch (activeSettingsTab.value) {
        case "audio":
            return audioAvailable.value ? audioOptions.value : null;
        case "subtitles":
            if (subtitleOptions.value.length === 0) return null;
            return [
                {
                    key: "off",
                    label: t("post_detail.viewer.player.subtitles_off"),
                    selected: !subtitleOptions.value.some((option) => option.selected),
                    select: () => playerRef.value?.store.selectSubtitlesTrack(null),
                },
                ...subtitleOptions.value,
            ];
        case "speed":
            return speedSettingsOptions.value;
        case "protocol":
            return canChooseProtocol.value ? protocolOptions.value : null;
        default:
            return null;
    }
});

const setPlayerVolume = (value: number) => {
    playerRef.value?.store.setVolume(value / 100);
};

const toggleMute = () => {
    const store = playerRef.value?.store;
    if (store) store.setMuted(!store.state.muted);
};

watch(
    () => props.autoplay,
    (autoplay) => {
        isAutoplayAttempting.value = autoplay;
        const store = playerRef.value?.store;
        if (!store) return;
        if (autoplay) store.play().catch(() => {});
        else store.pause();
    },
);

onBeforeUnmount(() => {
    releaseControlsLock?.();
    releaseControlsLock = null;
    captionLoadVersion += 1;
    if (import.meta.client) revokeCaptions();
});
</script>

<template>
    <div
        class="video-player-root relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-black"
        :class="[`sub-size-${subtitleFontSize}`, `sub-bg-${subtitleBgStyle}`]"
    >
        <ClientOnly>
            <div v-if="!isVideoSupported" class="relative grid h-full w-full min-h-[200px] place-items-center overflow-hidden bg-black">
                <img v-if="props.poster" class="absolute inset-0 h-full w-full object-contain opacity-40" :src="props.poster" alt="" />
                <div
                    role="alert"
                    class="relative mx-4 flex max-w-sm flex-col items-center gap-2 rounded-xl border border-white/14 bg-[rgba(9,9,11,0.82)] px-4 py-3 text-center text-xs text-white/90 backdrop-blur-md"
                >
                    <ShieldAlert class="h-5 w-5 text-amber-400" />
                    <span>{{ $t("post_detail.viewer.player.unsupported_codec") }}</span>
                </div>
            </div>
            <video-player v-else ref="playerRef" class="contents">
                <media-container class="player-container relative block h-full w-full">
                    <!-- Keyed by protocol so switching tears down one engine before the other attaches -->
                    <component
                        :is="activeProtocol === 'HLS' ? 'hlsjs-video' : 'dash-video'"
                        v-if="isStreaming"
                        :key="activeProtocol"
                        ref="engineRef"
                        :source.prop="activeProtocol === 'HLS' ? hlsSource : dashSource"
                        class="block h-full w-full"
                    >
                        <video
                            ref="videoRef"
                            slot="media"
                            class="h-full w-full object-contain"
                            playsinline
                            :autoplay="props.autoplay"
                            @play="handleMediaPlay"
                            @pause="handleMediaPause"
                            @playing="handleMediaPlaying"
                            @timeupdate="handleMediaTimeUpdate"
                            @loadedmetadata="handleLoadedMetadata"
                        >
                            <track
                                v-for="caption in loadedCaptions"
                                :key="caption.id"
                                kind="subtitles"
                                :label="caption.label"
                                :srclang="caption.language"
                                :src="caption.url"
                                :default="caption.default"
                            />
                        </video>
                    </component>
                    <video
                        v-else
                        ref="videoRef"
                        class="h-full w-full object-contain"
                        playsinline
                        :src="directSrc"
                        :autoplay="props.autoplay"
                        @play="handleMediaPlay"
                        @pause="handleMediaPause"
                        @playing="handleMediaPlaying"
                        @timeupdate="handleMediaTimeUpdate"
                        @loadedmetadata="handleLoadedMetadata"
                    >
                        <track
                            v-for="caption in loadedCaptions"
                            :key="caption.id"
                            kind="subtitles"
                            :label="caption.label"
                            :srclang="caption.language"
                            :src="caption.url"
                            :default="caption.default"
                        />
                    </video>

                    <img
                        v-if="props.poster"
                        :src="props.poster"
                        class="absolute inset-0 h-full w-full object-contain pointer-events-none transition-opacity duration-300 ease-out z-20"
                        :class="isFirstFramePainted ? 'opacity-0' : 'opacity-100'"
                        aria-hidden="true"
                    />

                    <media-gesture type="tap" action="togglePaused" :disabled="isSettingsOpen" />
                    <media-gesture type="doubletap" action="seekStep" value="-10" region="left" :disabled="isSettingsOpen" />
                    <media-gesture type="doubletap" action="seekStep" value="10" region="right" :disabled="isSettingsOpen" />

                    <media-hotkey keys="Space" action="togglePaused" />
                    <media-hotkey keys="k" action="togglePaused" />
                    <media-hotkey keys="m" action="toggleMuted" />
                    <media-hotkey keys="f" action="toggleFullscreen" />
                    <media-hotkey keys="c" action="toggleSubtitles" />
                    <media-hotkey keys="i" action="togglePictureInPicture" />
                    <media-hotkey keys="ArrowLeft" action="seekStep" value="-5" />
                    <media-hotkey keys="ArrowRight" action="seekStep" value="5" />
                    <media-hotkey keys="ArrowUp" action="volumeStep" value="5" />
                    <media-hotkey keys="ArrowDown" action="volumeStep" value="-5" />

                    <div
                        v-if="isBuffering || (isAutoplayAttempting && !isPlaying)"
                        class="buffering-indicator pointer-events-none absolute top-1/2 left-1/2 z-25 grid h-15 w-15 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-[rgba(15,15,18,0.72)] text-white shadow-2xl backdrop-blur-md"
                        aria-hidden="true"
                    >
                        <Loader2 class="h-7 w-7 animate-spin" />
                    </div>

                    <media-controls
                        class="player-controls absolute inset-0 z-30 flex flex-col justify-end box-border pointer-events-none opacity-0 transition-opacity duration-220 px-3.5 sm:px-4 md:px-6 pb-[max(10px,env(safe-area-inset-bottom,10px))] bg-gradient-to-t from-black/70 via-transparent via-25% to-transparent data-[visible]:opacity-100"
                        :class="isSettingsOpen ? '!opacity-100 !pointer-events-auto' : ''"
                    >
                        <!-- Center play button lives inside the controls so it fades out with them -->
                        <media-play-button
                            v-if="!isPlaying && !isBuffering"
                            class="center-play-button pointer-events-auto absolute top-1/2 left-1/2 z-25 grid h-13 w-13 sm:h-14 sm:w-14 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full border border-white/25 bg-black/50 text-white shadow-xl backdrop-blur-md transition-all duration-200 hover:scale-108 hover:border-white/40 hover:bg-black/75 hover:shadow-[0_0_24px_rgba(255,255,255,0.2)]"
                            :aria-label="$t('post_detail.viewer.player.play')"
                        >
                            <Play class="h-6 w-6 sm:h-7 sm:w-7 translate-x-0.5 fill-current" />
                        </media-play-button>

                        <!-- Transparent backdrop: click outside closes the drawer -->
                        <div
                            v-if="isSettingsOpen"
                            class="settings-backdrop pointer-events-auto absolute max-sm:fixed inset-0 z-45 bg-black/20 max-sm:bg-black/40 backdrop-blur-[1px] sm:backdrop-blur-none cursor-default transition-opacity duration-150"
                            @click.stop="closeSettings"
                        />

                        <!-- Settings drawer / bottom sheet -->
                        <Transition
                            enter-active-class="transition duration-200 ease-out"
                            enter-from-class="opacity-0 translate-y-4"
                            enter-to-class="opacity-100 translate-y-0"
                            leave-active-class="transition duration-150 ease-in"
                            leave-from-class="opacity-100 translate-y-0"
                            leave-to-class="opacity-0 translate-y-4"
                        >
                            <div
                                v-if="isSettingsOpen"
                                class="video-settings-drawer pointer-events-auto absolute z-50 overflow-hidden shadow-2xl backdrop-blur-2xl bg-white/95 text-neutral-900 border border-neutral-200/90 text-xs"
                                :class="[
                                    'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:rounded-t-2xl max-sm:max-h-[75vh]',
                                    'sm:absolute sm:bottom-16 sm:right-3.5 md:right-6 sm:w-68 sm:rounded-xl sm:max-h-[380px]',
                                ]"
                                @click.stop
                            >
                                <div class="sheet-handle sm:hidden mx-auto mt-2.5 h-1 w-9 rounded-full bg-neutral-300" />

                                <div class="flex items-center justify-between border-b border-neutral-200/80 px-3.5 py-2.5">
                                    <div class="flex items-center gap-1.5 font-semibold text-neutral-900 text-xs">
                                        <button
                                            v-if="activeSettingsTab !== 'all'"
                                            type="button"
                                            class="rounded p-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 transition-colors"
                                            @click.stop="activeSettingsTab = 'all'"
                                        >
                                            <ChevronLeft class="h-4 w-4" />
                                        </button>
                                        <span>{{ settingsTitle }}</span>
                                    </div>
                                    <button
                                        type="button"
                                        class="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800 transition-colors"
                                        @click.stop="closeSettings"
                                    >
                                        <X class="h-4 w-4" />
                                    </button>
                                </div>

                                <div class="overflow-y-auto p-3 max-h-[280px] space-y-2">
                                    <!-- Main menu -->
                                    <div v-if="activeSettingsTab === 'all'" class="space-y-1.5">
                                        <button
                                            type="button"
                                            class="flex w-full items-center justify-between rounded-xl bg-neutral-100/80 px-3.5 py-2.5 text-xs font-medium text-neutral-800 transition-all hover:bg-neutral-200/80 hover:text-neutral-900"
                                            @click.stop="activeSettingsTab = 'volume'"
                                        >
                                            <span class="flex items-center gap-2">
                                                <Volume2 v-if="!isMuted" class="h-4 w-4 text-neutral-500" />
                                                <VolumeX v-else class="h-4 w-4 text-neutral-500" />
                                                <span>{{ $t("post_detail.viewer.player.volume") }}</span>
                                            </span>
                                            <span class="flex items-center gap-1 text-neutral-500 font-semibold text-xs">
                                                <span>{{ isMuted ? "0%" : `${volumeLevel}%` }}</span>
                                                <ChevronRight class="h-4 w-4" />
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            class="flex w-full items-center justify-between rounded-xl bg-neutral-100/80 px-3.5 py-2.5 text-xs font-medium text-neutral-800 transition-all hover:bg-neutral-200/80 hover:text-neutral-900"
                                            @click.stop="activeSettingsTab = 'speed'"
                                        >
                                            <span class="flex items-center gap-2">
                                                <Gauge class="h-4 w-4 text-neutral-500" />
                                                <span>{{ $t("post_detail.viewer.player.speed") }}</span>
                                            </span>
                                            <span class="flex items-center gap-1 text-neutral-500 font-semibold text-xs">
                                                <span>{{ formatSpeed(currentSpeed) }}</span>
                                                <ChevronRight class="h-4 w-4" />
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            class="flex w-full items-center justify-between rounded-xl bg-neutral-100/80 px-3.5 py-2.5 text-xs font-medium text-neutral-800 transition-all hover:bg-neutral-200/80 hover:text-neutral-900"
                                            @click.stop="activeSettingsTab = 'subtitles'"
                                        >
                                            <span class="flex items-center gap-2">
                                                <Subtitles class="h-4 w-4 text-neutral-500" />
                                                <span>{{ $t("post_detail.viewer.player.subtitles") }}</span>
                                            </span>
                                            <span class="flex items-center gap-1 text-neutral-500 font-semibold text-xs">
                                                <ChevronRight class="h-4 w-4" />
                                            </span>
                                        </button>

                                        <button
                                            v-if="audioAvailable"
                                            type="button"
                                            class="flex w-full items-center justify-between rounded-xl bg-neutral-100/80 px-3.5 py-2.5 text-xs font-medium text-neutral-800 transition-all hover:bg-neutral-200/80 hover:text-neutral-900"
                                            @click.stop="activeSettingsTab = 'audio'"
                                        >
                                            <span class="flex items-center gap-2">
                                                <Volume2 class="h-4 w-4 text-neutral-500" />
                                                <span>{{ $t("post_detail.viewer.player.audio_tracks") }}</span>
                                            </span>
                                            <span class="flex items-center gap-1 text-neutral-500 font-semibold text-xs">
                                                <ChevronRight class="h-4 w-4" />
                                            </span>
                                        </button>

                                        <button
                                            v-if="canChooseProtocol"
                                            type="button"
                                            class="flex w-full items-center justify-between rounded-xl bg-neutral-100/80 px-3.5 py-2.5 text-xs font-medium text-neutral-800 transition-all hover:bg-neutral-200/80 hover:text-neutral-900"
                                            @click.stop="activeSettingsTab = 'protocol'"
                                        >
                                            <span class="flex items-center gap-2">
                                                <Network class="h-4 w-4 text-neutral-500" />
                                                <span>{{ $t("post_detail.viewer.player.protocol") }}</span>
                                            </span>
                                            <span class="flex items-center gap-1 text-neutral-500 font-semibold text-xs">
                                                <span>{{ activeProtocol }}</span>
                                                <ChevronRight class="h-4 w-4" />
                                            </span>
                                        </button>
                                    </div>

                                    <!-- Volume page -->
                                    <section v-else-if="activeSettingsTab === 'volume'" class="settings-section space-y-3">
                                        <div class="rounded-xl border border-neutral-200/80 bg-neutral-100/70 p-3 space-y-2.5">
                                            <div class="flex items-center justify-between text-xs font-semibold text-neutral-800 px-0.5">
                                                <span class="flex items-center gap-1.5 text-neutral-700">
                                                    <Volume2 v-if="!isMuted" class="h-4 w-4 text-neutral-600" />
                                                    <VolumeX v-else class="h-4 w-4 text-neutral-400" />
                                                    <span>{{ $t("post_detail.viewer.player.volume") }}</span>
                                                </span>
                                                <span class="font-mono text-xs font-bold text-neutral-600 tabular-nums">
                                                    {{ isMuted ? "0%" : `${volumeLevel}%` }}
                                                </span>
                                            </div>

                                            <div class="flex items-center gap-2.5 px-0.5">
                                                <button
                                                    type="button"
                                                    class="control-button grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-lg text-neutral-700 hover:bg-neutral-200/90 transition-colors"
                                                    :aria-label="
                                                        isMuted
                                                            ? $t('post_detail.viewer.player.unmute')
                                                            : $t('post_detail.viewer.player.mute')
                                                    "
                                                    @click.stop="toggleMute"
                                                >
                                                    <VolumeX v-if="isMuted" class="h-4 w-4 text-neutral-400" />
                                                    <Volume2 v-else class="h-4 w-4 text-neutral-700" />
                                                </button>

                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="100"
                                                    :value="isMuted ? 0 : volumeLevel"
                                                    class="volume-range-slider h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-neutral-200 accent-neutral-900 transition-all focus:outline-none"
                                                    @input.stop="setPlayerVolume(Number(($event.target as HTMLInputElement).value))"
                                                />
                                            </div>
                                        </div>

                                        <div class="settings-chip-group flex flex-wrap gap-1">
                                            <button
                                                type="button"
                                                class="settings-chip flex-1 min-w-[48px] cursor-pointer rounded-lg border border-neutral-200 bg-neutral-100/80 px-2 py-1.5 text-center text-xs font-medium text-neutral-700 transition-all hover:border-neutral-300 hover:bg-neutral-200/80 hover:text-neutral-900"
                                                :class="{ 'border-neutral-800 bg-neutral-900 text-white font-semibold shadow-xs': isMuted }"
                                                @click.stop="setPlayerVolume(0)"
                                            >
                                                {{ $t("post_detail.viewer.player.mute") }}
                                            </button>
                                            <button
                                                v-for="v in [25, 50, 75, 100]"
                                                :key="v"
                                                type="button"
                                                class="settings-chip flex-1 min-w-[48px] cursor-pointer rounded-lg border border-neutral-200 bg-neutral-100/80 px-2 py-1.5 text-center text-xs font-medium text-neutral-700 transition-all hover:border-neutral-300 hover:bg-neutral-200/80 hover:text-neutral-900"
                                                :class="{
                                                    'border-neutral-800 bg-neutral-900 text-white font-semibold shadow-xs':
                                                        !isMuted && volumeLevel === v,
                                                }"
                                                @click.stop="setPlayerVolume(v)"
                                            >
                                                {{ v }}%
                                            </button>
                                        </div>
                                    </section>

                                    <!-- Audio / subtitles / speed / protocol pages -->
                                    <template v-else>
                                        <section v-if="settingsOptions" class="settings-section">
                                            <div role="radiogroup" :aria-label="settingsTitle" class="flex w-full flex-col gap-1">
                                                <button
                                                    v-for="option in settingsOptions"
                                                    :key="option.key"
                                                    type="button"
                                                    role="radio"
                                                    class="settings-radio"
                                                    :aria-checked="option.selected"
                                                    :data-checked="option.selected || undefined"
                                                    @click.stop="option.select()"
                                                >
                                                    <span class="settings-radio-label">{{ option.label }}</span>
                                                    <span v-if="option.hint" class="settings-radio-hint">{{ option.hint }}</span>
                                                </button>
                                            </div>
                                        </section>

                                        <section v-if="activeSettingsTab === 'subtitles'" class="settings-section">
                                            <template v-if="loadedCaptions.length > 0">
                                                <div class="settings-subgroup mt-3 pt-2 border-t border-neutral-200/80">
                                                    <div
                                                        class="settings-subheading px-1 py-1 text-xs font-semibold uppercase tracking-wider text-neutral-400"
                                                    >
                                                        {{ $t("post_detail.viewer.player.subtitle_size") }}
                                                    </div>
                                                    <div class="settings-chip-group flex flex-wrap gap-1">
                                                        <button
                                                            v-for="opt in subtitleSizeOptions"
                                                            :key="opt.value"
                                                            type="button"
                                                            class="settings-chip flex-1 min-w-[52px] cursor-pointer rounded-lg border border-neutral-200 bg-neutral-100/80 px-2 py-1.5 text-center text-xs font-medium text-neutral-700 transition-all duration-120 hover:border-neutral-300 hover:bg-neutral-200/80 hover:text-neutral-900"
                                                            :class="{
                                                                'border-neutral-800 bg-neutral-900 text-white font-semibold shadow-xs':
                                                                    subtitleFontSize === opt.value,
                                                            }"
                                                            @click.stop="subtitleFontSize = opt.value"
                                                        >
                                                            {{ opt.label }}
                                                        </button>
                                                    </div>
                                                </div>

                                                <div class="settings-subgroup mt-2.5">
                                                    <div
                                                        class="settings-subheading px-1 py-1 text-xs font-semibold uppercase tracking-wider text-neutral-400"
                                                    >
                                                        {{ $t("post_detail.viewer.player.subtitle_bg") }}
                                                    </div>
                                                    <div class="settings-chip-group flex flex-wrap gap-1">
                                                        <button
                                                            v-for="opt in subtitleBgOptions"
                                                            :key="opt.value"
                                                            type="button"
                                                            class="settings-chip flex-1 min-w-[52px] cursor-pointer rounded-lg border border-neutral-200 bg-neutral-100/80 px-2 py-1.5 text-center text-xs font-medium text-neutral-700 transition-all duration-120 hover:border-neutral-300 hover:bg-neutral-200/80 hover:text-neutral-900"
                                                            :class="{
                                                                'border-neutral-800 bg-neutral-900 text-white font-semibold shadow-xs':
                                                                    subtitleBgStyle === opt.value,
                                                            }"
                                                            @click.stop="subtitleBgStyle = opt.value"
                                                        >
                                                            {{ opt.label }}
                                                        </button>
                                                    </div>
                                                </div>
                                            </template>
                                            <div
                                                v-else
                                                class="settings-empty-notice rounded-lg bg-neutral-100 p-3 text-center text-xs text-neutral-400"
                                            >
                                                {{ $t("post_detail.viewer.player.no_subtitles") }}
                                            </div>
                                        </section>
                                    </template>
                                </div>
                            </div>
                        </Transition>

                        <!-- Bottom controls: scrubber + button row -->
                        <div class="bottom-controls-cluster mt-auto pointer-events-auto flex w-full flex-col gap-1 shrink-0">
                            <media-time-slider
                                class="time-slider relative flex h-5 w-full cursor-pointer items-center touch-none select-none box-border px-0.5"
                            >
                                <media-slider-track class="slider-track">
                                    <media-slider-buffer class="slider-buffer" />
                                    <media-slider-fill class="slider-fill" />
                                </media-slider-track>
                                <media-slider-thumb class="slider-thumb" />
                            </media-time-slider>

                            <media-controls-group class="control-row flex w-full items-center justify-between gap-1 sm:gap-3">
                                <div class="control-cluster flex items-center gap-0.5 sm:gap-1.5 min-w-0">
                                    <media-play-button
                                        class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white"
                                        :aria-label="
                                            isPlaying ? $t('post_detail.viewer.player.pause') : $t('post_detail.viewer.player.play')
                                        "
                                    >
                                        <Pause v-if="isPlaying" class="h-4.5 w-4.5 fill-current" />
                                        <Play v-else class="h-4.5 w-4.5 translate-x-px fill-current" />
                                    </media-play-button>

                                    <div
                                        class="time-display flex min-w-0 items-center gap-1 ml-1.5 sm:ml-2.5 text-xs sm:text-sm font-semibold text-white/95 tabular-nums drop-shadow-xs"
                                    >
                                        <media-time type="current" />
                                        <span aria-hidden="true" class="opacity-70">/</span>
                                        <media-time type="duration" />
                                    </div>
                                </div>

                                <div class="control-cluster flex items-center gap-0.5 sm:gap-1.5 shrink-0">
                                    <button
                                        v-if="loadedCaptions.length > 0"
                                        type="button"
                                        class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white"
                                        :class="{ 'bg-white/20 text-white': isSettingsOpen && activeSettingsTab === 'subtitles' }"
                                        :aria-label="$t('post_detail.viewer.player.subtitles')"
                                        @click.stop="toggleSettings('subtitles')"
                                    >
                                        <Subtitles class="h-4 w-4" />
                                    </button>

                                    <button
                                        type="button"
                                        class="control-button relative hidden sm:flex h-8 px-2 shrink-0 cursor-pointer items-center justify-center rounded-lg text-xs font-semibold text-white/90 transition-all duration-140 hover:bg-white/15 hover:text-white"
                                        :class="{ 'bg-white/20 text-white font-bold': isSettingsOpen && activeSettingsTab === 'speed' }"
                                        :aria-label="$t('post_detail.viewer.player.speed')"
                                        @click.stop="toggleSettings('speed')"
                                    >
                                        <span>{{ formatSpeed(currentSpeed) }}</span>
                                    </button>

                                    <media-mute-button
                                        class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white"
                                        :aria-label="
                                            isMuted ? $t('post_detail.viewer.player.unmute') : $t('post_detail.viewer.player.mute')
                                        "
                                    >
                                        <VolumeX v-if="isMuted" class="h-4 w-4" />
                                        <Volume2 v-else class="h-4 w-4" />
                                    </media-mute-button>

                                    <media-pip-button
                                        class="control-button relative hidden sm:grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white"
                                        :aria-label="$t('post_detail.viewer.player.pip')"
                                    >
                                        <PictureInPicture2 class="h-4 w-4" />
                                    </media-pip-button>

                                    <button
                                        type="button"
                                        class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white"
                                        :class="{ 'bg-white/20 text-white': isSettingsOpen && activeSettingsTab === 'all' }"
                                        :aria-label="$t('common.more')"
                                        @click.stop="toggleSettings('all')"
                                    >
                                        <Settings class="h-4 w-4" />
                                    </button>

                                    <media-fullscreen-button
                                        class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white"
                                        :aria-label="
                                            isFullscreen
                                                ? $t('post_detail.viewer.player.exit_fullscreen')
                                                : $t('post_detail.viewer.player.fullscreen')
                                        "
                                    >
                                        <Minimize v-if="isFullscreen" class="h-4 w-4" />
                                        <Maximize v-else class="h-4 w-4" />
                                    </media-fullscreen-button>
                                </div>
                            </media-controls-group>
                        </div>
                    </media-controls>
                </media-container>
            </video-player>

            <template #fallback>
                <div class="video-player-fallback relative grid h-full w-full min-h-[200px] overflow-hidden place-items-center bg-black">
                    <img v-if="props.poster" class="absolute inset-0 h-full w-full object-contain opacity-100" :src="props.poster" alt="" />
                    <div
                        class="fallback-status relative flex items-center gap-2 rounded-full border border-white/14 bg-[rgba(9,9,11,0.82)] px-3 py-2 text-xs text-white/90 backdrop-blur-md"
                    >
                        <Loader2 class="h-4 w-4 animate-spin" />
                        <span>{{ $t("post_detail.viewer.player.loading") }}</span>
                    </div>
                </div>
            </template>
        </ClientOnly>
    </div>
</template>

<style scoped>
/* Captions are rendered natively by the browser; ::cue accepts only color, background and text-shadow. */
.player-container video::cue {
    color: #ffffff;
    font-weight: 500;
    line-height: 1.4;
}

.sub-size-small .player-container video::cue {
    font-size: clamp(12px, 1.4vw, 15px);
}
.sub-size-normal .player-container video::cue {
    font-size: clamp(14px, 1.8vw, 18px);
}
.sub-size-large .player-container video::cue {
    font-size: clamp(17px, 2.3vw, 22px);
}
.sub-size-xlarge .player-container video::cue {
    font-size: clamp(20px, 2.8vw, 28px);
}

.sub-bg-box .player-container video::cue {
    background-color: rgba(10, 10, 14, 0.78);
}

.sub-bg-shadow .player-container video::cue {
    background-color: transparent;
    text-shadow:
        0 2px 8px rgba(0, 0, 0, 0.95),
        0 0 2px rgba(0, 0, 0, 0.9);
}

/* Lift captions above the bottom controls while they are visible (Chromium / WebKit). */
.player-container video::-webkit-media-text-track-container {
    translate: 0 var(--media-caption-track-y, 0);
    transition: translate 220ms ease-out;
}

.player-container[data-controls-visible] {
    --media-caption-track-y: -72px;
}

.player-container:fullscreen .player-controls {
    padding-right: max(20px, env(safe-area-inset-right, 20px)) !important;
    padding-bottom: max(18px, env(safe-area-inset-bottom, 18px)) !important;
    padding-left: max(20px, env(safe-area-inset-left, 20px)) !important;
}

.player-container:fullscreen .video-settings-drawer {
    bottom: 72px !important;
    max-height: min(460px, 72vh) !important;
}

.slider-track {
    position: absolute;
    right: 0;
    left: 0;
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
    transition: height 140ms ease;
}

.time-slider:hover .slider-track,
.time-slider[data-dragging] .slider-track {
    height: 5px;
}

.slider-buffer,
.slider-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
}

.slider-buffer {
    width: var(--media-slider-buffer, 0%);
    background: rgba(255, 255, 255, 0.35);
}

.slider-fill {
    width: var(--media-slider-fill, 0%);
    background: #ffffff;
}

.slider-thumb {
    position: absolute;
    top: 50%;
    left: var(--media-slider-fill, 0%);
    width: 12px;
    height: 12px;
    transform: translate(-50%, -50%) scale(0);
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    transition: transform 140ms ease;
}

.time-slider:hover .slider-thumb,
.time-slider[data-dragging] .slider-thumb {
    transform: translate(-50%, -50%) scale(1);
}

.video-settings-drawer {
    width: 240px !important;
    min-width: 220px !important;
    max-width: calc(100vw - 24px) !important;
    max-height: min(320px, 55vh) !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    scrollbar-gutter: stable;
    overscroll-behavior: contain !important;
    touch-action: pan-y !important;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box !important;
    background: rgba(255, 255, 255, 0.95) !important;
    color: #171717 !important;
}

.video-settings-drawer::-webkit-scrollbar {
    width: 4px;
}
.video-settings-drawer::-webkit-scrollbar-track {
    background: transparent;
}
.video-settings-drawer::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.18);
    border-radius: 999px;
}

.settings-radio {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 38px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.04);
    color: #262626;
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: all 120ms ease;
}

.settings-radio:hover {
    background: rgba(0, 0, 0, 0.08);
    color: #000000;
}

.settings-radio[data-checked] {
    background: rgba(0, 0, 0, 0.08);
    border-color: rgba(0, 0, 0, 0.25);
    color: #000000;
    font-weight: 700;
}

.settings-radio[data-checked]::after {
    content: "✓";
    margin-left: 12px;
    color: #000000;
    font-size: 14px;
    font-weight: 700;
}

.settings-radio-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.settings-radio-hint {
    margin-left: auto;
    padding-left: 12px;
    color: #737373;
    font-size: 11px;
    white-space: nowrap;
}

@keyframes settings-sheet-slide-up {
    from {
        transform: translateY(100%);
        opacity: 0.5;
    }
    to {
        transform: translateY(0);
        opacity: 1;
    }
}

@media (max-width: 639px) {
    .video-settings-drawer {
        position: fixed !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        top: auto !important;
        width: 100vw !important;
        min-width: 100vw !important;
        max-width: 100vw !important;
        max-height: 75vh !important;
        border-radius: 20px 20px 0 0 !important;
        border: 1px solid rgba(0, 0, 0, 0.1) !important;
        border-bottom: none !important;
        background: rgba(255, 255, 255, 0.96) !important;
        backdrop-filter: blur(24px) !important;
        -webkit-backdrop-filter: blur(24px) !important;
        padding: 14px 16px max(24px, env(safe-area-inset-bottom, 24px)) 16px !important;
        box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.2) !important;
        animation: settings-sheet-slide-up 220ms cubic-bezier(0.16, 1, 0.3, 1) !important;
        transform: none !important;
    }

    .settings-radio {
        min-height: 42px;
        padding: 10px 14px;
        font-size: 14px;
    }
}
</style>
