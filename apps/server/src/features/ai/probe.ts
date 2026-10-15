import { generateText, jsonSchema, Output } from "ai";
import { getSafeAiErrorMessage } from "./errors";
import type { EmbeddingModelCapabilities, GeneratedTextModelCapabilities } from "./model-schema";
import { buildLanguageProvider, buildRerankProvider, buildTextEmbeddingProvider, buildVisualEmbeddingProvider } from "./providers";
import type { ResolvedModelConfig } from "./types";

/**
 * Probes verify a model definition against the live provider with small real requests, since
 * catalogs only say what a model supports in principle: gateways may drop image input, reject
 * JSON schemas or return another embedding size.
 */
export type ModelProbeCheck = "imageInput" | "structuredOutput" | "embedding" | "imageEmbedding" | "rerank";

export interface ModelProbeResult {
    check: ModelProbeCheck;
    ok: boolean;
    /** Why the check failed, or what the provider answered when the answer was wrong. */
    message?: string;
}

const PROBE_TIMEOUT_MS = 60_000;

/** A 64×64 solid red PNG: a model that really sees the image names its color. */
const RED_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsAtx/ZMZxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywKqxUDxqh7TUQAAAABJRU5ErkJggg==",
    "base64",
);

const SumOutput = Output.object({
    schema: jsonSchema<{ sum: number }>({
        type: "object",
        properties: { sum: { type: "number" } },
        required: ["sum"],
        additionalProperties: false,
    }),
});

async function runCheck(check: ModelProbeCheck, verify: (signal: AbortSignal) => Promise<string | null>): Promise<ModelProbeResult> {
    try {
        const failure = await verify(AbortSignal.timeout(PROBE_TIMEOUT_MS));
        return failure ? { check, ok: false, message: failure } : { check, ok: true };
    } catch (error) {
        return { check, ok: false, message: getSafeAiErrorMessage(error).slice(0, 300) };
    }
}

function probeGeneration(config: ResolvedModelConfig): Promise<ModelProbeResult[]> {
    const spec = config.capabilities as GeneratedTextModelCapabilities;
    const provider = buildLanguageProvider(config);
    const request = {
        model: provider.chatModel,
        maxRetries: 0,
        maxOutputTokens: provider.describeOptions.maxOutputTokens,
        reasoning: provider.describeOptions.reasoning,
        providerOptions: provider.describeOptions.providerOptions as never,
    };

    const checks: Promise<ModelProbeResult>[] = [];
    if (spec.inputModalities.includes("image")) {
        checks.push(
            runCheck("imageInput", async (abortSignal) => {
                const { text } = await generateText({
                    ...request,
                    abortSignal,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "What is the color of this image? Answer with one lowercase English word." },
                                { type: "file", data: RED_PNG, mediaType: "image/png" },
                            ],
                        },
                    ],
                });
                return /red/i.test(text) ? null : `Expected the model to see a red image, but it answered: ${text.slice(0, 200)}`;
            }),
        );
    }
    if (spec.structuredOutput) {
        checks.push(
            runCheck("structuredOutput", async (abortSignal) => {
                const { output } = await generateText({ ...request, abortSignal, output: SumOutput, prompt: "What is 2 + 3?" });
                return output?.sum === 5 ? null : `Unexpected structured output: ${JSON.stringify(output).slice(0, 200)}`;
            }),
        );
    }
    return Promise.all(checks);
}

function verifyDimension(dimension: number, expected: number): string | null {
    return dimension === expected ? null : `Returned ${dimension}-dimensional vectors, but the definition says ${expected}.`;
}

function probeEmbedding(config: ResolvedModelConfig): Promise<ModelProbeResult[]> {
    const spec = config.capabilities as EmbeddingModelCapabilities;
    const checks = [
        runCheck("embedding", async (abortSignal) => {
            const result = await buildTextEmbeddingProvider(config).embedText({ text: "a red square", purpose: "DOCUMENT", abortSignal });
            return verifyDimension(result.embedding.length, spec.dimension);
        }),
    ];
    if (spec.multimodal) {
        checks.push(
            runCheck("imageEmbedding", async (abortSignal) => {
                const [result] = await buildVisualEmbeddingProvider(config).embedImages([{ imageBuffer: RED_PNG, mimeType: "image/png" }], abortSignal);
                return result ? verifyDimension(result.embedding.length, spec.dimension) : "The provider returned no image embedding.";
            }),
        );
    }
    return Promise.all(checks);
}

async function probeRerank(config: ResolvedModelConfig): Promise<ModelProbeResult[]> {
    return [
        await runCheck("rerank", async (abortSignal) => {
            const scores = await buildRerankProvider(config).rerank("red fruit", ["a red apple", "a blue sky"], abortSignal);
            if (scores.length !== 2 || !scores.every(Number.isFinite)) return `Unexpected rerank scores: ${JSON.stringify(scores)}`;
            return scores[0]! > scores[1]! ? null : "The reranker ranked an unrelated document first.";
        }),
    ];
}

/** Runs the checks that apply to the model's definition; every check reports separately. */
export function probeModel(config: ResolvedModelConfig): Promise<ModelProbeResult[]> {
    if (config.category === "generation") return probeGeneration(config);
    if (config.category === "embedding") return probeEmbedding(config);
    return probeRerank(config);
}

/** A message naming every failed check, or null when all of them passed. */
export function summarizeProbeFailures(results: ModelProbeResult[]): string | null {
    const failures = results.filter((result) => !result.ok);
    if (failures.length === 0) return null;
    return failures.map((result) => `${result.check}: ${result.message ?? "failed"}`).join("; ");
}
