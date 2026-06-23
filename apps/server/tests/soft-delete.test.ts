import { describe, expect, test } from "bun:test";

const sourceFiles = {
    schema: () => Bun.file("src/db/schema/index.ts").text(),
    postApi: () => Bun.file("src/api/post.ts").text(),
    mediaApi: () => Bun.file("src/api/media.ts").text(),
    libraryApi: () => Bun.file("src/api/library.ts").text(),
    taskService: () => Bun.file("src/services/task.ts").text(),
    recycleService: () => Bun.file("src/services/recycle.ts").text(),
    latestMigration: async () => {
        const proc = Bun.spawn(["find", "drizzle", "-name", "migration.sql", "-print"], {
            stdout: "pipe",
        });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        const files = output.trim().split("\n").filter(Boolean);
        // Find the concerned_shape or latest migration
        const file =
            files.find((f) => f.includes("concerned_shape")) ?? files.sort().at(0);
        return Bun.file(file ?? "").text();
    },
};

describe("soft deletion lifecycle", () => {
    test("post and media tables expose delete_time with active-list indexes", async () => {
        const schema = await sourceFiles.schema();
        const migration = await sourceFiles.latestMigration();

        expect(schema).toContain('delete_time: temporal("delete_time")');
        expect(schema).toContain(
            'index("post_library_delete_time_idx").on(table.library_id, table.delete_time)',
        );
        expect(schema).toContain(
            'index("media_library_delete_time_idx").on(table.library_id, table.delete_time)',
        );
        expect(schema).toContain(
            'index("media_post_delete_time_idx").on(table.post_id, table.delete_time)',
        );

        const hasAddOrRename =
            migration.includes('"delete_time"') ||
            migration.includes('"delete_status"');
        expect(hasAddOrRename).toBe(true);
    });

    test("normal post and media APIs hide recycled/deleted records and expose trash actions", async () => {
        const postApi = await sourceFiles.postApi();
        const mediaApi = await sourceFiles.mediaApi();
        const clean = (str: string) => str.replace(/\s+/g, "");

        expect(clean(postApi)).toContain(clean("eq(Post.delete_status, DeleteStatus.ACTIVE)"));
        expect(clean(postApi)).toContain(clean("isNull(Post.recycle_time)"));
        expect(clean(postApi)).toContain(clean("eq(Media.delete_status, DeleteStatus.ACTIVE)"));
        expect(clean(postApi)).toContain(clean("isNull(Media.recycle_time)"));
        expect(clean(postApi)).toContain(clean('router.post("/trash/:id"'));
        expect(clean(postApi)).toContain(clean('router.post("/restore/:id"'));
        expect(clean(postApi)).toContain(clean('router.post("/delete/:id"'));

        expect(clean(mediaApi)).toContain(clean("eq(Media.delete_status, DeleteStatus.ACTIVE)"));
        expect(clean(mediaApi)).toContain(clean("isNull(Media.recycle_time)"));
        expect(clean(mediaApi)).toContain(clean('router.post("/trash/:id"'));
        expect(clean(mediaApi)).toContain(clean('router.post("/restore/:id"'));
        expect(clean(mediaApi)).toContain(clean('router.post("/delete/:id"'));
    });

    test("library deletion is blocked while any active post or media remains", async () => {
        const libraryApi = await sourceFiles.libraryApi();
        const recycleService = await sourceFiles.recycleService();
        const clean = (str: string) => str.replace(/\s+/g, "");

        expect(clean(libraryApi)).toContain(clean("DeleteService.deleteLibrary(id)"));
        expect(clean(libraryApi)).toContain(
            clean("Please empty posts and media in this library before deleting it."),
        );
        expect(clean(recycleService)).toContain(clean("eq(Post.library_id,libraryId)"));
        expect(clean(recycleService)).toContain(clean("eq(Post.delete_status,DeleteStatus.ACTIVE)"));
        expect(clean(recycleService)).toContain(clean("eq(Media.library_id,libraryId)"));
        expect(clean(recycleService)).toContain(clean("eq(Media.delete_status,DeleteStatus.ACTIVE)"));
    });

    test("scraper sync soft-deletes missing media instead of hard-deleting files", async () => {
        const taskService = await sourceFiles.taskService();

        expect(taskService).toContain("delete_time: deleteTime");
        expect(taskService).not.toContain("db.delete(Media)");
        expect(taskService).not.toContain("db.delete(MediaFile)");
    });
});
