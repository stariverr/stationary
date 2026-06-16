import { db } from "@/global/db";
import { File } from "@/db/schema";
import { s3 } from "@/global/s3";
import { env } from "@/global/env";
import { eq } from "drizzle-orm";

async function main() {
    const files = await db.select().from(File).where(eq(File.extension, "plain"));

    console.log(`Found ${files.length} files with extension 'plain' to migrate.`);

    for (const f of files) {
        if (!f.path.endsWith(".plain")) {
            console.log(
                `Skipping file ID: ${f.id} because path does not end with .plain: ${f.path}`,
            );
            continue;
        }

        const oldPath = f.path;
        const newPath = oldPath.replace(/\.plain$/, ".srt");

        console.log(`Migrating file ID ${f.id}:`);
        console.log(`  Old Path: ${oldPath}`);
        console.log(`  New Path: ${newPath}`);

        // 1. Copy object in S3
        console.log(`  Copying in S3...`);
        await s3.copy(oldPath, newPath, { bucket: f.bucket || env.S3_BUCKET });

        // 2. Delete old object in S3
        console.log(`  Deleting old object in S3...`);
        await s3.delete(oldPath, { bucket: f.bucket || env.S3_BUCKET });

        // 3. Update database record
        console.log(`  Updating DB...`);
        await db
            .update(File)
            .set({
                path: newPath,
                extension: "srt",
            })
            .where(eq(File.id, f.id));

        console.log(`  Migration completed for file ID ${f.id}.`);
    }

    console.log("All plain files migrated successfully!");
    process.exit(0);
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
