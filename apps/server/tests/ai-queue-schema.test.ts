import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { QueueAiSchema } from "../src/features/ai/schema";

const postId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3";
const mediaId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b4";

describe("queue AI schema", () => {
    test("accepts post and media targets", () => {
        expect(
            v.safeParse(QueueAiSchema, {
                post_ids: [postId],
                media_ids: [mediaId],
            }).success,
        ).toBe(true);
    });

    test("rejects an empty target set", () => {
        expect(v.safeParse(QueueAiSchema, {}).success).toBe(false);
        expect(v.safeParse(QueueAiSchema, { post_ids: [], media_ids: [] }).success).toBe(false);
    });

    test("rejects malformed target ids", () => {
        expect(v.safeParse(QueueAiSchema, { media_ids: ["not-a-uuid"] }).success).toBe(false);
    });
});
