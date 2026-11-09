import { describe, expect, test } from "bun:test";
import { avatarOrigin } from "@/features/author/avatar-pipeline";
import {
    Aspect,
    PIPELINES,
    PIPELINE_NAMES,
    assertAcyclic,
    parseQueueName,
    pipelinesReading,
    queueLockOrder,
    queueName,
    scanQueueName,
} from "@/infra/queue/pipelines";

describe("pipeline declarations", () => {
    test("the declared pipelines form no cycle", () => {
        expect(() => assertAcyclic(PIPELINES)).not.toThrow();
    });

    test("a cycle through outputs and inputs is rejected", () => {
        expect(() =>
            assertAcyclic({
                a: { subject: "media", inputs: [Aspect.MEDIA_COVER], outputs: [Aspect.MEDIA_CONTENT] },
                b: { subject: "media", inputs: [Aspect.MEDIA_CONTENT], outputs: [Aspect.MEDIA_COVER] },
            }),
        ).toThrow("cycle");
    });

    test("aspects route to the pipelines that read them", () => {
        expect(pipelinesReading(Aspect.MEDIA_SOURCE)).toEqual(["download"]);
        expect(pipelinesReading(Aspect.MEDIA_CONTENT)).toEqual(["preview"]);
        expect(pipelinesReading(Aspect.MEDIA_COVER)).toEqual(["preview"]);
        expect(pipelinesReading(Aspect.MEDIA_PREVIEW)).toEqual(["ai.describe", "ai.image"]);
        expect(pipelinesReading(Aspect.MEDIA_DESCRIPTION)).toEqual(["ai.index"]);
        expect(pipelinesReading(Aspect.MEDIA_SEARCH_DOC)).toEqual(["ai.text"]);
        expect(pipelinesReading(Aspect.LIBRARY_SPACES)).toEqual(["ai.text", "ai.image"]);
    });

    test("pipelines are declared in dependency order, which the queue's lock order relies on", () => {
        PIPELINE_NAMES.forEach((pipeline, index) => {
            for (const output of PIPELINES[pipeline].outputs) {
                for (const reader of pipelinesReading(output)) expect(PIPELINE_NAMES.indexOf(reader)).toBeGreaterThan(index);
            }
        });
    });

    test("a scan locks before its pipeline, and a pipeline before the ones that read it", () => {
        const order = [scanQueueName("preview"), queueName("preview", null), scanQueueName("ai.text", "s"), queueName("ai.text", "s")];
        expect(order.map(queueLockOrder)).toEqual(order.map(queueLockOrder).toSorted((a, b) => a - b));
        expect(new Set(order.map(queueLockOrder)).size).toBe(order.length);
    });

    test("queue names round-trip", () => {
        expect(parseQueueName("preview")).toEqual({ pipeline: "preview", scan: false, space: null });
        expect(parseQueueName(scanQueueName("avatar"))).toEqual({ pipeline: "avatar", scan: true, space: null });
        expect(parseQueueName(queueName("ai.text", "s1"))).toEqual({ pipeline: "ai.text", scan: false, space: "s1" });
        expect(parseQueueName(scanQueueName("ai.image", "s2"))).toEqual({ pipeline: "ai.image", scan: true, space: "s2" });
        expect(parseQueueName("scan:unknown")).toBeNull();
        // A per-space pipeline always names its space, and only those do.
        expect(parseQueueName("ai.text")).toBeNull();
        expect(parseQueueName("preview:s1")).toBeNull();
        // The removed cover pipeline is not a queue any more.
        expect(parseQueueName("cover")).toBeNull();
    });
});

describe("avatarOrigin", () => {
    test("a file to copy takes precedence over a URL", () => {
        expect(avatarOrigin({ avatar_source_file_id: "f1", avatar_source_url: "https://a" })).toBe("file:f1");
        expect(avatarOrigin({ avatar_source_file_id: null, avatar_source_url: "https://a" })).toBe("url:https://a");
        expect(avatarOrigin({ avatar_source_file_id: null, avatar_source_url: null })).toBeNull();
    });
});
