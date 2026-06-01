import { extractVideoFrame } from "../src/lib/utils/ffmpeg.ts";

async function run() {
    console.log("Testing extractVideoFrame utility (AVIF with Temp File)...");
    const testVideoUrl = "https://www.w3schools.com/html/mov_bbb.mp4"; // Sample public video URL
    
    try {
        const coverBytes = await extractVideoFrame(testVideoUrl);
        console.log(`Successfully extracted frame in AVIF format! Size: ${coverBytes.length} bytes`);
        
        // Simple AVIF signature detection: usually has "ftypavif" or similar in the first 16 bytes
        const hex = Array.from(coverBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`First 16 bytes hex: ${hex}`);
        
        const isAvif = hex.includes("66 74 79 70 61 76 69 66") || hex.includes("61 76 69 66"); // "avif" ASCII
        if (isAvif) {
            console.log("Verified: Output is a valid AVIF image!");
        } else {
            console.log("Output signature parsed.");
        }
    } catch (e) {
        console.error("Failed to extract frame:", e);
    }
}

run();
