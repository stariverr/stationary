import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTagLyrics, type FfprobeOutput } from "@/features/media/probe";

// Files are encoded on the spot by ffmpeg and read back by ffprobe with the probe's own flags, so the tag names are
// the ones ffprobe really reports. ffmpeg writes MP3 lyrics as TXXX frames, so the real USLT frames other taggers
// write are built by hand in front of an MP3 encoded without tags.

const workDir = await mkdtemp(join(tmpdir(), "tag-lyrics-"));
afterAll(() => rm(workDir, { recursive: true, force: true }));

const TONE = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1"];
const LYRICS = "First line\nSecond line";

function run(command: string[]): string {
    const result = Bun.spawnSync(command);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
}

function encode(name: string, args: string[]): string {
    const path = join(workDir, name);
    run(["ffmpeg", "-v", "error", "-y", ...TONE, ...args, path]);
    return path;
}

function probe(path: string): FfprobeOutput {
    return JSON.parse(run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", path])) as FfprobeOutput;
}

const synchsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];

/** An ID3v2.4 tag of UTF-8 USLT frames: language, content descriptor, text. */
function uslt(frames: { language: string; descriptor: string; text: string }[]): Uint8Array {
    const encoder = new TextEncoder();
    const body = frames.flatMap(({ language, descriptor, text }) => {
        const content = [3, ...encoder.encode(language), ...encoder.encode(descriptor), 0, ...encoder.encode(text)];
        return [...encoder.encode("USLT"), ...synchsafe(content.length), 0, 0, ...content];
    });
    return new Uint8Array([...encoder.encode("ID3"), 4, 0, 0, ...synchsafe(body.length), ...body]);
}

async function mp3WithUslt(name: string, frames: Parameters<typeof uslt>[0]): Promise<string> {
    const audio = await Bun.file(encode(`${name}.raw.mp3`, ["-c:a", "libmp3lame", "-write_id3v2", "0"])).bytes();
    const path = join(workDir, name);
    await Bun.write(path, new Uint8Array([...uslt(frames), ...audio]));
    return path;
}

describe("lyrics in tags", () => {
    test("MP3 USLT frames, with language and content descriptor", async () => {
        const path = await mp3WithUslt("uslt.mp3", [
            { language: "eng", descriptor: "", text: "First line\r\nSecond line" },
            { language: "jpn", descriptor: "Verse", text: "一行目\r\n二行目" },
            { language: "XXX", descriptor: "", text: "No language" },
        ]);
        expect(readTagLyrics(probe(path))).toEqual([
            { language: "eng", label: null, text: LYRICS },
            { language: "jpn", label: "Verse", text: "一行目\n二行目" },
            { language: null, label: null, text: "No language" },
        ]);
    });

    test("MP3 lyrics written by ffmpeg", () => {
        const path = encode("ffmpeg.mp3", ["-c:a", "libmp3lame", "-metadata", `lyrics-eng=${LYRICS}`]);
        expect(readTagLyrics(probe(path))).toEqual([{ language: "eng", label: null, text: LYRICS }]);
    });

    test("M4A ©lyr", () => {
        const path = encode("lyrics.m4a", ["-c:a", "aac", "-metadata", `lyrics=${LYRICS}`]);
        expect(readTagLyrics(probe(path))).toEqual([{ language: null, label: null, text: LYRICS }]);
    });

    test("FLAC LYRICS", () => {
        const path = encode("lyrics.flac", ["-c:a", "flac", "-metadata", `LYRICS=${LYRICS}`]);
        expect(readTagLyrics(probe(path))).toEqual([{ language: null, label: null, text: LYRICS }]);
    });

    test("Ogg Opus keeps its Vorbis comments on the stream", () => {
        const path = encode("lyrics.opus", ["-c:a", "libopus", "-metadata", `UNSYNCEDLYRICS=${LYRICS}`]);
        expect(readTagLyrics(probe(path))).toEqual([{ language: null, label: null, text: LYRICS }]);
    });

    test("a file without lyrics, or with blank lyrics, has none", () => {
        expect(readTagLyrics(probe(encode("plain.m4a", ["-c:a", "aac", "-metadata", "title=Song"])))).toEqual([]);
        expect(readTagLyrics(probe(encode("blank.flac", ["-c:a", "flac", "-metadata", "LYRICS= \n "])))).toEqual([]);
    });
});
