import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { AssetAiMetadata, DeleteStatus, EntityType, Media } from "@/db/schema";
import { db, type DbClient, type Transaction } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { ReconcileContext, SubjectPipelineHandler } from "@/infra/queue/types";
import { aiErrorResult } from "./pipeline-result";
import { aiSourceHash, loadAiImageSources, readAiSourceImage, resolveAiImageSource } from "./image-source";
import { AiService, providerBlockedMs } from "./service";
import type { DescribeTarget } from "./types";
import { computeSha256 } from "./utils";

type StoredAiMetadata = typeof AssetAiMetadata.$inferSelect;

const metadataOf = (mediaIds: readonly string[]) =>
    and(eq(AssetAiMetadata.entity_type, EntityType.MEDIA), inArray(AssetAiMetadata.entity_id, [...mediaIds]));

const activeMedia = and(eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));

/**
 * Whether the stored description still stands: it was made from the same image in the current language, and no
 * re-description was asked for. A description of another model or an older prompt version is still usable; a
 * re-description request marks those stale. A failure left on it was recorded for another image, and describing this
 * one again clears it.
 */
export function canReuseDescription(
    stored: Pick<StoredAiMetadata, "input_hash" | "language" | "is_stale" | "last_error"> | undefined,
    sourceHash: string | null,
    target: DescribeTarget,
): boolean {
    if (!stored || !sourceHash || stored.input_hash !== sourceHash) return false;
    return stored.language === target.language && !stored.is_stale && stored.last_error === null;
}

/** Identifies one describe attempt: the source image and what it is described with. */
export function describeInputHash(sourceHash: string, target: DescribeTarget): Promise<string> {
    return computeSha256(
        JSON.stringify({ sourceHash, model: target.model, promptVersion: target.promptVersion, language: target.language }),
    );
}

/** Deletes the description a media kept from its previous library (§11.13 #2); the new library describes it again. */
async function dropForeignDescription(
    tx: Transaction,
    mediaId: string,
    libraryId: string,
    fence: ReconcileContext["fence"],
): Promise<void> {
    const deleted = await tx
        .delete(AssetAiMetadata)
        .where(and(metadataOf([mediaId]), sql`${AssetAiMetadata.library_id} <> ${libraryId}`))
        .returning({ id: AssetAiMetadata.id });
    await fence(tx);
    if (deleted.length > 0) await markChanged(tx, Aspect.MEDIA_DESCRIPTION, [mediaId]);
}

const failedDescriptions = (libraryIds: readonly string[]) =>
    and(
        inArray(AssetAiMetadata.library_id, [...libraryIds]),
        eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
        isNotNull(AssetAiMetadata.last_error),
        activeMedia,
    );

/**
 * `ai.describe`: describes the media's best image (a current cover, else image content) with the library's describe
 * model, in the library's language. Waits while the cover pipeline still has the media queued.
 */
