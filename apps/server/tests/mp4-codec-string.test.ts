import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Mp4TrackCodec, readMp4TrackCodecs } from "@/lib/utils/mp4-codec-string";

// Samples are encoded on the spot by ffmpeg. A case whose encoder is missing on
// this machine is skipped. MP4Box was not available when these expectations
// were written, so they are derived from the specifications (noted per case)
// and, for H.264/HEVC, checked against ffmpeg's `trace_headers` SPS output.

const encoders = (() => {
    try {
        const result = Bun.spawnSync(["ffmpeg", "-hide_banner", "-encoders"]);
        return new Set(
            result.stdout
                .toString()
                .split("\n")
                .map((line) => line.trim().split(/\s+/)[1])
                .filter((name): name is string => Boolean(name)),
        );
    } catch {
        return new Set<string>();
    }
})();

const workDir = await mkdtemp(join(tmpdir(), "mp4-codec-string-"));
afterAll(() => rm(workDir, { recursive: true, force: true }));

const VIDEO = ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10"];
const AUDIO = ["-f", "lavfi", "-i", "sine"];
const FRAGMENTED = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof"];

let sampleCount = 0;
async function encode(args: string[], { fragmented = true } = {}): Promise<Uint8Array> {
    const out = join(workDir, `${sampleCount++}.mp4`);
    const cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args, "-t", "0.3"];
    if (fragmented) cmd.push(...FRAGMENTED);
    cmd.push(out);
    const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
}

type Case = {
    name: string;
    encoder: string;
    args: string[];
    expected: string;
    fragmented?: boolean;
};

function video(name: string, encoder: string, args: string[], expected: string): Case {
    return { name, encoder, args: [...VIDEO, "-c:v", encoder, ...args], expected };
}

function audio(name: string, encoder: string, args: string[], expected: string, fragmented = true): Case {
    return { name, encoder, args: [...AUDIO, "-c:a", encoder, ...args], expected, fragmented };
}

const x265 = (params: string) => ["-x265-params", `log-level=error:${params}`];

