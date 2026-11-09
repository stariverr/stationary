import { describe, expect, test } from "bun:test";
import { parseSidx } from "@/lib/utils/mp4-segment";

interface Reference {
    size: number;
    duration: number;
    nested?: boolean;
}

/** Builds a sidx box (ISO/IEC 14496-12 §8.16.3). */
const sidx = (options: { version: 0 | 1; timescale: number; firstOffset: number; references: Reference[] }) => {
    const headerSize = options.version === 0 ? 32 : 40;
    const size = headerSize + options.references.length * 12;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, size);
    bytes.set(new TextEncoder().encode("sidx"), 4);
    view.setUint8(8, options.version);
    view.setUint32(12, 1); // reference_ID
    view.setUint32(16, options.timescale);
    let cursor = 20;
    if (options.version === 0) {
        view.setUint32(cursor, 0);
        view.setUint32(cursor + 4, options.firstOffset);
        cursor += 8;
    } else {
        view.setBigUint64(cursor, 0n);
        view.setBigUint64(cursor + 8, BigInt(options.firstOffset));
        cursor += 16;
    }
    view.setUint16(cursor + 2, options.references.length);
    cursor += 4;
    for (const reference of options.references) {
        view.setUint32(cursor, ((reference.nested ? 1 : 0) << 31) | reference.size);
        view.setUint32(cursor + 4, reference.duration);
        view.setUint32(cursor + 8, 0x9000_0000); // starts_with_SAP, SAP type 1
        cursor += 12;
    }
    return bytes;
};

describe("parseSidx", () => {
    test("expands a version 0 index into contiguous byte ranges after the box", () => {
        const box = sidx({
            version: 0,
            timescale: 15_360,
            firstOffset: 0,
            references: [
                { size: 74_043, duration: 30_720 },
                { size: 70_000, duration: 30_720 },
                { size: 1_000, duration: 7_680 },
            ],
        });

        expect(parseSidx(box, 782)).toEqual([
            { offset: 782 + 68, length: 74_043, duration: 2 },
            { offset: 782 + 68 + 74_043, length: 70_000, duration: 2 },
            { offset: 782 + 68 + 144_043, length: 1_000, duration: 0.5 },
        ]);
    });

    test("reads version 1 and skips first_offset bytes after the box", () => {
        const box = sidx({ version: 1, timescale: 48_000, firstOffset: 100, references: [{ size: 500, duration: 96_000 }] });

        expect(parseSidx(box, 1_000)).toEqual([{ offset: 1_000 + 52 + 100, length: 500, duration: 2 }]);
    });

    test("ignores trailing bytes after the box", () => {
        const box = sidx({ version: 0, timescale: 1_000, firstOffset: 0, references: [{ size: 10, duration: 1_000 }] });
        const padded = new Uint8Array(box.length + 16);
        padded.set(box);

        expect(parseSidx(padded, 0)).toEqual([{ offset: 44, length: 10, duration: 1 }]);
    });

    test("rejects a reference to a nested sidx", () => {
        const box = sidx({
            version: 0,
            timescale: 1_000,
            firstOffset: 0,
            references: [
                { size: 10, duration: 1_000 },
                { size: 44, duration: 1_000, nested: true },
            ],
        });

        expect(() => parseSidx(box, 0)).toThrow(/nested sidx/);
    });

    test("rejects bytes that are not a whole sidx box", () => {
        const box = sidx({ version: 0, timescale: 1_000, firstOffset: 0, references: [{ size: 10, duration: 1_000 }] });

        expect(() => parseSidx(box.subarray(0, box.length - 1), 0)).toThrow(/does not fit/);
        const moof = box.slice();
        moof.set(new TextEncoder().encode("moof"), 4);
        expect(() => parseSidx(moof, 0)).toThrow(/box type is "moof"/);
    });
});
