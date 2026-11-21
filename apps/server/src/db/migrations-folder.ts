import { resolve } from "node:path";

function hasMigrations(dir: string): boolean {
    try {
        for (const _entry of new Bun.Glob("*/migration.sql").scanSync({ cwd: dir })) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/** Resolves the Drizzle SQL migrations directory in both source and bundled container layouts. */
export function resolveMigrationsFolder(fromDir: string): string {
    const explicit = process.env.DRIZZLE_MIGRATIONS_DIR;
    if (explicit) return explicit;

    const candidates = [resolve(fromDir, "./drizzle"), resolve(fromDir, "../drizzle"), resolve(fromDir, "../../drizzle")];
    const matched = candidates.find(hasMigrations);
    if (!matched) {
        throw new Error(`Could not locate Drizzle migrations directory. Checked: ${candidates.join(", ")}`);
    }
    return matched;
}
