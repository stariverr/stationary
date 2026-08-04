<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Loader2, Maximize, Minimize, Pause, PictureInPicture2, Play, Settings, Subtitles, Volume2, VolumeX } from "@lucide/vue";
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
});

const { t } = useI18n();
const playerRef = ref<MediaPlayerElement | null>(null);
const processedSubtitles = ref<ProcessedSubtitle[]>([]);
const isPlaying = ref(false);
const isBuffering = ref(false);
const isMuted = ref(false);
const isFullscreen = ref(false);
const isPictureInPicture = ref(false);
const runtimeQualityCount = ref(0);
const runtimeAudioTrackCount = ref(0);
const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];
let subtitleLoadVersion = 0;

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

const aspectStyle = computed(() => {
    const width = Number(props.width);
    const height = Number(props.height);
    return Number.isFinite(width) && Number.isFinite(height) && height > 0 ? { aspectRatio: `${width} / ${height}` } : {};
});

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

const handleQualitiesChange = (event: Event) => {
    runtimeQualityCount.value = (event as CustomEvent<unknown[]>).detail?.length || 0;
};

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

const handleVolumeChange = (event: Event) => {
    const detail = (event as CustomEvent<{ muted?: boolean; volume?: number }>).detail;
    isMuted.value = Boolean(detail?.muted || detail?.volume === 0);
};

onBeforeUnmount(() => {
    subtitleLoadVersion += 1;
    if (import.meta.client) revokeProcessedSubtitles();
});
</script>

