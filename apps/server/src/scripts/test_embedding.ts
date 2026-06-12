import { db } from "@/global/db";
import { Library, User } from "@/db/schema";
import { AiService } from "@/services/ai/service";
import { eq } from "drizzle-orm";

async function main() {
    console.log("🔍 Checking database for configured users...");
    const libraries = await db.select().from(Library).limit(1);
    const library = libraries[0];

    if (!library) {
        console.error("❌ No library found in database. Please log in or create an account first.");
        process.exit(1);
    }

    console.log(`👤 Found library: ${library.id}`);

    try {
        console.log("🚀 Resolving AI service instance...");
        const aiService = await AiService.forLibrary(library.id);
        if (!aiService) {
            console.error("❌ AiService is null. No AI config resolved.");
            process.exit(1);
        }

        console.log("📝 Generating text embedding for: 'Hello, Stationary!'...");
        const result = await aiService.embedText({
            text: "Hello, Stationary!",
            purpose: "QUERY",
        });

        console.log("✅ Embedding generated successfully!");
        console.log(`📊 Vector space ID: ${result.spaceId}`);
        console.log(`📊 Vector dimensions: ${result.dimension}`);
        console.log(`🔢 First 5 values: [${result.embedding.slice(0, 5).join(", ")}...]`);
    } catch (error: any) {
        console.error("❌ Embedding generation failed!");
        console.error(error.stack || error.message || String(error));
        process.exit(1);
    }

    process.exit(0);
}

main();
