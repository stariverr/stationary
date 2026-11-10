/**
 * Reads the top-level box layout of an MP4 file through byte-range reads, without downloading the media data:
 * the `moov` box (for codec strings, wherever it sits) and, in an fMP4, the `sidx` that follows the init segment.
 */

/** Reads the inclusive byte range [start, end] of the file. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

/** Where the segments of a single-stream fMP4 are: the init segment, then the sidx that indexes the rest. */
export interface Mp4SegmentIndex {
    /** The init segment is bytes [0, init_size). */
    init_size: number;
    /** The sidx box is bytes [index_offset, index_offset + index_size). */
    index_offset: number;
    index_size: number;
    timescale: number;
    earliest_presentation_time: number;
}

export interface Mp4Layout {
    moov: Uint8Array | null;
    segmentIndex: Mp4SegmentIndex | null;
}

const MAX_BOXES = 256;
/** A moov over this size is not read; codec strings are then missing. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

const fourcc = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);

/** Reads the timescale and earliest presentation time from the start of a sidx box. */
function readSidxHeader(bytes: Uint8Array): { timescale: number; earliest_presentation_time: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = view.getUint32(0) === 1 ? 16 : 8;
    const version = view.getUint8(headerSize);
    // version + flags, reference_ID
    const timescale = view.getUint32(headerSize + 8);
    const ept = version === 0 ? view.getUint32(headerSize + 12) : Number(view.getBigUint64(headerSize + 12));
    if (timescale === 0) throw new Error("sidx timescale is 0");
    return { timescale, earliest_presentation_time: ept };
}

/**
 * Walks the top-level boxes of a file of `size` bytes. A segment index is reported when a sidx directly follows the
 * moov (optionally after other non-media boxes), which is how a single-stream fMP4 with a global sidx is laid out.
 */
export async function readMp4Layout(read: RangeReader, size: number): Promise<Mp4Layout> {
    let moov: Uint8Array | null = null;
    let moovEnd: number | null = null;
    let segmentIndex: Mp4SegmentIndex | null = null;
    let offset = 0;

    for (let count = 0; count < MAX_BOXES && offset + 8 <= size; count++) {
        const header = await read(offset, Math.min(offset + 31, size - 1));
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        let boxSize = view.getUint32(0);
        const type = fourcc(header, 4);
        if (boxSize === 1) boxSize = Number(view.getBigUint64(8));
        else if (boxSize === 0) boxSize = size - offset;
        if (boxSize < 8 || offset + boxSize > size) break;

        if (type === "moov" && !moov) {
            if (boxSize <= MAX_MOOV_BYTES) moov = await read(offset, offset + boxSize - 1);
            moovEnd = offset + boxSize;
        } else if (type === "sidx" && moovEnd !== null && !segmentIndex) {
            segmentIndex = { init_size: offset, index_offset: offset, index_size: boxSize, ...readSidxHeader(header) };
        } else if (type === "moof" || type === "mdat") {
            // Media data: the layout of anything after it does not matter once the moov is known.
            if (moov) break;
        }
        offset += boxSize;
    }

    return { moov, segmentIndex };
}
