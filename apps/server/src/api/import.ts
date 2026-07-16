import { Context, Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { validator } from "hono/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import { DraftFile, DraftFileStatus, File as DbFile, Library, Media, PostSource, DeleteStatus, SyncStatus } from "@/db/schema";
import { s3 } from "@/global/s3";
import { and, eq, desc } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { nowDbTimestamp } from "@/lib/utils/time";
import { v7 as uuidv7 } from "uuid";
import { env } from "@/global/env";
import crypto from "crypto";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { TrackService } from "@/services/track";
import { replaceMediaTagsTx } from "@/services/media";
import { consumeDraftFile, deleteDraftFile, DraftFileUnavailableError } from "@/services/draft-file";
import { getFileExtension, getMimeTypeByExt } from "@/lib/utils/file";
import {
    assignTrackPriorities,
    validateDraftMediaGroups as validateMediaDraft,
    validateDraftTrackFileTypes,
    MediaDraftSchema,
} from "@/lib/validation/media-composition";

const router = new Hono<AuthEnv>();

// Helper to check library access
async function checkLibraryAccess(c: Context, libraryId: string): Promise<any | null> {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }
    const libraryList = await db.select().from(Library).where(eq(Library.id, libraryId)).limit(1);
    const library = libraryList[0];
    if (!library || library.owner_id !== user.id) {
        return c.json(error(Code.FORBIDDEN, "You do not have access to this library"), 403);
    }
    const apiToken = c.get("apiToken");
    if (apiToken && apiToken.library_id && apiToken.library_id !== libraryId) {
        return c.json(error(Code.FORBIDDEN, "API token scope restricted to another library"), 403);
    }
    return null;
}

// Token generation and verification helpers
function generateUploadToken(libraryId: string, path: string, expiresAt: number): string {
    const data = `${libraryId}:${path}:${expiresAt}`;
    const hmac = crypto.createHmac("sha256", env.AUTH_SECRET);
    hmac.update(data);
    const signature = hmac.digest("hex");
    return `${expiresAt}.${signature}`;
}

function verifyUploadToken(libraryId: string, path: string, token: string): boolean {
    try {
        const [expiresAtStr, signature] = token.split(".");
        if (!expiresAtStr || !signature) return false;

        const expiresAt = parseInt(expiresAtStr, 10);
        if (Date.now() > expiresAt) return false; // Expired

        const data = `${libraryId}:${path}:${expiresAt}`;
        const hmac = crypto.createHmac("sha256", env.AUTH_SECRET);
        hmac.update(data);
        const expectedSignature = hmac.digest("hex");

        return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSignature, "hex"));
    } catch {
        return false;
    }
}

// 1. Presign Upload URL for Draft File
const PresignDraftSchema = z.object({
    library_id: z.uuid(),
    fileName: z.string().min(1, "fileName is required"),
});

router.post(
    "/draft/presign",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = PresignDraftSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, parsed.error.issues[0]?.message || "Invalid parameters"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const { library_id, fileName } = c.req.valid("json");
        const user = c.get("user");
        if (!user) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }

        const accessErr = await checkLibraryAccess(c, library_id);
        if (accessErr) return accessErr;

        const ext = getFileExtension(fileName) || "bin";
        const fileId = uuidv7();
        const path = `v2/l/${library_id.slice(-2)}/${library_id}/drafts/${fileId}.${ext}`;
        const mimeType = getMimeTypeByExt(ext);

        const uploadUrl = await s3.getUploadPresignedUrl(path, {
            bucket: env.S3_BUCKET,
            contentType: mimeType,
            expiresInSeconds: 3600, // 1 hour expiration
        });

        // Token expires in 1 hour
        const expiresAt = Date.now() + 3600 * 1000;
        const uploadToken = generateUploadToken(library_id, path, expiresAt);

        // Pre-create pending draft file and db file records
        const draftFileId = await db.transaction(async (tx) => {
            const [newFile] = await tx
                .insert(DbFile)
                .values({
                    path: path,
                    bucket: env.S3_BUCKET,
                    mime_type: mimeType,
                    extension: ext,
                    size: 0,
                    delete_status: DeleteStatus.ACTIVE,
                })
                .returning();

            const [newDraft] = await tx
                .insert(DraftFile)
                .values({
                    file_id: newFile.id,
                    library_id: library_id,
                    owner_id: user.id,
                    original_name: fileName,
                    status: DraftFileStatus.PENDING,
                })
                .returning();

            return newDraft.id;
        });

        return c.json(
            success(Code.SUCCESS, {
                url: uploadUrl,
                path: path,
                bucket: env.S3_BUCKET,
                mime_type: mimeType,
                upload_token: uploadToken,
                draft_file_id: draftFileId,
            }),
        );
    },
);

