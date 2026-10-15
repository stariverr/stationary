import { describe, expect, test } from "bun:test";
import { Transformer } from "@napi-rs/image";
import { MAX_IMAGE_EDGE, prepareImageForModel, supportsImageFormat } from "../src/features/ai/image-format";

const avifImage = Buffer.from(
    "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACgAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgUBsAAAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwwMDAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAwbWRhdBIACghYADa0BDQbhDIaGUeHhiGJpppmgAAAkD+bDGFLK02PUUVOpCA=",
    "base64",
);

async function pngOfSize(width: number, height: number): Promise<Buffer> {
    return Transformer.fromRgbaPixels(new Uint8Array(width * height * 4).fill(200), width, height).png();
}

describe("AI image format preparation", () => {
    test("passes small accepted images through unchanged", async () => {
        const small = await pngOfSize(64, 32);
        expect(await prepareImageForModel(small, "image/png", ["image/png"])).toEqual({ image: small, mimeType: "image/png" });
        // Bytes this decoder cannot read are still sent when the model accepts their format.
        const opaque = Buffer.from("image");
        expect(await prepareImageForModel(opaque, "image/avif", ["image/avif"])).toEqual({ image: opaque, mimeType: "image/avif" });
        expect(supportsImageFormat("IMAGE/AVIF; charset=binary", ["image/avif"])).toBe(true);
        expect(supportsImageFormat("image/webp")).toBe(true);
    });

    test("sends AVIF covers untouched to models that declare AVIF", async () => {
        expect(await prepareImageForModel(avifImage, "image/avif", ["image/avif", "image/jpeg"])).toEqual({
            image: avifImage,
            mimeType: "image/avif",
        });
    });

    test("shrinks oversized images to fit the edge limit, even in an accepted format", async () => {
        const large = await pngOfSize(3000, 1000);
        const result = await prepareImageForModel(large, "image/png", ["image/png", "image/jpeg"]);
        expect(result.mimeType).toBe("image/jpeg");
        const size = await new Transformer(result.image).metadata();
        expect([size.width, size.height]).toEqual([MAX_IMAGE_EDGE, 512]);
    });

    test("converts unsupported AVIF into JPEG by default", async () => {
        const result = await prepareImageForModel(avifImage, "image/avif");
        expect(result.mimeType).toBe("image/jpeg");
        expect(Buffer.from(result.image).subarray(0, 3).toString("hex")).toBe("ffd8ff");
    });

    test("uses PNG when it is the only accepted output", async () => {
        const result = await prepareImageForModel(avifImage, "image/avif", ["image/png"]);
        expect(result.mimeType).toBe("image/png");
        expect(Buffer.from(result.image).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    });

    test("uses WebP when it is the only accepted output", async () => {
        const result = await prepareImageForModel(avifImage, "image/avif", ["image/webp"]);
        expect(result.mimeType).toBe("image/webp");
        expect(Buffer.from(result.image).subarray(0, 4).toString()).toBe("RIFF");
    });

    test("rejects undecodable unsupported formats and models without an output format", async () => {
        await expect(prepareImageForModel(Buffer.from("image"), "image/jxl")).rejects.toThrow("could not be decoded");
        await expect(prepareImageForModel(avifImage, "image/avif", ["image/gif"])).rejects.toThrow("no image format available");
    });
});
