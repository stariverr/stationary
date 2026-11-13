import { expect, test } from "bun:test";

test("OpenAPI documents the media playback contract", async () => {
    const document = await Bun.file("docs/openapi.json").json();
    const mediaDetail = document.paths["/api/media/detail/{id}"].get.responses["200"].content["application/json"].schema.properties.data;
    const playback = mediaDetail.properties.playback;
    const playbackSchema = playback.anyOf?.find((item: { type?: string }) => item.type !== "null") ?? playback;

    for (const property of ["direct_url", "hls_url", "dash_url", "duration", "video", "audio_tracks", "captions", "lyrics"]) {
        expect(playbackSchema.properties[property]).toBeDefined();
    }
    expect(playbackSchema.properties.audio_tracks.items.properties.codec_string).toBeDefined();
    expect(playbackSchema.properties.captions.items.properties.vtt_url.type).toBe("string");
    expect(playbackSchema.properties.lyrics.items.properties.lrc_url.type).toBe("string");
    expect(playbackSchema.properties.lyrics.items.properties.timing.enum).toEqual(["NONE", "LINE", "WORD"]);
    for (const property of ["originals", "captions", "width", "height", "duration"]) {
        expect(mediaDetail.properties[property]).toBeDefined();
    }

    const postMedia = document.paths["/api/post/{id}/media"].get.responses["200"].content["application/json"].schema.properties.data;
    expect(postMedia.properties.list.items.properties.playback).toBeDefined();
});
