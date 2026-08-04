import { TrackPurpose, TrackStreamLayout, TrackType, type Stream } from "@/db/schema";
import { Quality } from "@/lib/types";

export interface TrackFormatFields {
    container: string | null;
    is_fragmented: boolean | null;
    stream_layout: TrackStreamLayout | null;
    has_video: boolean;
    has_audio: boolean;
    streams: Stream[];
}

export interface TrackFormatInput {
    type: TrackType;
    metadata?: unknown;
    container?: string | null;
    is_fragmented?: boolean | null;
    stream_layout?: TrackStreamLayout | null;
    has_video?: boolean | null;
    has_audio?: boolean | null;
    streams?: Stream[] | null;
    file?: {
        mime_type?: string | null;
        extension?: string | null;
    } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const readString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

const readBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const readNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const PROGRESSIVE_VIDEO_CONTAINERS = new Set(["mp4", "webm", "ogg"]);

const CONTAINER_NORMALIZE_MAP: Record<string, string> = {
    fmp4: "mp4",
    "mpeg-4": "mp4",
    "iso.segment": "mp4",
    m4s: "mp4",
};

const MIME_TYPE_CONTAINER_MAP: Record<string, string> = {
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
    "model/vnd.usdz+zip": "usdz",
};

const normalizeContainer = (value: string | null): string | null => {
    if (!value) return null;
    const normalized = value.toLowerCase().replace(/^[.]/, "");
    return CONTAINER_NORMALIZE_MAP[normalized] ?? normalized;
};

const inferContainerFromFile = (file: TrackFormatInput["file"]): string | null => {
    const mimeType = file?.mime_type?.toLowerCase() || "";
    if (MIME_TYPE_CONTAINER_MAP[mimeType]) {
        return MIME_TYPE_CONTAINER_MAP[mimeType];
    }

    const mimeContainer = mimeType.split("/")[1]?.split(";")[0];
    if (["mp4", "webm", "ogg"].includes(mimeContainer)) return mimeContainer;
    if (mimeContainer === "iso.segment") return "mp4";

    return normalizeContainer(file?.extension ?? null);
};

const normalizeStreamType = (value: unknown): Stream["type"] | null => {
    const normalized = readString(value)?.toUpperCase();
    if (normalized === TrackType.VIDEO || normalized === TrackType.AUDIO || normalized === TrackType.SUBTITLE) {
        return normalized;
    }
    return null;
};

const normalizeStreamLayout = (value: unknown): TrackStreamLayout | null => {
    const normalized = readString(value)?.toUpperCase();
    if (!normalized) return null;

    return Object.values(TrackStreamLayout).includes(normalized as TrackStreamLayout) ? (normalized as TrackStreamLayout) : null;
};

export function normalizeTrackStreams(value: unknown): Stream[] {
    if (!Array.isArray(value)) return [];

    return value.flatMap((item, itemIndex) => {
        if (!isRecord(item)) return [];

        const type = normalizeStreamType(item.type);
        if (!type) return [];

        const rawIndex = item.index ?? item.stream_index;
        const index = typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : itemIndex;

        return [
            {
                index,
                id: readString(item.id ?? item.stream_id),
                type,
                codec: readString(item.codec ?? item.codecs),
                language: readString(item.language),
                label: readString(item.label ?? item.display_name),
                role: readString(item.role),
                width: readNumber(item.width),
                height: readNumber(item.height),
                bandwidth: readNumber(item.bandwidth),
                channels: readNumber(item.channels),
                sample_rate: readNumber(item.sample_rate),
                is_default: readBoolean(item.is_default) ?? undefined,
            },
        ];
    });
}

export const hasDashSegmentBase = (metadata: unknown): boolean => {
    if (!isRecord(metadata)) return false;
    const segmentBase = metadata.segment_base;
    if (!isRecord(segmentBase)) return false;

    return Boolean(readString(segmentBase.initialization) && readString(segmentBase.index_range));
};

export const REDUNDANT_METADATA_KEYS = new Set([
    "streams",
    "container",
    "is_fragmented",
    "fragmented",
    "stream_layout",
    "layout",
    "codec",
    "codecs",
    "language",
    "label",
    "role",
    "bandwidth",
    "channels",
    "sample_rate",
    "frame_rate",
    "has_video",
    "has_audio",
    "type",
    "width",
    "height",
    "duration",
]);

export function cleanTrackMetadata(metadata: unknown): Record<string, unknown> {
    if (typeof metadata !== "object" || metadata === null) return {};
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
        if (!REDUNDANT_METADATA_KEYS.has(key)) {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

function inferStreamLayout(hasVideo: boolean, hasAudio: boolean, trackType: TrackType): TrackStreamLayout {
    if (hasVideo && hasAudio) return TrackStreamLayout.MUXED;
    if (hasVideo) return TrackStreamLayout.VIDEO_ONLY;
    if (hasAudio) return TrackStreamLayout.AUDIO_ONLY;
    if (trackType === TrackType.SUBTITLE) return TrackStreamLayout.TEXT_ONLY;
    return TrackStreamLayout.SINGLE;
}

export function deriveTrackFormat(input: TrackFormatInput): TrackFormatFields {
    const streams = normalizeTrackStreams(input.streams);
    const streamTypes = new Set(streams.map((stream) => stream.type));
    const container = normalizeContainer(input.container ?? null) ?? inferContainerFromFile(input.file);
    const isFragmented = input.is_fragmented ?? (hasDashSegmentBase(input.metadata) ? true : null);

    const explicitHasVideo = typeof input.has_video === "boolean" ? input.has_video : null;
    const explicitHasAudio = typeof input.has_audio === "boolean" ? input.has_audio : null;

    const hasVideo = explicitHasVideo ?? (streamTypes.has(TrackType.VIDEO) || input.type === TrackType.VIDEO);
    const inferredProgressiveAudio =
        input.type === TrackType.VIDEO &&
        isFragmented !== true &&
        Boolean(container && PROGRESSIVE_VIDEO_CONTAINERS.has(container)) &&
        streams.length === 0;
    const hasAudio = explicitHasAudio ?? (streamTypes.has(TrackType.AUDIO) || input.type === TrackType.AUDIO || inferredProgressiveAudio);

    const streamLayout = normalizeStreamLayout(input.stream_layout) ?? inferStreamLayout(hasVideo, hasAudio, input.type);

    return {
        container,
        is_fragmented: isFragmented,
        stream_layout: streamLayout,
        has_video: hasVideo,
        has_audio: hasAudio,
        streams,
    };
}

export function isDashCompatibleFormat(type: TrackType, format: TrackFormatFields, metadata: unknown): boolean {
    if (type !== TrackType.VIDEO && type !== TrackType.AUDIO) return false;
    if (format.container !== "mp4" || format.is_fragmented !== true || !hasDashSegmentBase(metadata)) return false;

    return type === TrackType.VIDEO
        ? format.stream_layout === TrackStreamLayout.VIDEO_ONLY
        : format.stream_layout === TrackStreamLayout.AUDIO_ONLY;
}

export function isDashCompatibleTrack(input: TrackFormatInput): boolean {
    const format = deriveTrackFormat(input);
    return isDashCompatibleFormat(input.type, format, input.metadata);
}

export function isProgressiveMuxedFormat(type: TrackType, format: TrackFormatFields): boolean {
    return (
        type === TrackType.VIDEO &&
        Boolean(format.container && PROGRESSIVE_VIDEO_CONTAINERS.has(format.container)) &&
        format.is_fragmented !== true &&
        format.stream_layout === TrackStreamLayout.MUXED &&
        format.has_video
    );
}

export function isProgressiveMuxedTrack(input: TrackFormatInput): boolean {
    const format = deriveTrackFormat(input);
    return isProgressiveMuxedFormat(input.type, format);
}

export interface RawIncomingTrackInput {
    type: TrackType;
    purpose?: TrackPurpose;
    quality?: Quality;
    priority?: number;
    url?: string | null;
    variant_key?: string;
    is_original?: boolean;
    is_default?: boolean;
    is_primary?: boolean;
    display_name?: string | null;
    language?: string | null;
    codec?: string | null;
    duration?: number | null;
    width?: number | null;
    height?: number | null;
    bandwidth?: number | null;
    container?: string | null;
    is_fragmented?: boolean | null;
    stream_layout?: TrackStreamLayout | null;
    has_video?: boolean | null;
    has_audio?: boolean | null;
    streams?: Stream[] | null;
    metadata?: unknown;
    file?: {
        mime_type?: string | null;
        extension?: string | null;
    } | null;
}

export function normalizeIncomingTrack(input: RawIncomingTrackInput) {
    const rawMeta = isRecord(input.metadata) ? input.metadata : {};

    // 1. Extract canonical attributes BEFORE cleaning metadata
    const language = readString(input.language) ?? readString(rawMeta.language) ?? null;
    const codec = readString(input.codec) ?? readString(rawMeta.codecs) ?? readString(rawMeta.codec) ?? null;
    const duration = readNumber(input.duration) ?? readNumber(rawMeta.duration) ?? null;
    const width = readNumber(input.width) ?? readNumber(rawMeta.width) ?? null;
    const height = readNumber(input.height) ?? readNumber(rawMeta.height) ?? null;
    const bandwidth = readNumber(input.bandwidth) ?? readNumber(rawMeta.bandwidth) ?? null;
    const streams = normalizeTrackStreams(input.streams !== undefined ? input.streams : rawMeta.streams);

    // 2. Derive format
    const format = deriveTrackFormat({
        ...input,
        metadata: rawMeta,
        streams,
    });

    // 3. Clean metadata AFTER extraction
    const cleanedMetadata = cleanTrackMetadata(rawMeta);

    return {
        type: input.type,
        purpose: input.purpose,
        quality: input.quality,
        priority: input.priority ?? 0,
        url: input.url ?? null,
        variant_key: input.variant_key,
        is_original: input.is_original ?? true,
        is_default: input.is_default ?? false,
        is_primary: input.is_primary ?? false,
        display_name: input.display_name ?? null,
        language,
        codec,
        duration,
        width,
        height,
        bandwidth,
        format,
        metadata: cleanedMetadata,
    };
}
