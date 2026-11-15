/**
 * Reads a `.vvic` image (`image/vvic`): a HEIF file whose primary item is one VVC (H.266) intra picture, as Douyin
 * writes them.
 *
 * Neither ImageMagick nor FFmpeg opens the container: libheif has no VVC decoder here and rejects Douyin's `vvcC`,
 * and FFmpeg's MP4 demuxer does not expose `vvc1` items. FFmpeg does decode raw VVC, so the picture is taken out of
 * the container as an Annex B stream.
 */
import { boxes, child } from "@/lib/utils/mp4-codec-string";

export interface VvicImage {
    width: number;
    height: number;
    /** The parameter sets and the picture as an Annex B stream, which FFmpeg reads as a `.vvc` file. */
    annexB: Uint8Array;
}

const START_CODE = Uint8Array.of(0, 0, 0, 1);
/** Properties that change how the picture is displayed. None has been seen in a `.vvic`, so none is applied. */
const TRANSFORMS = new Set(["irot", "imir", "clap"]);
/** OPI and DCI arrays in a `vvcC` hold exactly one NAL unit and carry no count. */
const SINGLE_NAL_TYPES = new Set([12, 13]);

export function readVvic(bytes: Uint8Array): VvicImage {
    // meta, iinf, pitm, iloc and ipma are full boxes: version and flags come before their fields.
    const meta = child(bytes, "meta").subarray(4);
    const itemId = primaryItemId(child(meta, "pitm"));

    const type = itemType(child(meta, "iinf"), itemId);
    if (type !== "vvc1") throw new Error(`The primary item is ${type ?? "missing"}, not a single VVC picture`);

    const iprp = child(meta, "iprp");
    const properties = itemProperties(Array.from(boxes(child(iprp, "ipco"))), child(iprp, "ipma"), itemId);
    const transform = properties.find((property) => TRANSFORMS.has(property.type));
    if (transform) throw new Error(`The ${transform.type} transform is not supported`);
    const ispe = properties.find((property) => property.type === "ispe")?.data;
    const vvcC = properties.find((property) => property.type === "vvcC")?.data;
    if (!ispe || !vvcC) throw new Error("The picture has no size or no decoder configuration");

    const config = readDecoderConfig(vvcC);
    const picture = nalUnits(itemData(bytes, child(meta, "iloc"), itemId), config.lengthSize);
    const size = view(ispe);
    return {
        width: size.getUint32(4),
        height: size.getUint32(8),
        annexB: concat([...config.parameterSets, ...picture].flatMap((nal) => [START_CODE, nal])),
    };
}

function primaryItemId(pitm: Uint8Array): number {
    return pitm[0] === 0 ? view(pitm).getUint16(4) : view(pitm).getUint32(4);
}

function itemType(iinf: Uint8Array, itemId: number): string | null {
    for (const infe of boxes(iinf.subarray(iinf[0] === 0 ? 6 : 8))) {
        const version = infe.data[0]!;
        if (version < 2) continue;
        const data = view(infe.data);
        const id = version === 2 ? data.getUint16(4) : data.getUint32(4);
        // item_ID, then a 16-bit protection index, then the type.
        const typeOffset = (version === 2 ? 6 : 8) + 2;
        if (id === itemId) return String.fromCharCode(...infe.data.subarray(typeOffset, typeOffset + 4));
    }
    return null;
}

function itemProperties(ipco: { type: string; data: Uint8Array }[], ipma: Uint8Array, itemId: number) {
    const data = view(ipma);
    const version = ipma[0]!;
    const wideIndex = (ipma[3]! & 1) === 1;
    let offset = 8;
    for (let entry = data.getUint32(4); entry > 0; entry--) {
        const id = version === 0 ? data.getUint16(offset) : data.getUint32(offset);
        offset += version === 0 ? 2 : 4;
        const count = ipma[offset++]!;
        const indexes: number[] = [];
        for (let i = 0; i < count; i++) {
            // The top bit marks the property essential; the rest is its 1-based place in ipco.
            indexes.push(wideIndex ? data.getUint16(offset) & 0x7fff : ipma[offset]! & 0x7f);
            offset += wideIndex ? 2 : 1;
        }
        if (id === itemId) return indexes.flatMap((index) => ipco[index - 1] ?? []);
    }
    return [];
}

