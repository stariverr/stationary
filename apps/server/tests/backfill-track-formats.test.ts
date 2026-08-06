import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TrackStreamLayout, TrackType } from "@/db/schema";
import { deriveBackfilledTrackFormat } from "@/scripts/backfill_track_formats";

const resolveSrc = (relativePath: string) => join(import.meta.dir, "..", relativePath);

describe("track format backfill", () => {
    test("re-derives legacy default values from metadata and physical file fields", () => {
        const format = deriveBackfilledTrackFormat(
            {
                id: "legacy-track",
                type: TrackType.VIDEO,
                metadata: {
                    type: "fmp4",
                    streams: [{ index: 0, type: TrackType.VIDEO, codec: "avc1.640028" }],
                    segment_base: { initialization: "0-899", index_range: "900-5000" },
                },
                container: null,
                is_fragmented: null,
                stream_layout: null,
                has_video: false,
                has_audio: false,
                streams: [],
            },
            { mime_type: "video/mp4", extension: "mp4" },
        );

        expect(format.container).toBe("mp4");
        expect(format.is_fragmented).toBe(true);
        expect(format.stream_layout).toBe(TrackStreamLayout.VIDEO_ONLY);
        expect(format.has_video).toBe(true);
        expect(format.has_audio).toBe(false);
        expect(format.streams).toHaveLength(1);
    });

    test("keeps the CLI dry-run by default and requires an explicit apply flag", async () => {
        const source = await Bun.file(resolveSrc("src/scripts/backfill_track_formats.ts")).text();

        expect(source).toContain("const apply = options.apply ?? false");
        expect(source).toContain('process.argv.includes("--apply")');
        expect(source).not.toContain("has_video = false");
    });
});
