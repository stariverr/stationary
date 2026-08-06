import { TrackPurpose, TrackStreamLayout, TrackType, type TrackMetadata, type Stream } from "@/db/schema";
import { isDashCompatibleFormat, isProgressiveMuxedFormat, type TrackFormatFields } from "@/lib/utils/track-format";
import { Quality } from "../types";
import { createMediaSignature } from "./media-signer";

export interface PlaybackTrackInput {
    track_id: string;
    type: TrackType;
    purpose: TrackPurpose;
    priority: number;
    quality: Quality;
    is_default: boolean;
    is_primary: boolean;
    display_name: string | null;
    language: string | null;
    codec: string | null;
    metadata: TrackMetadata;
    container: string | null;
    is_fragmented: boolean | null;
    stream_layout: TrackStreamLayout | null;
    has_video: boolean;
    has_audio: boolean;
    streams: Stream[];
    url: string | null;
    mime_type: string | null;
    width: number | null;
    height: number | null;
    bandwidth?: number | null;
}

export interface PlaybackVariant {
    track_id: string;
    url: string;
    mime_type: string | null;
    quality: string;
    label: string;
    codec: string | null;
    width: number | null;
    height: number | null;
    bandwidth: number | null;
    frame_rate: number | null;
}

export interface PlaybackAudioTrack {
    id: string;
    track_id: string;
    source: "INTERNAL" | "EXTERNAL";
    stream_index: number | null;
    url: string | null;
    select_url: string | null;
    mime_type: string | null;
    language: string | null;
    label: string;
    role: string | null;
    codec: string | null;
    channels: number | null;
    is_default: boolean;
    selectable: boolean;
}

export interface PlaybackSubtitleTrack {
    id: string;
    track_id: string;
    source: "INTERNAL" | "EXTERNAL";
    stream_index: number | null;
    url: string | null;
    mime_type: string | null;
    language: string | null;
    label: string;
    format: string | null;
    selectable: boolean;
}

export interface MediaPlaybackInfo {
    url: string | null;
    mime_type: string | null;
    protocol: "DASH" | "HLS" | "PROGRESSIVE" | null;
    hls_url: string | null;
    dash_url: string | null;
    track_id: string | null;
    variants: PlaybackVariant[];
    capabilities: {
        quality_switching: boolean;
        audio_switching: boolean;
        subtitle_switching: boolean;
        protocol_supports_switching: boolean;
    };
    audio_tracks: PlaybackAudioTrack[];
    subtitle_tracks: PlaybackSubtitleTrack[];
}

const qualityRank: Record<Quality, number> = {
    [Quality.HIGH]: 3,
    [Quality.MEDIUM]: 2,
    [Quality.LOW]: 1,
};

const sortTracks = (tracks: PlaybackTrackInput[]) =>
    [...tracks].sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        const qualityDifference = (qualityRank[right.quality] || 0) - (qualityRank[left.quality] || 0);
        return qualityDifference || left.track_id.localeCompare(right.track_id);
    });

const selectPrimaryTrack = (tracks: PlaybackTrackInput[]) => {
    const sorted = sortTracks(tracks);
    return sorted.find((track) => track.is_primary) || sorted.find((track) => track.is_default) || sorted[0] || null;
};

const trackFormat = (track: PlaybackTrackInput): TrackFormatFields => ({
    container: track.container,
    is_fragmented: track.is_fragmented,
    stream_layout: track.stream_layout,
    has_video: track.has_video,
    has_audio: track.has_audio,
    streams: track.streams,
});

const inferMimeType = (track: PlaybackTrackInput): string | null => {
    if (track.mime_type) return track.mime_type;
    if (track.container === "webm") return track.type === TrackType.AUDIO ? "audio/webm" : "video/webm";
    if (track.container === "ogg") return track.type === TrackType.AUDIO ? "audio/ogg" : "video/ogg";
    if (track.container === "mp4") return track.type === TrackType.AUDIO ? "audio/mp4" : "video/mp4";
    return null;
};

const inferInternalAudioMimeType = (track: PlaybackTrackInput): string | null => {
    if (track.container === "webm") return "audio/webm";
    if (track.container === "ogg") return "audio/ogg";
    if (track.container === "mp4") return "audio/mp4";
    return null;
};

const isDashTrack = (track: PlaybackTrackInput) => isDashCompatibleFormat(track.type, trackFormat(track), track.metadata);

const isProgressiveVideo = (track: PlaybackTrackInput) =>
    Boolean(track.url) &&
    track.type === TrackType.VIDEO &&
    track.has_video &&
    track.is_fragmented !== true &&
    track.stream_layout !== TrackStreamLayout.AUDIO_ONLY &&
    track.stream_layout !== TrackStreamLayout.TEXT_ONLY;

