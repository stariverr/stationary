import { Hono } from "hono";
import { db } from "@/global/db";
import * as v from "valibot";
import { validate } from "@/lib/validation/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import {
    DeleteStatus,
    Library,
    AsyncTask,
    AsyncTaskType,
    AsyncTaskStatus,
} from "@/db/schema";
import { Quality } from "@/lib/types";

import { and, eq, ilike, SQL, count, sql, desc } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { JobManager } from "@/infra/jobs/manager";
import { LibraryMoveItemsBodySchema } from "@/features/library/schema";
import { LibraryDeleteError, LibraryMoveError } from "@/features/library/errors";
import { moveLibraryItems } from "@/features/library/move-items";
import { deleteLibrary } from "@/features/library/delete-library";

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
});

export const LibraryUpdateBodySchema = v.strictObject({
    id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
    name: v.optional(v.pipe(v.string(), v.nonEmpty("Name is required"))),
    description: v.optional(v.string()),
});

export const LibraryAiConfigSchema = v.object({
    ai_provider: v.optional(v.nullable(v.picklist(["gemini", "openai"]))),
    openai_api_key: v.optional(v.nullable(v.string())),
    openai_base_url: v.optional(v.nullable(v.string())),
    openai_model_embedding_text: v.optional(v.nullable(v.string())),
    openai_model_embedding_text_map_to: v.optional(v.nullable(v.string())),
    openai_model_embedding_image: v.optional(v.nullable(v.string())),
    openai_model_embedding_image_map_to: v.optional(v.nullable(v.string())),
    openai_model_describe_image: v.optional(v.nullable(v.string())),
    openai_model_describe_image_map_to: v.optional(v.nullable(v.string())),
    gemini_api_key: v.optional(v.nullable(v.string())),
    gemini_base_url: v.optional(v.nullable(v.string())),
});

export const LibraryCoverJobsBodySchema = v.object({
    type: v.optional(v.picklist(["MANUAL", "RECONCILE"]), "RECONCILE"),
    media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid("Invalid media ID format")))),
    qualities: v.optional(v.array(v.enum(Quality))),
    force: v.optional(v.boolean(), false),
});

export const LibraryCoverConfigBodySchema = v.object({
    qualities: v.pipe(
        v.array(v.enum(Quality)),
        v.minLength(1, "At least 1 cover quality tier is required"),
        v.maxLength(3, "At most 3 cover quality tiers are allowed"),
        v.transform((list) => {
            const set = new Set(list);
            const ordered: Quality[] = [];
            for (const q of [Quality.LOW, Quality.MEDIUM, Quality.HIGH]) {
                if (set.has(q)) ordered.push(q);
            }
            return ordered;
        }),
    ),
});

function maskKey(key: string | null | undefined): string | null {
    if (!key) return null;
    if (key.length <= 8) return "********";
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

router.get("/list", requireAuth, validate("query", LibraryListQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const page = query.page ?? 1;
    const pageSize = query.count ?? 20;
    const offset = (page - 1) * pageSize;
    const { keyword } = query;

    const where: SQL[] = [eq(Library.delete_status, DeleteStatus.ACTIVE)];
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

    const newLib = await db
        .insert(Library)
        .values({
            name: body.name,
            description: body.description,
            owner_id: user.id,
        })
        .returning();
    return c.json(success(Code.SUCCESS, newLib[0]));
});

router.post("/update", requireAuth, validate("json", LibraryUpdateBodySchema), async (c) => {
    const body = c.req.valid("json");
    const { id, ...updateData } = body;
    const updated = await db.update(Library).set(updateData).where(eq(Library.id, id)).returning();

    if (updated.length === 0) return c.json(error(Code.NOT_FOUND, "Library not found"));
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
            if (cause.kind === "FORBIDDEN") {
                return c.json(error(Code.FORBIDDEN, cause.message), 403);
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
            if (cause.kind === "FORBIDDEN") {
                return c.json(error(Code.FORBIDDEN, cause.message), 403);
            }
            return c.json(error(Code.INVALID_PARAMETER, cause.message), 400);
        }

        const message = cause instanceof Error ? cause.message : String(cause);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, message), 500);
    }
});

