/**
 * Reads the RFC 6381 codec string of every track in an MP4 `moov` box.
 *
 * The strings go into HLS `CODECS` and DASH `codecs`, and clients pass them to
 * `MediaSource.isTypeSupported()`, so they are derived from the decoder
 * configuration boxes rather than guessed from the codec name.
 */

export type Mp4TrackCodec = {
    track_id: number;
    /** `hdlr` handler type: `vide`, `soun`, or any other four-character code. */
    handler: string;
    /** RFC 6381 codec string, or null when the sample entry is not supported. */
    codec_string: string | null;
};

type Box = { type: string; data: Uint8Array };

/**
 * Parses the tracks of the first `moov` box in `bytes`, which may be an fMP4
 * init segment, a whole MP4 file, or the `moov` box on its own.
 */
export function readMp4TrackCodecs(bytes: Uint8Array): Mp4TrackCodec[] {
    // Stop at moov so that a truncated mdat after it does not matter.
    const moov = child(bytes, "moov");

    return Array.from(boxes(moov))
        .filter((box) => box.type === "trak")
        .map((trak) => {
            const mdia = child(trak.data, "mdia");
            const stsd = child(child(child(mdia, "minf"), "stbl"), "stsd");
            // stsd is a full box: version/flags, entry_count, then the sample entries.
            const entry = boxes(stsd.subarray(8)).next().value;
            if (!entry) throw new Error("stsd has no sample entry");
            return {
                track_id: trackId(child(trak.data, "tkhd")),
                handler: fourcc(child(mdia, "hdlr"), 8),
                codec_string: codecString(entry),
            };
        });
}

function codecString(entry: Box): string | null {
    switch (entry.type) {
        case "avc1":
        case "avc3":
            return avcCodec(entry.type, child(visualChildren(entry), "avcC"));
        case "hvc1":
        case "hev1":
            return hevcCodec(entry.type, child(visualChildren(entry), "hvcC"));
        case "av01":
            return av1Codec(child(visualChildren(entry), "av1C"));
        case "vp09":
            return vp9Codec(child(visualChildren(entry), "vpcC"));
        case "mp4a":
            return mp4aCodec(child(audioChildren(entry), "esds"));
        case "Opus":
            return "opus";
        case "ac-3":
            return "ac-3";
        case "ec-3":
            return "ec-3";
        case "fLaC":
            return "flac";
        default:
            return null;
    }
}

/** ISO/IEC 14496-15 §5.4.1: `avc1.PPCCLL` from AVCDecoderConfigurationRecord. */
function avcCodec(type: string, avcC: Uint8Array): string {
    const view = dataView(avcC);
    return `${type}.${hex(view.getUint8(1))}${hex(view.getUint8(2))}${hex(view.getUint8(3))}`;
}

/** ISO/IEC 14496-15 Annex E.3, from HEVCDecoderConfigurationRecord. */
function hevcCodec(type: string, hvcC: Uint8Array): string {
    const view = dataView(hvcC);
    const byte1 = view.getUint8(1);
    const profileSpace = ["", "A", "B", "C"][byte1 >> 6];
    const tier = byte1 & 0x20 ? "H" : "L";
    const profileIdc = byte1 & 0x1f;

    // The 32 compatibility flags are written in reverse bit order.
    let compatibility = view.getUint32(2);
    let reversed = 0;
    for (let i = 0; i < 32; i++) {
        reversed = (reversed << 1) | (compatibility & 1);
        compatibility >>>= 1;
    }

    const constraints = Array.from(hvcC.subarray(6, 12));
    while (constraints.length > 0 && constraints.at(-1) === 0) constraints.pop();

    return [
        type,
        `${profileSpace}${profileIdc}`,
        (reversed >>> 0).toString(16).toUpperCase(),
        `${tier}${view.getUint8(12)}`,
        ...constraints.map((byte) => byte.toString(16).toUpperCase()),
    ].join(".");
}

/** AV1 Codec ISO Media File Format Binding §5: `av01.P.LLT.DD`. */
function av1Codec(av1C: Uint8Array): string {
    const view = dataView(av1C);
    const byte1 = view.getUint8(1);
    const byte2 = view.getUint8(2);
    const profile = byte1 >> 5;
    const level = byte1 & 0x1f;
    const tier = byte2 & 0x80 ? "H" : "M";
    const highBitdepth = (byte2 & 0x40) !== 0;
    const twelveBit = (byte2 & 0x20) !== 0;
    const bitDepth = highBitdepth ? (profile === 2 && twelveBit ? 12 : 10) : 8;
    return `av01.${profile}.${pad(level)}${tier}.${pad(bitDepth)}`;
}

/**
 * VP Codec ISO Media File Format Binding §6: `vp09.PP.LL.DD`. The optional
 * colour fields are left out, as browsers and packagers commonly do.
 */
function vp9Codec(vpcC: Uint8Array): string {
    // vpcC is a full box: version/flags, then profile, level, bitDepth << 4 | ...
    const view = dataView(vpcC);
    return `vp09.${pad(view.getUint8(4))}.${pad(view.getUint8(5))}.${pad(view.getUint8(6) >> 4)}`;
}

