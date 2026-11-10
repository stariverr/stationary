import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/global/db";
import { DeleteStatus, File as DbFile, Media, MediaCaption, MediaType } from "@/db/schema";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";
import { assemblePlayback } from "@/features/playback/assembly";
import { CoverService } from "./cover";
import { kindOfState, loadOriginalStates, type OriginalKind, type OriginalState } from "./originals";
import { loadPreviewImages, NO_PREVIEWS } from "./preview";

/** The original a media is shown by: its image (IMAGE, LIVE_PHOTO), video, audio or PDF. */
const MAIN_KIND: Record<MediaType, OriginalKind> = {
    [MediaType.IMAGE]: "IMAGE",
    [MediaType.LIVE_PHOTO]: "IMAGE",
    [MediaType.VIDEO]: "VIDEO",
    [MediaType.AUDIO]: "AUDIO",
    [MediaType.PDF]: "PDF",
};

function mainOriginal(type: MediaType, states: OriginalState[]): OriginalState | undefined {
    return states.find((state) => state.file && kindOfState(state) === MAIN_KIND[type]);
}

const fileUrl = (file: { bucket: string; path: string } | null) => (file ? buildCdnUrl(file.bucket, file.path) : null);

export const MediaService = {
    /** Media details with originals, captions, playback, cover and previews, each loaded once for the whole batch. */
    async getDetails(mediaList: Array<typeof Media.$inferSelect>, startPosition = 0) {
        if (!mediaList.length) return [];
        const mediaIds = mediaList.map((m) => m.id);
        const [previewsByMedia, coversByMedia, statesByMedia, playbackByMedia, captionRows] = await Promise.all([
            loadPreviewImages(mediaIds),
            CoverService.loadUrls(mediaIds),
            loadOriginalStates(db, mediaIds),
            assemblePlayback(mediaIds),
            db
                .select({ caption: MediaCaption, file: DbFile })
                .from(MediaCaption)
                .leftJoin(DbFile, and(eq(DbFile.id, MediaCaption.vtt_file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
                .where(inArray(MediaCaption.media_id, mediaIds))
                .orderBy(asc(MediaCaption.create_time)),
        ]);

        return mediaList.map((media, index) => {
            const states = statesByMedia.get(media.id) ?? [];
            return {
                id: media.id,
                eid: media.eid,
                post_id: media.post_id ?? null,
                source: media.source,
                title: media.title,
                description: media.description,
                type: media.type,
                sort_order: media.sort_order,
                create_time: toIsoTimestamp(media.create_time) ?? undefined,
                published_time: toIsoTimestamp(media.published_time) ?? undefined,
                sync_status: media.sync_status,
                last_error: media.last_error,
                url: fileUrl(mainOriginal(media.type, states)?.file ?? null),
                width: media.display_width,
                height: media.display_height,
                duration: media.duration,
                previews: previewsByMedia.get(media.id) ?? NO_PREVIEWS,
                cover: coversByMedia.get(media.id) ?? null,
                playback: playbackByMedia.get(media.id)?.playback ?? null,
                originals: states.map((state) => ({
                    id: state.original.id,
                    kind: kindOfState(state),
                    url: fileUrl(state.file),
                    mime_type: state.file?.mime_type ?? null,
                    size: state.file?.size ?? null,
                    status: state.original.status,
                    last_error: state.original.last_error,
                })),
                captions: captionRows
                    .filter(({ caption }) => caption.media_id === media.id)
                    .map(({ caption, file }) => ({
                        id: caption.id,
                        origin: caption.origin,
                        language: caption.language,
                        label: caption.label,
                        is_default: caption.is_default,
                        status: caption.status,
                        last_error: caption.last_error,
                        vtt_url: fileUrl(file),
                    })),
                position: startPosition + index,
            };
        });
    },

    async getDetail(media: typeof Media.$inferSelect) {
        const details = await this.getDetails([media]);
        return details[0];
    },

    /** The URL of each media's main original, for lists. */
    async getMainUrls(media: readonly { id: string; type: MediaType }[]): Promise<Map<string, string>> {
        const states = await loadOriginalStates(
            db,
            media.map((item) => item.id),
        );
        const urls = new Map<string, string>();
        for (const item of media) {
            const url = fileUrl(mainOriginal(item.type, states.get(item.id) ?? [])?.file ?? null);
            if (url) urls.set(item.id, url);
        }
        return urls;
    },
};