/** The item's bytes: its extents in the file, joined. */
function itemData(file: Uint8Array, iloc: Uint8Array, itemId: number): Uint8Array {
    const data = view(iloc);
    const version = iloc[0]!;
    const [offsetSize, lengthSize, baseOffsetSize, indexSize] = [iloc[4]! >> 4, iloc[4]! & 15, iloc[5]! >> 4, version === 0 ? 0 : iloc[5]! & 15];
    let offset = 6;
    const read = (size: number): number => {
        const value = size === 8 ? Number(data.getBigUint64(offset)) : size === 4 ? data.getUint32(offset) : size === 2 ? data.getUint16(offset) : 0;
        offset += size;
        return value;
    };
    for (let item = read(version < 2 ? 2 : 4); item > 0; item--) {
        const id = read(version < 2 ? 2 : 4);
        const constructionMethod = version === 0 ? 0 : read(2) & 15;
        offset += 2; // data_reference_index
        const baseOffset = read(baseOffsetSize);
        const extents: Uint8Array[] = [];
        for (let extent = read(2); extent > 0; extent--) {
            offset += indexSize;
            const start = baseOffset + read(offsetSize);
            const length = read(lengthSize);
            extents.push(file.subarray(start, length === 0 ? file.length : start + length));
        }
        if (id !== itemId) continue;
        if (constructionMethod !== 0) throw new Error("The picture is not stored at a file offset");
        return concat(extents);
    }
    throw new Error("The picture has no location");
}

/**
 * The NAL length size and the parameter sets of a `vvcC`.
 *
 * Douyin's box follows a draft of ISO/IEC 14496-15: it has no version and flags, and its profile-tier-level record
 * is laid out differently. The parameter set arrays at the end are the same in both, so they are found as the one
 * place from which the arrays parse to exactly the end of the box with every NAL unit of its array's type.
 */
function readDecoderConfig(vvcC: Uint8Array): { lengthSize: number; parameterSets: Uint8Array[] } {
    const record = vvcC[0] === 0 ? vvcC.subarray(4) : vvcC;
    const lengthSize = ((record[0]! >> 1) & 3) + 1;
    for (let start = 1; start < record.length; start++) {
        const parameterSets = readParameterSets(record, start);
        if (parameterSets?.length) return { lengthSize, parameterSets };
    }
    throw new Error("The decoder configuration has no parameter sets");
}

function readParameterSets(record: Uint8Array, start: number): Uint8Array[] | null {
    const data = view(record);
    const parameterSets: Uint8Array[] = [];
    let offset = start + 1;
    for (let array = record[start]!; array > 0; array--) {
        if (offset >= record.length) return null;
        const type = record[offset++]! & 31;
        let count = 1;
        if (!SINGLE_NAL_TYPES.has(type)) {
            if (offset + 2 > record.length) return null;
            count = data.getUint16(offset);
            offset += 2;
        }
        for (; count > 0; count--) {
            if (offset + 2 > record.length) return null;
            const length = data.getUint16(offset);
            const nal = record.subarray(offset + 2, offset + 2 + length);
            offset += 2 + length;
            // The NAL unit type is the top five bits of the second header byte.
            if (length < 2 || offset > record.length || nal[1]! >> 3 !== type) return null;
            parameterSets.push(nal);
        }
    }
    return offset === record.length ? parameterSets : null;
}

/** Splits length-prefixed NAL units. */
function nalUnits(bytes: Uint8Array, lengthSize: number): Uint8Array[] {
    const units: Uint8Array[] = [];
    for (let offset = 0; offset + lengthSize <= bytes.length; ) {
        let length = 0;
        for (let i = 0; i < lengthSize; i++) length = length * 256 + bytes[offset + i]!;
        offset += lengthSize;
        if (length === 0 || offset + length > bytes.length) throw new Error("The picture data is truncated");
        units.push(bytes.subarray(offset, offset + length));
        offset += length;
    }
    if (units.length === 0) throw new Error("The picture has no data");
    return units;
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
    }
    return joined;
}

function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
