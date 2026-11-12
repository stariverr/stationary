/**
 * HLS and DASH manifests (docs/media_refactor.zh-Hans.md, 8.2), generated per request from the playback assembly.
 * A stream comes either from byte ranges of a single-stream fMP4 original, or from segments packaged at request time
 * (8.7) whose URLs carry the same playback signature as the manifest.
 */
import { buildDashManifest, type DashSegments } from "@/lib/utils/dash-manifest";
import {
    buildHlsMasterManifest,
    buildHlsPackagedManifest,
    buildHlsSubtitleManifest,
    buildHlsVariantManifest,
} from "@/lib/utils/hls-manifest";
import { createMediaSignature } from "@/lib/utils/media-signer";
import { packagedSegments } from "@/lib/utils/mp4-packager";
import { parseSidx, type Mp4Segment } from "@/lib/utils/mp4-segment";
import { s3 } from "@/global/s3";
import { createPromiseCache } from "@/features/ai/promise-cache";
import { assemblePlayback, type ManifestStream } from "./assembly";
import { packagedTrack } from "./packaging";

/** A sidx is 12 bytes per segment; 1 MiB covers far more segments than any real file has. */
const SIDX_MAX_BYTES = 1024 * 1024;
/** A file's bytes never change under the same id, so its segment list can be cached for a long time. */
const segmentListCache = createPromiseCache<Mp4Segment[]>(24 * 60 * 60 * 1000, 1000);

type SidxSource = Extract<ManifestStream["source"], { kind: "sidx" }>;

const readSidxSegments = (file: ManifestStream["file"], source: SidxSource) =>
    segmentListCache.getOrCreate(file.id, async () => {
        const { index_offset, index_size } = source.avFile;
        if (index_size > SIDX_MAX_BYTES) throw new Error(`sidx of file ${file.id} is ${index_size} bytes`);
        const range = { start: index_offset, end: index_offset + index_size - 1 };
        const bytes = await s3.read(file.path, { bucket: file.bucket, maxBytes: SIDX_MAX_BYTES, range });
        return parseSidx(bytes, index_offset);
    });

async function readPackagedTrack(source: ManifestStream) {
    const track = await packagedTrack(source.file, source.stream.stream_index);
    if (!track) throw new Error(`stream ${source.stream.id} has no packageable track`);
    return track;
}

/** The signature query the manifest was requested with, or a fresh one for a manifest opened with a session. */
function signatureQuery(mediaId: string, querySuffix?: string) {
    const query = (querySuffix ?? "").replace(/^\?/, "");
    return new URLSearchParams(query).has("sig") ? query : createMediaSignature(mediaId).queryParams;
}

/** Segment URLs live on our server: they never expire mid-playback and need no cookie (8.5). */
const packagedUrl = (mediaId: string, streamId: string, name: string, query: string) =>
    `/api/media/${mediaId}/packaged/${streamId}/${name}?${query}`;

async function dashSegments(mediaId: string, source: ManifestStream, query: string): Promise<DashSegments> {
    if (source.source.kind === "sidx") {
        const { avFile, url } = source.source;
        return {
            kind: "base",
            url,
            segment_base: {
                initialization: `0-${avFile.init_size - 1}`,
                index_range: `${avFile.index_offset}-${avFile.index_offset + avFile.index_size - 1}`,
                timescale: avFile.timescale,
                earliest_presentation_time: String(avFile.earliest_presentation_time),
            },
        };
    }
    const track = await readPackagedTrack(source);
    return {
        kind: "template",
        timescale: track.timescale,
        initialization: packagedUrl(mediaId, source.stream.id, "init.mp4", query),
        media: packagedUrl(mediaId, source.stream.id, "$Number$.m4s", query),
        timeline: packagedSegments(track),
    };
}

const audioLabel = (stream: ManifestStream["stream"], index: number) => stream.label || stream.language || `Audio ${index + 1}`;
const captionLabel = (caption: { label: string | null; language: string | null }, index: number) =>
    caption.label || caption.language || `Caption ${index + 1}`;