// 2. Confirm Upload and Register as DraftFile
const ConfirmDraftSchema = z.object({
    library_id: z.uuid(),
    draft_file_id: z.uuid(),
    fileName: z.string().min(1, "fileName is required"),
    path: z.string().min(1),
    bucket: z.string().min(1),
    mime_type: z.string().min(1),
    size: z.number().int().nonnegative(),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    duration: z.number().nullable().optional(),
    upload_token: z.string().min(1),
});

router.post(
    "/draft/confirm",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = ConfirmDraftSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, parsed.error.issues[0]?.message || "Invalid parameters"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const body = c.req.valid("json");
        const user = c.get("user");
        if (!user) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }

        const accessErr = await checkLibraryAccess(c, body.library_id);
        if (accessErr) return accessErr;

        // Verify upload token
        const isValidToken = verifyUploadToken(body.library_id, body.path, body.upload_token);
        if (!isValidToken) {
            return c.json(error(Code.INVALID_PARAMETER, "Invalid or expired upload token"), 400);
        }

        const fileExtension = getFileExtension(body.fileName) || "bin";
        const pathExtension = getFileExtension(body.path);
        const expectedMimeType = getMimeTypeByExt(fileExtension);
        const expectedPathPrefix = `v2/l/${body.library_id.slice(-2)}/${body.library_id}/drafts/`;
        if (body.bucket !== env.S3_BUCKET) {
            return c.json(error(Code.INVALID_PARAMETER, "Draft upload bucket does not match the presigned upload"), 400);
        }
        if (!body.path.startsWith(expectedPathPrefix) || pathExtension !== fileExtension) {
            return c.json(error(Code.INVALID_PARAMETER, "Draft upload path does not match the selected file"), 400);
        }
        if (body.mime_type !== expectedMimeType) {
            return c.json(error(Code.INVALID_PARAMETER, "Draft MIME type does not match the selected file"), 400);
        }

        const draftRow = await db
            .select()
            .from(DraftFile)
            .where(and(eq(DraftFile.id, body.draft_file_id), eq(DraftFile.library_id, body.library_id)))
            .limit(1)
            .then((rows) => rows[0]);

        if (!draftRow) {
            return c.json(error(Code.NOT_FOUND, "Draft file not found"), 404);
        }
        if (draftRow.status !== DraftFileStatus.PENDING) {
            return c.json(error(Code.ALREADY_EXISTS, "Draft file is already confirmed or deleted"), 409);
        }

        const result = await db.transaction(async (tx) => {
            const [updatedFile] = await tx
                .update(DbFile)
                .set({
                    size: body.size,
                    width: body.width || null,
                    height: body.height || null,
                    duration: body.duration ? Math.round(body.duration) : null,
                })
                .where(eq(DbFile.id, draftRow.file_id))
                .returning();

            if (!updatedFile) {
                throw new Error("Physical file record not found for draft file");
            }

            const [updatedDraft] = await tx
                .update(DraftFile)
                .set({
                    status: DraftFileStatus.DRAFT,
                    update_time: nowDbTimestamp(),
                })
                .where(eq(DraftFile.id, draftRow.id))
                .returning();

            return {
                id: updatedDraft.id,
                file_id: updatedFile.id,
                name: updatedDraft.original_name,
                size: updatedFile.size ?? body.size,
                mime_type: updatedFile.mime_type,
                url: buildCdnUrl(updatedFile.bucket, updatedFile.path),
                create_time: updatedDraft.create_time.toString(),
            };
        });

        return c.json(success(Code.SUCCESS, result));
    },
);

// 3. List Draft Files in a Library
router.get("/draft/files", requireAuth, async (c) => {
    const libraryId = c.req.query("library_id");
    if (!libraryId) {
        return c.json(error(Code.INVALID_PARAMETER, "library_id is required"), 400);
    }

    const accessErr = await checkLibraryAccess(c, libraryId);
    if (accessErr) return accessErr;

    const list = await db
        .select({
            draft: DraftFile,
            file: DbFile,
        })
        .from(DraftFile)
        .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
        .where(
            and(
                eq(DraftFile.library_id, libraryId),
                eq(DraftFile.status, DraftFileStatus.DRAFT),
                eq(DbFile.delete_status, DeleteStatus.ACTIVE),
            ),
        )
        .orderBy(desc(DraftFile.create_time));

    const result = list.map((item) => ({
        id: item.draft.id,
        file_id: item.draft.file_id,
        name: item.draft.original_name,
        size: item.file.size,
        mime_type: item.file.mime_type,
        url: buildCdnUrl(item.file.bucket, item.file.path),
        create_time: item.draft.create_time.toString(),
    }));

    return c.json(success(Code.SUCCESS, result));
});

