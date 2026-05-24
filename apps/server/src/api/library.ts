import { Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { validator } from "hono/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import { Library, Media, Post } from "@/db/schema";
import { and, eq, ilike, SQL, count, inArray, isNull } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { RecycleService } from "@/services/recycle";
import { DeleteService } from "@/services/delete";
import { Temporal } from "@js-temporal/polyfill";

const router = new Hono<AuthEnv>();

export const LibraryListQuerySchema = z.object({
    page: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(1).optional(),
    ),
    count: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(10).lte(100).optional(),
    ),
    keyword: z.string().optional(),
});

export const LibraryCreateBodySchema = z
    .object({
        name: z.string().min(1, "Name is required"),
        description: z.string().optional().default(""),
    })
    .strict();

export const LibraryUpdateBodySchema = z
    .object({
        id: z.uuid(),
        name: z.string().min(1, "Name is required").optional(),
        description: z.string().optional(),
    })
    .strict();

export const LibraryMoveItemsBodySchema = z
    .object({
        post_ids: z.array(z.uuid()).default([]),
        media_ids: z.array(z.uuid()).default([]),
        target_library_id: z.uuid(),
    })
    .strict()
    .refine(
        (body) => body.post_ids.length > 0 || body.media_ids.length > 0,
        "At least one post or media id is required",
    );

export const uniqueIds = (ids: string[]) => Array.from(new Set(ids));

export const getAttachedMediaIds = (media: Pick<typeof Media.$inferSelect, "id" | "post_id">[]) =>
    media.filter((item) => item.post_id !== null).map((item) => item.id);

router.get(
    "/list",
    requireAuth,
    validator("query", (value, c) => {
        const parsed = LibraryListQuerySchema.safeParse(value);
        if (!parsed.success) return c.text("Invalid query", 400);
        return parsed.data;
    }),
    async (c) => {
        const page = c.req.valid("query").page ?? 1;
        const pageSize = c.req.valid("query").count ?? 20;
        const offset = (page - 1) * pageSize;
        const { keyword } = c.req.valid("query");

        const where: SQL[] = [eq(Library.delete_status, "ACTIVE")];
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
                total: totalResult[0].total,
            }),
        );
    },
);

router.post(
    "/create",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = LibraryCreateBodySchema.safeParse(value);
        if (!parsed.success) return c.text("Invalid body", 400);
        return parsed.data;
    }),
    async (c) => {
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
    },
);

router.post(
    "/update",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = LibraryUpdateBodySchema.safeParse(value);
        if (!parsed.success) return c.text("Invalid body", 400);
        return parsed.data;
    }),
    async (c) => {
        const body = c.req.valid("json");
        const { id, ...updateData } = body;
        const updated = await db
            .update(Library)
            .set(updateData)
            .where(eq(Library.id, id))
            .returning();

        if (updated.length === 0) return c.json(error(Code.NOT_FOUND, "Library not found"));
        return c.json(success(Code.SUCCESS, updated[0]));
    },
);

/**
 * Delete Library
 *
 * Only empty library can be deleted
 *
 * @param id
 * @returns
 */
router.post("/delete/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "library id is required"));
    }

    try {
        const result = await DeleteService.deleteLibrary(id);
        if (result.libraryUpdated === 0) {
            return c.json(error(Code.NOT_FOUND, "Library not found"));
        }
        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        if (e.message === "Library is not empty") {
            return c.json(
                error(
                    Code.LIBRARY_NOT_EMPTY,
                    "Please empty posts and media in this library before deleting it.",
                ),
            );
        }
        throw e;
    }
});

router.post(
    "/move-items",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = LibraryMoveItemsBodySchema.safeParse(value);
        if (!parsed.success) return c.text("Invalid body", 400);
        return {
            target_library_id: parsed.data.target_library_id,
            post_ids: uniqueIds(parsed.data.post_ids),
            media_ids: uniqueIds(parsed.data.media_ids),
        };
    }),
    async (c) => {
        const body = c.req.valid("json");

        const targetLibraries = await db
            .select({ id: Library.id })
            .from(Library)
            .where(and(eq(Library.id, body.target_library_id), eq(Library.delete_status, "ACTIVE")))
            .limit(1);

        if (targetLibraries.length === 0) {
            return c.json(error(Code.NOT_FOUND, "Target library not found"));
        }

        const selectedPosts =
            body.post_ids.length > 0
                ? await db
                      .select({ id: Post.id })
                      .from(Post)
                      .where(and(inArray(Post.id, body.post_ids), eq(Post.delete_status, "ACTIVE")))
                : [];

        if (selectedPosts.length !== body.post_ids.length) {
            return c.json(error(Code.NOT_FOUND, "One or more posts were not found"));
        }

        const selectedMedia =
            body.media_ids.length > 0
                ? await db
                      .select({ id: Media.id, post_id: Media.post_id })
                      .from(Media)
                      .where(
                          and(inArray(Media.id, body.media_ids), eq(Media.delete_status, "ACTIVE")),
                      )
                : [];

        if (selectedMedia.length !== body.media_ids.length) {
            return c.json(error(Code.NOT_FOUND, "One or more media items were not found"));
        }

        const attachedMediaIds = getAttachedMediaIds(selectedMedia);
        if (attachedMediaIds.length > 0) {
            return c.json(
                error(Code.INVALID_PARAMETER, "Only independent media can be moved directly"),
            );
        }

        const moved = await db.transaction(async (tx) => {
            let posts = 0;
            let media = 0;
            let postMedia = 0;

            if (body.post_ids.length > 0) {
                const updatedPosts = await tx
                    .update(Post)
                    .set({ library_id: body.target_library_id })
                    .where(inArray(Post.id, body.post_ids))
                    .returning({ id: Post.id });
                posts = updatedPosts.length;

                const updatedPostMedia = await tx
                    .update(Media)
                    .set({ library_id: body.target_library_id })
                    .where(inArray(Media.post_id, body.post_ids))
                    .returning({ id: Media.id });
                postMedia = updatedPostMedia.length;
            }

            if (body.media_ids.length > 0) {
                const updatedMedia = await tx
                    .update(Media)
                    .set({ library_id: body.target_library_id })
                    .where(and(inArray(Media.id, body.media_ids), isNull(Media.post_id)))
                    .returning({ id: Media.id });
                media = updatedMedia.length;
            }

            return { posts, media, post_media: postMedia };
        });

        return c.json(success(Code.SUCCESS, moved));
    },
);

export default router;
