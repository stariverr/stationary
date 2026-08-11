import { TrackType, TrackPurpose, Track, SyncStatus } from "@/db/schema";
import { generateDeterministicVariantKey } from "@/lib/utils/track";
import { normalizeIncomingTrack, type TrackFormatFields } from "@/lib/utils/track-format";
import type { MediaItemData } from "@/api/schemas/ingest";

export type IncomingTrack = MediaItemData["tracks"][number];
export type ExistingTrack = typeof Track.$inferSelect;

export type PreparedTrack = IncomingTrack & {
    variant_key: string;
    is_default: boolean;
    format: TrackFormatFields;
    metadata_signature: string;
    streams_signature: string;
    priority: number;
    language: string | null;
    codec: string | null;
    duration: number | null;
    width: number | null;
    height: number | null;
    bandwidth: number | null;
};

export type TrackMetadataFields = {
    language?: string | null;
    codec?: string | null;
};

export function getTrackMetadataFields(track: { language?: unknown; codec?: unknown }): TrackMetadataFields {
    return {
        language: typeof track.language === "string" ? track.language : null,
        codec: typeof track.codec === "string" ? track.codec : null,
    };
}

export const trackGroupKey = (type: TrackType, purpose: TrackPurpose) => `${type}:${purpose}`;

export const trackIdentityKey = (track: Pick<IncomingTrack, "type" | "purpose"> & { variant_key: string }) =>
    `${trackGroupKey(track.type, track.purpose)}:${track.variant_key}`;

export function prepareIncomingTracks(tracks: IncomingTrack[]): PreparedTrack[] {
    const prepared = tracks.map((track) => {
        const normalized = normalizeIncomingTrack(track);
        const baseKey = generateDeterministicVariantKey(
            {
                type: track.type,
                purpose: track.purpose,
                quality: track.quality,
                priority: normalized.priority,
                is_original: normalized.is_original,
                metadata: track.metadata,
                language: normalized.language ?? undefined,
                codec: normalized.codec ?? undefined,
                width: normalized.width,
                height: normalized.height,
            },
            null,
        );

        return {
            ...track,
            priority: normalized.priority,
            language: normalized.language,
            codec: normalized.codec,
            duration: normalized.duration,
            width: normalized.width,
            height: normalized.height,
            bandwidth: normalized.bandwidth,
            metadata: normalized.metadata,
            baseKey,
            format: normalized.format,
            metadata_signature: JSON.stringify(normalized.metadata),
            streams_signature: JSON.stringify(normalized.format.streams),
        };
    });

    const seenKeys = new Set<string>();
    const defaultKeys = new Map<string, string>();
    const keyedTracks = prepared.map(({ baseKey, ...track }) => {
        let variantKey = baseKey;
        let duplicateIndex = 1;
        const duplicateKey = () => `${trackIdentityKey({ ...track, variant_key: variantKey })}`;

        while (seenKeys.has(duplicateKey())) {
            duplicateIndex += 1;
            variantKey = `${baseKey}-dup-${duplicateIndex}`;
        }
        seenKeys.add(duplicateKey());

        return {
            ...track,
            variant_key: variantKey,
        };
    });

    for (const track of keyedTracks) {
        if (track.priority === 0) {
            const groupKey = trackGroupKey(track.type, track.purpose);
            if (!defaultKeys.has(groupKey)) defaultKeys.set(groupKey, track.variant_key);
        }
    }

    return keyedTracks.map((track) => ({
        ...track,
        is_default: defaultKeys.get(trackGroupKey(track.type, track.purpose)) === track.variant_key,
    }));
}

export function hasTrackPayloadChanged(existing: ExistingTrack, incoming: PreparedTrack): boolean {
    const metadataFields = getTrackMetadataFields(incoming);
    return (
        existing.source_url !== incoming.url ||
        existing.is_original !== incoming.is_original ||
        existing.quality !== incoming.quality ||
        existing.sync_status === SyncStatus.FAILED ||
        existing.language !== metadataFields.language ||
        existing.codec !== metadataFields.codec ||
        existing.container !== incoming.format.container ||
        existing.is_fragmented !== incoming.format.is_fragmented ||
        existing.stream_layout !== incoming.format.stream_layout ||
        existing.has_video !== incoming.format.has_video ||
        existing.has_audio !== incoming.format.has_audio ||
        JSON.stringify(existing.streams || []) !== incoming.streams_signature ||
        JSON.stringify(existing.metadata || {}) !== incoming.metadata_signature
    );
}

export function trackNeedsProcessing(existing: ExistingTrack, incoming: PreparedTrack): boolean {
    return existing.sync_status === SyncStatus.PENDING || hasTrackPayloadChanged(existing, incoming);
}

export function getTrackPresentationUpdates(existing: ExistingTrack, incoming: PreparedTrack): Partial<typeof Track.$inferInsert> {
    const updates: Partial<typeof Track.$inferInsert> = {};
    if (existing.priority !== incoming.priority) updates.priority = incoming.priority;
    if (existing.is_default !== incoming.is_default) updates.is_default = incoming.is_default;
    return updates;
}
