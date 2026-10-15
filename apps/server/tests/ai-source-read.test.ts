import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { classifyAiError } from "../src/features/ai/errors";
import { readAiSourceImage } from "../src/features/ai/image-source";
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
