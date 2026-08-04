import { expect, test } from "bun:test";

test("OpenAPI documents the canonical media playback contract", async () => {
    const document = await Bun.file("docs/openapi.json").json();
    const mediaDetail = document.paths["/api/media/detail/{id}"].get.responses["200"].content["application/json"].schema.properties.data;
    const playback = mediaDetail.properties.playback;
    const playbackSchema = playback.anyOf?.find((item: { type?: string }) => item.type !== "null") ?? playback;
    const variant = playbackSchema.properties.variants.items;

    for (const property of ["width", "height", "bandwidth", "frame_rate"]) {
        expect(variant.properties[property]).toBeDefined();
    }
    expect(playbackSchema.properties.capabilities.properties.protocol_supports_switching.type).toBe("boolean");
    expect(playbackSchema.properties.audio_tracks.items.properties.role).toBeDefined();
    expect(playbackSchema.properties.subtitle_tracks.items.properties.selectable.type).toBe("boolean");

    const postMedia = document.paths["/api/post/{id}/media"].get.responses["200"].content["application/json"].schema.properties.data;
    expect(postMedia.properties.list.items.properties.playback).toBeDefined();
});
