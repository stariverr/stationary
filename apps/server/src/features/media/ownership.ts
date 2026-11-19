/**
 * What the user owns of an imported media or post, so a later import does not undo it
 * (docs/failure_handling.zh-Hans.md, 8): the sources they deleted or replaced, and the fields they edited.
 */
import { eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { Media } from "@/db/schema";
import type { DbClient } from "@/global/db";

export type SourceKind = "original" | "caption" | "cover";

/** How an imported source is named in `media.excluded_source_keys`: its kind, then its key. */
export const sourceKeyOf = (kind: SourceKind, sourceKey: string) => `${kind}:${sourceKey}`;

/** `column` with `values` added, each once, sorted. */
export function withValues(column: AnyColumn, values: readonly string[]): SQL {
    if (values.length === 0) return sql`${column}`;
    const added = sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
    );
    return sql`ARRAY(SELECT DISTINCT unnest(${column} || ARRAY[${added}]::text[]) ORDER BY 1)`;
}

/** Keeps later imports from bringing back the imported sources the user deleted or replaced (8.1). */
export async function excludeSources(
    client: DbClient,
    mediaId: string,
    sources: readonly { kind: SourceKind; sourceKey: string | null }[],
) {
    const keys = sources.flatMap((source) => (source.sourceKey ? [sourceKeyOf(source.kind, source.sourceKey)] : []));
    if (keys.length === 0) return;
    await client
        .update(Media)
        .set({ excluded_source_keys: withValues(Media.excluded_source_keys, keys) })
        .where(eq(Media.id, mediaId));
}

const sameValue = (a: unknown, b: unknown) =>
    a instanceof Temporal.Instant && b instanceof Temporal.Instant ? a.equals(b) : (a ?? null) === (b ?? null);

/** The fields of `patch` that change `current`: what an edit makes the user's own (8.2). */
export function changedFields<F extends string>(
    current: Record<F, unknown>,
    patch: Partial<Record<F, unknown>>,
    fields: readonly F[],
): F[] {
    return fields.filter((field) => patch[field] !== undefined && !sameValue(current[field], patch[field]));
}

/** The incoming values an import may write: those of fields the user has not edited. */
export function unedited<F extends string, T extends Partial<Record<F, unknown>>>(values: T, edited: readonly F[]): T {
    return Object.fromEntries(Object.entries(values).filter(([field]) => !edited.includes(field as F))) as T;
}
