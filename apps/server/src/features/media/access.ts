import { and, eq } from "drizzle-orm";
import { DeleteStatus, Library, Media } from "@/db/schema";
import { reachableLibraryFilter, type LibraryAuth } from "@/features/library/access";
import { db } from "@/global/db";

export class MediaAccessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MediaAccessError";
    }
}

export async function assertMediaAccess(
    mediaId: string,
    auth: LibraryAuth,
    options: { allowRecycled?: boolean } = {},
) {
    const [row] = await db
        .select({ media: Media })
        .from(Media)
        .innerJoin(Library, eq(Library.id, Media.library_id))
        .where(and(eq(Media.id, mediaId), reachableLibraryFilter(auth)))
        .limit(1);

    if (!row || row.media.delete_status !== DeleteStatus.ACTIVE || (!options.allowRecycled && row.media.recycle_time !== null)) {
        throw new MediaAccessError("Media not found or is in recycle bin");
    }

    return row.media;
}
