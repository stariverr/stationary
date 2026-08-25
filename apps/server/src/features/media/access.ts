import { eq } from "drizzle-orm";
import { DeleteStatus, Library, Media } from "@/db/schema";
import { db } from "@/global/db";

export type MediaAccessAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

export type MediaAccessErrorKind = "NOT_FOUND" | "FORBIDDEN";

export class MediaAccessError extends Error {
    constructor(
        public readonly kind: MediaAccessErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "MediaAccessError";
    }
}

export async function assertMediaAccess(
    mediaId: string,
    auth: MediaAccessAuth,
    options: { allowRecycled?: boolean } = {},
) {
    const [media] = await db.select().from(Media).where(eq(Media.id, mediaId)).limit(1);
    if (!media || media.delete_status !== DeleteStatus.ACTIVE || (!options.allowRecycled && media.recycle_time !== null)) {
        throw new MediaAccessError("NOT_FOUND", "Media not found or is in recycle bin");
    }

    const [library] = await db.select().from(Library).where(eq(Library.id, media.library_id)).limit(1);
    if (!library || library.owner_id !== auth.ownerId) {
        throw new MediaAccessError("FORBIDDEN", "You do not have access to this library");
    }

    if (auth.scopedLibraryId && auth.scopedLibraryId !== media.library_id) {
        throw new MediaAccessError("FORBIDDEN", "API token scope restricted to another library");
    }

    return media;
}