const findStream = (track: PlaybackTrackInput, type: TrackType) => track.streams.find((stream) => stream.type === type);

const finiteNumber = (...values: unknown[]): number | null => {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
};

const variantMetrics = (track: PlaybackTrackInput) => {
    const stream = findStream(track, TrackType.VIDEO);
    return {
        width: finiteNumber(stream?.width, track.width),
        height: finiteNumber(stream?.height, track.height),
        bandwidth: finiteNumber(track.bandwidth),
        frame_rate: finiteNumber(track.metadata.frame_rate),
    };
};

const variantLabel = (track: PlaybackTrackInput, height: number | null) =>
    track.display_name || (height ? `${height}p` : track.quality || "Video");

const toVariant = (track: PlaybackTrackInput, url: string, mimeType: string | null): PlaybackVariant => {
    const metrics = variantMetrics(track);
    return {
        track_id: track.track_id,
        url,
        mime_type: mimeType,
        quality: track.quality,
        label: variantLabel(track, metrics.height),
        codec: track.codec || findStream(track, TrackType.VIDEO)?.codec || null,
        ...metrics,
    };
};

const audioFields = (track: PlaybackTrackInput, stream?: Stream) => {
    const language = stream?.language ?? track.language ?? null;
    const codec = stream?.codec ?? track.codec ?? null;
    const explicitLabel = stream?.label || track.display_name || stream?.language || track.language;
    const qualityLabel = track.quality;
    const fallbackLabel = codec ? `Audio (${String(codec).toUpperCase()})` : "Audio Track";

    return {
        language,
        label: explicitLabel || qualityLabel || fallbackLabel,
        role: stream?.role ?? track.metadata.role ?? (track.is_default ? "main" : "alternate"),
        codec,
        channels: finiteNumber(stream?.channels, track.metadata.channels),
    };
};

const toExternalSubtitle = (track: PlaybackTrackInput): PlaybackSubtitleTrack => ({
    id: `track:${track.track_id}`,
    track_id: track.track_id,
    source: "EXTERNAL",
    stream_index: null,
    url: track.url,
    mime_type: track.mime_type,
    language: track.language,
    label: track.display_name || track.language || "Subtitle",
    format: typeof track.metadata.format === "string" ? track.metadata.format : null,
    selectable: true,
});

function resolveDashPlayback(
    mediaId: string,
    dashVideoTracks: PlaybackTrackInput[],
    dashAudioTracks: PlaybackTrackInput[],
    subtitleTracks: PlaybackTrackInput[],
): MediaPlaybackInfo {
    const sig = createMediaSignature(mediaId);
    const dashUrl = `/api/media/${mediaId}/manifest.mpd?${sig.queryParams}`;
    const hlsUrl = `/api/media/${mediaId}/manifest.m3u8?${sig.queryParams}`;
    const primaryDashTrack = selectPrimaryTrack(dashVideoTracks);
    const variants = dashVideoTracks.map((track) => {
        const trackSig = createMediaSignature(mediaId, track.track_id);
        const variantHlsUrl = `/api/media/${mediaId}/hls/${track.track_id}/manifest.m3u8?${trackSig.queryParams}`;
        return toVariant(track, variantHlsUrl, "application/x-mpegURL");
    });
    const resolvedAudioTracks = dashAudioTracks.map(
        (track): PlaybackAudioTrack => ({
            id: `track:${track.track_id}`,
            track_id: track.track_id,
            source: "EXTERNAL",
            stream_index: null,
            url: track.url,
            select_url: null,
            mime_type: inferMimeType(track),
            ...audioFields(track, findStream(track, TrackType.AUDIO)),
            is_default: track.is_default,
            selectable: true,
        }),
    );
    const resolvedSubtitleTracks = subtitleTracks.map(toExternalSubtitle);

    return {
        url: dashUrl,
        mime_type: "application/dash+xml",
        protocol: "DASH",
        hls_url: hlsUrl,
        dash_url: dashUrl,
        track_id: primaryDashTrack?.track_id || null,
        variants,
        capabilities: {
            quality_switching: variants.length > 1,
            audio_switching: resolvedAudioTracks.length > 1,
            subtitle_switching: resolvedSubtitleTracks.length > 0,
            protocol_supports_switching: true,
        },
        audio_tracks: resolvedAudioTracks,
        subtitle_tracks: resolvedSubtitleTracks,
    };
}

