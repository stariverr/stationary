import { runMediaTrackIntegrityScan } from "@/audit/media-track";

try {
    const report = await runMediaTrackIntegrityScan();
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    console.error("Media/Track integrity audit failed:", error);
    process.exitCode = 1;
}
