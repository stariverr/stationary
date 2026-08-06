import { runMediaTrackIntegrityScan } from "@/audit/media-track";

const blockingChecks = new Set([
    "media_blank_eid",
    "media_attached_duplicate_eid",
    "media_independent_duplicate_eid",
    "media_missing_post",
    "media_post_library_mismatch",
    "media_missing_library",
    "track_missing_media",
    "track_missing_file",
    "track_invalid_source",
    "track_original_and_generated",
    "track_invalid_numeric_values",
    "file_negative_size",
    "media_deprecated_url_values",
    "media_tag_cross_library",
    "post_tag_cross_library",
]);

try {
    const report = await runMediaTrackIntegrityScan();
    const blocking = Object.fromEntries(
        Object.entries(report.counts).filter(([name, count]) => blockingChecks.has(name) && count > 0),
    );

    console.log(JSON.stringify(report, null, 2));
    if (Object.keys(blocking).length > 0) {
        console.error("Media/Track migration preflight failed for blocking checks:", JSON.stringify(blocking));
        process.exitCode = 1;
    } else {
        console.log("Media/Track migration preflight passed.");
    }
} catch (error) {
    console.error("Media/Track migration preflight failed:", error);
    process.exitCode = 1;
}
