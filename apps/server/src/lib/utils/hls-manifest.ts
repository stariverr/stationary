import { createMediaSignature } from "./media-signer";

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
        for (let i = 0; i < input.audio.length; i++) {
            const a = input.audio[i];
            const suffix = appendSigIfNeeded(a.track_id, input.query_suffix);
            const uri = `hls/${a.track_id}/manifest.m3u8${suffix}`;
            const isDefault = a.is_default || i === 0 ? "YES" : "NO";
            const langAttr = a.language ? `,LANGUAGE="${a.language}"` : "";
            lines.push(
                `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${a.label}"${langAttr},DEFAULT=${isDefault},AUTOSELECT=YES,URI="${uri}"`,
            );
        }
        lines.push("");
    }

    // 2. Subtitle Media Group
    if (hasSubtitles && input.subtitle) {
        for (let i = 0; i < input.subtitle.length; i++) {
            const s = input.subtitle[i];
            const suffix = appendSigIfNeeded(s.track_id, input.query_suffix);
            const uri = `hls/${s.track_id}/manifest.m3u8${suffix}`;
            const isDefault = s.is_default || i === 0 ? "YES" : "NO";
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

export interface HlsVariantSegment {
    file_url: string;
    init_range?: string | null;
    media_range?: string | null;
    duration: number;
    query_suffix?: string;
}

export function buildHlsVariantManifest(segment: HlsVariantSegment): string {
    const targetDuration = Math.max(1, Math.ceil(segment.duration || 10));
    const suffix = segment.query_suffix || "";
    let fileUrlWithQuery = segment.file_url;

    if (suffix) {
        const cleanSuffix = suffix.replace(/^\?/, "");
        if (cleanSuffix) {
            fileUrlWithQuery = segment.file_url.includes("?")
                ? `${segment.file_url}&${cleanSuffix}`
                : `${segment.file_url}?${cleanSuffix}`;
        }
    }

    const lines: string[] = [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
    ];

    if (segment.init_range) {
        lines.push(`#EXT-X-MAP:URI="${fileUrlWithQuery}",BYTERANGE="${segment.init_range}"`);
    }

    lines.push(`#EXTINF:${(segment.duration || 0).toFixed(3)},`);

    if (segment.media_range) {
        lines.push(`#EXT-X-BYTERANGE:${segment.media_range}`);
    }

    lines.push(fileUrlWithQuery);
    lines.push("#EXT-X-ENDLIST");

    return lines.join("\n");
}
