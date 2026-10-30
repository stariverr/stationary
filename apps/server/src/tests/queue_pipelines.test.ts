import { describe, expect, test } from "bun:test";
import { DeleteStatus, File as DbFile, SyncStatus, Track, TrackPurpose, TrackType } from "@/db/schema";
import { avatarOrigin } from "@/features/author/avatar-pipeline";
import { coverVariantKey, pickCoverSource } from "@/features/media/cover";
import { planCover } from "@/features/media/cover-pipeline";
import { Aspect, PIPELINES, assertAcyclic, parseQueueName, pipelinesReading, queueName, scanQueueName } from "@/infra/queue/pipelines";
import { Quality } from "@/lib/types";

type TrackRow = typeof Track.$inferSelect;
type FileRow = typeof DbFile.$inferSelect;

const track = (fields: Partial<TrackRow>): TrackRow =>
    ({
        id: crypto.randomUUID(),
        media_id: "m1",
        type: TrackType.IMAGE,
        purpose: TrackPurpose.CONTENT,
        quality: null,
        priority: 0,
        is_primary: false,
        is_default: false,
        is_generated: false,
        is_stale: false,
        sync_status: SyncStatus.COMPLETED,
        delete_status: DeleteStatus.ACTIVE,
        file_id: null,
        metadata: {},
        variant_key: "original",
        last_error: null,
        ...fields,
    }) as TrackRow;

const file = (id: string, extension = "jpg"): FileRow =>
    ({ id, path: `p/${id}.${extension}`, bucket: "b", extension, delete_status: DeleteStatus.ACTIVE }) as FileRow;

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
        expect(pipelinesReading(Aspect.MEDIA_CONTENT)).toEqual(["cover", "ai.describe", "ai.image"]);
        expect(pipelinesReading(Aspect.LIBRARY_COVER_CONFIG)).toEqual(["cover"]);
        expect(pipelinesReading(Aspect.MEDIA_COVER)).toEqual(["ai.describe", "ai.image"]);
        expect(pipelinesReading(Aspect.MEDIA_DESCRIPTION)).toEqual(["ai.index"]);
        expect(pipelinesReading(Aspect.MEDIA_SEARCH_DOC)).toEqual(["ai.text"]);
        expect(pipelinesReading(Aspect.LIBRARY_SPACES)).toEqual(["ai.text", "ai.image"]);
    });

    test("queue names round-trip", () => {
        expect(parseQueueName("cover")).toEqual({ pipeline: "cover", scan: false, space: null });
        expect(parseQueueName(scanQueueName("avatar"))).toEqual({ pipeline: "avatar", scan: true, space: null });
        expect(parseQueueName(queueName("ai.text", "s1"))).toEqual({ pipeline: "ai.text", scan: false, space: "s1" });
        expect(parseQueueName(scanQueueName("ai.image", "s2"))).toEqual({ pipeline: "ai.image", scan: true, space: "s2" });
        expect(parseQueueName("scan:unknown")).toBeNull();
        // A per-space pipeline always names its space, and only those do.
        expect(parseQueueName("ai.text")).toBeNull();
        expect(parseQueueName("cover:s1")).toBeNull();
    });
});

describe("pickCoverSource", () => {
    test("prefers a renderable image over video and unsupported formats", () => {
        const video = track({ type: TrackType.VIDEO, file_id: "f-video" });
        const jxl = track({ file_id: "f-jxl" });
        const image = track({ file_id: "f-image" });
        const source = pickCoverSource([
            { track: video, file: file("f-video", "mp4") },
            { track: jxl, file: file("f-jxl", "jxl") },
            { track: image, file: file("f-image") },
        ]);
        expect(source?.fileId).toBe("f-image");
    });

    test("ignores tracks that are not completed content with an active file", () => {
        const deletedFile = { ...file("f1"), delete_status: DeleteStatus.DELETED } as FileRow;
        expect(
            pickCoverSource([
                { track: track({ file_id: "f1" }), file: deletedFile },
                { track: track({ file_id: "f2", sync_status: SyncStatus.PENDING }), file: file("f2") },
                { track: track({ file_id: "f3", purpose: TrackPurpose.COVER }), file: file("f3") },
                { track: track({ file_id: null }), file: null },
            ]),
        ).toBeNull();
    });
});

describe("planCover", () => {
    const qualities = [Quality.LOW, Quality.HIGH];
    const cover = (quality: Quality, fields: Partial<TrackRow>) =>
        track({ purpose: TrackPurpose.COVER, quality, variant_key: coverVariantKey(quality), is_generated: true, ...fields });

    test("renders every configured quality that has no cover", () => {
        expect(planCover("src", [], new Set(), qualities, false)).toEqual(qualities);
    });

    test("a cover generated from the current source is current", () => {
        const tracks = [cover(Quality.LOW, { file_id: "c1", metadata: { source_file_id: "src" } })];
        expect(planCover("src", tracks, new Set(["c1"]), qualities, false)).toEqual([Quality.HIGH]);
    });

    test("stale covers, covers of an older source and covers without an active file are rendered again", () => {
        const tracks = [
            cover(Quality.LOW, { file_id: "c1", metadata: { source_file_id: "old" } }),
            cover(Quality.HIGH, { file_id: "c2", metadata: { source_file_id: "src" }, is_stale: true }),
        ];
        expect(planCover("src", tracks, new Set(["c1", "c2"]), qualities, false)).toEqual(qualities);
        const fresh = [cover(Quality.LOW, { file_id: "c3", metadata: { source_file_id: "src" } })];
        expect(planCover("src", fresh, new Set(), [Quality.LOW], false)).toEqual([Quality.LOW]);
    });

    test("a cover supplied by the source counts for its quality", () => {
        const supplied = track({ purpose: TrackPurpose.COVER, quality: Quality.HIGH, file_id: "c1" });
        expect(planCover("src", [supplied], new Set(["c1"]), qualities, false)).toEqual([Quality.LOW]);
    });

    test("scans skip a quality rejected on the current source, changes do not", () => {
        const failed = [
            cover(Quality.LOW, { sync_status: SyncStatus.FAILED, last_error: "bad", metadata: { error_source_file_id: "src" } }),
        ];
        expect(planCover("src", failed, new Set(), [Quality.LOW], true)).toEqual([]);
        expect(planCover("src", failed, new Set(), [Quality.LOW], false)).toEqual([Quality.LOW]);
        expect(planCover("new", failed, new Set(), [Quality.LOW], true)).toEqual([Quality.LOW]);
    });

    test("scans retry a quality that failed for another reason", () => {
        const failed = [cover(Quality.LOW, { sync_status: SyncStatus.FAILED, last_error: "storage is down" })];
        expect(planCover("src", failed, new Set(), [Quality.LOW], true)).toEqual([Quality.LOW]);
    });
});

describe("avatarOrigin", () => {
    test("a file to copy takes precedence over a URL", () => {
        expect(avatarOrigin({ avatar_source_file_id: "f1", avatar_source_url: "https://a" })).toBe("file:f1");
        expect(avatarOrigin({ avatar_source_file_id: null, avatar_source_url: "https://a" })).toBe("url:https://a");
        expect(avatarOrigin({ avatar_source_file_id: null, avatar_source_url: null })).toBeNull();
    });
});
