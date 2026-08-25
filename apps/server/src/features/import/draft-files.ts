import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { DraftFile, DraftFileStatus, File as DbFile, DeleteStatus } from "@/db/schema";
import { db } from "@/global/db";
import { env } from "@/global/env";
import { s3 } from "@/global/s3";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { getFileExtension, getMimeTypeByExt } from "@/lib/utils/file";
import { deleteDraftFile as deleteDraftFileTx } from "./draft-file";
import { ImportAuth, assertLibraryAccess } from "./access";
import { ImportError } from "./errors";
import type { ConfirmDraftInput, PresignDraftInput } from "./schema";

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
        const nowMs = Temporal.Now.instant().epochMilliseconds;
        if (nowMs > expiresAt) return false;

        const data = `${libraryId}:${path}:${expiresAt}`;
        const hmac = crypto.createHmac("sha256", env.AUTH_SECRET);
        hmac.update(data);
        const expectedSignature = hmac.digest("hex");

        return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSignature, "hex"));
    } catch {
        return false;
    }
}

export async function presignDraftUpload(input: PresignDraftInput, auth: ImportAuth) {
    await assertLibraryAccess(input.library_id, auth);

    const ext = getFileExtension(input.fileName) || "bin";
    const fileId = uuidv7();
    const path = `v2/l/${input.library_id.slice(-2)}/${input.library_id}/drafts/${fileId}.${ext}`;
    const mimeType = getMimeTypeByExt(ext);

    const uploadUrl = await s3.getUploadPresignedUrl(path, {
        bucket: env.S3_BUCKET,
        contentType: mimeType,
        expiresInSeconds: 3600,
    });

    const expiresAt = Temporal.Now.instant().add({ hours: 1 }).epochMilliseconds;
    const uploadToken = generateUploadToken(input.library_id, path, expiresAt);

    const draftFileId = await db.transaction(async (tx) => {
        const [newFile] = await tx
            .insert(DbFile)
            .values({
                path,
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
                library_id: input.library_id,
                owner_id: auth.ownerId,
                original_name: input.fileName,
                status: DraftFileStatus.PENDING,
            })
            .returning();

        return newDraft.id;
    });

    return {
        url: uploadUrl,
        path,
        bucket: env.S3_BUCKET,
        mime_type: mimeType,
        upload_token: uploadToken,
        draft_file_id: draftFileId,
    };
}

export async function confirmDraftUpload(input: ConfirmDraftInput, auth: ImportAuth) {
    await assertLibraryAccess(input.library_id, auth);

    if (!verifyUploadToken(input.library_id, input.path, input.upload_token)) {
        throw new ImportError("INVALID_PARAMETER", "Invalid or expired upload token");
    }

    const fileExtension = getFileExtension(input.fileName) || "bin";
    const pathExtension = getFileExtension(input.path);
    const expectedMimeType = getMimeTypeByExt(fileExtension);
    const expectedPathPrefix = `v2/l/${input.library_id.slice(-2)}/${input.library_id}/drafts/`;

    if (input.bucket !== env.S3_BUCKET) {
        throw new ImportError("INVALID_PARAMETER", "Draft upload bucket does not match the presigned upload");
    }
    if (!input.path.startsWith(expectedPathPrefix) || pathExtension !== fileExtension) {
        throw new ImportError("INVALID_PARAMETER", "Draft upload path does not match the selected file");
    }
    if (input.mime_type !== expectedMimeType) {
        throw new ImportError("INVALID_PARAMETER", "Draft MIME type does not match the selected file");
    }

    const [draftRow] = await db
        .select()
        .from(DraftFile)
        .where(and(eq(DraftFile.id, input.draft_file_id), eq(DraftFile.library_id, input.library_id)))
        .limit(1);

    if (!draftRow) {
        throw new ImportError("NOT_FOUND", "Draft file not found");
    }
    if (draftRow.status !== DraftFileStatus.PENDING) {
        throw new ImportError("CONFLICT", "Draft file is already confirmed or deleted");
    }

    return db.transaction(async (tx) => {
        const [updatedFile] = await tx
            .update(DbFile)
            .set({ size: input.size })
            .where(eq(DbFile.id, draftRow.file_id))
            .returning();

        if (!updatedFile) {
            throw new Error("Physical file record not found for draft file");
        }

        const [updatedDraft] = await tx
            .update(DraftFile)
            .set({
                status: DraftFileStatus.DRAFT,
                update_time: Temporal.Now.instant(),
            })
            .where(and(eq(DraftFile.id, draftRow.id), eq(DraftFile.status, DraftFileStatus.PENDING)))
            .returning();

        if (!updatedDraft) {
            throw new Error("Draft file was modified or already confirmed by another request");
        }

        return {
            id: updatedDraft.id,
            file_id: updatedFile.id,
            name: updatedDraft.original_name,
            size: updatedFile.size ?? input.size,
            mime_type: updatedFile.mime_type,
            url: buildCdnUrl(updatedFile.bucket, updatedFile.path),
            create_time: updatedDraft.create_time.toString(),
        };
    });
}

export async function listDraftFiles(libraryId: string, auth: ImportAuth) {
    await assertLibraryAccess(libraryId, auth);

    const list = await db
        .select({ draft: DraftFile, file: DbFile })
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

    return list.map((item) => ({
        id: item.draft.id,
        file_id: item.draft.file_id,
        name: item.draft.original_name,
        size: item.file.size,
        mime_type: item.file.mime_type,
        url: buildCdnUrl(item.file.bucket, item.file.path),
        create_time: item.draft.create_time.toString(),
    }));
}

export async function deleteDraftFile(draftFileId: string, auth: ImportAuth) {
    const [draft] = await db.select().from(DraftFile).where(eq(DraftFile.id, draftFileId)).limit(1);
    if (!draft) {
        throw new ImportError("NOT_FOUND", "Draft file not found");
    }

    await assertLibraryAccess(draft.library_id, auth);

    const deleted = await db.transaction((tx) => deleteDraftFileTx(tx, draftFileId, draft.library_id));
    if (!deleted) {
        throw new ImportError("CONFLICT", "Draft file is already consumed or deleted");
    }

    return { success: true };
}
