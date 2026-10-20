import { generateText, jsonSchema, Output, type LanguageModel } from "ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import type { DescribeImageRequestOptions, ImageAiMetadata } from "./types";
import { AiProviderError } from "./errors";
import { withTimeout } from "./utils";

/**
 * Bump whenever the prompt or schema changes. Descriptions of older versions stay in use; the
 * library AI settings offer to update them and say what the new version improves, from the web
 * locale key `settings.ai_config.describe_update_reason_<version>`; add one with each bump.
 */
export const IMAGE_METADATA_PROMPT_VERSION = "v2";

/** English name of a BCP 47 language tag, e.g. "zh-Hans" → "Chinese, Simplified". */
export function languageName(language: string): string {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
}

/** True for well-formed BCP 47 tags that have a known display name. */
export function isSupportedLanguage(language: string): boolean {
    try {
        return Intl.getCanonicalLocales(language).length === 1 && languageName(language) !== language;
    } catch {
        return false;
    }
}

function buildImageMetadataPrompt(language: string): string {
    return (
        "Analyze the provided image in detail. Extract structured metadata representing the image content. " +
        "Provide: \n" +
        "1. An accurate descriptive caption containing rich keywords suitable for search.\n" +
        "2. Visual tags, physical objects identified, and dominant colors.\n" +
        "3. Aesthetic/artistic styles (e.g. tech, minimal, cyberpunk, pastel).\n" +
        "4. Scene description (e.g. rainy street, coffee shop, neon lights, desk setup).\n" +
        "5. Full OCR text of any visible writing, characters, or text. If no text exists, leave ocrText empty.\n" +
        `Write the caption, tags, objects, colors, styles and scene in ${languageName(language)} (${language}). ` +
        "Transcribe ocrText exactly as it appears in the image, in its original language; never translate it."
    );
}

const imageMetadataSchema = v.object({
    caption: v.string(),
    tags: v.array(v.string()),
    objects: v.array(v.string()),
    colors: v.array(v.string()),
    styles: v.array(v.string()),
    scene: v.string(),
    ocrText: v.string(),
});

/**
 * OpenAI strict structured outputs require `additionalProperties: false` on every
 * object node. @valibot/to-json-schema does not emit it, so add it recursively.
 */
function enforceStrictObjectSchema(node: unknown): unknown {
    if (Array.isArray(node)) {
        return node.map(enforceStrictObjectSchema);
    }
    if (node && typeof node === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
            result[key] = enforceStrictObjectSchema(value);
        }
        if (result.type === "object" && result.additionalProperties === undefined) {
            result.additionalProperties = false;
        }
        return result;
    }
    return node;
}

function buildImageMetadataOutput(strict: boolean) {
    const jsonSchemaValue = toJsonSchema(imageMetadataSchema);
    return Output.object({
        schema: jsonSchema((strict ? enforceStrictObjectSchema(jsonSchemaValue) : jsonSchemaValue) as any),
    });
}

const StrictImageMetadataOutput = buildImageMetadataOutput(true);
const DefaultImageMetadataOutput = buildImageMetadataOutput(false);

function toImageContent(image: Buffer | Uint8Array, mimeType: string = "image/jpeg"): { type: "file"; data: Buffer; mediaType: string } {
    const validMime = mimeType && mimeType.includes("/") ? mimeType : "image/jpeg";
    return { type: "file", data: Buffer.from(image), mediaType: validMime };
}

/**
 * Output token cap for one description. The model's own limit can be hundreds of thousands of
 * tokens; a description with full OCR text fits well within this, with room for light reasoning.
 */
export const DESCRIBE_MAX_OUTPUT_TOKENS = 4096;

/** Upper bound of one description call, generous enough for light reasoning and long OCR output. */
const DESCRIBE_TIMEOUT_MS = 120_000;

/**
 * Bounds of stored fields. Applied after generation rather than in the JSON schema, since strict
 * structured output modes reject string length keywords; a runaway model is cut, not failed.
 */
const TEXT_LIMITS = { caption: 1000, scene: 300, ocrText: 4000 } as const;
const LIST_LIMITS = { tags: 30, objects: 30, colors: 10, styles: 10 } as const;
const LIST_ITEM_MAX_LENGTH = 80;

const clampList = (items: string[], max: number) =>
    [...new Set(items.map((item) => item.trim().slice(0, LIST_ITEM_MAX_LENGTH)).filter(Boolean))].slice(0, max);

export function normalizeImageAiMetadata(output: ImageAiMetadata): ImageAiMetadata {
    return {
        caption: output.caption.slice(0, TEXT_LIMITS.caption),
        tags: clampList(output.tags, LIST_LIMITS.tags),
        objects: clampList(output.objects, LIST_LIMITS.objects),
        colors: clampList(output.colors, LIST_LIMITS.colors),
        styles: clampList(output.styles, LIST_LIMITS.styles),
        scene: output.scene.slice(0, TEXT_LIMITS.scene),
        ocrText: output.ocrText.slice(0, TEXT_LIMITS.ocrText),
    };
}

/** Describes an image; descriptive fields are written in `language` (BCP 47). */
export async function describeImageWithModel(
    model: LanguageModel,
    image: Buffer | Uint8Array,
    mimeType: string,
    language: string,
    request: DescribeImageRequestOptions = {},
): Promise<ImageAiMetadata> {
    const { output } = await generateText({
        model,
        maxRetries: 0,
        abortSignal: withTimeout(request.abortSignal, DESCRIBE_TIMEOUT_MS),
        output: request.strictJsonSchema === false ? DefaultImageMetadataOutput : StrictImageMetadataOutput,
        maxOutputTokens: Math.min(request.maxOutputTokens ?? DESCRIBE_MAX_OUTPUT_TOKENS, DESCRIBE_MAX_OUTPUT_TOKENS),
        reasoning: request.reasoning,
        providerOptions: request.providerOptions as any,
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: buildImageMetadataPrompt(language) }, toImageContent(image, mimeType)],
            },
        ],
    });

    const parsed = v.safeParse(imageMetadataSchema, output);
    if (!parsed.success) {
        throw new AiProviderError("UNSUPPORTED", "AI provider returned invalid image metadata output");
    }

    return normalizeImageAiMetadata(parsed.output);
}