/** RFC 6381 §3.3: `mp4a.OO`, plus the audio object type for MPEG-4 audio (0x40). */
function mp4aCodec(esds: Uint8Array): string {
    // esds is a full box holding an ES_Descriptor.
    const es = descriptor(esds.subarray(4), 0x03);
    const flags = es[2];
    if (flags === undefined) throw new Error("ES_Descriptor is truncated");
    let offset = 3;
    if (flags & 0x80) offset += 2; // dependsOn_ES_ID
    if (flags & 0x40) offset += 1 + (es[offset] ?? 0); // URL
    if (flags & 0x20) offset += 2; // OCR_ES_Id

    const decoderConfig = descriptor(es.subarray(offset), 0x04);
    const objectType = decoderConfig[0];
    if (objectType === undefined) throw new Error("DecoderConfigDescriptor is truncated");
    if (objectType !== 0x40) return `mp4a.${hex(objectType)}`;

    // DecoderSpecificInfo follows the 13 fixed bytes and holds the AudioSpecificConfig.
    return `mp4a.40.${audioObjectType(descriptor(decoderConfig.subarray(13), 0x05))}`;
}

/**
 * ISO/IEC 14496-3 §1.6.2.1. The first audio object type is the one RFC 6381
 * names: 5 for HE-AAC and 29 for HE-AAC v2 with explicit hierarchical
 * signalling. With backward-compatible signalling the config starts with
 * AAC-LC (2) and announces SBR and PS in a sync extension after
 * GASpecificConfig, which is read here too.
 */
function audioObjectType(config: Uint8Array): number {
    const bits = new BitReader(config);
    const readObjectType = () => {
        const type = bits.read(5);
        return type === 31 ? 32 + bits.read(6) : type;
    };
    const readFrequency = () => {
        if (bits.read(4) === 0xf) bits.read(24);
    };

    const objectType = readObjectType();
    if (objectType !== 2) return objectType;

    readFrequency();
    const channelConfiguration = bits.read(4);
    // GASpecificConfig for AAC-LC: frameLengthFlag, dependsOnCoreCoder, extensionFlag.
    bits.read(1);
    if (bits.read(1)) bits.read(14);
    bits.read(1);
    // A program_config_element (channel configuration 0) is not walked; such
    // streams keep AAC-LC.
    if (channelConfiguration === 0) return objectType;

    if (bits.remaining() < 16 || bits.read(11) !== 0x2b7) return objectType;
    if (readObjectType() !== 5 || !bits.read(1)) return objectType;
    readFrequency();
    if (bits.remaining() >= 12 && bits.read(11) === 0x548 && bits.read(1)) return 29;
    return 5;
}

/** Reads an MPEG-4 descriptor with the given tag and returns its payload. */
function descriptor(bytes: Uint8Array, tag: number): Uint8Array {
    if (bytes[0] !== tag) throw new Error(`Expected descriptor tag ${tag}, found ${bytes[0]}`);
    let size = 0;
    let offset = 1;
    for (let i = 0; i < 4; i++) {
        const byte = bytes[offset++];
        if (byte === undefined) throw new Error("Descriptor size is truncated");
        size = (size << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) break;
    }
    if (offset + size > bytes.length) throw new Error("Descriptor is truncated");
    return bytes.subarray(offset, offset + size);
}

function trackId(tkhd: Uint8Array): number {
    const view = dataView(tkhd);
    // Version 1 uses 64-bit creation and modification times.
    return view.getUint32(view.getUint8(0) === 1 ? 20 : 12);
}

/** Child boxes of a VisualSampleEntry, after its 78 fixed bytes. */
function visualChildren(entry: Box): Uint8Array {
    return entry.data.subarray(78);
}

/**
 * Child boxes of an AudioSampleEntry, after its 28 fixed bytes. QuickTime sound
 * description versions 1 and 2 add 16 and 36 bytes.
 */
function audioChildren(entry: Box): Uint8Array {
    const version = dataView(entry.data).getUint16(8);
    return entry.data.subarray(28 + (version === 1 ? 16 : version === 2 ? 36 : 0));
}

function child(bytes: Uint8Array, type: string): Uint8Array {
    for (const box of boxes(bytes)) {
        if (box.type === type) return box.data;
    }
    throw new Error(`MP4 box ${type} not found`);
}

/** Yields the sibling boxes in `bytes`, each with its payload after the header. */
function* boxes(bytes: Uint8Array): Generator<Box> {
    const view = dataView(bytes);
    let offset = 0;
    while (offset + 8 <= bytes.length) {
        let size = view.getUint32(offset);
        let header = 8;
        if (size === 1) {
            size = Number(view.getBigUint64(offset + 8));
            header = 16;
        } else if (size === 0) {
            size = bytes.length - offset;
        }
        if (size < header || offset + size > bytes.length) {
            throw new Error(`MP4 box ${fourcc(bytes, offset + 4)} is truncated`);
        }
        yield { type: fourcc(bytes, offset + 4), data: bytes.subarray(offset + header, offset + size) };
        offset += size;
    }
}

function fourcc(bytes: Uint8Array, offset: number): string {
    if (offset + 4 > bytes.length) throw new Error("MP4 box is truncated");
    return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function dataView(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function hex(byte: number): string {
    return byte.toString(16).toUpperCase().padStart(2, "0");
}

function pad(value: number): string {
    return value.toString().padStart(2, "0");
}

class BitReader {
    private position = 0;

    constructor(private readonly bytes: Uint8Array) {}

    read(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++) {
            const byte = this.bytes[this.position >> 3];
            if (byte === undefined) throw new Error("AudioSpecificConfig is truncated");
            value = value * 2 + ((byte >> (7 - (this.position & 7))) & 1);
            this.position++;
        }
        return value;
    }

    remaining(): number {
        return this.bytes.length * 8 - this.position;
    }
}