const cases: Case[] = [
    // avcC: profile_idc, constraint flags, level_idc as hex. x264 sets
    // constraint_set0+1 (0xC0) for Baseline and constraint_set1 (0x40) for Main.
    video("H.264 Baseline 3.0", "libx264", ["-profile:v", "baseline", "-level", "3.0"], "avc1.42C01E"),
    video("H.264 Main 4.0", "libx264", ["-profile:v", "main", "-level", "4.0"], "avc1.4D4028"),
    video("H.264 High 4.1", "libx264", ["-profile:v", "high", "-level", "4.1"], "avc1.640029"),
    video(
        "H.264 High 10 5.1",
        "libx264",
        ["-pix_fmt", "yuv420p10le", "-profile:v", "high10", "-level", "5.1"],
        "avc1.6E0033",
    ),
    video("H.264 avc3 sample entry", "libx264", ["-tag:v", "avc3", "-level", "2.0"], "avc3.640014"),

    // hvcC: profile_idc, reversed compatibility flags, tier + level_idc (level
    // × 30), constraint bytes without trailing zeros. x265 writes
    // progressive_source + frame_only (0x90).
    video("HEVC Main 3.1", "libx265", ["-tag:v", "hvc1", ...x265("level-idc=3.1")], "hvc1.1.6.L93.90"),
    video(
        "HEVC Main 10 4.1",
        "libx265",
        ["-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", ...x265("level-idc=4.1:high-tier=0")],
        "hvc1.2.4.L123.90",
    ),
    video(
        "HEVC Main High tier 5.0",
        "libx265",
        ["-tag:v", "hvc1", ...x265("level-idc=5:high-tier=1:vbv-maxrate=100000:vbv-bufsize=100000")],
        "hvc1.1.6.H150.90",
    ),
    video("HEVC hev1 sample entry", "libx265", ["-tag:v", "hev1", ...x265("level-idc=2")], "hev1.1.6.L60.90"),
    // Main 4:4:4 (RExt, profile 4): compatibility bit 4 reversed is 0x10, and
    // the constraint bytes carry max_12/10/8bit (0x9E) and lower_bit_rate (0x08).
    video(
        "HEVC Main 4:4:4",
        "libx265",
        ["-pix_fmt", "yuv444p", "-tag:v", "hvc1", ...x265("level-idc=1")],
        "hvc1.4.10.L30.9E.8",
    ),

    // av1C: SVT-AV1 always writes seq_level_idx 0 (level 2.0) and only encodes
    // the Main profile, so other levels, the High tier and 12-bit are covered
    // by the hand-built av1C test below.
    video("AV1 Main 8-bit", "libsvtav1", [], "av01.0.00M.08"),
    video("AV1 Main 10-bit", "libsvtav1", ["-pix_fmt", "yuv420p10le"], "av01.0.00M.10"),

    // vpcC: profile, level (ffmpeg derives 1.0 → 10 for 64×64), bit depth.
    video("VP9 profile 0", "libvpx-vp9", [], "vp09.00.10.08"),
    video("VP9 profile 1 (4:4:4)", "libvpx-vp9", ["-pix_fmt", "yuv444p"], "vp09.01.10.08"),
    video("VP9 profile 2 (10-bit)", "libvpx-vp9", ["-pix_fmt", "yuv420p10le"], "vp09.02.10.10"),

    audio("AAC-LC", "aac", [], "mp4a.40.2"),
    // ffmpeg's own AAC encoder only produces AAC-LC. AudioToolbox (macOS only)
    // writes HE-AAC with backward-compatible signalling: AAC-LC followed by the
    // 0x2B7 SBR and 0x548 PS sync extensions. Explicit signalling is covered by
    // the hand-built esds tests below.
    audio("HE-AAC", "aac_at", ["-profile:a", "4"], "mp4a.40.5"),
    audio("HE-AAC v2", "aac_at", ["-ac", "2", "-profile:a", "28"], "mp4a.40.29"),
    // ffmpeg writes objectTypeIndication 0x6B (MPEG-1 audio) above 24 kHz and
    // 0x69 (MPEG-2 audio) at lower sample rates.
    audio("MP3 MPEG-1", "libmp3lame", ["-ar", "44100"], "mp4a.6B"),
    audio("MP3 MPEG-2", "libmp3lame", ["-ar", "22050"], "mp4a.69"),
    audio("Opus", "libopus", [], "opus"),
    // ffmpeg cannot write the dac3/dec3 boxes into an empty_moov init segment,
    // so the AC-3 family uses a regular MP4 with moov after mdat.
    audio("AC-3", "ac3", [], "ac-3", false),
    audio("E-AC-3", "eac3", [], "ec-3", false),
    audio("FLAC", "flac", [], "flac"),
];

describe("readMp4TrackCodecs with ffmpeg samples", () => {
    for (const c of cases) {
        test.skipIf(!encoders.has(c.encoder))(
            `${c.name} (${c.encoder})`,
            async () => {
                const tracks = readMp4TrackCodecs(await encode(c.args, { fragmented: c.fragmented }));
                const handler = c.args.includes("-c:v") ? "vide" : "soun";
                expect(tracks).toEqual([{ track_id: 1, handler, codec_string: c.expected }]);
            },
            30_000,
        );
    }

    test.skipIf(!encoders.has("libx264") || !encoders.has("aac") || !encoders.has("mov_text"))(
        "lists every track, with null for unsupported sample entries",
        async () => {
            const subtitles = join(workDir, "subtitles.srt");
            await writeFile(subtitles, "1\n00:00:00,000 --> 00:00:00,200\nhi\n");
            const bytes = await encode(
                [
                    ...VIDEO,
                    ...AUDIO,
                    "-i",
                    subtitles,
                    ...["-map", "0", "-map", "1", "-map", "2"],
                    ...["-c:v", "libx264", "-level", "3.0", "-c:a", "aac", "-c:s", "mov_text"],
                ],
                { fragmented: false },
            );
            const expected: Mp4TrackCodec[] = [
                { track_id: 1, handler: "vide", codec_string: "avc1.64001E" },
                { track_id: 2, handler: "soun", codec_string: "mp4a.40.2" },
                { track_id: 3, handler: "sbtl", codec_string: null },
            ];
            expect(readMp4TrackCodecs(bytes)).toEqual(expected);
            // The moov box on its own parses the same way.
            expect(readMp4TrackCodecs(topLevelBox(bytes, "moov"))).toEqual(expected);
        },
        30_000,
    );
});

