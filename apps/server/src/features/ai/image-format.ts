import { ResizeFit, Transformer } from "@napi-rs/image";
import type { ImageFormat } from "./model-schema";

export const DEFAULT_IMAGE_FORMATS: readonly ImageFormat[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * Images sent to models are capped in size: providers reject large payloads (e.g. 10 MB per
 * image on DashScope) and vision models bill by pixels, while neither description nor
 * embeddings gain from more detail than this.
 */
export const MAX_IMAGE_EDGE = 1536;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Transcoding targets for models that do not take the source format (covers are AVIF), smallest
 * output first. PNG is only a last resort for models that accept neither JPEG nor WebP.
 */
const ENCODE_TARGETS = ["image/jpeg", "image/webp", "image/png"] as const;

export function supportsImageFormat(mimeType: string, formats?: readonly ImageFormat[]): boolean {
    return (formats ?? DEFAULT_IMAGE_FORMATS).includes(mimeType.split(";", 1)[0]!.trim().toLowerCase() as ImageFormat);
}

/**
 * Returns image bytes a model accepts: within MAX_IMAGE_EDGE and MAX_IMAGE_BYTES and in one of
 * `formats`. Accepted images that are already small enough pass through unchanged — generated
 * covers are AVIF of at most 1440 px, so a model declaring `image/avif` gets them untouched.
 * Everything else is decoded, EXIF-rotated, shrunk to fit and re-encoded.
 */
export async function prepareImageForModel(
    image: Buffer | Uint8Array,
    mimeType: string,
    formats?: readonly ImageFormat[],
): Promise<{ image: Buffer | Uint8Array; mimeType: string }> {
    const normalizedType = mimeType.split(";", 1)[0]!.trim().toLowerCase();
    const accepted = supportsImageFormat(normalizedType, formats);

    let size: { width: number; height: number } | null = null;
    try {
        size = await new Transformer(image).metadata();
    } catch {
        // Undecodable here; an accepted format can still be sent as-is.
    }
    const fits = size !== null && Math.max(size.width, size.height) <= MAX_IMAGE_EDGE && image.byteLength <= MAX_IMAGE_BYTES;
    if (accepted && (fits || size === null)) {
        return { image, mimeType: normalizedType };
    }
    if (size === null) {
        throw new Error(`Image format ${normalizedType} is not supported by this model and could not be decoded for conversion.`);
    }

    const target = ENCODE_TARGETS.find((format) => (formats ?? DEFAULT_IMAGE_FORMATS).includes(format));
    if (!target) throw new Error("This model has no image format available for conversion.");

    const transformer = new Transformer(image).rotate();
    if (Math.max(size.width, size.height) > MAX_IMAGE_EDGE) {
        transformer.resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: ResizeFit.Inside });
    }
    try {
        const converted =
            target === "image/jpeg"
                ? await transformer.jpeg(85)
                : target === "image/webp"
                  ? await transformer.webp(85)
                  : await transformer.png();
        return { image: converted, mimeType: target };
    } catch {
        throw new Error(`Image format ${normalizedType} could not be converted to ${target}.`);
    }
}
