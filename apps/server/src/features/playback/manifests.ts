/**
 * HLS and DASH manifests (docs/media_refactor.zh-Hans.md, 8.2), generated per request from the playback assembly.
 * Both reference the same bytes of the same single-stream fMP4 files.
 */
import { buildDashManifest, type DashSegmentBase } from "@/lib/utils/dash-manifest";
import { buildHlsMasterManifest, buildHlsSubtitleManifest, buildHlsVariantManifest } from "@/lib/utils/hls-manifest";
import { parseSidx, type Mp4Segment } from "@/lib/utils/mp4-segment";
import { s3 } from "@/global/s3";
import { createPromiseCache } from "@/features/ai/promise-cache";
import { assemblePlayback, type ManifestStream } from "./assembly";

/** A sidx is 12 bytes per segment; 1 MiB covers far more segments than any real file has. */
const SIDX_MAX_BYTES = 1024 * 1024;
/** A file's bytes never change under the same id, so its segment list can be cached for a long time. */
const segmentListCache = createPromiseCache<Mp4Segment[]>(24 * 60 * 60 * 1000, 1000);

const readSegmentList = (source: ManifestStream) =>
    segmentListCache.getOrCreate(source.file.id, async () => {
        const { index_offset, index_size } = source.avFile;
        if (index_size > SIDX_MAX_BYTES) throw new Error(`sidx of file ${source.file.id} is ${index_size} bytes`);
        const range = { start: index_offset, end: index_offset + index_size - 1 };
        const bytes = await s3.read(source.file.path, { bucket: source.file.bucket, maxBytes: SIDX_MAX_BYTES, range });
        return parseSidx(bytes, index_offset);
    });

const segmentBase = ({ avFile }: ManifestStream): DashSegmentBase => ({
    initialization: `0-${avFile.init_size - 1}`,
    index_range: `${avFile.index_offset}-${avFile.index_offset + avFile.index_size - 1}`,
    timescale: avFile.timescale,
    earliest_presentation_time: String(avFile.earliest_presentation_time),
});

const audioLabel = (stream: ManifestStream["stream"], index: number) => stream.label || stream.language || `Audio ${index + 1}`;
const captionLabel = (caption: { label: string | null; language: string | null }, index: number) =>
    caption.label || caption.language || `Caption ${index + 1}`;

async function manifestOf(mediaId: string) {
    return (await assemblePlayback([mediaId])).get(mediaId)?.manifest ?? null;
}

export async function buildMediaDashManifest(mediaId: string): Promise<string | null> {
    const manifest = await manifestOf(mediaId);
    if (!manifest?.video) return null;
    const { video } = manifest;
    return buildDashManifest({
        duration: manifest.duration ?? video.avFile.duration ?? 0,
        video: [
            {
                id: video.stream.id,
                url: video.url,
                codec: video.stream.codec_string!,
                bandwidth: video.bandwidth,
                width: video.stream.width!,
                height: video.stream.height!,
                frame_rate: video.stream.frame_rate,
                segment_base: segmentBase(video),
            },
        ],
        audio: manifest.audio.map((audio, index) => ({
            id: audio.stream.id,
            url: audio.url,
            codec: audio.stream.codec_string!,
            bandwidth: audio.bandwidth,
            language: audio.stream.language,
            label: audioLabel(audio.stream, index),
            role: audio.stream.is_default ? "main" : "alternate",
            channels: audio.stream.channels!,
            sample_rate: audio.stream.sample_rate,
            audio_group_id: audio.stream.id,
            segment_base: segmentBase(audio),
        })),
        text: manifest.captions.map((caption, index) => ({
            id: caption.id,
            url: caption.vtt_url,
            language: caption.language,
            label: captionLabel(caption, index),
            is_default: caption.is_default,
        })),
    });
}

export async function buildMediaHlsMaster(mediaId: string, querySuffix?: string): Promise<string | null> {
    const manifest = await manifestOf(mediaId);
    if (!manifest?.video) return null;
    const { video } = manifest;
    // CODECS lists every codec a client needs for the variant, audio renditions included.
    const codecs = [...new Set([video.stream.codec_string!, ...manifest.audio.map((audio) => audio.stream.codec_string!)])].join(",");
    return buildHlsMasterManifest({
        media_id: mediaId,
        query_suffix: querySuffix,
        video: [
            {
                track_id: video.stream.id,
                url: video.url,
                codec: codecs,
                bandwidth: video.bandwidth + Math.max(0, ...manifest.audio.map((audio) => audio.bandwidth)),
                width: video.stream.width!,
                height: video.stream.height!,
                frame_rate: video.stream.frame_rate,
            },
        ],
        audio: manifest.audio.map((audio, index) => ({
            track_id: audio.stream.id,
            url: audio.url,
            codec: audio.stream.codec_string!,
            bandwidth: audio.bandwidth,
            language: audio.stream.language,
            label: audioLabel(audio.stream, index),
            channels: audio.stream.channels!,
            is_default: audio.stream.is_default,
        })),
        subtitle: manifest.captions.map((caption, index) => ({
            track_id: caption.id,
            url: caption.vtt_url,
            language: caption.language,
            label: captionLabel(caption, index),
            is_default: caption.is_default,
        })),
    });
}

/** The playlist of one rendition of the master: a stream's fragments by byte range, or a caption's WebVTT. */
export async function buildMediaHlsRendition(mediaId: string, renditionId: string): Promise<string | null> {
    const manifest = await manifestOf(mediaId);
    if (!manifest) return null;
    const caption = manifest.captions.find((item) => item.id === renditionId);
    if (caption) return buildHlsSubtitleManifest({ file_url: caption.vtt_url, duration: manifest.duration ?? 0 });

    const source = [manifest.video, ...manifest.audio].find((item) => item?.stream.id === renditionId);
    if (!source) return null;
    return buildHlsVariantManifest({
        file_url: source.url,
        init: { offset: 0, length: source.avFile.init_size },
        segments: await readSegmentList(source),
    });
}
