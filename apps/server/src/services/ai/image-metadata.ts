import { generateText, jsonSchema, Output, type LanguageModel } from "ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import type { ImageAiMetadata } from "./types";

export const IMAGE_METADATA_PIPELINE_VERSION = "image-metadata:zh-en:v1";

const IMAGE_METADATA_PROMPT =
    "Analyze the provided image in detail. Extract structured metadata representing the image content. " +
    "Provide: \n" +
    "1. An accurate descriptive caption containing rich keywords suitable for search.\n" +
    "2. A concise summary.\n" +
    "3. Visual tags, physical objects identified, and dominant colors.\n" +
    "4. Aesthetic/artistic styles (e.g. tech, minimal, cyberpunk, pastel).\n" +
    "5. Scene description (e.g. rainy street, coffee shop, neon lights, desk setup).\n" +
    "6. Full OCR text of any visible writing, characters, or text. If no text exists, leave ocrText empty.";

const imageMetadataSchema = v.object({
    caption: v.string(),
    tags: v.array(v.string()),
    objects: v.array(v.string()),
    colors: v.array(v.string()),
    styles: v.array(v.string()),
    scene: v.string(),
    ocrText: v.string(),
});

const ImageMetadataOutput = Output.object({
    schema: jsonSchema(toJsonSchema(imageMetadataSchema) as any),
});

function toImageContent(
    image: Buffer | Uint8Array | string,
    mimeType: string = "image/jpeg",
): {
    type: "file";
    data: URL | Buffer;
    mediaType: string;
} {
    const validMime = mimeType && mimeType.includes("/") ? mimeType : "image/jpeg";
    if (typeof image === "string") {
        return { type: "file", data: new URL(image), mediaType: validMime };
    }

    return { type: "file", data: Buffer.from(image), mediaType: validMime };
}

function normalizeImageAiMetadata(output: Partial<ImageAiMetadata>): ImageAiMetadata {
    return {
        caption: output.caption || "",
        tags: Array.isArray(output.tags) ? output.tags : [],
        objects: Array.isArray(output.objects) ? output.objects : [],
        colors: Array.isArray(output.colors) ? output.colors : [],
        styles: Array.isArray(output.styles) ? output.styles : [],
        scene: output.scene || "",
        ocrText: output.ocrText || "",
    };
}

export async function describeImageWithModel(
    model: LanguageModel,
    image: Buffer | Uint8Array | string,
    mimeType: string = "image/jpeg",
): Promise<ImageAiMetadata> {
    const { output } = await generateText({
        model,
        output: ImageMetadataOutput,
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: IMAGE_METADATA_PROMPT }, toImageContent(image, mimeType)],
            },
        ],
    });

    return normalizeImageAiMetadata(output as any);
}
