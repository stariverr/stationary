import { Hono } from "hono";
import { db } from "@/global/db";
import * as v from "valibot";
import { validate } from "@/lib/validation/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import { DeleteStatus, Library, Media } from "@/db/schema";

import { and, eq, ilike, SQL, count, sql } from "drizzle-orm";
import { AuthEnv, ownedLibrary, requireAuth } from "@/lib/auth/middleware";
import { clearLibraryPreviews } from "@/features/media/preview";
import { requestScan } from "@/infra/queue/changes";
import { LibraryMoveItemsBodySchema } from "@/features/library/schema";
import { LibraryDeleteError, LibraryMoveError } from "@/features/library/errors";
import { moveLibraryItems } from "@/features/library/move-items";
import { deleteLibrary } from "@/features/library/delete-library";
import { isSupportedLanguage } from "@/features/ai/image-metadata";

const router = new Hono<AuthEnv>();

export const LibraryIdParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
});

export const LibraryListQuerySchema = v.object({
    page: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === "" || val === undefined ? undefined : Number(val))),
            v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        ),
    ),
    count: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === "" || val === undefined ? undefined : Number(val))),
            v.optional(v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(100))),
        ),
    ),
    keyword: v.optional(v.string()),
});

export const LibraryCreateBodySchema = v.strictObject({
    name: v.pipe(v.string(), v.nonEmpty("Name is required")),
    description: v.optional(v.string(), ""),
    /** BCP 47 language AI image descriptions are written in; the creator's UI language by default. */
    ai_language: v.optional(v.pipe(v.string(), v.check(isSupportedLanguage, "Unsupported language"))),
});

export const LibraryUpdateBodySchema = v.strictObject({
    id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
    name: v.optional(v.pipe(v.string(), v.nonEmpty("Name is required"))),
    description: v.optional(v.string()),
});

export const LibraryPreviewJobsBodySchema = v.object({
    /** Render every preview again, not only missing or outdated ones. */
    force: v.optional(v.boolean(), false),
});

function maskKey(key: string | null | undefined): string | null {
    if (!key) return null;
    if (key.length <= 8) return "********";
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

router.get("/list", requireAuth, validate("query", LibraryListQuerySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const query = c.req.valid("query");
    const page = query.page ?? 1;
    const pageSize = query.count ?? 20;
    const offset = (page - 1) * pageSize;
    const { keyword } = query;

    const where: SQL[] = [eq(Library.owner_id, user.id), eq(Library.delete_status, DeleteStatus.ACTIVE)];
    const scopedLibraryId = c.get("apiToken")?.library_id;
    if (scopedLibraryId) {
        where.push(eq(Library.id, scopedLibraryId));
    }
    if (keyword) {
        where.push(ilike(Library.name, `%${keyword}%`));
    }

    const libraries = await db
        .select()
        .from(Library)
        .where(and(...where))
        .limit(pageSize)
        .offset(offset);

    const totalResult = await db
        .select({ total: count() })
        .from(Library)
        .where(and(...where));

    return c.json(
        success(Code.SUCCESS, {
            list: libraries,
            total: totalResult[0]?.total ?? 0,
        }),
    );
});

router.post("/create", requireAuth, validate("json", LibraryCreateBodySchema), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }
    if (c.get("apiToken")?.library_id) {
        return c.json(error(Code.FORBIDDEN, "Library-scoped API tokens cannot create libraries"), 403);
    }

    const newLib = await db
        .insert(Library)
        .values({
            name: body.name,
            description: body.description,
            owner_id: user.id,
            ...(body.ai_language ? { ai_language: body.ai_language } : {}),
        })
        .returning();
    return c.json(success(Code.SUCCESS, newLib[0]));
});

router.post("/update", requireAuth, validate("json", LibraryUpdateBodySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const { id, ...updateData } = c.req.valid("json");
    const library = await ownedLibrary(c, user.id, id);
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);

    const updated = await db.update(Library).set(updateData).where(eq(Library.id, id)).returning();
    return c.json(success(Code.SUCCESS, updated[0]));
});

router.post("/delete/:id", requireAuth, validate("param", LibraryIdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    try {
        const result = await deleteLibrary(id, {
            ownerId: user.id,
            scopedLibraryId: c.get("apiToken")?.library_id,
        });
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        if (cause instanceof LibraryDeleteError) {
            if (cause.kind === "NOT_FOUND") {
                return c.json(error(Code.NOT_FOUND, cause.message), 404);
            }
            if (cause.kind === "NOT_EMPTY") {
                return c.json(error(Code.LIBRARY_NOT_EMPTY, "Please empty posts and media in this library before deleting it."), 400);
            }
            return c.json(error(Code.INTERNAL_SERVER_ERROR, cause.message), 500);
        }

        const message = cause instanceof Error ? cause.message : String(cause);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, message), 500);
    }
});

router.post("/move-items", requireAuth, validate("json", LibraryMoveItemsBodySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    try {
        const result = await moveLibraryItems(c.req.valid("json"), {
            ownerId: user.id,
            scopedLibraryId: c.get("apiToken")?.library_id,
        });
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        if (cause instanceof LibraryMoveError) {
            if (cause.kind === "NOT_FOUND") {
                return c.json(error(Code.NOT_FOUND, cause.message), 404);
            }
            return c.json(error(Code.INVALID_PARAMETER, cause.message), 400);
        }

        const message = cause instanceof Error ? cause.message : String(cause);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, message), 500);
    }
});

router.post(
    "/:id/preview-jobs",
    requireAuth,
    validate("param", LibraryIdParamSchema),
    validate("json", LibraryPreviewJobsBodySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

        const { id } = c.req.valid("param");
        const body = c.req.valid("json");

        const library = await ownedLibrary(c, user.id, id);
        if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);

        await db.transaction(async (tx) => {
            if (body.force) await clearLibraryPreviews(tx, library.id);
            await requestScan(tx, "preview", [library.id]);
        });

        return c.json(success(Code.SUCCESS, { library_id: library.id }), 202);
    },
);

export default router;
