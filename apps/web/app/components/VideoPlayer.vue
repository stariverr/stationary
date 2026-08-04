<script setup lang="ts">
import { Airplay, ArrowLeft, ChevronLeft, ChevronRight, Gauge, Loader2, Maximize, Minimize, MoreHorizontal, Pause, PictureInPicture2, Play, Settings, SlidersHorizontal, Subtitles, Volume2, VolumeX, X } from "@lucide/vue";
import type { MediaPlayerElement } from "vidstack/elements";

import "vidstack/player";
import "vidstack/player/ui";
import "vidstack/player/styles/default/theme.css";
import type { MediaPlayback } from "@/types/post";

interface Subtitle {
    url?: string | null;
    language?: string | null;
    label?: string;
    format?: string | null;
}

interface VideoTrackItem {
    id?: string;
    url: string;
    type: string;
    purpose?: string;
    quality?: string;
    codec?: string | null;
    mime_type?: string | null;
    width?: number | null;
    height?: number | null;
}

interface Props {
    src: string;
    poster?: string;
    tracks?: VideoTrackItem[];
    playback?: MediaPlayback | null;
    subtitles?: Subtitle[];
    width?: number | string;
    height?: number | string;
    autoplay?: boolean;
    title?: string;
    showBack?: boolean;
}

interface PlayerProvider {
    library?: unknown;
    config?: unknown;
}

interface PlayerSource {
    id?: string;
    src: string;
    type: string;
    width?: number;
    height?: number;
    bitrate?: number;
    codec?: string;
}

interface ProcessedSubtitle {
    url: string;
    language: string;
    label: string;
    default: boolean;
    isBlob: boolean;
}

type SubtitleFontSize = "small" | "normal" | "large" | "xlarge";
type SubtitleBgStyle = "shadow" | "box";

const props = withDefaults(defineProps<Props>(), {
    src: "",
    poster: "",
    tracks: () => [],
    playback: null,
    subtitles: () => [],
    width: undefined,
    height: undefined,
    autoplay: true,
    title: "",
    showBack: false,
});

const emit = defineEmits(["back"]);

const { t } = useI18n();
const playerRef = ref<MediaPlayerElement | null>(null);
const processedSubtitles = ref<ProcessedSubtitle[]>([]);
const isPlaying = ref(false);
const isBuffering = ref(false);
const isAutoplayAttempting = ref(props.autoplay);
const isMuted = ref(false);
const isFullscreen = ref(false);
const isPictureInPicture = ref(false);
const runtimeQualityCount = ref(0);
const runtimeAudioTrackCount = ref(0);
const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];
let subtitleLoadVersion = 0;

const isSettingsOpen = ref(false);
const activeSettingsTab = ref<"all" | "volume" | "quality" | "speed" | "subtitles" | "audio">("all");
const currentSpeed = ref(1);