function resolveProgressivePlayback(
    videoTracks: PlaybackTrackInput[],
    audioTracks: PlaybackTrackInput[],
    subtitleTracks: PlaybackTrackInput[],
    muxedProgressiveVideoTracks: PlaybackTrackInput[],
): MediaPlaybackInfo {
    const progressiveVideoTracks =
        muxedProgressiveVideoTracks.length > 0 ? muxedProgressiveVideoTracks : videoTracks.filter(isProgressiveVideo);
    const selectedVideo = selectPrimaryTrack(progressiveVideoTracks.length > 0 ? progressiveVideoTracks : videoTracks);
    const variantTracks = progressiveVideoTracks.length > 0 ? progressiveVideoTracks : selectedVideo ? [selectedVideo] : [];
    const variants = sortTracks(variantTracks).map((track) => toVariant(track, track.url || "", inferMimeType(track)));
    const internalAudioTracks = (selectedVideo?.streams || [])
        .filter((stream) => stream.type === TrackType.AUDIO)
        .map(
            (stream): PlaybackAudioTrack => ({
                id: `stream:${selectedVideo?.track_id}:${stream.index}`,
                track_id: selectedVideo?.track_id || "",
                source: "INTERNAL",
                stream_index: stream.index,
                url: selectedVideo?.url || null,
                select_url: null,
                mime_type: selectedVideo ? inferInternalAudioMimeType(selectedVideo) : null,
                ...audioFields(selectedVideo!, stream),
                is_default: stream.is_default ?? false,
                selectable: false,
            }),
        );
    const resolvedAudioTracks = [
        ...internalAudioTracks,
        ...sortTracks(audioTracks).map(
            (track): PlaybackAudioTrack => ({
                id: `track:${track.track_id}`,
                track_id: track.track_id,
                source: "EXTERNAL",
                stream_index: null,
                url: track.url,
                select_url: null,
                mime_type: inferMimeType(track),
                ...audioFields(track, findStream(track, TrackType.AUDIO)),
                is_default: track.is_default,
                selectable: false,
            }),
        ),
    ];
    const internalSubtitleTracks = (selectedVideo?.streams || [])
        .filter((stream) => stream.type === TrackType.SUBTITLE)
        .map(
            (stream): PlaybackSubtitleTrack => ({
                id: `stream:${selectedVideo?.track_id}:${stream.index}`,
                track_id: selectedVideo?.track_id || "",
                source: "INTERNAL",
                stream_index: stream.index,
                url: null,
                mime_type: null,
                language: stream.language ?? null,
                label: stream.label || stream.language || `Subtitle ${stream.index + 1}`,
                format: null,
                selectable: false,
            }),
        );
    const resolvedSubtitleTracks = [...internalSubtitleTracks, ...subtitleTracks.map(toExternalSubtitle)];

    return {
        url: selectedVideo?.url || null,
        mime_type: selectedVideo ? inferMimeType(selectedVideo) : null,
        protocol: selectedVideo ? "PROGRESSIVE" : null,
        hls_url: null,
        dash_url: null,
        track_id: selectedVideo?.track_id || null,
        variants,
        capabilities: {
            quality_switching: variants.length > 1,
            audio_switching: resolvedAudioTracks.length > 1,
            subtitle_switching: resolvedSubtitleTracks.some((track) => track.selectable),
            protocol_supports_switching: false,
        },
        audio_tracks: resolvedAudioTracks,
        subtitle_tracks: resolvedSubtitleTracks,
    };
}

export function resolveMediaPlayback(mediaId: string, inputTracks: PlaybackTrackInput[]): MediaPlaybackInfo {
    const contentTracks = inputTracks.filter((track) => track.purpose === TrackPurpose.CONTENT && track.url);
    const videoTracks = contentTracks.filter((track) => track.type === TrackType.VIDEO);
    const audioTracks = contentTracks.filter((track) => track.type === TrackType.AUDIO);
    const subtitleTracks = sortTracks(contentTracks.filter((track) => track.type === TrackType.SUBTITLE));
    const dashVideoTracks = sortTracks(videoTracks.filter(isDashTrack));
    const dashAudioTracks = sortTracks(audioTracks.filter(isDashTrack));
    const muxedProgressiveVideoTracks = videoTracks.filter((track) => isProgressiveMuxedFormat(track.type, trackFormat(track)));

    if (dashVideoTracks.length > 0 && (dashAudioTracks.length > 0 || muxedProgressiveVideoTracks.length === 0)) {
        return resolveDashPlayback(mediaId, dashVideoTracks, dashAudioTracks, subtitleTracks);
    }

    return resolveProgressivePlayback(videoTracks, audioTracks, subtitleTracks, muxedProgressiveVideoTracks);
}
