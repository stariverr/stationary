import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const resolveSrc = (relativePath: string) => join(import.meta.dir, "..", relativePath);

const sourceFiles = {
    schema: () => Bun.file(resolveSrc("src/db/schema/index.ts")).text(),
    postApi: () => Bun.file(resolveSrc("src/api/post.ts")).text(),
    mediaApi: () => Bun.file(resolveSrc("src/api/media.ts")).text(),
    taskService: async () => {
        const task = await Bun.file(resolveSrc("src/services/task.ts")).text();
        const ingestDb = await Bun.file(resolveSrc("src/services/ingest/persistence.ts")).text();
        return task + "\n" + ingestDb;
    },
    latestMigration: async () => {
        const proc = Bun.spawn(["find", resolveSrc("drizzle"), "-name", "migration.sql", "-print"], {
            stdout: "pipe",
        });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        const files = output.trim().split("\n").filter(Boolean);
        const file = files.find((f) => f.includes("concerned_shape")) ?? files.sort().at(0);
        return Bun.file(file ?? "").text();
    },
};

describe("post and media time fields", () => {
    test("schema keeps create_time as record creation time and adds published_time", async () => {
        const schema = await sourceFiles.schema();

        expect(schema).toContain('create_time: temporal("create_time")');
        expect(schema).toContain('published_time: temporal("published_time")');
    });

    test("task service writes source timestamps to published_time instead of create_time", async () => {
        const taskService = await sourceFiles.taskService();

        expect(taskService).toContain("published_time:");
        expect(taskService).not.toContain("Temporal.Now.instant().epochMilliseconds");
    });

    test("post and media API responses include published_time", async () => {
        const postApi = await sourceFiles.postApi();
        const mediaApi = await sourceFiles.mediaApi();

        expect(postApi).toContain("published_time");
        expect(postApi).toContain("toIsoTimestamp");
        expect(mediaApi).toContain("published_time");
    });

    test("migration adds published_time without renaming create_time semantics away", async () => {
        const migration = await sourceFiles.latestMigration();

        expect(migration).toContain('"published_time"');
        expect(migration).toContain('"create_time"');
    });
});
