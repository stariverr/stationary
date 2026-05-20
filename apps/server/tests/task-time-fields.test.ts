import { describe, expect, test } from "bun:test";

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

describe("task time fields", () => {
    test("accepts published_time for posts and media", async () => {
        const taskApi = await import("../src/api/task");

        const parsed = taskApi.CreateTaskSchema.parse({
            library_id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3",
            posts: [{
                title: "Original timestamp",
                description: "",
                external_id: "post-1",
                tags: [],
                author: { name: "Author", external_id: "author-1" },
                platform: "XHS",
                published_time: "2024-01-02T03:04:05Z",
                media: [{
                    external_id: "media-1",
                    title: "Media",
                    description: "",
                    type: "IMAGE",
                    primary_file_url: "https://example.com/image.jpg",
                    published_time: "2024-01-02T03:05:06Z",
                }],
            }],
        });

        expect(parsed.posts[0].published_time?.toString()).toBe("2024-01-02T03:04:05Z");
        expect(parsed.library_id).toBe("018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3");
        expect(parsed.posts[0].media[0].published_time?.toString()).toBe("2024-01-02T03:05:06Z");
    });

    test("keeps legacy create_time input as an alias for original publish time", async () => {
        const taskApi = await import("../src/api/task");

        const parsed = taskApi.CreateTaskSchema.parse({
            library_id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3",
            posts: [{
                title: "Legacy timestamp",
                description: "",
                external_id: "post-legacy",
                tags: [],
                author: { name: "Author", external_id: "author-1" },
                platform: "DOUYIN",
                create_time: "1710000000",
                media: [{
                    external_id: "media-legacy",
                    title: "",
                    description: "",
                    type: "VIDEO",
                    primary_file_url: "https://example.com/video.mp4",
                    create_time: "1710000000123",
                }],
            }],
        });

        expect(parsed.posts[0].published_time?.epochMilliseconds).toBe(1710000000000);
        expect(parsed.posts[0].media[0].published_time?.epochMilliseconds).toBe(1710000000123);
    });
});
