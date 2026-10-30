import { and, eq } from "drizzle-orm";
import { Library, Tag } from "@/db/schema";
import { findOwnedLibrary, reachableLibraryFilter, type LibraryAuth } from "@/features/library/access";
import { db } from "@/global/db";
import { TagError } from "./errors";

export async function assertTagLibraryAccess(libraryId: string, auth: LibraryAuth) {
    const library = await findOwnedLibrary(libraryId, auth);
    if (!library) {
        throw new TagError("NOT_FOUND", "Library not found");
    }

    return library;
}

export async function assertTagAccess(tagId: string, auth: LibraryAuth) {
    const [row] = await db
        .select({ tag: Tag })
        .from(Tag)
        .innerJoin(Library, eq(Library.id, Tag.library_id))
        .where(and(eq(Tag.id, tagId), reachableLibraryFilter(auth)))
        .limit(1);

    if (!row) {
        throw new TagError("NOT_FOUND", "Tag not found");
    }

    return row.tag;
}
