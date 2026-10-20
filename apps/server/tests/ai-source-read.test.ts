import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { classifyAiError } from "../src/features/ai/errors";
import { loadAiEmbeddingImage, readAiSourceImage } from "../src/features/ai/image-source";
import type { VisualEmbeddingProvider } from "../src/features/ai/types";
import { s3, S3ObjectTooLargeError } from "../src/global/s3";

const file = { id: "file-1", path: "/a/b.jpg", bucket: "bucket" };

describe("readAiSourceImage", () => {
    afterEach(() => {
        spyOn(s3, "read").mockRestore();
    });

    test("reads the object through the S3 client", async () => {
        const read = spyOn(s3, "read").mockResolvedValue(new Uint8Array([1, 2, 3]));

        expect(await readAiSourceImage(file)).toEqual(new Uint8Array([1, 2, 3]));
        expect(read.mock.calls[0]![0]).toBe("/a/b.jpg");
        expect(read.mock.calls[0]![1]).toMatchObject({ bucket: "bucket", maxBytes: 50 * 1024 * 1024 });
    });

    test("does not retry files over the size limit", async () => {
        spyOn(s3, "read").mockRejectedValue(new S3ObjectTooLargeError(60_000_000, 50 * 1024 * 1024));

        const error = await readAiSourceImage(file).catch((caught: unknown) => caught);
        expect(classifyAiError(error)).toEqual({ kind: "INVALID_REQUEST", retryable: false });
    });

    test("keeps caller cancellation as cancellation", async () => {
        const controller = new AbortController();
        spyOn(s3, "read").mockImplementation(async (_key, options) => {
            controller.abort();
            options.signal?.throwIfAborted();
            throw new Error("unreachable");
        });

        const error = await readAiSourceImage(file, controller.signal).catch((caught: unknown) => caught);
        expect(classifyAiError(error)).toEqual({ kind: "CANCELLED", retryable: false });
    });
});

describe("loadAiEmbeddingImage", () => {
    const avif = { ...file, path: "/a/cover.avif", mime_type: "image/avif", size: 200_000 };
    const fits = { width: 1440, height: 960 };
    const provider = (fetchesImageUrls: boolean, imageFormats = ["image/jpeg", "image/avif"]) =>
        ({ fetchesImageUrls, capabilities: { imageFormats } }) as unknown as VisualEmbeddingProvider;

    afterEach(() => {
        spyOn(s3, "read").mockRestore();
        spyOn(s3, "getPresignedUrl").mockRestore();
    });

    test("hands a model server that downloads images a URL to a source it accepts as stored", async () => {
        const presign = spyOn(s3, "getPresignedUrl").mockResolvedValue("https://s3.local/a/cover.avif?sig");
        const read = spyOn(s3, "read");

        expect(await loadAiEmbeddingImage(avif, fits, provider(true))).toEqual({
            url: "https://s3.local/a/cover.avif?sig",
            mimeType: "image/avif",
        });
        expect(presign.mock.calls[0]).toEqual(["/a/cover.avif", { bucket: "bucket", expiresInSeconds: 3600 }]);
        expect(read).not.toHaveBeenCalled();
    });

    test("reads the bytes when the source would need converting or its size is unknown", async () => {
        spyOn(s3, "read").mockResolvedValue(new Uint8Array([1]));
        const presign = spyOn(s3, "getPresignedUrl");
        const bytes = { imageBuffer: new Uint8Array([1]), mimeType: "image/avif" };

        expect(await loadAiEmbeddingImage(avif, fits, provider(false))).toEqual(bytes);
        expect(await loadAiEmbeddingImage(avif, fits, provider(true, ["image/jpeg"]))).toEqual(bytes);
        expect(await loadAiEmbeddingImage(avif, { width: 4000, height: 3000 }, provider(true))).toEqual(bytes);
        expect(await loadAiEmbeddingImage({ ...avif, size: 5 * 1024 * 1024 }, fits, provider(true))).toEqual(bytes);
        expect(await loadAiEmbeddingImage(avif, undefined, provider(true))).toEqual(bytes);
        expect(await loadAiEmbeddingImage({ ...avif, size: null }, fits, provider(true))).toEqual(bytes);
        expect(presign).not.toHaveBeenCalled();
    });
});
