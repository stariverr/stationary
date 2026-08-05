import { describe, expect, test } from "bun:test";
import * as v from "valibot";

Object.assign(process.env, {
    AUTH_SECRET: "test-auth-secret",
    RESEND_API_KEY: "test-resend-key",
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_REGION: "test-region",
    S3_BUCKET: "test-bucket",
    CDN_BASE_URL: "http://localhost:9000/test-bucket",
    DB_URL: "postgres://test:test@localhost:5432/test",
});

describe("library creation", () => {
    test("rejects user_id from the request body", async () => {
        const libraryApi = await import("../src/api/library");

        const parsed = v.safeParse(libraryApi.LibraryCreateBodySchema, {
            name: "Design References",
            description: "",
            user_id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3",
        });

        expect(parsed.success).toBe(false);
    });

    test("updates libraries by id and rejects legacy identifier payloads", async () => {
        const libraryApi = await import("../src/api/library");
        const id = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3";
        const legacyIdentifierKey = ["u", "id"].join("");

        const currentPayload = v.safeParse(libraryApi.LibraryUpdateBodySchema, {
            id,
            name: "Updated",
        });
        expect(currentPayload.success).toBe(true);

        const legacyPayload = v.safeParse(libraryApi.LibraryUpdateBodySchema, {
            [legacyIdentifierKey]: id,
            name: "Updated",
        });
        expect(legacyPayload.success).toBe(false);
    });
});

describe("library item movement", () => {
    test("accepts post and independent media ids without a source library id", async () => {
        const libraryApi = await import("../src/api/library");
        const targetLibraryId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3";
        const postId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b4";
        const mediaId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b5";

        const parsed = v.safeParse(libraryApi.LibraryMoveItemsBodySchema, {
            post_ids: [postId],
            media_ids: [mediaId],
            target_library_id: targetLibraryId,
        });

        expect(parsed.success).toBe(true);
    });

    test("rejects empty movement requests", async () => {
        const libraryApi = await import("../src/api/library");
        const targetLibraryId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3";

        const parsed = v.safeParse(libraryApi.LibraryMoveItemsBodySchema, {
            post_ids: [],
            media_ids: [],
            target_library_id: targetLibraryId,
        });

        expect(parsed.success).toBe(false);
    });

    test("requires selected media to be independent", async () => {
        const libraryApi = await import("../src/api/library");

        expect(
            libraryApi.getAttachedMediaIds([
                { id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b4", post_id: null },
                {
                    id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b5",
                    post_id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b6",
                },
            ]),
        ).toEqual(["018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b5"]);
    });

    test("deduplicates selected ids before updating rows", async () => {
        const libraryApi = await import("../src/api/library");
        const id = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b4";

        expect(libraryApi.uniqueIds([id, id])).toEqual([id]);
    });

    test("exposes an action-style move-items endpoint", async () => {
        const source = await Bun.file("src/api/library.ts").text();
        const clean = (str: string) => str.replace(/\s+/g, "");

        expect(clean(source)).toContain(clean('router.post("/move-items"'));
        expect(clean(source)).not.toContain(clean('router.post("/migrate-items"'));
    });

    test("moves post media with their parent posts", async () => {
        const source = await Bun.file("src/api/library.ts").text();
        const clean = (str: string) => str.replace(/\s+/g, "");

        expect(clean(source)).toContain(clean(".update(Post)"));
        expect(clean(source)).toContain(clean(".update(Media)"));
        expect(clean(source)).toContain(clean("inArray(Media.post_id, body.post_ids)"));
    });
});

describe("cover config and jobs api", () => {
    test("validates force option in cover jobs body schema", async () => {
        const libraryApi = await import("../src/api/library");

        const defaultParsed = v.parse(libraryApi.LibraryCoverJobsBodySchema, {
            type: "MANUAL",
        });
        expect(defaultParsed.force).toBe(false);

        const forceParsed = v.parse(libraryApi.LibraryCoverJobsBodySchema, {
            type: "MANUAL",
            force: true,
        });
        expect(forceParsed.force).toBe(true);
    });

    test("exposes decoupled cover-config and cover-jobs/active endpoints", async () => {
        const source = await Bun.file("src/api/library.ts").text();
        const clean = (str: string) => str.replace(/\s+/g, "");

        expect(clean(source)).toContain(clean('router.get("/:id/cover-config"'));
        expect(clean(source)).toContain(clean('router.get("/:id/cover-jobs/active"'));
    });

    test("LibraryCoverConfigBodySchema validates and orders qualities correctly", async () => {
        const libraryApi = await import("../src/api/library");
        const { Quality } = await import("../src/lib/types");

        const parsed = v.parse(libraryApi.LibraryCoverConfigBodySchema, {
            qualities: ["MEDIUM", "LOW"],
        });
        expect(parsed.qualities).toEqual([Quality.LOW, Quality.MEDIUM]);
    });
});
