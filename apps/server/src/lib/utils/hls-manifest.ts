import { createMediaSignature } from "./media-signer";
import type { Mp4Segment } from "./mp4-segment";

export interface HlsVideoVariant {
    track_id: string;
    stream_index?: number | null;
    url: string;
    codec: string;
    bandwidth: number;
    width: number;
    height: number;
    frame_rate?: number | null;
}

export interface HlsAudioVariant {
    track_id: string;
    stream_index?: number | null;
    url: string;
    codec: string;
    bandwidth: number;
    language: string | null;
    label: string;
    channels: number;
    is_default?: boolean;
}

export interface HlsSubtitleVariant {
    track_id: string;
    stream_index?: number | null;
    url: string;
    language: string | null;
    label: string;
    is_default?: boolean;
}

export interface HlsMasterInput {
    media_id: string;
    video: HlsVideoVariant[];
    audio: HlsAudioVariant[];
    subtitle?: HlsSubtitleVariant[];
    query_suffix?: string;
}

/** Exactly one audio rendition is DEFAULT=YES: the first one marked default, else the first one. */
const defaultIndex = (renditions: { is_default?: boolean }[]) => Math.max(0, renditions.findIndex((r) => r.is_default));

export function buildHlsMasterManifest(input: HlsMasterInput): string {
    const lines: string[] = [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        "",
    ];

    const hasAudio = input.audio.length > 0;
    const hasSubtitles = Boolean(input.subtitle && input.subtitle.length > 0);

    const appendSigIfNeeded = (trackId: string, currentSuffix?: string) => {
        let suffix = currentSuffix || "";
        if (!suffix.includes("sig=")) {
            const sigInfo = createMediaSignature(input.media_id, trackId);
            if (!suffix) {
                suffix = `?${sigInfo.queryParams}`;
            } else {
                const prefix = suffix.includes("?") ? "&" : "?";
                suffix = `${suffix}${prefix}${sigInfo.queryParams}`;
            }
        }
        return suffix;
    };

    // 1. Audio Media Group
    if (hasAudio) {
        const defaultAudio = defaultIndex(input.audio);
        for (let i = 0; i < input.audio.length; i++) {
            const a = input.audio[i];
            const suffix = appendSigIfNeeded(a.track_id, input.query_suffix);
            const uri = `hls/${a.track_id}/manifest.m3u8${suffix}`;
            const isDefault = i === defaultAudio ? "YES" : "NO";
            const langAttr = a.language ? `,LANGUAGE="${a.language}"` : "";
            lines.push(
                `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${a.label}"${langAttr},DEFAULT=${isDefault},AUTOSELECT=YES,URI="${uri}"`,
            );
        }
        lines.push("");
    }

    // 2. Subtitle Media Group
    if (hasSubtitles && input.subtitle) {
        // Captions start off unless the media marks one as default, so a subtitle group may have no default.
        for (const s of input.subtitle) {
            const suffix = appendSigIfNeeded(s.track_id, input.query_suffix);
            const uri = `hls/${s.track_id}/manifest.m3u8${suffix}`;
            const isDefault = s.is_default ? "YES" : "NO";
            const langAttr = s.language ? `,LANGUAGE="${s.language}"` : "";
            lines.push(
                `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="${s.label}"${langAttr},DEFAULT=${isDefault},AUTOSELECT=YES,URI="${uri}"`,
            );
        }
        lines.push("");
    }

    // 3. Video Stream INF
    const audioGroupAttr = hasAudio ? `,AUDIO="audio"` : "";
    const subtitleGroupAttr = hasSubtitles ? `,SUBTITLES="subtitles"` : "";

    for (const v of input.video) {
        const resolution = `${v.width}x${v.height}`;
        const frameRate = v.frame_rate ? `,FRAME-RATE=${v.frame_rate}` : "";
        const suffix = appendSigIfNeeded(v.track_id, input.query_suffix);
        const variantUrl = `hls/${v.track_id}/manifest.m3u8${suffix}`;
        lines.push(
            `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${resolution},CODECS="${v.codec}"${frameRate}${audioGroupAttr}${subtitleGroupAttr}`,
        );
        lines.push(variantUrl);
        lines.push("");
    }

    return lines.join("\n");
}

const withQuery = (url: string, querySuffix?: string) => {
    const query = (querySuffix || "").replace(/^\?/, "");
    if (!query) return url;
    return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
};

export interface HlsVariantInput {
    file_url: string;
    /** The init segment (ftyp + moov) as a byte range of the file. */
    init: { offset: number; length: number };
    /** The media segments listed by the file's sidx, in order. */
    segments: Mp4Segment[];
    query_suffix?: string;
}

/** A media playlist that addresses each fMP4 fragment of one file by byte range. */
export function buildHlsVariantManifest(input: HlsVariantInput): string {
    const url = withQuery(input.file_url, input.query_suffix);
    const targetDuration = Math.max(1, Math.ceil(Math.max(0, ...input.segments.map((segment) => segment.duration))));

    const lines: string[] = [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        `#EXT-X-MAP:URI="${url}",BYTERANGE="${input.init.length}@${input.init.offset}"`,
    ];
    for (const segment of input.segments) {
        lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
        lines.push(`#EXT-X-BYTERANGE:${segment.length}@${segment.offset}`);
        lines.push(url);
    }
    lines.push("#EXT-X-ENDLIST");
    return lines.join("\n");
}

export interface HlsSubtitleInput {
    file_url: string;
    duration: number;
    query_suffix?: string;
}

/** A media playlist whose single segment is the whole WebVTT file. */
export function buildHlsSubtitleManifest(input: HlsSubtitleInput): string {
    const duration = Number.isFinite(input.duration) && input.duration > 0 ? input.duration : 0;
    return [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(duration))}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        `#EXTINF:${duration.toFixed(6)},`,
        withQuery(input.file_url, input.query_suffix),
        "#EXT-X-ENDLIST",
    ].join("\n");
}