export const describePipeline: SubjectPipelineHandler = {
    async reconcile(ctx) {
        const [media] = await db
            .select({ id: Media.id, libraryId: Media.library_id })
            .from(Media)
            .where(and(eq(Media.id, ctx.subjectId), activeMedia))
            .limit(1);
        if (!media) return { kind: "done" };

        let stored: StoredAiMetadata | undefined = (
            await db
                .select()
                .from(AssetAiMetadata)
                .where(metadataOf([media.id]))
                .limit(1)
        )[0];
        if (stored && stored.library_id !== media.libraryId) {
            await db.transaction((tx) => dropForeignDescription(tx, media.id, media.libraryId, ctx.fence));
            stored = undefined;
        }

        const service = await AiService.forLibrary(media.libraryId, "background");
        const target = service?.describeTarget;
        if (!service || !target) return { kind: "done" };

        const { source, waitingForCover } = await resolveAiImageSource(media.id);
        // No image to describe: coverage counts the media as having no image work.
        if (!source || waitingForCover) return { kind: "done" };
        const sourceHash = aiSourceHash(source.file);
        if (canReuseDescription(stored, sourceHash, target)) return { kind: "done" };

        let described;
        try {
            const image = await readAiSourceImage(source.file, ctx.signal);
            described = await service.describeImage(image, source.file.mime_type, ctx.signal);
        } catch (error) {
            return aiErrorResult(error);
        }

        const result = {
            caption: described.caption,
            tags: described.tags,
            objects: described.objects,
            colors: described.colors,
            styles: described.styles,
            scene: described.scene,
            ocr_text: described.ocrText,
            model: target.model,
            prompt_version: target.promptVersion,
            language: target.language,
            input_hash: sourceHash,
            is_stale: false,
            last_error: null,
            error_kind: null,
            error_input_hash: null,
        };
        await db.transaction(async (tx) => {
            await tx
                .insert(AssetAiMetadata)
                .values({ library_id: media.libraryId, entity_type: EntityType.MEDIA, entity_id: media.id, ...result })
                .onConflictDoUpdate({
                    target: [AssetAiMetadata.entity_type, AssetAiMetadata.entity_id],
                    set: { ...result, library_id: media.libraryId, update_time: sql`now()` },
                });
            await ctx.fence(tx);
            await markChanged(tx, Aspect.MEDIA_DESCRIPTION, [media.id]);
        });
        return { kind: "done" };
    },

    /** Records the error with the input; a stored description stays, and so does what it was made with. */
    async recordFailure(tx, { subjectId, error, errorKind }) {
        const [media] = await tx
            .select({ libraryId: Media.library_id })
            .from(Media)
            .where(and(eq(Media.id, subjectId), activeMedia))
            .limit(1);
        const target = media ? (await AiService.forLibrary(media.libraryId))?.describeTarget : null;
        const { source } = await resolveAiImageSource(subjectId);
        if (!media || !target || !source) return;

        const failure = {
            last_error: error,
            error_kind: errorKind,
            error_input_hash: await describeInputHash(aiSourceHash(source.file), target),
        };
        await tx
            .insert(AssetAiMetadata)
            .values({
                library_id: media.libraryId,
                entity_type: EntityType.MEDIA,
                entity_id: subjectId,
                model: target.model,
                prompt_version: target.promptVersion,
                language: target.language,
                ...failure,
            })
            .onConflictDoUpdate({
                target: [AssetAiMetadata.entity_type, AssetAiMetadata.entity_id],
                set: { ...failure, update_time: sql`now()` },
            });
    },

    async scanPage(libraryId, cursor, limit) {
        const page = await db
            .select({ id: Media.id })
            .from(Media)
            .where(and(eq(Media.library_id, libraryId), activeMedia, ...(cursor ? [gt(Media.id, cursor)] : [])))
            .orderBy(asc(Media.id))
            .limit(limit);
        const nextCursor = page.length === limit ? page[page.length - 1]!.id : null;
        const target = (await AiService.forLibrary(libraryId))?.describeTarget;
        if (!target || page.length === 0) return { subjectIds: [], nextCursor };

        const ids = page.map((media) => media.id);
        const [sources, storedRows] = await Promise.all([
            loadAiImageSources(ids),
            db.select().from(AssetAiMetadata).where(metadataOf(ids)),
        ]);
        const storedById = new Map(storedRows.map((row) => [row.entity_id, row]));

        const subjectIds: string[] = [];
        for (const id of ids) {
            const stored = storedById.get(id);
            if (stored && stored.library_id !== libraryId) {
                subjectIds.push(id);
                continue;
            }
            const source = sources.get(id);
            if (!source) continue;
            const sourceHash = aiSourceHash(source.file);
            if (canReuseDescription(stored, sourceHash, target)) continue;
            if (stored?.error_input_hash && stored.error_input_hash === (await describeInputHash(sourceHash, target))) continue;
            subjectIds.push(id);
        }
        return { subjectIds, nextCursor };
    },

    async blockedMs(libraryId) {
        const provider = (await AiService.forLibrary(libraryId))?.describeProvider;
        return provider ? providerBlockedMs(provider.providerId) : 0;
    },

    async countFailures(libraryIds) {
        if (libraryIds.length === 0) return new Map();
        const rows = await db
            .select({ libraryId: AssetAiMetadata.library_id, count: sql<number>`count(*)::int` })
            .from(AssetAiMetadata)
            .innerJoin(Media, eq(Media.id, AssetAiMetadata.entity_id))
            .where(failedDescriptions(libraryIds))
            .groupBy(AssetAiMetadata.library_id);
        return new Map(rows.map((row) => [row.libraryId, row.count]));
    },

    async listFailures(libraryId, limit) {
        const query = db
            .select({
                subjectId: AssetAiMetadata.entity_id,
                label: Media.title,
                error: AssetAiMetadata.last_error,
                time: AssetAiMetadata.update_time,
            })
            .from(AssetAiMetadata)
            .innerJoin(Media, eq(Media.id, AssetAiMetadata.entity_id))
            .where(failedDescriptions([libraryId]))
            .orderBy(desc(AssetAiMetadata.update_time))
            .$dynamic();
        const rows = limit === undefined ? await query : await query.limit(limit);
        return rows.map((row) => ({ ...row, error: row.error ?? "" }));
    },
};

/**
 * A re-description request: descriptions another model or an older prompt version wrote are made again with the
 * current ones. Call it in the transaction that asks for it; the scan it queues does the work.
 */
export async function requestRedescribe(client: DbClient, libraryId: string, target: DescribeTarget): Promise<void> {
    await client
        .update(AssetAiMetadata)
        .set({ is_stale: true, update_time: sql`now()` })
        .where(
            and(
                eq(AssetAiMetadata.library_id, libraryId),
                eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
                isNotNull(AssetAiMetadata.input_hash),
                sql`(${AssetAiMetadata.model} <> ${target.model} OR ${AssetAiMetadata.prompt_version} <> ${target.promptVersion})`,
            ),
        );
    await markChanged(client, Aspect.LIBRARY_AI_CONFIG, [libraryId]);
}