describe("readMp4TrackCodecs with hand-built boxes", () => {
    test("av1C with High tier, level 13 and 12-bit profile 2", () => {
        // marker/version, seq_profile 2 | seq_level_idx 13, tier + high_bitdepth + twelve_bit.
        const av1C = box("av1C", [0x81, (2 << 5) | 13, 0b1110_0000, 0]);
        expect(codecOf(box("av01", zeros(78), av1C), "vide")).toBe("av01.2.13H.12");
    });

    test("esds with explicit HE-AAC signalling", () => {
        // AOT 5 (SBR), 24 kHz, stereo, extension 48 kHz, core AOT 2, GASpecificConfig.
        const config = bits("00101 0110 0010 0011 00010 000");
        expect(codecOf(mp4a(config), "soun")).toBe("mp4a.40.5");
    });

    test("esds with explicit HE-AAC v2 signalling", () => {
        const config = bits("11101 0110 0001 0011 00010 000");
        expect(codecOf(mp4a(config), "soun")).toBe("mp4a.40.29");
    });

    test("esds with an escaped audio object type", () => {
        // 31 escapes to 32 + 6 bits: 32 + 10 = 42 (USAC).
        const config = bits("11111 001010 0011 0010");
        expect(codecOf(mp4a(config), "soun")).toBe("mp4a.40.42");
    });

    test("rejects input without a moov box", () => {
        expect(() => readMp4TrackCodecs(box("ftyp", ascii("isom"), [0, 0, 2, 0]))).toThrow("moov");
    });

    test("rejects a truncated box", () => {
        const moov = box("moov", box("trak", zeros(8)));
        expect(() => readMp4TrackCodecs(moov.subarray(0, moov.length - 4))).toThrow("truncated");
    });
});

function topLevelBox(bytes: Uint8Array, type: string): Uint8Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (offset + 8 <= bytes.length) {
        const size = view.getUint32(offset);
        if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === type) {
            return bytes.subarray(offset, offset + size);
        }
        offset += size;
    }
    throw new Error(`${type} not found`);
}

type Bytes = Uint8Array | number[];

function box(type: string, ...parts: Bytes[]): Uint8Array {
    const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(ascii(type), 4);
    let offset = 8;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** Wraps one sample entry in moov/trak (track 1) and returns its codec string. */
function codecOf(entry: Uint8Array, handler: string): string | null {
    const tkhd = box("tkhd", zeros(12), u32(1), zeros(68));
    const hdlr = box("hdlr", zeros(8), ascii(handler), zeros(13));
    const stsd = box("stsd", zeros(4), u32(1), entry);
    const moov = box("moov", box("trak", tkhd, box("mdia", hdlr, box("minf", box("stbl", stsd)))));
    const [track] = readMp4TrackCodecs(moov);
    expect(track).toMatchObject({ track_id: 1, handler });
    return track?.codec_string ?? null;
}

/** An mp4a sample entry whose esds carries the given AudioSpecificConfig. */
function mp4a(audioSpecificConfig: number[]): Uint8Array {
    const descriptor = (tag: number, ...parts: number[][]) => {
        const body = parts.flat();
        return [tag, body.length, ...body];
    };
    const decoderSpecificInfo = descriptor(0x05, audioSpecificConfig);
    // objectTypeIndication 0x40, streamType audio, buffer size and bitrates.
    const decoderConfig = descriptor(0x04, [0x40, 0x15], zeros(11), decoderSpecificInfo);
    const es = descriptor(0x03, [0, 1, 0], decoderConfig);
    const esds = box("esds", zeros(4), es);
    // SampleEntry + AudioSampleEntry fields: 2 channels, 16-bit, 44.1 kHz.
    return box("mp4a", zeros(6), [0, 1], zeros(8), [0, 2, 0, 16], zeros(4), u32(44100 * 65536), esds);
}

function bits(pattern: string): number[] {
    const digits = pattern.replaceAll(" ", "").padEnd(Math.ceil(pattern.replaceAll(" ", "").length / 8) * 8, "0");
    return Array.from({ length: digits.length / 8 }, (_, i) => Number.parseInt(digits.slice(i * 8, i * 8 + 8), 2));
}

function u32(value: number): number[] {
    return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function zeros(length: number): number[] {
    return new Array(length).fill(0);
}

function ascii(text: string): number[] {
    return Array.from(text, (char) => char.charCodeAt(0));
}
