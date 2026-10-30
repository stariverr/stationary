import { findOwnedLibrary, type LibraryAuth } from "@/features/library/access";
import { ImportError } from "./errors";

export async function assertLibraryAccess(libraryId: string, auth: LibraryAuth) {
    const library = await findOwnedLibrary(libraryId, auth);
    if (!library) {
        throw new ImportError("NOT_FOUND", "Library not found");
    }

    return library;
}
