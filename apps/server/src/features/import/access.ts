import { eq } from "drizzle-orm";
import { Library } from "@/db/schema";
import { db } from "@/global/db";
import { ImportError } from "./errors";

export type ImportAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

export async function assertLibraryAccess(libraryId: string, auth: ImportAuth) {
    const [library] = await db.select().from(Library).where(eq(Library.id, libraryId)).limit(1);
    if (!library || library.owner_id !== auth.ownerId) {
        throw new ImportError("FORBIDDEN", "You do not have access to this library");
    }

    if (auth.scopedLibraryId && auth.scopedLibraryId !== libraryId) {
        throw new ImportError("FORBIDDEN", "API token scope restricted to another library");
    }

    return library;
}
