/**
 * Applies the sources an import offers for one media (docs/media_refactor.zh-Hans.md, 6.3): its originals, cover and
 * captions, each matched to what the media has by `source_key`. A known key only refreshes its URL and declarations,
 * a new key waits for the download pipeline, and a key the import no longer offers is deleted. What the user uploaded
 * (no `source_key`) is left alone.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { AssetOrigin, MediaCaption, MediaOriginal, MediaType, SyncStatus } from "@/db/schema";
import type { Transaction } from "@/global/db";
import { deleteCaptions } from "@/features/media/captions";
import { CoverService } from "@/features/media/cover";
import { removeOriginal } from "@/features/media/originals";
import { CAPTION_MEDIA_TYPES } from "@/lib/validation/media-composition";
import type { MediaItemData } from "./schema";

type ImportSources = Pick<MediaItemData, "originals" | "cover" | "captions">;

async function syncOriginals(tx: Transaction, media: { id: string; type: MediaType }, incoming: ImportSources["originals"]): Promise<boolean> {
    const existing = await tx
        .select()
        .from(MediaOriginal)
        .where(and(eq(MediaOriginal.media_id, media.id), isNotNull(MediaOriginal.source_key)))
        .for("update");
    const byKey = new Map(existing.map((original) => [original.source_key!, original]));
    const keys = new Set(incoming.map((original) => original.source_key));

    for (const original of existing) {
        if (!keys.has(original.source_key!)) await removeOriginal(tx, media, original.id);
    }

    let pending = false;
    const now = Temporal.Now.instant();
    for (const original of incoming) {
        const declared = { declared_language: original.language, declared_label: original.label, declared_default: original.is_default };
        const current = byKey.get(original.source_key);
        if (current) {
            await tx
                .update(MediaOriginal)
                .set({ source_url: original.url, ...declared, update_time: now })
                .where(eq(MediaOriginal.id, current.id));
            if (current.status !== SyncStatus.COMPLETED) pending = true;
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

async function syncCaptions(tx: Transaction, media: { id: string; type: MediaType }, incoming: ImportSources["captions"]): Promise<boolean> {
    const offered = CAPTION_MEDIA_TYPES.has(media.type) ? incoming : [];
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
            await tx.update(MediaCaption).set({ source_url: caption.url, update_time: now }).where(eq(MediaCaption.id, current.id));
            if (current.status !== SyncStatus.COMPLETED) pending = true;
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
export async function syncImportedSources(tx: Transaction, media: { id: string; type: MediaType }, sources: ImportSources): Promise<boolean> {
    const originals = await syncOriginals(tx, media, sources.originals);
    const cover = await CoverService.syncImported(tx, media, sources.cover);
    const captions = await syncCaptions(tx, media, sources.captions);
    return originals || cover || captions;
}
