/**
 * Playback assembly (docs/media_refactor.zh-Hans.md, 7): the one place that reads originals, streams and captions to
 * decide how a media plays. The detail DTO, the HLS playlists and the DASH manifest all come from here.
 *
 * The server does not judge codec support: every stream carries its codec string and clients decide.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
    AvStreamType,
    DeleteStatus,
    File as DbFile,
    Media,
    MediaCaption,
    MediaType,
    SyncStatus,
    type AvFile,
    type AvStream,
} from "@/db/schema";
import { db } from "@/global/db";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { createMediaSignature } from "@/lib/utils/media-signer";
import { kindOfState, loadOriginalStates, type OriginalState } from "@/features/media/originals";
import { isPackageableContainer } from "./packaging";

type AvFileRow = typeof AvFile.$inferSelect;
type AvStreamRow = typeof AvStream.$inferSelect;
type FileRow = typeof DbFile.$inferSelect;

export interface PlaybackVideo {
    id: string;
    codec: string;
    codec_string: string | null;
    width: number;
    height: number;
    rotation: number;
    frame_rate: number | null;
}

export interface PlaybackAudioTrack {
    id: string;
    codec: string;
    codec_string: string | null;
    language: string | null;
    label: string | null;
    is_default: boolean;
    channels: number;
    /** Whether `direct_url` carries this track: a client that needs a track it lacks plays a manifest (8.1). */
    in_direct: boolean;
    /** Whether the manifests carry this track; tracks they cannot carry are unavailable when playing them (16). */
    in_manifest: boolean;
}

export interface PlaybackCaption {
    id: string;
    language: string | null;
    label: string | null;
    is_default: boolean;
    vtt_url: string;
}

/** How a media plays (7.1). */
export interface MediaPlayback {
    /** The original that plays as is: the video original of a VIDEO or LIVE_PHOTO, the original of an AUDIO. */
    direct_url: string;
    direct_mime_type: string;
    /** Only when direct play is not enough and the video stream can go in a manifest (8.1, 7 step 4). */
    hls_url: string | null;
    dash_url: string | null;
    duration: number | null;
    video: PlaybackVideo | null;
    audio_tracks: PlaybackAudioTrack[];
    captions: PlaybackCaption[];
}

/** The sidx facts of a single-stream fMP4 original. */
type SidxAvFile = AvFileRow & { init_size: number; index_offset: number; index_size: number; timescale: number; earliest_presentation_time: number };

/**
 * Where a manifest gets a stream's segments (7, step 4): byte ranges of a single-stream fMP4 original with a sidx,
 * or segments packaged at request time from a non-fragmented MP4, MOV or M4A (8.7).
 */
export type ManifestSource = { kind: "sidx"; avFile: SidxAvFile; url: string } | { kind: "packaged" };

/** A stream ready for a manifest. */
export interface ManifestStream {
    stream: AvStreamRow;
    file: FileRow;
    source: ManifestSource;
    bandwidth: number;
}

export interface AssembledPlayback {
    mediaId: string;
    playback: MediaPlayback;
    /** What the manifests list; null when the media has no manifest. */
    manifest: { duration: number | null; video: ManifestStream; audio: ManifestStream[]; captions: PlaybackCaption[] } | null;
}

function manifestSource(state: OriginalState, stream: AvStreamRow): ManifestStream | null {
    const { file, avFile } = state;
    if (!file || !avFile || !stream.codec_string) return null;
    let source: ManifestSource;
    if (avFile.init_size !== null) {
        if (state.streams.length !== 1) return null;
        source = { kind: "sidx", avFile: avFile as SidxAvFile, url: buildCdnUrl(file.bucket, file.path) };
    } else if (isPackageableContainer(avFile.container)) {
        source = { kind: "packaged" };
    } else {
        return null;
    }
    const duration = avFile.duration ?? 0;
    const estimated = file.size && duration > 0 ? Math.round((file.size * 8) / duration / Math.max(1, state.streams.length)) : null;
    return {
        stream,
        file,
        source,
        bandwidth: stream.bitrate ?? estimated ?? (stream.type === AvStreamType.VIDEO ? 2_000_000 : 128_000),
    };
}