<template>
    <div
        class="video-player-root relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-black"
        :style="aspectStyle"
    >
        <ClientOnly>
            <media-player
                ref="playerRef"
                class="vidstack-player-core h-full w-full"
                :src="mediaSource"
                :poster="props.poster || undefined"
                playsinline
                key-target="player"
                aria-label="Video player"
                @provider-change="handleProviderChange"
                @source-change="handleSourceChange"
                @qualities-change="handleQualitiesChange"
                @audio-tracks-change="handleAudioTracksChange"
                @play="isPlaying = true"
                @pause="isPlaying = false"
                @waiting="isBuffering = true"
                @playing="isBuffering = false"
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
                <media-captions
                    class="vds-captions absolute inset-x-[6%] bottom-6 z-20 pointer-events-none text-center transition-[bottom] duration-200"
                    :class="[`sub-size-${subtitleFontSize}`, `sub-bg-${subtitleBgStyle}`]"
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
                    v-if="isBuffering"
                    class="buffering-indicator pointer-events-none absolute top-1/2 left-1/2 z-25 grid h-15 w-15 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-[rgba(15,15,18,0.72)] text-white shadow-2xl backdrop-blur-md"
                    aria-hidden="true"
                >
                    <Loader2 class="h-7 w-7 animate-spin" />
                </div>

                <media-controls
                    class="player-controls absolute inset-x-0 bottom-0 top-auto z-30 flex flex-col justify-end box-border pointer-events-none opacity-0 transition-opacity duration-220 bg-gradient-to-t from-black/45 via-black/12 to-transparent px-2.5 sm:px-3.5 pb-[max(12px,env(safe-area-inset-bottom,12px))] pt-6 data-[visible]:opacity-100 data-[active]:opacity-100"
                    hide-delay="2500"
                >
                    <media-controls-group class="progress-group pointer-events-auto mb-1.5 w-full">
                        <media-time-slider class="vds-time-slider relative flex h-[22px] w-full cursor-pointer items-center touch-none">
                            <div class="vds-slider-track" />
                            <div class="vds-slider-track-fill vds-slider-track" />
                            <div class="vds-slider-progress vds-slider-track" />
                            <div class="vds-slider-thumb" />
                            <media-slider-preview
                                class="time-preview absolute bottom-7 left-[var(--preview-pointer,0%)] -translate-x-1/2 rounded-md border border-white/16 bg-[rgba(15,15,18,0.92)] px-2 py-1 text-[11px] text-white whitespace-nowrap tabular-nums shadow-xl backdrop-blur-md"
                            >
                                <media-slider-value type="pointer" format="time" />
                            </media-slider-preview>
                        </media-time-slider>
                    </media-controls-group>

                    <media-controls-group class="control-row pointer-events-auto flex w-full items-center justify-between gap-1 sm:gap-3">
                        <div class="control-cluster flex items-center gap-0.5 sm:gap-1.5 min-w-0">
                            <media-play-button
                                class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white data-[active]:bg-sky-400/16 data-[active]:text-sky-400"
                                :aria-label="isPlaying ? $t('post_detail.viewer.player.pause') : $t('post_detail.viewer.player.play')"
                            >
                                <Pause v-if="isPlaying" class="h-4.5 w-4.5 fill-current" />
                                <Play v-else class="h-4.5 w-4.5 translate-x-px fill-current" />
                            </media-play-button>

                            <div class="volume-group group relative flex items-center">
                                <media-mute-button
                                    class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white data-[active]:bg-sky-400/16 data-[active]:text-sky-400"
                                    :aria-label="isMuted ? $t('post_detail.viewer.player.unmute') : $t('post_detail.viewer.player.mute')"
                                >
                                    <VolumeX v-if="isMuted" class="h-4.5 w-4.5" />
                                    <Volume2 v-else class="h-4.5 w-4.5" />
                                </media-mute-button>

                                <media-volume-slider
                                    class="vds-volume-slider relative flex h-[22px] cursor-pointer items-center touch-none box-border w-0 opacity-0 overflow-hidden ml-0 mr-0 p-0 sm:w-[66px] sm:opacity-100 sm:overflow-visible sm:px-1.5 group-hover:w-[64px] group-hover:opacity-100 group-hover:overflow-visible group-hover:ml-0.5 group-hover:mr-1 group-hover:px-1.5 group-focus-within:w-[64px] group-focus-within:opacity-100 group-focus-within:overflow-visible group-focus-within:ml-0.5 group-focus-within:mr-1 group-focus-within:px-1.5 transition-all duration-180"
                                >
                                    <div class="vds-slider-track" />
                                    <div class="vds-slider-track-fill vds-slider-track" />
                                    <div class="vds-slider-thumb" />
                                </media-volume-slider>
                            </div>

                            <div
                                class="time-display flex min-w-0 items-center gap-0.5 sm:gap-1 ml-1.5 sm:ml-2 text-[10px] sm:text-xs font-medium text-white/80 tabular-nums"
                            >
                                <media-time type="current" />
                                <span aria-hidden="true">/</span>
                                <media-time type="duration" />
                            </div>
                        </div>

                        <div class="control-cluster flex items-center gap-0.5 sm:gap-1.5 shrink-0">
                            <media-caption-button
                                v-if="processedSubtitles.length > 0"
                                class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white data-[active]:bg-sky-400/16 data-[active]:text-sky-400"
                                :aria-label="$t('post_detail.viewer.player.subtitles')"
                            >
                                <Subtitles class="h-4 w-4" />
                            </media-caption-button>

                            <media-menu class="settings-menu relative">
                                <media-menu-button
                                    class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-colors duration-140 hover:bg-white/15 hover:text-white data-[active]:bg-sky-400/16 data-[active]:text-sky-400"
                                    :aria-label="$t('common.settings')"
                                >
                                    <Settings class="h-4 w-4" />
                                </media-menu-button>
                                <media-menu-portal>
                                    <media-menu-items
                                        class="settings-panel z-50 max-h-[min(320px,50vh)] w-[min(260px,calc(100vw-24px))] overflow-y-auto rounded-xl border border-white/12 bg-[rgba(15,15,18,0.88)] p-2.5 text-xs text-white shadow-2xl backdrop-blur-xl"
                                        placement="top end"
                                        :offset="8"
                                        @wheel.stop
                                        @touchmove.stop
                                        @pointermove.stop
                                    >
                                        <section
                                            v-if="qualityAvailable"
                                            class="settings-section [&+.settings-section]:mt-2.5 [&+.settings-section]:pt-2.5 [&+.settings-section]:border-t [&+.settings-section]:border-white/8"
                                        >
                                            <div
                                                class="settings-heading flex items-center justify-between px-2 pt-0.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/45"
                                            >
                                                {{ $t("post_detail.viewer.player.quality") }}
                                            </div>
                                            <media-quality-radio-group :auto-label="$t('post_detail.viewer.player.auto_quality')">
                                                <template>
                                                    <media-radio>
                                                        <span class="settings-radio-label" data-part="label"></span>
                                                        <span class="settings-radio-hint" data-part="bitrate"></span>
                                                    </media-radio>
                                                </template>
                                            </media-quality-radio-group>
                                        </section>

                                        <section
                                            v-if="audioAvailable"
                                            class="settings-section [&+.settings-section]:mt-2.5 [&+.settings-section]:pt-2.5 [&+.settings-section]:border-t [&+.settings-section]:border-white/8"
                                        >
                                            <div
                                                class="settings-heading flex items-center justify-between px-2 pt-0.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/45"
                                            >
                                                {{ $t("media.tracks.group_audios") }}
                                            </div>
                                            <media-audio-radio-group :empty-label="$t('post_detail.viewer.player.default_audio')">
                                                <template>
                                                    <media-radio>
                                                        <span class="settings-radio-label" data-part="label"></span>
                                                    </media-radio>
                                                </template>
                                            </media-audio-radio-group>
                                        </section>

                                        <section
                                            class="settings-section [&+.settings-section]:mt-2.5 [&+.settings-section]:pt-2.5 [&+.settings-section]:border-t [&+.settings-section]:border-white/8"
                                        >
                                            <div
                                                class="settings-heading flex items-center justify-between px-2 pt-0.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/45"
                                            >
                                                {{ $t("post_detail.viewer.player.subtitles") }}
                                            </div>
                                            <template v-if="processedSubtitles.length > 0">
                                                <media-captions-radio-group :off-label="$t('post_detail.viewer.player.subtitles_off')">
                                                    <template>
                                                        <media-radio>
                                                            <span class="settings-radio-label" data-part="label"></span>
                                                        </media-radio>
                                                    </template>
                                                </media-captions-radio-group>

                                                <div class="settings-subgroup mt-1.5">
                                                    <div class="settings-subheading px-2 py-1 text-[11px] font-medium text-white/60">
                                                        {{ $t("post_detail.viewer.player.subtitle_size") }}
                                                    </div>
                                                    <div class="settings-chip-group flex flex-wrap gap-1 px-1">
                                                        <button
                                                            v-for="opt in subtitleSizeOptions"
                                                            :key="opt.value"
                                                            type="button"
                                                            class="settings-chip flex-1 min-w-[52px] cursor-pointer rounded-md border border-white/12 bg-white/4 px-2 py-1 text-center text-[11px] font-medium text-white/70 transition-all duration-120 hover:border-white/25 hover:bg-white/10 hover:text-white"
                                                            :class="{ active: subtitleFontSize === opt.value }"
                                                            @click="subtitleFontSize = opt.value"
                                                        >
                                                            {{ opt.label }}
                                                        </button>
                                                    </div>
                                                </div>

                                                <div class="settings-subgroup mt-1.5">
                                                    <div class="settings-subheading px-2 py-1 text-[11px] font-medium text-white/60">
                                                        {{ $t("post_detail.viewer.player.subtitle_bg") }}
                                                    </div>
                                                    <div class="settings-chip-group flex flex-wrap gap-1 px-1">
                                                        <button
                                                            v-for="opt in subtitleBgOptions"
                                                            :key="opt.value"
                                                            type="button"
                                                            class="settings-chip flex-1 min-w-[52px] cursor-pointer rounded-md border border-white/12 bg-white/4 px-2 py-1 text-center text-[11px] font-medium text-white/70 transition-all duration-120 hover:border-white/25 hover:bg-white/10 hover:text-white"
                                                            :class="{ active: subtitleBgStyle === opt.value }"
                                                            @click="subtitleBgStyle = opt.value"
                                                        >
                                                            {{ opt.label }}
                                                        </button>
                                                    </div>
                                                </div>
                                            </template>
                                            <template v-else>
                                                <div
                                                    class="settings-empty-notice rounded-md bg-white/4 p-2 text-center text-xs text-white/45"
                                                >
                                                    {{ $t("post_detail.viewer.player.no_subtitles") }}
                                                </div>
                                            </template>
                                        </section>

                                        <section
                                            class="settings-section [&+.settings-section]:mt-2.5 [&+.settings-section]:pt-2.5 [&+.settings-section]:border-t [&+.settings-section]:border-white/8"
                                        >
                                            <div
                                                class="settings-heading flex items-center justify-between px-2 pt-0.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/45"
                                            >
                                                {{ $t("post_detail.viewer.player.speed") }}
                                            </div>
                                            <media-speed-radio-group
                                                :rates="speedOptions"
                                                :normal-label="$t('post_detail.viewer.player.normal_speed')"
                                            >
                                                <template>
                                                    <media-radio>
                                                        <span class="settings-radio-label" data-part="label"></span>
                                                    </media-radio>
                                                </template>
                                            </media-speed-radio-group>
                                        </section>
                                    </media-menu-items>
                                </media-menu-portal>
                            </media-menu>

                            <media-pip-button
                                class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white data-[active]:bg-sky-400/16 data-[active]:text-sky-400 hidden sm:flex"
                                :aria-label="$t('post_detail.viewer.player.pip')"
                            >
                                <PictureInPicture2 class="h-4 w-4" :class="{ 'text-emerald-300': isPictureInPicture }" />
                            </media-pip-button>

                            <media-fullscreen-button
                                class="control-button relative grid h-8 w-8 sm:h-8.5 sm:w-8.5 shrink-0 cursor-pointer place-items-center rounded-lg text-white/85 transition-all duration-140 hover:scale-105 hover:bg-white/15 hover:text-white data-[active]:bg-sky-400/16 data-[active]:text-sky-400"
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
                </media-controls>
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

