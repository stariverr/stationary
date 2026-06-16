import { db } from "@/global/db";
import { File, Track, DeleteStatus } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { s3 } from "@/global/s3";

async function main() {
    console.log("🔍 Fetching a physical file record from DB...");
    // Let's find the files of the post that failed
    const fileRecord = await db
        .select()
        .from(File)
        .where(eq(File.delete_status, DeleteStatus.ACTIVE))
        .limit(1)
        .then((rows) => rows[0]);

    if (!fileRecord) {
        console.error("❌ No active file records found in DB.");
        process.exit(1);
    }

    console.log(`📂 DB File Record:`);
    console.log(`- ID: ${fileRecord.id}`);
    console.log(`- Path: ${fileRecord.path}`);
    console.log(`- Bucket: ${fileRecord.bucket}`);

    try {
        console.log("🔗 Generating presigned URL...");
        const presignedUrl = await s3.getPresignedUrl(fileRecord.path, {
            bucket: fileRecord.bucket,
            expiresInSeconds: 600,
        });

        console.log(`🔗 Generated URL: ${presignedUrl}`);

        console.log("📥 Fetching file...");
        const response = await fetch(presignedUrl);
        console.log(`📥 Response Status: ${response.status} (${response.statusText})`);

        const bodyText = await response.text();
        if (!response.ok) {
            console.error("❌ S3 XML Error Details:");
            console.error(bodyText);
        } else {
            console.log("✅ File downloaded successfully! Size:", bodyText.length);
        }
    } catch (err: any) {
        console.error("❌ Critical S3 error:", err.message);
    }
    process.exit(0);
}

main();