function assemble(
    media: { id: string; type: MediaType; duration: number | null },
    states: OriginalState[],
    captions: PlaybackCaption[],
): AssembledPlayback | null {
    if (media.type !== MediaType.VIDEO && media.type !== MediaType.AUDIO && media.type !== MediaType.LIVE_PHOTO) return null;
    const completed = states.filter((state) => state.file && state.avFile);
    const main = completed.find((state) => kindOfState(state) === (media.type === MediaType.AUDIO ? "AUDIO" : "VIDEO"));
    if (!main?.file) return null;

    const videoStream = main.streams.find((stream) => stream.type === AvStreamType.VIDEO) ?? null;
    const audio = completed.flatMap((state) =>
        state.streams.filter((stream) => stream.type === AvStreamType.AUDIO).map((stream) => ({ state, stream })),
    );

    // 8.1: a manifest is offered when direct play cannot give a client everything: several originals, several audio
    // tracks, or captions (which an external player can only get from a manifest). It needs the video stream; audio
    // streams that cannot go in (16) are left out.
    const needsManifest =
        media.type !== MediaType.LIVE_PHOTO && (completed.length > 1 || audio.length > 1 || captions.length > 0);
    let manifest: AssembledPlayback["manifest"] = null;
    if (needsManifest) {
        const video = videoStream ? manifestSource(main, videoStream) : null;
        const audioSources = audio.flatMap(({ state, stream }) => manifestSource(state, stream) ?? []);
        if (video) manifest = { duration: media.duration, video, audio: audioSources, captions };
    }

    const signature = manifest ? createMediaSignature(media.id).queryParams : null;
    return {
        mediaId: media.id,
        manifest,
        playback: {
            direct_url: buildCdnUrl(main.file.bucket, main.file.path),
            direct_mime_type: main.file.mime_type,
            hls_url: signature ? `/api/media/${media.id}/manifest.m3u8?${signature}` : null,
            dash_url: signature ? `/api/media/${media.id}/manifest.mpd?${signature}` : null,
            duration: media.duration,
            video: videoStream
                ? {
                      id: videoStream.id,
                      codec: videoStream.codec,
                      codec_string: videoStream.codec_string,
                      width: videoStream.width!,
                      height: videoStream.height!,
                      rotation: videoStream.rotation ?? 0,
                      frame_rate: videoStream.frame_rate,
                  }
                : null,
            audio_tracks: audio.map(({ state, stream }) => ({
                id: stream.id,
                codec: stream.codec,
                codec_string: stream.codec_string,
                language: stream.language,
                label: stream.label,
                is_default: stream.is_default,
                channels: stream.channels!,
                in_direct: state === main,
                in_manifest: manifest?.audio.some((source) => source.stream.id === stream.id) ?? false,
            })),
            captions,
        },
    };
}

/** Assembles the playback of each media; media that do not play (images, PDFs, unprobed) are left out. */
export async function assemblePlayback(mediaIds: readonly string[]): Promise<Map<string, AssembledPlayback>> {
    const result = new Map<string, AssembledPlayback>();
    if (mediaIds.length === 0) return result;
    const ids = [...mediaIds];
    const [media, states, captionRows] = await Promise.all([
        db.select({ id: Media.id, type: Media.type, duration: Media.duration }).from(Media).where(inArray(Media.id, ids)),
        loadOriginalStates(db, ids),
        db
            .select({ caption: MediaCaption, file: DbFile })
            .from(MediaCaption)
            .innerJoin(DbFile, and(eq(DbFile.id, MediaCaption.vtt_file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(and(inArray(MediaCaption.media_id, ids), eq(MediaCaption.status, SyncStatus.COMPLETED)))
            .orderBy(asc(MediaCaption.create_time)),
    ]);
    for (const row of media) {
        const captions = captionRows
            .filter(({ caption }) => caption.media_id === row.id)
            .map(({ caption, file }) => ({
                id: caption.id,
                language: caption.language,
                label: caption.label,
                is_default: caption.is_default,
                vtt_url: buildCdnUrl(file.bucket, file.path),
            }));
        const assembled = assemble(row, states.get(row.id) ?? [], captions);
        if (assembled) result.set(row.id, assembled);
    }
    return result;
}
