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
    /** Only when streaming is needed and every stream it needs is a single-stream fMP4 (8.1, 7 step 4). */
    hls_url: string | null;
    dash_url: string | null;
    duration: number | null;
    video: PlaybackVideo | null;
    audio_tracks: PlaybackAudioTrack[];
    captions: PlaybackCaption[];
}

/** A stream with the single-stream fMP4 that carries it, ready for a manifest. */
export interface ManifestStream {
    stream: AvStreamRow;
    file: FileRow;
    avFile: AvFileRow & { init_size: number; index_offset: number; index_size: number; timescale: number; earliest_presentation_time: number };
    url: string;
    bandwidth: number;
}

export interface AssembledPlayback {
    mediaId: string;
    playback: MediaPlayback;
    /** What the manifests list; null when the media plays directly. */
    manifest: { duration: number | null; video: ManifestStream | null; audio: ManifestStream[]; captions: PlaybackCaption[] } | null;
}

/** A file is usable in a manifest when it is an fMP4 with a sidx holding exactly this one stream. */
function manifestSource(state: OriginalState, stream: AvStreamRow): ManifestStream | null {
    const { file, avFile } = state;
    if (!file || !avFile || avFile.init_size === null || state.streams.length !== 1 || !stream.codec_string) return null;
    const duration = avFile.duration ?? 0;
    const estimated = file.size && duration > 0 ? Math.round((file.size * 8) / duration) : null;
    return {
        stream,
        file,
        avFile: avFile as ManifestStream["avFile"],
        url: buildCdnUrl(file.bucket, file.path),
        bandwidth: stream.bitrate ?? avFile.bitrate ?? estimated ?? (stream.type === AvStreamType.VIDEO ? 2_000_000 : 128_000),
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

    // 8.1: one original with at most one audio track plays directly; anything else needs a manifest.
    const needsStreaming = media.type !== MediaType.LIVE_PHOTO && (completed.length > 1 || audio.length > 1);
    let manifest: AssembledPlayback["manifest"] = null;
    if (needsStreaming) {
        const video = videoStream ? manifestSource(main, videoStream) : null;
        const audioSources = audio.flatMap(({ state, stream }) => manifestSource(state, stream) ?? []);
        // Streams without a single-stream fMP4 wait for a remux (phase 3); without the video there is nothing to
        // stream yet. An AUDIO media has a single original, so it only needs a manifest once remuxes exist.
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
            audio_tracks: audio.map(({ stream }) => ({
                id: stream.id,
                codec: stream.codec,
                codec_string: stream.codec_string,
                language: stream.language,
                label: stream.label,
                is_default: stream.is_default,
                channels: stream.channels!,
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