:global(.settings-panel) {
    --media-font-size: 13px !important;
    --media-menu-font-size: 13px !important;
    display: block !important;
    width: 240px !important;
    min-width: 220px !important;
    max-width: calc(100vw - 24px) !important;
    max-height: min(300px, 50vh) !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    scrollbar-gutter: stable;
    overscroll-behavior: contain !important;
    pointer-events: auto !important;
    touch-action: pan-y !important;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box !important;
}

:global(.settings-panel media-quality-radio-group),
:global(.settings-panel media-audio-radio-group),
:global(.settings-panel media-captions-radio-group),
:global(.settings-panel media-speed-radio-group) {
    display: grid !important;
    gap: 3px !important;
}

:global(.settings-panel media-radio) {
    display: flex !important;
    min-height: 32px !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 5px 10px !important;
    border-radius: 7px !important;
    color: rgba(255, 255, 255, 0.75) !important;
    font-size: 13px !important;
    cursor: pointer !important;
    transition: all 120ms ease !important;
}

:global(.settings-panel media-radio:hover) {
    background: rgba(255, 255, 255, 0.1) !important;
    color: #fff !important;
}

:global(.settings-panel media-radio[data-checked]) {
    background: rgba(255, 255, 255, 0.15) !important;
    color: #fff !important;
    font-weight: 500 !important;
}

:global(.settings-panel media-radio[data-checked]::after) {
    content: "✓" !important;
    margin-left: 8px !important;
    color: #38bdf8 !important;
    font-size: 12px !important;
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
    color: rgba(255, 255, 255, 0.45) !important;
    font-size: 11px !important;
    white-space: nowrap !important;
}

:global(.settings-radio-hint:empty) {
    display: none !important;
}
</style>
