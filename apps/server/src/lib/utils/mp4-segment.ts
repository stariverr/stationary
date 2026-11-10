/** One media subsegment of a single-stream fMP4 file: a byte range and its duration in seconds. */
export interface Mp4Segment {
    offset: number;
    length: number;
    duration: number;
}

/**
 * Expands a sidx box into the byte ranges it indexes. `bytes` must hold the whole box and
 * `boxOffset` is where it starts in the file. Hierarchical indexes (a reference to another
 * sidx) are rejected rather than guessed at.
 */
export function parseSidx(bytes: Uint8Array, boxOffset: number): Mp4Segment[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fail = (reason: string): never => {
        throw new Error(`Invalid sidx at byte ${boxOffset}: ${reason}`);
    };
    if (bytes.byteLength < 8) fail("box header is truncated");

    const type = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
    if (type !== "sidx") fail(`box type is "${type}"`);

    let boxSize = view.getUint32(0);
    let cursor = 8;
    if (boxSize === 1) {
        if (bytes.byteLength < 16) fail("large size is truncated");
        boxSize = Number(view.getBigUint64(8));
        cursor = 16;
    }
    if (boxSize < cursor + 4 || boxSize > bytes.byteLength) fail(`box size ${boxSize} does not fit ${bytes.byteLength} bytes`);

    const version = view.getUint8(cursor);
    if (version !== 0 && version !== 1) fail(`unsupported version ${version}`);
    cursor += 4 + 4; // version + flags, reference_ID

    const fixedSize = version === 0 ? 4 + 4 + 4 + 4 : 4 + 8 + 8 + 4;
    if (cursor + fixedSize > boxSize) fail("header is truncated");

    const timescale = view.getUint32(cursor);
    cursor += 4;
    if (timescale === 0) fail("timescale is 0");

    let firstOffset: bigint;
    if (version === 0) {
        firstOffset = BigInt(view.getUint32(cursor + 4));
        cursor += 8;
    } else {
        firstOffset = view.getBigUint64(cursor + 8);
        cursor += 16;
    }
    cursor += 2; // reserved
    const referenceCount = view.getUint16(cursor);
    cursor += 2;
    if (cursor + referenceCount * 12 > boxSize) fail(`${referenceCount} references do not fit the box`);

    // first_offset counts from the first byte after the sidx box.
    const start = BigInt(boxOffset) + BigInt(boxSize) + firstOffset;
    if (start > BigInt(Number.MAX_SAFE_INTEGER)) fail("first_offset is out of range");
    let offset = Number(start);

    const segments: Mp4Segment[] = [];
    for (let i = 0; i < referenceCount; i++) {
        const reference = view.getUint32(cursor);
        if (reference >>> 31 === 1) fail(`reference ${i} points to a nested sidx, which is not supported`);
        const length = reference & 0x7fff_ffff;
        const duration = view.getUint32(cursor + 4) / timescale;
        segments.push({ offset, length, duration });
        offset += length;
        cursor += 12;
    }
    return segments;
}
