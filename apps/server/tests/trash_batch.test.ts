import { describe, expect, test } from "bun:test";
import { batchDeletePost, batchRestorePost, deletePost, restorePost } from "@/features/post/lifecycle";
import { batchDeleteMedia, batchRestoreMedia, deleteMedia, restoreMedia } from "@/features/media/lifecycle";
import { TrashService } from "@/features/trash/trash-service";

describe("batch lifecycle contract and safety", () => {
    test("batchDeletePost and batchRestorePost handle empty arrays safely", async () => {
        const delRes = await batchDeletePost([]);
        expect(delRes).toEqual({ postUpdated: 0, mediaUpdated: 0, fileUpdated: 0 });

        const resRes = await batchRestorePost([]);
        expect(resRes).toEqual({ postUpdated: 0, mediaUpdated: 0 });
    });

    test("batchDeleteMedia and batchRestoreMedia handle empty arrays safely", async () => {
        const delRes = await batchDeleteMedia([]);
        expect(delRes).toEqual({ mediaUpdated: 0, fileUpdated: 0 });

        const resRes = await batchRestoreMedia([]);
        expect(resRes).toEqual({ mediaUpdated: 0 });
    });

    test("batch functions handle non-existent UUIDs without throwing", async () => {
        const nonExistentUuid = "00000000-0000-0000-0000-000000000000";

        const delPostRes = await batchDeletePost([nonExistentUuid]);
        expect(delPostRes).toEqual({ postUpdated: 0, mediaUpdated: 0, fileUpdated: 0 });

        const resPostRes = await batchRestorePost([nonExistentUuid]);
        expect(resPostRes).toEqual({ postUpdated: 0, mediaUpdated: 0 });

        const delMediaRes = await batchDeleteMedia([nonExistentUuid]);
        expect(delMediaRes).toEqual({ mediaUpdated: 0, fileUpdated: 0 });

        const resMediaRes = await batchRestoreMedia([nonExistentUuid]);
        expect(resMediaRes).toEqual({ mediaUpdated: 0 });
    });

    test("single item lifecycle functions delegate to batch functions cleanly", async () => {
        const nonExistentUuid = "00000000-0000-0000-0000-000000000000";

        const delPostRes = await deletePost(nonExistentUuid);
        expect(delPostRes.postUpdated).toBe(0);

        const resPostRes = await restorePost(nonExistentUuid);
        expect(resPostRes.postUpdated).toBe(0);

        const delMediaRes = await deleteMedia(nonExistentUuid);
        expect(delMediaRes.mediaUpdated).toBe(0);

        const resMediaRes = await restoreMedia(nonExistentUuid);
        expect(resMediaRes.mediaUpdated).toBe(0);
    });

    test("TrashService source code uses set-based batch operations instead of sequential loops", async () => {
        const trashServiceSource = await Bun.file(new URL("../src/features/trash/trash-service.ts", import.meta.url).pathname).text();

        // Must not contain item-by-item sequential delete loops
        expect(trashServiceSource).not.toContain("for (const p of validPosts)");
        expect(trashServiceSource).not.toContain("for (const m of validMedia)");
        expect(trashServiceSource).not.toContain("for (const p of trashedPosts)");
        expect(trashServiceSource).not.toContain("for (const m of trashedMedia)");

        // Must invoke batch lifecycle methods
        expect(trashServiceSource).toContain("batchDeletePost");
        expect(trashServiceSource).toContain("batchDeleteMedia");
        expect(trashServiceSource).toContain("batchRestorePost");
        expect(trashServiceSource).toContain("batchRestoreMedia");
    });
});