// GET Library AI Config
router.get("/:id/ai-config", requireAuth, validate("param", LibraryIdParamSchema), async (c) => {
    const { id } = c.req.valid("param");

    const libraryRows = await db.select().from(Library).where(eq(Library.id, id)).limit(1);
    const library = libraryRows[0];

    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    return c.json(
        success(Code.SUCCESS, {
            ai_provider: library.ai_provider,
            openai_api_key: maskKey(library.openai_api_key),
            openai_base_url: library.openai_base_url,
            openai_model_embedding_text: library.openai_model_embedding_text,
            openai_model_embedding_text_map_to: library.openai_model_embedding_text_map_to,
            openai_model_embedding_image: library.openai_model_embedding_image,
            openai_model_embedding_image_map_to: library.openai_model_embedding_image_map_to,
            openai_model_describe_image: library.openai_model_describe_image,
            openai_model_describe_image_map_to: library.openai_model_describe_image_map_to,
            gemini_api_key: maskKey(library.gemini_api_key),
            gemini_base_url: library.gemini_base_url,
        }),
    );
});

// POST Library AI Config
router.post("/:id/ai-config", requireAuth, validate("param", LibraryIdParamSchema), validate("json", LibraryAiConfigSchema), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const libraryRows = await db.select().from(Library).where(eq(Library.id, id)).limit(1);
    const library = libraryRows[0];

    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    let geminiApiKey = body.gemini_api_key;
    if (geminiApiKey && geminiApiKey.includes("...")) {
        geminiApiKey = library.gemini_api_key;
    }

    let openaiApiKey = body.openai_api_key;
    if (openaiApiKey && openaiApiKey.includes("...")) {
        openaiApiKey = library.openai_api_key;
    }

    await db
        .update(Library)
        .set({
            ai_provider: body.ai_provider,
            openai_api_key: openaiApiKey,
            openai_base_url: body.openai_base_url,
            openai_model_embedding_text: body.openai_model_embedding_text,
            openai_model_embedding_text_map_to: body.openai_model_embedding_text_map_to,
            openai_model_embedding_image: body.openai_model_embedding_image,
            openai_model_embedding_image_map_to: body.openai_model_embedding_image_map_to,
            openai_model_describe_image: body.openai_model_describe_image,
            openai_model_describe_image_map_to: body.openai_model_describe_image_map_to,
            gemini_api_key: geminiApiKey,
            gemini_base_url: body.gemini_base_url,
            update_time: sql`now()`,
        })
        .where(eq(Library.id, id));

    return c.json(success(Code.SUCCESS, null, "Library AI configuration updated successfully"));
});

router.post(
    "/:id/cover-jobs",
    requireAuth,
    validate("param", LibraryIdParamSchema),
    validate("json", LibraryCoverJobsBodySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

        const { id } = c.req.valid("param");
        const body = c.req.valid("json");

        const library = await db.query.Library.findFirst({
            where: { id },
        });
        if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
        if (library.owner_id !== user.id) return c.json(error(Code.UNAUTHORIZED, "Unauthorized access to library"), 403);

        const sourceType = body.type === "MANUAL" ? "MANUAL" : "RECONCILE";
        const qualities = body.qualities || (library.cover_qualities as Quality[]) || [Quality.LOW, Quality.MEDIUM];

        const task = await JobManager.createTask({
            type: sourceType === "MANUAL" ? AsyncTaskType.COVER_BATCH : AsyncTaskType.COVER_RECONCILE,
            libraryId: library.id,
            ownerId: user.id,
            inputSnapshot: {
                source_type: sourceType,
                qualities,
                media_ids: body.media_ids || null,
                force: body.force ?? false,
            },
            configVersion: library.cover_config_version,
        });

        return c.json(
            success(Code.SUCCESS, {
                task_id: task.id,
                type: task.type,
                status: task.status,
                config_version: task.config_version,
                active_task: task,
            }),
            202,
        );
    },
);

