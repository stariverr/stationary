/**
 * Applies the sources an import offers for one media (docs/media_refactor.zh-Hans.md, 6.3): its originals, cover and
 * captions, each matched to what the media has by `source_key` (originals also by their declared kind). A known
 * source only refreshes its URL and declarations, a new one waits for the download pipeline, and one the import no
 * longer offers is deleted.
 * What the user owns stays (docs/failure_handling.zh-Hans.md, 8): uploads (no `source_key`) are left alone and keep
 * their place, sources the user deleted or replaced are not brought back, and sources are taken by the media's
 * effective type, which is the user's when they changed it.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { AssetOrigin, MediaCaption, MediaOriginal, MediaType, SyncStatus, type OriginalKind } from "@/db/schema";
import type { Transaction } from "@/global/db";
import { deleteCaptions } from "@/features/media/captions";
import { CoverService } from "@/features/media/cover";
import { kindOfOriginal, loadOriginalStates, removeOriginal } from "@/features/media/originals";
import { sourceKeyOf } from "@/features/media/ownership";
import { refreshSource } from "@/features/media/source-rows";
import { CAPTION_MEDIA_TYPES, hasRoomFor } from "@/lib/validation/media-composition";
import type { MediaItemData } from "./schema";
import { Priority } from "@/infra/queue/policy";

type ImportSources = Pick<MediaItemData, "originals" | "cover" | "captions">;

/** The media an import applies its sources to, with its effective type and the sources the user excluded. */
export interface ImportTarget {
    id: string;
    type: MediaType;
    excluded_source_keys: readonly string[];
}

/**
 * The offered originals the media takes: not excluded, and with room for their declared kind in the effective type
 * once the uploads have taken theirs (8.3). The first offered of a kind wins.
 */
function takenOriginals(media: ImportTarget, uploadKinds: OriginalKind[], incoming: ImportSources["originals"]) {
    const kinds = [...uploadKinds];
    return incoming.filter((original) => {
        if (media.excluded_source_keys.includes(sourceKeyOf("original", original.source_key))) return false;
        if (!hasRoomFor(media.type, kinds, original.kind)) return false;
        kinds.push(original.kind);
        return true;
    });
}

async function syncOriginals(tx: Transaction, media: ImportTarget, offered: ImportSources["originals"]): Promise<boolean> {
    await tx.select({ id: MediaOriginal.id }).from(MediaOriginal).where(eq(MediaOriginal.media_id, media.id)).for("update");
    const states = (await loadOriginalStates(tx, [media.id])).get(media.id) ?? [];
    const uploadKinds = states.flatMap((state) => {
        const kind = state.original.source_key ? null : kindOfOriginal(state);
        return kind ? [kind] : [];
    });
    const incoming = takenOriginals(media, uploadKinds, offered);
    // An original is known by its key and declared kind: its file was checked against that kind, so a key declared
    // with another kind is a new original.
    const taken = new Map(incoming.map((original) => [original.source_key, original.kind]));
    const existing = states.map((state) => state.original).filter((original) => original.source_key !== null);
    const kept = existing.filter((original) => taken.get(original.source_key!) === original.declared_kind);
    const byKey = new Map(kept.map((original) => [original.source_key!, original]));

    for (const original of existing) {
        if (!byKey.has(original.source_key!)) await removeOriginal(tx, media, original.id, Priority.CHANGE);
    }

    let pending = false;
    const now = Temporal.Now.instant();
    for (const original of incoming) {
        const declared = {
            declared_kind: original.kind,
            declared_language: original.language,
            declared_label: original.label,
            declared_default: original.is_default,
        };
        const current = byKey.get(original.source_key);
        if (current) {
            const refreshed = refreshSource(current, original.url);
            await tx
                .update(MediaOriginal)
                .set({ ...refreshed.values, ...declared, update_time: now })
                .where(eq(MediaOriginal.id, current.id));
            if (refreshed.pending) pending = true;
            continue;
        }
        await tx.insert(MediaOriginal).values({
            media_id: media.id,
            source_url: original.url,
            source_key: original.source_key,
            ...declared,
            status: SyncStatus.PENDING,
        });
        pending = true;
    }
    return pending;
}

async function syncCaptions(tx: Transaction, media: ImportTarget, incoming: ImportSources["captions"]): Promise<boolean> {
    const offered = CAPTION_MEDIA_TYPES.has(media.type)
        ? incoming.filter((caption) => !media.excluded_source_keys.includes(sourceKeyOf("caption", caption.source_key)))
        : [];
    const existing = await tx
        .select()
        .from(MediaCaption)
        .where(and(eq(MediaCaption.media_id, media.id), isNotNull(MediaCaption.source_key)))
        .for("update");
    const byKey = new Map(existing.map((caption) => [caption.source_key!, caption]));
    const keys = new Set(offered.map((caption) => caption.source_key));
    await deleteCaptions(
        tx,
        media.id,
        existing.filter((caption) => !keys.has(caption.source_key!)).map((caption) => caption.id),
    );

    let pending = false;
    const now = Temporal.Now.instant();
    for (const caption of offered) {
        const current = byKey.get(caption.source_key);
        if (current) {
            // Language, label and default are the caption's own fields, which the user may have edited since.
            const refreshed = refreshSource(current, caption.url);
            await tx
                .update(MediaCaption)
                .set({ ...refreshed.values, update_time: now })
                .where(eq(MediaCaption.id, current.id));
            if (refreshed.pending) pending = true;
            continue;
        }
        if (caption.is_default) {
            await tx
                .update(MediaCaption)
                .set({ is_default: false })
                .where(and(eq(MediaCaption.media_id, media.id), eq(MediaCaption.is_default, true)));
        }
        await tx.insert(MediaCaption).values({
            media_id: media.id,
            origin: AssetOrigin.FILE,
            language: caption.language,
            label: caption.label,
            is_default: caption.is_default,
            source_url: caption.url,
            source_key: caption.source_key,
            status: SyncStatus.PENDING,
        });
        pending = true;
    }
    return pending;
}

/** Applies the offered sources; returns whether any of them still needs a download. */
export async function syncImportedSources(tx: Transaction, media: ImportTarget, sources: ImportSources): Promise<boolean> {
    const originals = await syncOriginals(tx, media, sources.originals);
    // An excluded cover is as good as not offered: an imported cover of another key the media has goes with it.
    const offeredCover =
        sources.cover && !media.excluded_source_keys.includes(sourceKeyOf("cover", sources.cover.source_key)) ? sources.cover : null;
    const cover = await CoverService.syncImported(tx, media, offeredCover, Priority.CHANGE);
    const captions = await syncCaptions(tx, media, sources.captions);
    return originals || cover || captions;
}
