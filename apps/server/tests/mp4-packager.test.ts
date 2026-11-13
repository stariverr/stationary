import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMp4Layout } from "@/lib/utils/mp4-layout";
import {
    decodePackagedFile,
    encodePackagedFile,
    indexMoov,
    packageSegment,
    segmentCount,
    type PackagedTrack,
} from "@/lib/utils/mp4-packager";

// Samples are encoded on the spot by ffmpeg, then packaged and read back by ffmpeg: the packaged stream must carry
// exactly the original's samples, on the original's presentation timeline (edit lists applied).

const workDir = await mkdtemp(join(tmpdir(), "mp4-packager-"));
afterAll(() => rm(workDir, { recursive: true, force: true }));

const ffmpeg = (args: string[]) => {
    const result = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
};

const VIDEO = ["-f", "lavfi", "-i", "testsrc=size=160x90:rate=30"];
const tone = (hz: number) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000`];
const H264 = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-bf", "2", "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", "64k"];

async function encode(name: string, args: string[]) {
    const path = join(workDir, name);
    ffmpeg([...args, "-t", "14", path]);
    return path;
}

const reader = (path: string) => {
    const file = Bun.file(path);
    return { size: file.size, read: async (start: number, end: number) => new Uint8Array(await file.slice(start, end + 1).arrayBuffer()) };
};

async function index(path: string) {
    const { read, size } = reader(path);
    const { moov } = await readMp4Layout(read, size);
    return indexMoov(moov!);
}

async function segmentBytes(track: PackagedTrack, index: number, path: string) {
    const { size, body } = packageSegment(track, index, reader(path).read);
    const bytes = await new Response(body).bytes();
    expect(bytes.byteLength).toBe(size);
    return bytes;
}

/** Writes the init segment and every media segment of a track into one fMP4 file. */
async function packageAll(path: string, track: PackagedTrack, name: string) {
    const parts: Uint8Array[] = [track.init];
    for (let i = 0; i < segmentCount(track); i++) parts.push(await segmentBytes(track, i, path));
    const out = join(workDir, name);
    await Bun.write(out, Buffer.concat(parts));
    return out;
}

/** Packet hashes (without timestamps) of one stream. */
const packets = (path: string, map: string) =>
    ffmpeg(["-i", path, "-map", map, "-c", "copy", "-f", "framemd5", "-"])
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split(",").slice(4, 6).join(",").trim());

describe("just-in-time MP4 packaging", () => {
    test("packages every track of a file with moov at the end, sample for sample", async () => {
        const path = await encode("multi.mp4", [...VIDEO, ...tone(1000), ...tone(2000), "-map", "0", "-map", "1", "-map", "2", ...H264, ...AAC]);
        const file = await index(path);
        expect(file.tracks.map((track) => [track.trakIndex, track.kind])).toEqual([
            [0, "video"],
            [1, "audio"],
            [2, "audio"],
        ]);

        const [video, , english] = file.tracks;
        // 14 s at 2 s GOPs cut at ~6 s: 0-6, 6-12, 12-14.
        expect(segmentCount(video!)).toBe(3);
        expect(packets(await packageAll(path, video!, "v.mp4"), "0:v")).toEqual(packets(path, "0:v"));
        expect(packets(await packageAll(path, english!, "a.mp4"), "0:a")).toEqual(packets(path, "0:a:1"));
    });

    test("applies the edit list so B-frame video presents from 0 like the original", async () => {
        const path = await encode("faststart.mp4", [...VIDEO, ...tone(1000), ...H264, ...AAC, "-movflags", "+faststart"]);
        const [video, audio] = (await index(path)).tracks;
        // ffmpeg delays B-frame video by two frames (1024 ticks) and trims it with an edit; the packaged track has no
        // edit, so the first sync sample presents at its decode time 0 and reordered frames get negative offsets.
        expect(video!.compositionOffsets[0]).toBe(0);
        expect(Math.min(...video!.compositionOffsets)).toBeLessThan(0);
        // AAC priming (1024 samples) is trimmed the same way.
        expect(audio!.compositionOffsets[0]).toBe(-1024);
        expect(Buffer.from(video!.init).includes("edts")).toBe(false);
    });

    test("survives the cache round trip", async () => {
        const path = await encode("audio.m4a", [...tone(440), ...AAC]);
        const file = await index(path);
        const decoded = decodePackagedFile(encodePackagedFile(file));
        expect(decoded).toEqual(file);
        expect(await segmentBytes(decoded.tracks[0]!, 1, path)).toEqual(await segmentBytes(file.tracks[0]!, 1, path));
    });

    test("reads runs longer than a read piece in order", async () => {
        // A video-only file is one byte run per segment; lossless video makes that run longer than a 1 MiB piece.
        const path = await encode("big.mp4", ["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0"]);
        const [video] = (await index(path)).tracks;
        const firstSegment = video!.sizes.slice(0, video!.segmentSamples[1]).reduce((total, size) => total + size, 0);
        expect(firstSegment).toBeGreaterThan(1024 * 1024);
        expect(packets(await packageAll(path, video!, "big-v.mp4"), "0:v")).toEqual(packets(path, "0:v"));
    });

    test("rejects a fragmented file", async () => {
        const path = await encode("frag.mp4", [...tone(440), ...AAC, "-movflags", "frag_keyframe+empty_moov"]);
        await expect(index(path)).rejects.toThrow("fragmented");
    });

    test("the layout tells fragmented files from plain ones, with or without a sidx", async () => {
        const layout = async (name: string, movflags: string) => {
            const { read, size } = reader(await encode(name, [...tone(440), ...AAC, "-movflags", movflags]));
            const { fragmented, segmentIndex } = await readMp4Layout(read, size);
            return { fragmented, sidx: segmentIndex !== null };
        };
        expect(await layout("plain.m4a", "+faststart")).toEqual({ fragmented: false, sidx: false });
        expect(await layout("frag-no-sidx.m4a", "frag_keyframe+empty_moov")).toEqual({ fragmented: true, sidx: false });
        expect(await layout("frag-sidx.m4a", "frag_keyframe+empty_moov+global_sidx")).toEqual({ fragmented: true, sidx: true });
    });
});