router.get("/:id/cover-jobs/active", requireAuth, validate("param", LibraryIdParamSchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const { id } = c.req.valid("param");

    const library = await db.query.Library.findFirst({
        where: { id: id },
    });
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    if (library.owner_id !== user.id) return c.json(error(Code.UNAUTHORIZED, "Unauthorized access to library"), 403);

    const activeTasks = await db
        .select()
        .from(AsyncTask)
        .where(
            and(
                eq(AsyncTask.library_id, id),
                eq(AsyncTask.type, AsyncTaskType.COVER_RECONCILE),
                eq(AsyncTask.config_version, library.cover_config_version),
            ),
        )
        .orderBy(desc(AsyncTask.create_time))
        .limit(1);

    const activeTask = activeTasks[0];

    const isRunning = activeTask && (activeTask.status === AsyncTaskStatus.DISCOVERING || activeTask.status === AsyncTaskStatus.RUNNING);
    const reconcileStatus = isRunning ? "IN_PROGRESS" : "IDLE";

    return c.json(
        success(Code.SUCCESS, {
            library_id: library.id,
            reconcile_status: reconcileStatus,
            active_task: activeTask || null,
        }),
    );
});

router.get("/:id/cover-config", requireAuth, validate("param", LibraryIdParamSchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const { id } = c.req.valid("param");

    const library = await db.query.Library.findFirst({
        where: { id: id },
    });
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    if (library.owner_id !== user.id) return c.json(error(Code.UNAUTHORIZED, "Unauthorized access to library"), 403);

    const rawQualities = library.cover_qualities;
    const qualities = Array.isArray(rawQualities) ? rawQualities : [Quality.LOW, Quality.MEDIUM];

    return c.json(
        success(Code.SUCCESS, {
            library_id: library.id,
            qualities,
            config_version: library.cover_config_version,
        }),
    );
});

router.put(
    "/:id/cover-config",
    requireAuth,
    validate("param", LibraryIdParamSchema),
    validate("json", LibraryCoverConfigBodySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

        const { id } = c.req.valid("param");
        const body = c.req.valid("json");

        const library = await db.query.Library.findFirst({
            where: { id },
        });
        if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
        if (library.owner_id !== user.id) return c.json(error(Code.UNAUTHORIZED, "Unauthorized access to library"), 403);

        // Check whether the new qualities are different from the old ones
        const oldQualities = (library.cover_qualities as Quality[]) || [];
        const isSame =
            oldQualities.length === body.qualities.length &&
            new Set(oldQualities).size === new Set(body.qualities).size &&
            oldQualities.every((quality) => body.qualities.includes(quality));
        const isChanged = !isSame;

        let newVersion = library.cover_config_version;
        let createdTask: typeof AsyncTask.$inferSelect | null = null;

        if (isChanged) {
            newVersion += 1;
            const now = Temporal.Now.instant();

            await db
                .update(Library)
                .set({
                    cover_qualities: body.qualities,
                    cover_config_version: newVersion,
                    update_time: now,
                })
                .where(eq(Library.id, id));

            createdTask = await JobManager.createTask({
                type: AsyncTaskType.COVER_RECONCILE,
                libraryId: id,
                ownerId: user.id,
                inputSnapshot: {
                    source_type: "RECONCILE",
                    qualities: body.qualities,
                },
                configVersion: newVersion,
            });
        }

        return c.json(
            success(Code.SUCCESS, {
                library_id: id,
                qualities: body.qualities,
                config_version: newVersion,
                is_changed: isChanged,
                active_task: createdTask || null,
            }),
        );
    },
);

export default router;