async function manifestOf(mediaId: string) {
    return (await assemblePlayback([mediaId])).get(mediaId)?.manifest ?? null;
}

export async function buildMediaDashManifest(mediaId: string, querySuffix?: string): Promise<string | null> {
    const manifest = await manifestOf(mediaId);
    if (!manifest) return null;
    const { video } = manifest;
    const query = signatureQuery(mediaId, querySuffix);
    return buildDashManifest({
        duration: manifest.duration ?? 0,
        video: [
            {
                id: video.stream.id,
                codec: video.stream.codec_string!,
                bandwidth: video.bandwidth,
                width: video.stream.width!,
                height: video.stream.height!,
                frame_rate: video.stream.frame_rate,
                segments: await dashSegments(mediaId, video, query),
            },
        ],
        audio: await Promise.all(
            manifest.audio.map(async (audio, index) => ({
                id: audio.stream.id,
                codec: audio.stream.codec_string!,
                bandwidth: audio.bandwidth,
                language: audio.stream.language,
                label: audioLabel(audio.stream, index),
                role: audio.stream.is_default ? "main" : "alternate",
                channels: audio.stream.channels!,
                sample_rate: audio.stream.sample_rate,
                audio_group_id: audio.stream.id,
                segments: await dashSegments(mediaId, audio, query),
            })),
        ),
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
    if (!manifest) return null;
    const { video } = manifest;
    // CODECS lists every codec a client needs for the variant, audio renditions included.
    const codecs = [...new Set([video.stream.codec_string!, ...manifest.audio.map((audio) => audio.stream.codec_string!)])].join(",");
    return buildHlsMasterManifest({
        media_id: mediaId,
        query_suffix: querySuffix,
        video: [
            {
                track_id: video.stream.id,
                codec: codecs,
                bandwidth: video.bandwidth + Math.max(0, ...manifest.audio.map((audio) => audio.bandwidth)),
                width: video.stream.width!,
                height: video.stream.height!,
                frame_rate: video.stream.frame_rate,
            },
        ],
        audio: manifest.audio.map((audio, index) => ({
            track_id: audio.stream.id,
            codec: audio.stream.codec_string!,
            bandwidth: audio.bandwidth,
            language: audio.stream.language,
            label: audioLabel(audio.stream, index),
            channels: audio.stream.channels!,
            is_default: audio.stream.is_default,
        })),
        subtitle: manifest.captions.map((caption, index) => ({
            track_id: caption.id,
            language: caption.language,
            label: captionLabel(caption, index),
            is_default: caption.is_default,
        })),
    });
}

/** The playlist of one rendition of the master: a stream's fragments, or a caption's WebVTT. */
export async function buildMediaHlsRendition(mediaId: string, renditionId: string, querySuffix?: string): Promise<string | null> {
    const manifest = await manifestOf(mediaId);
    if (!manifest) return null;
    const caption = manifest.captions.find((item) => item.id === renditionId);
    if (caption) return buildHlsSubtitleManifest({ file_url: caption.vtt_url, duration: manifest.duration ?? 0 });

    const source = [manifest.video, ...manifest.audio].find((item) => item.stream.id === renditionId);
    if (!source) return null;
    if (source.source.kind === "sidx") {
        return buildHlsVariantManifest({
            file_url: source.source.url,
            init: { offset: 0, length: source.source.avFile.init_size },
            segments: await readSidxSegments(source.file, source.source),
        });
    }
    const track = await readPackagedTrack(source);
    const query = signatureQuery(mediaId, querySuffix);
    return buildHlsPackagedManifest({
        init_url: packagedUrl(mediaId, source.stream.id, "init.mp4", query),
        segments: packagedSegments(track).map((segment, index) => ({
            url: packagedUrl(mediaId, source.stream.id, `${index}.m4s`, query),
            duration: segment.duration / track.timescale,
        })),
    });
}
