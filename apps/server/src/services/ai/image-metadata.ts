import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
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

const ImageMetadataOutput = Output.object({
    schema: z.object({
        caption: z.string(),
        tags: z.array(z.string()),
        objects: z.array(z.string()),
        colors: z.array(z.string()),
        styles: z.array(z.string()),
        scene: z.string(),
        ocrText: z.string(),
    }),
});

function toImageContent(image: Buffer | Uint8Array | string): {
    type: "image";
    image: URL | Buffer;
} {
    if (typeof image === "string") {
        return { type: "image", image: new URL(image) };
    }

    return { type: "image", image: Buffer.from(image) };
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
): Promise<ImageAiMetadata> {
    const { output } = await generateText({
        model,
        output: ImageMetadataOutput,
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: IMAGE_METADATA_PROMPT }, toImageContent(image)],
            },
        ],
    });

    return normalizeImageAiMetadata(output);
}
