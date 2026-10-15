/**
 * Regenerates src/features/ai/catalog/catalog.json from models.dev and the curated data in
 * src/features/ai/catalog/curated.ts. The output is committed and reviewed like code; the
 * server never fetches models.dev at runtime.
 */
import { buildCatalog, MODELS_DEV_URL } from "@/features/ai/catalog/models-dev";

const OUTPUT_PATH = new URL("../features/ai/catalog/catalog.json", import.meta.url);

const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`models.dev responded ${res.status}`);

const catalog = buildCatalog((await res.json()) as Record<string, unknown>);
await Bun.write(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`);

const counts = Object.entries(catalog.providers).map(([provider, models]) => `${provider}: ${models.length}`);
console.log(`Wrote ${OUTPUT_PATH.pathname}\n${counts.join("\n")}`);
