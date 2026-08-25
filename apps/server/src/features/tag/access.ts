import { eq } from "drizzle-orm";
import { Library } from "@/db/schema";
import { db } from "@/global/db";
import { TagError } from "./errors";

export type TagAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

export async function assertTagLibraryAccess(libraryId: string, auth: TagAuth) {
    const [library] = await db.select().from(Library).where(eq(Library.id, libraryId)).limit(1);
    if (!library || library.owner_id !== auth.ownerId) {
        throw new TagError("FORBIDDEN", "You do not have access to this library");
    }

    if (auth.scopedLibraryId && auth.scopedLibraryId !== libraryId) {
        throw new TagError("FORBIDDEN", "API token scope restricted to another library");
    }

    return library;
}
