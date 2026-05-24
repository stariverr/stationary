import { db } from "@/global/db";
import { Library, Post, Media, User } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";

async function migrate() {
    console.log("Starting Library Migration...");

    let defaultLib = await db
        .select()
        .from(Library)
        .where(eq(Library.name, "Default Library"))
        .limit(1)
        .then((rows) => rows[0]);

    if (!defaultLib) {
        console.log("- Creating Default Library...");
        const defaultUser = await db.select().from(User).limit(1).then((rows) => rows[0]);
        if (!defaultUser) {
            console.error("Migration Failed: No user found to own the default library.");
            process.exit(1);
        }

        const newLibs = await db
            .insert(Library)
            .values({
                name: "Default Library",
                description: "Migrated default library",
                is_public: true,
                owner_id: defaultUser.id,
            })
            .returning();
        defaultLib = newLibs[0];
    } else {
        console.log("- Default Library already exists.");
    }

    console.log("[Default Library ID] " + defaultLib.id);

    console.log("- Migrating Posts...");
    const updatedPosts = await db
        .update(Post)
        .set({ library_id: defaultLib.id })
        .where(isNull(Post.library_id))
        .returning();
    console.log("Migrated " + updatedPosts.length + " posts.");

    console.log("- Migrating Media...");
    const updatedMedia = await db
        .update(Media)
        .set({ library_id: defaultLib.id })
        .where(isNull(Media.library_id))
        .returning();
    console.log("Migrated " + updatedMedia.length + " media assets.");

    console.log("Migration Complete!");
    process.exit(0);
}

migrate().catch((err) => {
    console.error("Migration Failed:", err);
    process.exit(1);
});
