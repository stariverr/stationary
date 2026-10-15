import { RETIRED_MODELS, MIN_RELEASE_DATE } from "./curated";
import { normalizeModelId, type CatalogModel } from "./types";

/**
 * Lifecycle rules that keep the catalog to models worth choosing today. They only depend on
 * the models.dev snapshot and curated.ts, so regenerating the same snapshot gives the same
 * catalog without anyone picking models by hand.
 */

interface ModelLine {
    /** The id with its version replaced by `*`, e.g. `gemini-*-flash` or `claude-sonnet-*`. */
    line: string;
    version: number[];
    preview: boolean;
}

/**
 * Splits an id into its product line and version. Date snapshots (`-20250929`, `-2024-08-06`,
 * `-0309`) and preview markers belong to the version they snapshot, so they are dropped; sizes
 * such as `-31b` are part of the line. Aliases (`-latest`) and unversioned ids have no line.
 */
export function parseModelLine(name: string): ModelLine | null {
    let id = normalizeModelId(name)
        .replace(/-\d{4}-\d{2}-\d{2}$/, "")
        .replace(/-\d{2}-\d{4}$/, "")
        .replace(/-\d{4}(?:\d{2}){0,2}(?=-|$)/g, "");
    const preview = /-(?:preview|exp)(?=-|$)/.test(id);
    id = id.replace(/-(?:preview|exp)(?=-|$)/g, "");
    if (id.includes("latest")) return null;

    const match = /(?<![\d.])(\d+)(?:[.-](\d+))?(?![\d.]|b)/.exec(id);
    if (!match) return null;
    const version = match[2] === undefined ? [Number(match[1])] : [Number(match[1]), Number(match[2])];
    return { line: `${id.slice(0, match.index)}*${id.slice(match.index + match[0].length)}`, version, preview };
}

function compareVersions(a: number[], b: number[]): number {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const diff = (a[index] ?? 0) - (b[index] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Keeps the newest version of every product line in one provider's listing: `gemini-3.8-flash`
 * supersedes `gemini-3.5-flash`, and a stable release supersedes the preview of its version.
 * Snapshots of the newest version (`claude-sonnet-4-5-20250929`) stay next to its alias.
 */
export function dropSupersededModels(models: CatalogModel[]): CatalogModel[] {
    const lines = new Map<string, { model: CatalogModel; parsed: ModelLine }[]>();
    const unversioned: CatalogModel[] = [];
    for (const model of models) {
        const parsed = parseModelLine(model.name);
        if (!parsed) {
            unversioned.push(model);
            continue;
        }
        lines.set(parsed.line, [...(lines.get(parsed.line) ?? []), { model, parsed }]);
    }

    const kept = [...lines.values()].flatMap((entries) => {
        const newest = entries.reduce((max, entry) => (compareVersions(entry.parsed.version, max) > 0 ? entry.parsed.version : max), entries[0]!.parsed.version);
        const current = entries.filter((entry) => compareVersions(entry.parsed.version, newest) === 0);
        const stable = current.filter((entry) => !entry.parsed.preview);
        return (stable.length > 0 ? stable : current).map((entry) => entry.model);
    });
    return [...unversioned, ...kept];
}

/** Whether the curated lifecycle data retires a model: too old, or listed as end of life. */
export function isRetiredModel(model: CatalogModel): boolean {
    if (model.releaseDate && model.releaseDate < MIN_RELEASE_DATE) return true;
    const id = normalizeModelId(model.name);
    return RETIRED_MODELS.some((pattern) => (pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern));
}
