import { Context, Hono } from "hono";
import { validate } from "@/lib/validation/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import {
    ConfirmDraftSchema,
    CommitMediaSchema,
    PresignDraftSchema,
} from "@/features/import/schema";
import { confirmDraftUpload, deleteDraftFile, listDraftFiles, presignDraftUpload } from "@/features/import/draft-files";
import { commitMedia } from "@/features/import/commit-media";
import { ImportError } from "@/features/import/errors";

const router = new Hono<AuthEnv>();

function getImportAuth(c: Context<AuthEnv>) {
    const user = c.get("user");
    if (!user) return null;

    return {
        ownerId: user.id,
        scopedLibraryId: c.get("apiToken")?.library_id,
    };
}

function handleImportError(c: Context<AuthEnv>, cause: unknown): Response {
    if (!(cause instanceof ImportError)) throw cause;

    if (cause.kind === "FORBIDDEN") {
        return c.json(error(Code.FORBIDDEN, cause.message), 403);
    }
    if (cause.kind === "NOT_FOUND") {
        return c.json(error(Code.NOT_FOUND, cause.message), 404);
    }
    if (cause.kind === "CONFLICT") {
        return c.json(error(Code.ALREADY_EXISTS, cause.message), 409);
    }
    return c.json(error(Code.INVALID_PARAMETER, cause.message), 400);
}

router.post("/draft/presign", requireAuth, validate("json", PresignDraftSchema), async (c) => {
    const auth = getImportAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    try {
        const result = await presignDraftUpload(c.req.valid("json"), auth);
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        return handleImportError(c, cause);
    }
});

router.post("/draft/confirm", requireAuth, validate("json", ConfirmDraftSchema), async (c) => {
    const auth = getImportAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    try {
        const result = await confirmDraftUpload(c.req.valid("json"), auth);
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        return handleImportError(c, cause);
    }
});

router.get("/draft/files", requireAuth, async (c) => {
    const auth = getImportAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const libraryId = c.req.query("library_id");
    if (!libraryId) {
        return c.json(error(Code.INVALID_PARAMETER, "library_id is required"), 400);
    }

    try {
        const result = await listDraftFiles(libraryId, auth);
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        return handleImportError(c, cause);
    }
});

router.post("/draft/files/:id/delete", requireAuth, async (c) => {
    const auth = getImportAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const draftFileId = c.req.param("id");
    if (!draftFileId) {
        return c.json(error(Code.INVALID_PARAMETER, "ID is required"), 400);
    }

    try {
        const result = await deleteDraftFile(draftFileId, auth);
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        return handleImportError(c, cause);
    }
});

router.post("/draft/commit-media", requireAuth, validate("json", CommitMediaSchema), async (c) => {
    const auth = getImportAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    try {
        const result = await commitMedia(c.req.valid("json"), auth);
        return c.json(success(Code.SUCCESS, { media_ids: result.mediaIds }));
    } catch (cause) {
        return handleImportError(c, cause);
    }
});

export default router;