// 4. Delete a Draft File
router.post("/draft/files/:id/delete", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "ID is required"), 400);
    }

    const [draft] = await db.select().from(DraftFile).where(eq(DraftFile.id, id)).limit(1);

    if (!draft) {
        return c.json(error(Code.NOT_FOUND, "Draft file not found"), 404);
    }

    const accessErr = await checkLibraryAccess(c, draft.library_id);
    if (accessErr) return accessErr;

    const deleted = await db.transaction((tx) => deleteDraftFile(tx, id, draft.library_id));
    if (!deleted) {
        return c.json(error(Code.ALREADY_EXISTS, "Draft file is already consumed or deleted"), 409);
    }

    return c.json(success(Code.SUCCESS, { success: true }));
});

const CommitMediaSchema = z.object({
    library_id: z.uuid(),
    media_drafts: z.array(MediaDraftSchema).min(1, "At least one media group is required"),
});

router.post(
    "/draft/commit-media",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = CommitMediaSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, parsed.error.issues[0]?.message || "Invalid parameters"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const { library_id, media_drafts } = c.req.valid("json");

        const accessErr = await checkLibraryAccess(c, library_id);
        if (accessErr) return accessErr;

        const compositionError = validateMediaDraft(media_drafts);
        if (compositionError) {
            return c.json(error(Code.INVALID_PARAMETER, compositionError), 400);
        }

        // Collect all draft_file_ids
        const draftIds: string[] = [];
        for (const group of media_drafts) {
            for (const t of group.tracks) {
                draftIds.push(t.draft_file_id);
            }
        }

        // Verify draft files belong to this library and are DRAFT status
        const draftRows = await db
            .select({ draft: DraftFile, file: DbFile })
            .from(DraftFile)
            .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
            .where(and(eq(DraftFile.library_id, library_id), eq(DraftFile.status, DraftFileStatus.DRAFT)));

        const activeDraftMap = new Map(
            draftRows.map(({ draft, file }) => [
                draft.id,
                {
                    name: draft.original_name,
                    mime_type: file.mime_type,
                },
            ]),
        );
        for (const draftId of draftIds) {
            if (!activeDraftMap.has(draftId)) {
                return c.json(error(Code.INVALID_PARAMETER, `Draft file ${draftId} is invalid or already consumed`), 400);
            }
        }
        const fileTypeError = validateDraftTrackFileTypes(media_drafts, activeDraftMap);
        if (fileTypeError) {
            return c.json(error(Code.INVALID_PARAMETER, fileTypeError), 400);
        }

        const mediaIds: string[] = [];

        try {
            await db.transaction(async (tx) => {
                const now = nowDbTimestamp();

                for (const group of media_drafts) {
                    const mediaId = uuidv7();

                    await tx.insert(Media).values({
                        id: mediaId,
                        eid: mediaId,
                        sort_order: 0,
                        library_id: library_id,
                        source: PostSource.UNKNOWN,
                        title: group.title,
                        description: group.description || "",
                        type: group.type,
                        sync_status: SyncStatus.PENDING,
                        create_time: now,
                    });

                    for (const track of assignTrackPriorities(group.tracks)) {
                        const fileId = await consumeDraftFile(tx, track.draft_file_id, library_id);

                        await TrackService.upsertTrack(
                            mediaId,
                            {
                                type: track.type,
                                purpose: track.purpose,
                                quality: track.quality,
                                priority: track.priority,
                                is_default: track.is_default,
                                language: track.language || null,
                            },
                            fileId,
                            tx,
                        );
                    }

                    if (group.tag_ids && group.tag_ids.length > 0) {
                        await replaceMediaTagsTx(tx, mediaId, library_id, group.tag_ids);
                    }

                    mediaIds.push(mediaId);
                }
            });
        } catch (e) {
            if (e instanceof DraftFileUnavailableError) {
                return c.json(error(Code.ALREADY_EXISTS, e.message), 409);
            }
            throw e;
        }

        return c.json(success(Code.SUCCESS, { media_ids: mediaIds }));
    },
);

export default router;
