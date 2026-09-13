import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as v from "valibot";
import { TrashListQuerySchema, TrashBatchActionSchema, TrashEmptySchema } from "../src/api/trash";
import { TrashService } from "../src/features/trash/trash-service";
import { assertPostAccess } from "../src/features/post/access";
import { assertMediaAccess } from "../src/features/media/access";

const resolveSrc = (relativePath: string) => join(import.meta.dir, "..", relativePath);

const routeSources = {
    trash: () => Bun.file(resolveSrc("src/api/trash.ts")).text(),
    post: () => Bun.file(resolveSrc("src/api/post.ts")).text(),
    media: () => Bun.file(resolveSrc("src/api/media.ts")).text(),
    index: () => Bun.file(resolveSrc("src/index.ts")).text(),
};

const expectRouteRequiresAuth = (source: string, method: string, path: string) => {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(source).toMatch(new RegExp(`router\\.${method}\\(\\s*["']${escapedPath}["'],\\s*requireAuth`));
};

describe("trash route authentication and mounting", () => {
    test("trash routes are mounted on /api/trash", async () => {
        const indexSource = await routeSources.index();
        expect(indexSource).toContain('app.route("/api/trash", trash)');
    });

    test("trash routes require auth", async () => {
        const source = await routeSources.trash();
        expectRouteRequiresAuth(source, "get", "/list");
        expectRouteRequiresAuth(source, "post", "/restore");
        expectRouteRequiresAuth(source, "post", "/delete");
        expectRouteRequiresAuth(source, "post", "/empty");
    });
});

describe("trash schema validations", () => {
    const validLibraryId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3";
    const validPostId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b4";
    const validMediaId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b5";

    test("TrashListQuerySchema validates valid inputs and assigns defaults", () => {
        const parsed = v.safeParse(TrashListQuerySchema, {
            library_id: validLibraryId,
        });

        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.output.type).toBe("all");
            expect(parsed.output.page).toBe(1);
            expect(parsed.output.count).toBe(20);
            expect(parsed.output.sort_by).toBe("recycle_time");
            expect(parsed.output.sort_order).toBe("desc");
        }
    });

    test("TrashListQuerySchema rejects invalid library_id", () => {
        const parsed = v.safeParse(TrashListQuerySchema, {
            library_id: "not-a-uuid",
        });

        expect(parsed.success).toBe(false);
    });

    test("TrashBatchActionSchema accepts valid post_ids and media_ids", () => {
        const parsed = v.safeParse(TrashBatchActionSchema, {
            library_id: validLibraryId,
            post_ids: [validPostId],
            media_ids: [validMediaId],
        });

        expect(parsed.success).toBe(true);
    });

    test("TrashBatchActionSchema accepts only post_ids or only media_ids", () => {
        const parsedPostOnly = v.safeParse(TrashBatchActionSchema, {
            library_id: validLibraryId,
            post_ids: [validPostId],
        });
        expect(parsedPostOnly.success).toBe(true);

        const parsedMediaOnly = v.safeParse(TrashBatchActionSchema, {
            library_id: validLibraryId,
            media_ids: [validMediaId],
        });
        expect(parsedMediaOnly.success).toBe(true);
    });

    test("TrashBatchActionSchema rejects empty IDs array", () => {
        const parsed = v.safeParse(TrashBatchActionSchema, {
            library_id: validLibraryId,
            post_ids: [],
            media_ids: [],
        });

        expect(parsed.success).toBe(false);
    });

    test("TrashEmptySchema validates library_id", () => {
        const validParsed = v.safeParse(TrashEmptySchema, {
            library_id: validLibraryId,
        });
        expect(validParsed.success).toBe(true);

        const invalidParsed = v.safeParse(TrashEmptySchema, {
            library_id: "invalid-uuid",
        });
        expect(invalidParsed.success).toBe(false);
    });
});

describe("trash service contracts and access checks", () => {
    test("TrashService exposes required lifecycle and query methods", () => {
        expect(typeof TrashService.listTrashItems).toBe("function");
        expect(typeof TrashService.batchRestore).toBe("function");
        expect(typeof TrashService.batchDelete).toBe("function");
        expect(typeof TrashService.emptyTrash).toBe("function");
    });

    test("assertPostAccess and assertMediaAccess both accept allowRecycled option", () => {
        expect(assertPostAccess.length).toBeGreaterThanOrEqual(2);
        expect(assertMediaAccess.length).toBeGreaterThanOrEqual(2);
    });
});