const toggleSettings = (tab: "all" | "volume" | "quality" | "speed" | "subtitles" | "audio" = "all") => {
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

const isDash = computed(() => props.playback?.protocol === "DASH" || /\.mpd($|\?)/i.test(props.src) || props.src.includes("manifest.mpd"));

const mediaSource = computed<PlayerSource | PlayerSource[]>(() => {
    if (isDash.value) {
        return {
            src: resolveUrl(props.playback?.url || props.src),
            type: "application/dash+xml",
        };
    }

    const playbackVariants = props.playback?.protocol === "PROGRESSIVE" ? props.playback.variants : [];
    const variants = playbackVariants
        .filter((variant) => Boolean(variant.url))
        .map((variant) => ({
            id: variant.track_id,
            src: resolveUrl(variant.url),
            type: variant.mime_type || "video/mp4",
            width: variant.width ?? undefined,
            height: variant.height ?? undefined,
            bitrate: variant.bandwidth ?? undefined,
            codec: variant.codec ?? undefined,
        }));
    if (variants.length > 0) return variants;

    const trackSources = props.tracks
        .filter((track) => track.type.toUpperCase() === "VIDEO" && track.purpose?.toUpperCase() !== "COVER" && track.url)
        .map((track) => ({
            id: track.id,
            src: resolveUrl(track.url),
            type: track.mime_type || "video/mp4",
            width: track.width ?? undefined,
            height: track.height ?? undefined,
            codec: track.codec ?? undefined,
        }));
    if (trackSources.length > 0) return trackSources;

    return {
        src: resolveUrl(props.src),
        type: props.playback?.mime_type || "video/mp4",
    };
});

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

const canonicalSubtitles = computed<Subtitle[]>(() => {
    if (props.subtitles && props.subtitles.length > 0) return props.subtitles;

    const playbackSubs = (props.playback?.subtitle_tracks || [])
        .filter((track) => track.selectable && Boolean(track.url))
        .map((track) => ({
            url: track.url!,
            language: track.language || "und",
            label: formatLanguageLabel(track.language, track.label),
            format: track.format || "vtt",
        }));
    if (playbackSubs.length > 0) return playbackSubs;

    return (props.tracks || [])
        .filter((track) => track.type?.toUpperCase() === "SUBTITLE" && Boolean(track.url))
        .map((track) => ({
            url: track.url!,
            language: (track as any).metadata?.language || track.purpose || "und",
            label: formatLanguageLabel(
                (track as any).metadata?.language || track.purpose,
                (track as any).display_name || (track as any).metadata?.label || (track as any).metadata?.language || track.purpose,
            ),
            format: (track as any).metadata?.format === "json" ? "vtt" : (track as any).metadata?.format || "vtt",
        }));
});

const revokeProcessedSubtitles = (subtitles = processedSubtitles.value) => {
    for (const subtitle of subtitles) {
        if (subtitle.isBlob) URL.revokeObjectURL(subtitle.url);
    }
};

const isSrtSubtitle = (subtitle: Subtitle) =>
    Boolean((subtitle.format && subtitle.format.toLowerCase() === "srt") || (subtitle.url && /\.srt($|\?)/i.test(subtitle.url)));

const loadSubtitles = async (subtitles: Subtitle[]) => {
    const loadVersion = ++subtitleLoadVersion;
    const previous = processedSubtitles.value;
    processedSubtitles.value = [];
    if (import.meta.client) revokeProcessedSubtitles(previous);

    const validSubtitles = subtitles.filter((sub): sub is Subtitle & { url: string } => Boolean(sub.url));

    const loaded = await Promise.all(
        validSubtitles.map(async (subtitle): Promise<ProcessedSubtitle> => {
            const displayLabel = formatLanguageLabel(subtitle.language, subtitle.label);
            const fallback = {
                url: resolveUrl(subtitle.url),
                language: subtitle.language || "und",
                label: displayLabel,
                default: subtitle.language === "zh-CN" || subtitle.language === "zh",
                isBlob: false,
            };
            if (!import.meta.client || !isSrtSubtitle(subtitle)) return fallback;

            try {
                const response = await fetch(fallback.url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const text = await response.text();
                const webVtt = `WEBVTT\n\n${text.replace(/(\d+:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
                return {
                    ...fallback,
                    url: URL.createObjectURL(new Blob([webVtt], { type: "text/vtt" })),
                    isBlob: true,
                };
            } catch (error) {
                console.error("Failed to convert SRT subtitle:", error);
                return fallback;
            }
        }),
    );

    if (loadVersion !== subtitleLoadVersion) {
        if (import.meta.client) revokeProcessedSubtitles(loaded);
        return;
    }
    processedSubtitles.value = loaded;
};

watch(canonicalSubtitles, (subtitles) => loadSubtitles(subtitles), { deep: true, immediate: true });

const loadDashLibrary = async () => {
    const { MediaPlayer } = await import("dashjs");
    return { default: MediaPlayer };
};

const handleProviderChange = (event: Event) => {
    runtimeQualityCount.value = 0;
    runtimeAudioTrackCount.value = 0;
    const provider = (event as CustomEvent<PlayerProvider | null>).detail;
    if (!provider || !isDash.value) return;
    provider.library = loadDashLibrary;
    provider.config = {
        debug: { logLevel: 2 },
        streaming: { cmcd: { enabled: false } },
    };
};

const activeQualityLabel = ref<string>("");

const handleQualitiesChange = (event: Event) => {
    runtimeQualityCount.value = (event as CustomEvent<unknown[]>).detail?.length || 0;
};

const handleQualityChange = (event: Event) => {
    const detail = (event as CustomEvent<{ height?: number; label?: string; autoSelected?: boolean } | null>).detail;
    if (!detail) {
        activeQualityLabel.value = t("post_detail.viewer.player.auto_quality");
    } else if (detail.autoSelected && detail.height) {
        activeQualityLabel.value = `${t("post_detail.viewer.player.auto_quality")} ${detail.height}P`;
    } else if (detail.height) {
        activeQualityLabel.value = `${detail.height}P`;
    } else if (detail.label) {
        activeQualityLabel.value = detail.label;
    } else {
        activeQualityLabel.value = t("post_detail.viewer.player.auto_quality");
    }
};

const displayQualityLabel = computed(() => {
    if (activeQualityLabel.value) return activeQualityLabel.value;
    return t("post_detail.viewer.player.quality");
});

const handleAudioTracksChange = (event: Event) => {
    const detail = (event as CustomEvent<Array<{ id?: string; label?: string; language?: string; selected?: boolean }>>).detail || [];
    runtimeAudioTrackCount.value = detail.length;

    let selectedCount = 0;
    detail.forEach((track, index) => {
        if (!track.id || detail.filter((t) => t.id === track.id).length > 1) {
            track.id = `audio-track-${index}`;
        }
        const langName = track.language ? formatLanguageLabel(track.language) : "";
        if (!track.label || track.label === "Audio" || detail.filter((t) => t.label === track.label).length > 1) {
            track.label = langName
                ? `${t("post_detail.viewer.player.audio_tracks")} ${index + 1} (${langName})`
                : `${t("post_detail.viewer.player.audio_tracks")} ${index + 1}`;
        }
        if (track.selected) {
            if (selectedCount > 0) {
                track.selected = false;
            }
            selectedCount++;
        }
    });
};

const qualityAvailable = computed(() => Boolean(props.playback?.capabilities.quality_switching) && runtimeQualityCount.value > 1);
const audioAvailable = computed(
    () =>
        Boolean(props.playback?.capabilities.protocol_supports_switching && props.playback.capabilities.audio_switching) &&
        runtimeAudioTrackCount.value > 1,
);

const handleSourceChange = () => {
    isPlaying.value = false;
    isBuffering.value = false;
};

const volumeLevel = ref(100);

const handleVolumeChange = (event: Event) => {
    const detail = (event as CustomEvent<{ muted?: boolean; volume?: number }>).detail;
    isMuted.value = Boolean(detail?.muted || detail?.volume === 0);
    if (typeof detail?.volume === "number") {
        volumeLevel.value = Math.round(detail.volume * 100);
    }
};

const setPlayerVolume = (val: number) => {
    volumeLevel.value = val;
    if (playerRef.value) {
        playerRef.value.volume = val / 100;
        if (val > 0 && isMuted.value) {
            playerRef.value.muted = false;
        }
    }
};

const toggleMute = () => {
    if (playerRef.value) {
        playerRef.value.muted = !playerRef.value.muted;
    }
};

watch(
    () => props.autoplay,
    (newAutoplay) => {
        isAutoplayAttempting.value = newAutoplay;
        if (!playerRef.value) return;
        if (newAutoplay) {
            playerRef.value.play().catch(() => {});
        } else {
            playerRef.value.pause().catch(() => {});
        }
    },
);

onBeforeUnmount(() => {
    subtitleLoadVersion += 1;
    if (import.meta.client) revokeProcessedSubtitles();
});
</script>

<template>
    <div class="video-player-root relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-black">
        <ClientOnly>
            <media-player
                ref="playerRef"
                class="vidstack-player-core h-full w-full"
                :src="mediaSource"
                :poster="props.poster || undefined"
                :autoplay="props.autoplay"
                playsinline
                key-target="player"
                aria-label="Video player"
                @provider-change="handleProviderChange"
                @source-change="handleSourceChange"
                @qualities-change="handleQualitiesChange"
                @quality-change="handleQualityChange"
                @audio-tracks-change="handleAudioTracksChange"
                @play="
                    isPlaying = true;
                    isAutoplayAttempting = false;
                "
                @pause="
                    isPlaying = false;
                    isAutoplayAttempting = false;
                "
                @waiting="isBuffering = true"
                @playing="
                    isBuffering = false;
                    isPlaying = true;
                    isAutoplayAttempting = false;
                "
                @can-play="isBuffering = false"
                @volume-change="handleVolumeChange"
                @fullscreen-change="isFullscreen = Boolean(($event as CustomEvent<boolean>).detail)"
                @picture-in-picture-change="isPictureInPicture = Boolean(($event as CustomEvent<boolean>).detail)"
            >
                <media-provider>
                    <track
                        v-for="subtitle in processedSubtitles"
                        :key="`${subtitle.language}:${subtitle.url}`"
                        kind="subtitles"
                        :label="subtitle.label"
                        :srclang="subtitle.language"
                        :src="subtitle.url"
                        :default="subtitle.default"
                    />
                </media-provider>

                <media-poster
                    v-if="props.poster"
                    class="vds-poster absolute inset-0 h-full w-full object-contain"
                    :src="props.poster"
                    alt=""
                />

                <media-gesture
                    class="gesture-layer absolute top-0 bottom-[72px] z-10 left-[25%] right-[25%]"
                    event="pointerup"
                    action="toggle:paused"
                />
                <media-gesture
                    class="gesture-layer absolute top-0 bottom-[72px] z-10 left-0 w-1/4"
                    event="dblpointerup"
                    action="seek:-10"
                />
                <media-gesture
                    class="gesture-layer absolute top-0 bottom-[72px] z-10 right-0 w-1/4"
                    event="dblpointerup"
                    action="seek:10"
                />

                <media-play-button
                    v-if="!isPlaying && !isBuffering"
                    class="center-play-button absolute top-1/2 left-1/2 z-25 grid h-15 w-15 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full border border-white/20 bg-[rgba(15,15,18,0.72)] text-white shadow-2xl backdrop-blur-md transition-all duration-200 hover:scale-108 hover:border-white/35 hover:bg-[rgba(15,15,18,0.86)] hover:shadow-[0_0_28px_rgba(56,189,248,0.25)]"
                    :aria-label="$t('post_detail.viewer.player.play')"
                >
                    <Play class="h-7 w-7 translate-x-0.5 fill-current" />
                </media-play-button>

                <div
                    v-if="isBuffering || (isAutoplayAttempting && !isPlaying)"
                    class="buffering-indicator pointer-events-none absolute top-1/2 left-1/2 z-25 grid h-15 w-15 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-[rgba(15,15,18,0.72)] text-white shadow-2xl backdrop-blur-md"
                    aria-hidden="true"
                >
                    <Loader2 class="h-7 w-7 animate-spin" />
                </div>

                <media-controls
                    class="player-controls absolute inset-0 z-30 flex flex-col justify-between box-border pointer-events-none opacity-0 transition-opacity duration-220 bg-gradient-to-t from-black/80 via-transparent to-black/60 px-3 sm:px-4 pb-[max(10px,env(safe-area-inset-bottom,10px))] pt-3 sm:pt-3.5 data-[visible]:opacity-100 data-[active]:opacity-100"
                    hide-delay="2500"
                >
                    <!-- TOP BAR: Clean & Minimal (Back button + Video Title + Cast/Airplay) -->
                    <media-controls-group class="top-row pointer-events-auto flex w-full items-center justify-between gap-3 px-1">
                        <div class="top-left-cluster flex items-center gap-2 min-w-0">
                            <button
                                v-if="props.showBack"
                                type="button"
                                class="control-button grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 hover:bg-white/15 hover:text-white transition-all duration-140"
                                @click="emit('back')"
                            >
                                <ArrowLeft class="h-4.5 w-4.5" />
                            </button>
                            <span v-if="props.title" class="video-title truncate text-xs sm:text-sm font-medium text-white/95 drop-shadow">
                                {{ props.title }}
                            </span>
                        </div>

                        <div class="top-right-cluster flex items-center gap-1 shrink-0">
                            <!-- Picture in Picture (PIP) Button -->
                            <media-pip-button
                                class="control-button relative grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 hover:bg-white/15 hover:text-white transition-all duration-140"
                                :aria-label="$t('post_detail.viewer.player.pip')"
                            >
                                <PictureInPicture2 class="h-4 w-4" />
                            </media-pip-button>

                            <!-- Cast / Airplay Icon -->
                            <button
                                type="button"
                                class="control-button grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 hover:bg-white/15 hover:text-white transition-all duration-140"
                                :aria-label="$t('post_detail.viewer.player.cast')"
                            >
                                <Airplay class="h-4 w-4" />
                            </button>

                            <!-- More Button (...) in Top Right -->
                            <button
                                type="button"
                                class="control-button grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 hover:bg-white/15 hover:text-white transition-all duration-140"
                                :class="{ 'bg-white/20 text-white': isSettingsOpen && activeSettingsTab === 'all' }"
                                :aria-label="$t('common.more')"
                                @click.stop="toggleSettings('all')"
                            >
                                <MoreHorizontal class="h-4.5 w-4.5" />
                            </button>
                        </div>
                    </media-controls-group>

                    <!-- Transparent Backdrop for Click-Outside to Close Drawer -->
                    <div
                        v-if="isSettingsOpen"
                        class="settings-backdrop pointer-events-auto fixed inset-0 sm:absolute sm:inset-0 z-40 bg-black/10 max-sm:bg-black/35 backdrop-blur-[1px] sm:backdrop-blur-none cursor-default transition-opacity duration-150"
                        @click.stop="closeSettings"
                    />

                    <!-- Vue-driven Settings Drawer / Bottom Sheet (Light Glass Theme) -->
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
                            class="video-settings-drawer settings-panel pointer-events-auto absolute z-50 overflow-hidden shadow-2xl backdrop-blur-2xl bg-white/95 text-neutral-900 border border-neutral-200/90 text-xs"
                            :class="[
                                'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:rounded-t-2xl max-sm:max-h-[75vh]',
                                'sm:absolute sm:top-12 sm:right-4 sm:w-68 sm:rounded-xl sm:max-h-[360px]'
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
                                    <span>
                                        {{
                                            activeSettingsTab === 'volume' ? ($t('post_detail.viewer.player.volume') || '音量') :
                                            activeSettingsTab === 'quality' ? $t('post_detail.viewer.player.quality') :
                                            activeSettingsTab === 'speed' ? $t('post_detail.viewer.player.speed') :
                                            activeSettingsTab === 'subtitles' ? $t('post_detail.viewer.player.subtitles') :
                                            activeSettingsTab === 'audio' ? $t('media.tracks.group_audios') :
                                            ($t('common.more') || '更多')
                                        }}
                                    </span>
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
                                <!-- Main Menu (All Settings Level) -->
                                <div v-if="activeSettingsTab === 'all'" class="space-y-1.5">
                                    <!-- Volume Row (Matching 100% with other rows) -->
                                    <button
                                        type="button"
                                        class="flex w-full items-center justify-between rounded-xl bg-neutral-100/80 px-3.5 py-2.5 text-xs font-medium text-neutral-800 transition-all hover:bg-neutral-200/80 hover:text-neutral-900"
                                        @click.stop="activeSettingsTab = 'volume'"
                                    >
                                        <span class="flex items-center gap-2">
                                            <Volume2 v-if="!isMuted && volumeLevel > 0" class="h-4 w-4 text-neutral-500" />
                                            <VolumeX v-else class="h-4 w-4 text-neutral-500" />
                                            <span>{{ $t("post_detail.viewer.player.volume") || "音量" }}</span>
                                        </span>
                                        <span class="flex items-center gap-1 text-neutral-500 font-semibold text-xs">
                                            <span>{{ isMuted ? '0%' : `${volumeLevel}%` }}</span>
                                            <ChevronRight class="h-4 w-4" />
                                        </span>
                                    </button>

                                    <!-- Quality Row -->
                                    <button
                                        v-if="qualityAvailable"
                                        type="button"
                                        class="flex w-full items-center justify-between rounded-xl bg-neutral-100/80 px-3.5 py-2.5 text-xs font-medium text-neutral-800 transition-all hover:bg-neutral-200/80 hover:text-neutral-900"
                                        @click.stop="activeSettingsTab = 'quality'"
                                    >
                                        <span class="flex items-center gap-2">
                                            <SlidersHorizontal class="h-4 w-4 text-neutral-500" />
                                            <span>{{ $t("post_detail.viewer.player.quality") }}</span>
                                        </span>
                                        <span class="flex items-center gap-1 text-neutral-500 font-semibold text-xs">
                                            <span>{{ displayQualityLabel }}</span>
                                            <ChevronRight class="h-4 w-4" />
                                        </span>
                                    </button>

                                    <!-- Speed Row -->
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
                                            <span>{{ currentSpeed === 1 ? '1.0x' : `${currentSpeed}x` }}</span>
                                            <ChevronRight class="h-4 w-4" />
                                        </span>
                                    </button>

                                    <!-- Subtitles Row -->
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

                                    <!-- Audio Track Row (if multi-audio) -->
                                    <button
                                        v-if="audioAvailable"
                                        type="button"
                                        class="flex w-full items-center justify-between rounded-xl bg-neutral-100/80 px-3.5 py-2.5 text-xs font-medium text-neutral-800 transition-all hover:bg-neutral-200/80 hover:text-neutral-900"
                                        @click.stop="activeSettingsTab = 'audio'"
                                    >
                                        <span class="flex items-center gap-2">
                                            <Volume2 class="h-4 w-4 text-neutral-500" />
                                            <span>{{ $t("media.tracks.group_audios") }}</span>
                                        </span>
                                        <span class="flex items-center gap-1 text-neutral-500 font-semibold text-xs">
                                            <ChevronRight class="h-4 w-4" />
                                        </span>
                                    </button>
                                </div>

                                <!-- Sub-Pages (when specific tab is selected) -->
                                <template v-else>
                                    <!-- Volume Sub-Page -->
                                    <section v-if="activeSettingsTab === 'volume'" class="settings-section space-y-3">
                                        <div class="rounded-xl border border-neutral-200/80 bg-neutral-100/70 p-3 space-y-2.5">
                                            <div class="flex items-center justify-between text-xs font-semibold text-neutral-800 px-0.5">
                                                <span class="flex items-center gap-1.5 text-neutral-700">
                                                    <Volume2 v-if="!isMuted && volumeLevel > 0" class="h-4 w-4 text-neutral-600" />
                                                    <VolumeX v-else class="h-4 w-4 text-neutral-400" />
                                                    <span>{{ $t("post_detail.viewer.player.volume") || "音量" }}</span>
                                                </span>
                                                <span class="font-mono text-xs font-bold text-neutral-600 tabular-nums">
                                                    {{ isMuted ? '0%' : `${volumeLevel}%` }}
                                                </span>
                                            </div>

                                            <div class="flex items-center gap-2.5 px-0.5">
                                                <button
                                                    type="button"
                                                    class="control-button grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-lg text-neutral-700 hover:bg-neutral-200/90 transition-colors"
                                                    :aria-label="isMuted ? ($t('post_detail.viewer.player.unmute') || '取消静音') : ($t('post_detail.viewer.player.mute') || '静音')"
                                                    @click.stop="toggleMute"
                                                >
                                                    <VolumeX v-if="isMuted || volumeLevel === 0" class="h-4 w-4 text-neutral-400" />
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
                                                class="settings-chip flex-1 min-w-[48px] cursor-pointer rounded-lg border border-neutral-200 bg-neutral-100/80 px-2 py-1.5 text-center text-[11px] font-medium text-neutral-700 transition-all hover:border-neutral-300 hover:bg-neutral-200/80 hover:text-neutral-900"
                                                :class="{ 'border-neutral-800 bg-neutral-900 text-white font-semibold shadow-xs': isMuted || volumeLevel === 0 }"
                                                @click.stop="setPlayerVolume(0)"
                                            >
                                                {{ $t("post_detail.viewer.player.mute") || "静音" }}
                                            </button>
                                            <button
                                                v-for="v in [25, 50, 75, 100]"
                                                :key="v"
                                                type="button"
                                                class="settings-chip flex-1 min-w-[48px] cursor-pointer rounded-lg border border-neutral-200 bg-neutral-100/80 px-2 py-1.5 text-center text-[11px] font-medium text-neutral-700 transition-all hover:border-neutral-300 hover:bg-neutral-200/80 hover:text-neutral-900"
                                                :class="{ 'border-neutral-800 bg-neutral-900 text-white font-semibold shadow-xs': !isMuted && volumeLevel === v }"
                                                @click.stop="setPlayerVolume(v)"
                                            >
                                                {{ v }}%
                                            </button>
                                        </div>
                                    </section>
                                    <section v-if="qualityAvailable && activeSettingsTab === 'quality'" class="settings-section">
                                        <media-quality-radio-group :auto-label="$t('post_detail.viewer.player.auto_quality')">
                                            <template>
                                                <media-radio>
                                                    <span class="settings-radio-label" data-part="label"></span>
                                                    <span class="settings-radio-hint" data-part="bitrate"></span>
                                                </media-radio>
                                            </template>
                                        </media-quality-radio-group>
                                    </section>

                                    <section v-if="audioAvailable && activeSettingsTab === 'audio'" class="settings-section">
                                        <media-audio-radio-group :empty-label="$t('post_detail.viewer.player.default_audio')">
                                            <template>
                                                <media-radio>
                                                    <span class="settings-radio-label" data-part="label"></span>
                                                </media-radio>
                                            </template>
                                        </media-audio-radio-group>
                                    </section>

                                    <section v-if="activeSettingsTab === 'subtitles'" class="settings-section">
                                        <template v-if="processedSubtitles.length > 0">
                                            <media-captions-radio-group :off-label="$t('post_detail.viewer.player.subtitles_off')">
                                                <template>
                                                    <media-radio>
                                                        <span class="settings-radio-label" data-part="label"></span>
                                                    </media-radio>
                                                </template>
                                            </media-captions-radio-group>

                                            <div class="settings-subgroup mt-3 pt-2 border-t border-neutral-200/80">
                                                <div class="settings-subheading px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                                                    {{ $t("post_detail.viewer.player.subtitle_size") }}
                                                </div>
                                                <div class="settings-chip-group flex flex-wrap gap-1">
                                                    <button
                                                        v-for="opt in subtitleSizeOptions"
                                                        :key="opt.value"
                                                        type="button"
                                                        class="settings-chip flex-1 min-w-[52px] cursor-pointer rounded-lg border border-neutral-200 bg-neutral-100/80 px-2 py-1.5 text-center text-[11px] font-medium text-neutral-700 transition-all duration-120 hover:border-neutral-300 hover:bg-neutral-200/80 hover:text-neutral-900"
                                                        :class="{ 'border-neutral-800 bg-neutral-900 text-white font-semibold shadow-xs': subtitleFontSize === opt.value }"
                                                        @click.stop="subtitleFontSize = opt.value"
                                                    >
                                                        {{ opt.label }}
                                                    </button>
                                                </div>
                                            </div>

                                            <div class="settings-subgroup mt-2.5">
                                                <div class="settings-subheading px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                                                    {{ $t("post_detail.viewer.player.subtitle_bg") }}
                                                </div>
                                                <div class="settings-chip-group flex flex-wrap gap-1">
                                                    <button
                                                        v-for="opt in subtitleBgOptions"
                                                        :key="opt.value"
                                                        type="button"
                                                        class="settings-chip flex-1 min-w-[52px] cursor-pointer rounded-lg border border-neutral-200 bg-neutral-100/80 px-2 py-1.5 text-center text-[11px] font-medium text-neutral-700 transition-all duration-120 hover:border-neutral-300 hover:bg-neutral-200/80 hover:text-neutral-900"
                                                        :class="{ 'border-neutral-800 bg-neutral-900 text-white font-semibold shadow-xs': subtitleBgStyle === opt.value }"
                                                        @click.stop="subtitleBgStyle = opt.value"
                                                    >
                                                        {{ opt.label }}
                                                    </button>
                                                </div>
                                            </div>
                                        </template>
                                        <template v-else>
                                            <div class="settings-empty-notice rounded-lg bg-neutral-100 p-3 text-center text-xs text-neutral-400">
                                                {{ $t("post_detail.viewer.player.no_subtitles") }}
                                            </div>
                                        </template>
                                    </section>

                                    <section v-if="activeSettingsTab === 'speed'" class="settings-section">
                                        <media-speed-radio-group
                                            :rates="speedOptions"
                                            :normal-label="$t('post_detail.viewer.player.normal_speed')"
                                            @rate-change="currentSpeed = ($event as CustomEvent<number>).detail || 1"
                                        >
                                            <template>
                                                <media-radio>
                                                    <span class="settings-radio-label" data-part="label"></span>
                                                </media-radio>
                                            </template>
                                        </media-speed-radio-group>
                                    </section>
                                </template>
                            </div>
                        </div>
                    </Transition>

                    <!-- Bottom Controls Container (Scrubber + Buttons Row) -->
                    <div class="bottom-controls-cluster pointer-events-auto flex w-full flex-col gap-1">
                        <!-- Video Progress Bar Scrubber -->
                        <media-time-slider class="vds-time-slider group relative flex h-5 w-full cursor-pointer items-center touch-none select-none box-border px-0.5">
                            <div class="vds-slider-track" />
                            <div class="vds-slider-track-fill vds-slider-track" />
                            <div class="vds-slider-thumb" />
                        </media-time-slider>

                        <!-- Player Core Controls Layer -->
                        <media-controls-group class="control-row flex w-full items-center justify-between gap-1 sm:gap-3">
                            <div class="control-cluster flex items-center gap-0.5 sm:gap-1.5 min-w-0">
                                <media-play-button
                                    class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white"
                                    :aria-label="isPlaying ? $t('post_detail.viewer.player.pause') : $t('post_detail.viewer.player.play')"
                                >
                                    <Pause v-if="isPlaying" class="h-4.5 w-4.5 fill-current" />
                                    <Play v-else class="h-4.5 w-4.5 translate-x-px fill-current" />
                                </media-play-button>

                                <div class="time-display flex min-w-0 items-center gap-1 ml-1.5 sm:ml-2.5 text-xs sm:text-sm font-semibold text-white/95 tabular-nums drop-shadow-xs">
                                    <media-time type="current" />
                                    <span aria-hidden="true" class="opacity-70">/</span>
                                    <media-time type="duration" />
                                </div>
                            </div>

                            <div class="control-cluster flex items-center gap-0.5 sm:gap-1.5 shrink-0">
                                <!-- Subtitles CC Button -->
                                <button
                                    v-if="processedSubtitles.length > 0"
                                    type="button"
                                    class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white"
                                    :class="{ 'bg-white/20 text-white': isSettingsOpen && activeSettingsTab === 'subtitles' }"
                                    :aria-label="$t('post_detail.viewer.player.subtitles')"
                                    @click.stop="toggleSettings('subtitles')"
                                >
                                    <Subtitles class="h-4 w-4" />
                                </button>

                                <!-- Dynamic Quality Badge (Desktop / Wide Mode) -->
                                <button
                                    v-if="qualityAvailable"
                                    type="button"
                                    class="control-button relative hidden sm:flex h-8 px-2 shrink-0 cursor-pointer items-center justify-center rounded-lg text-xs font-semibold text-white/90 transition-all duration-140 hover:bg-white/15 hover:text-white"
                                    :class="{ 'bg-white/20 text-white font-bold': isSettingsOpen && activeSettingsTab === 'quality' }"
                                    :aria-label="$t('post_detail.viewer.player.quality')"
                                    @click.stop="toggleSettings('quality')"
                                >
                                    <span>{{ displayQualityLabel }}</span>
                                </button>

                                <!-- Speed Quick Button (Desktop / Wide Mode) -->
                                <button
                                    type="button"
                                    class="control-button relative hidden sm:flex h-8 px-2 shrink-0 cursor-pointer items-center justify-center rounded-lg text-xs font-semibold text-white/90 transition-all duration-140 hover:bg-white/15 hover:text-white"
                                    :class="{ 'bg-white/20 text-white font-bold': isSettingsOpen && activeSettingsTab === 'speed' }"
                                    :aria-label="$t('post_detail.viewer.player.speed')"
                                    @click.stop="toggleSettings('speed')"
                                >
                                    <span>{{ currentSpeed === 1 ? '1.0x' : `${currentSpeed}x` }}</span>
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

                <media-captions
                    class="vds-captions absolute inset-x-[6%] bottom-6 z-20 pointer-events-none text-center transition-[bottom] duration-220"
                    :class="[`sub-size-${subtitleFontSize}`, `sub-bg-${subtitleBgStyle}`]"
                />
            </media-player>

            <template #fallback>
                <div class="video-player-fallback relative grid h-full w-full min-h-[200px] overflow-hidden place-items-center bg-black">
                    <img v-if="props.poster" class="absolute inset-0 h-full w-full object-contain opacity-45" :src="props.poster" alt="" />
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
:deep(media-player),
:deep([data-media-player]) {
    /* Override Vidstack base font scaling inside player components */
    --media-font-size: 13px !important;
    aspect-ratio: unset !important;
    width: 100% !important;
    height: 100% !important;
}

:deep(media-provider),
:deep([data-media-provider]) {
    width: 100% !important;
    height: 100% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
}

:deep(media-provider video),
:deep(media-provider img),
:deep([data-media-provider] video) {
    width: 100% !important;
    height: 100% !important;
    object-fit: contain !important;
}

:deep(media-controls[data-visible]) ~ .vds-captions,
:deep(media-controls[data-active]) ~ .vds-captions {
    bottom: 84px;
}

:deep(.vds-captions [data-part="cue"]) {
    display: inline-block;
    max-width: 90%;
    margin: 0 auto;
    font-weight: 500;
    line-height: 1.4;
    transition: all 150ms ease;
}

:deep(.vds-captions.sub-size-small [data-part="cue"]) {
    font-size: clamp(12px, 1.4vw, 15px);
}
:deep(.vds-captions.sub-size-normal [data-part="cue"]) {
    font-size: clamp(14px, 1.8vw, 18px);
}
:deep(.vds-captions.sub-size-large [data-part="cue"]) {
    font-size: clamp(17px, 2.3vw, 22px);
}
:deep(.vds-captions.sub-size-xlarge [data-part="cue"]) {
    font-size: clamp(20px, 2.8vw, 28px);
}

:deep(.vds-captions.sub-bg-box [data-part="cue"]) {
    padding: 4px 12px;
    border-radius: 8px;
    background: rgba(10, 10, 14, 0.78);
    color: #ffffff;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(8px);
}

:deep(.vds-captions.sub-bg-shadow [data-part="cue"]) {
    padding: 2px 6px;
    background: transparent;
    color: #ffffff;
    text-shadow:
        0 2px 8px rgba(0, 0, 0, 0.95),
        0 0 2px rgba(0, 0, 0, 0.9);
}

:deep(media-player[data-fullscreen] .player-controls),
:deep(media-player[fullscreen] .player-controls),
:deep([data-fullscreen] .player-controls),
:deep(:fullscreen .player-controls) {
    padding-top: 36px !important;
    padding-right: max(20px, env(safe-area-inset-right, 20px)) !important;
    padding-bottom: max(18px, env(safe-area-inset-bottom, 18px)) !important;
    padding-left: max(20px, env(safe-area-inset-left, 20px)) !important;
}

:global(media-player[data-fullscreen] .settings-panel),
:global([data-fullscreen] .settings-panel),
:global(.settings-panel[data-fullscreen]) {
    bottom: 48px !important;
    max-height: min(460px, 72vh) !important;
}

:deep(media-player[data-fullscreen] .vds-captions),
:deep([data-fullscreen] .vds-captions) {
    bottom: 24px !important;
}

:deep(media-player[data-fullscreen] media-controls[data-visible] ~ .vds-captions),
:deep(media-player[data-fullscreen] media-controls[data-active] ~ .vds-captions),
:deep([data-fullscreen] media-controls[data-visible] ~ .vds-captions),
:deep([data-fullscreen] media-controls[data-active] ~ .vds-captions) {
    bottom: 78px !important;
}

.vds-time-slider,
.vds-volume-slider {
    --slider-fill: #fff;
    --slider-progress: rgba(255, 255, 255, 0.35);
    --slider-track: rgba(255, 255, 255, 0.22);
}

.vds-volume-slider .vds-slider-track {
    right: 6px;
    left: 6px;
}

.vds-slider-track {
    position: absolute;
    right: 0;
    left: 0;
    height: 3px;
    border-radius: 999px;
    background: var(--slider-track);
    transition: height 140ms ease;
}

.vds-time-slider:hover .vds-slider-track,
.vds-time-slider[data-dragging] .vds-slider-track {
    height: 5px;
}

.vds-slider-progress {
    width: var(--slider-progress, 0%);
    background: rgba(255, 255, 255, 0.35);
}

.vds-slider-track-fill {
    width: var(--slider-fill, 0%);
    background: #ffffff;
}

.vds-slider-thumb {
    position: absolute;
    top: 50%;
    left: var(--slider-fill, 0%);
    width: 12px;
    height: 12px;
    transform: translate(-50%, -50%) scale(0);
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    transition:
        transform 140ms ease,
        scale 140ms ease;
}

.vds-time-slider:hover .vds-slider-thumb,
.vds-time-slider[data-dragging] .vds-slider-thumb,
.vds-volume-slider:hover .vds-slider-thumb {
    transform: translate(-50%, -50%) scale(1);
}

:global(.settings-panel::-webkit-scrollbar) {
    width: 4px;
}
:global(.settings-panel::-webkit-scrollbar-track) {
    background: transparent;
}
:global(.settings-panel::-webkit-scrollbar-thumb) {
    background: rgba(255, 255, 255, 0.18);
    border-radius: 999px;
}

:global(.settings-panel),
:global(.video-settings-drawer) {
    --media-font-size: 13px !important;
    --media-menu-font-size: 13px !important;
    width: 240px !important;
    min-width: 220px !important;
    max-width: calc(100vw - 24px) !important;
    max-height: min(320px, 55vh) !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    scrollbar-gutter: stable;
    overscroll-behavior: contain !important;
    pointer-events: auto !important;
    touch-action: pan-y !important;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box !important;
    background: rgba(255, 255, 255, 0.95) !important;
    color: #171717 !important;
}

:global(.settings-panel media-quality-radio-group),
:global(.settings-panel media-audio-radio-group),
:global(.settings-panel media-captions-radio-group),
:global(.settings-panel media-speed-radio-group),
:global(.video-settings-drawer media-quality-radio-group),
:global(.video-settings-drawer media-audio-radio-group),
:global(.video-settings-drawer media-captions-radio-group),
:global(.video-settings-drawer media-speed-radio-group) {
    display: flex !important;
    flex-direction: column !important;
    width: 100% !important;
    gap: 4px !important;
}

:global(.settings-panel media-radio),
:global(.video-settings-drawer media-radio) {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: space-between !important;
    width: 100% !important;
    min-height: 38px !important;
    padding: 8px 12px !important;
    border-radius: 10px !important;
    background: rgba(0, 0, 0, 0.04) !important;
    color: #262626 !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    cursor: pointer !important;
    box-sizing: border-box !important;
    transition: all 120ms ease !important;
}

:global(.settings-panel media-radio:hover),
:global(.video-settings-drawer media-radio:hover) {
    background: rgba(0, 0, 0, 0.08) !important;
    color: #000000 !important;
}

:deep(media-fullscreen-button[data-active]),
:deep(media-fullscreen-button[data-fullscreen]),
:deep(media-play-button[data-active]),
:deep(media-mute-button[data-active]),
:deep(media-pip-button[data-active]),
:deep(media-caption-button[data-active]),
:deep(.control-button[data-active]) {
    background-color: transparent !important;
    background: transparent !important;
    color: rgba(255, 255, 255, 0.9) !important;
}

:deep(media-fullscreen-button:hover),
:deep(media-play-button:hover),
:deep(media-mute-button:hover),
:deep(media-pip-button:hover),
:deep(media-caption-button:hover),
:deep(.control-button:hover) {
    background-color: rgba(255, 255, 255, 0.15) !important;
    background: rgba(255, 255, 255, 0.15) !important;
    color: #ffffff !important;
}

:global(.settings-panel media-radio[data-checked]),
:global(.video-settings-drawer media-radio[data-checked]) {
    background: rgba(0, 0, 0, 0.08) !important;
    border: 1px solid rgba(0, 0, 0, 0.25) !important;
    color: #000000 !important;
    font-weight: 700 !important;
}

:global(.settings-panel media-radio[data-checked]::after),
:global(.video-settings-drawer media-radio[data-checked]::after) {
    content: "✓" !important;
    margin-left: auto !important;
    color: #000000 !important;
    font-size: 14px !important;
    font-weight: 700 !important;
}

:global(.settings-radio-label) {
    min-width: 0 !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
    font-size: 13px !important;
}

:global(.settings-radio-hint) {
    margin-left: 12px !important;
    color: #737373 !important;
    font-size: 11px !important;
    white-space: nowrap !important;
}

:global(.settings-radio-hint:empty) {
    display: none !important;
}

@keyframes vds-sheet-slide-up {
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
    :global(.settings-panel.video-settings-drawer),
    :global(.video-settings-drawer) {
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
        animation: vds-sheet-slide-up 220ms cubic-bezier(0.16, 1, 0.3, 1) !important;
        transform: none !important;
    }

    :global(.settings-panel media-radio),
    :global(.video-settings-drawer media-radio) {
        min-height: 42px !important;
        padding: 10px 14px !important;
        font-size: 14px !important;
    }
}
</style>
