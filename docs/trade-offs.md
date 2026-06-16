# Architectural Trade-offs

## 1. Media-Centric Vectorization (No Direct Post Vectorization)

### Context & Decision

We index and embed search documents at the `Media` level (`entity_type: EntityType.MEDIA`) rather than the `Post` level, even though `Post` represents the top-level logical entity containing media.

### Rationales

- **Retrieval Granularity**: The application's primary UI is a Media Grid. Search results must resolve to specific, previewable image or video files.
- **Context Injection**: During the AI enrichment process (`enrichMediaItem`), the parent `Post`'s title and description are injected into the child `Media`'s `combinedFtsContent` before embedding. Thus, searching media embeddings implicitly queries the parent post's textual context.
- **Redundancy & Resource Efficiency**: Independent `Post` vectorization would introduce redundant embedding calculations and storage space without providing standalone visual modalities (as posts lack direct physical media files).

### Future Considerations

`EntityType.POST` remains in the schema to support potential future "text-only posts" or dedicated "Post Feed search" layouts if the product requirements evolve.

## 2. Single-File DASH Video Playback & Dynamic SegmentBase Extraction

### Context & Decision

Some third-party media platforms serve high-quality videos using Fragmented MP4 (fMP4) formats with separated audio and video tracks (typically ending in `.m4s` or `.mp4`). Since the standard HTML5 `<video>` tag cannot directly merge and play two separate audio/video streams, we encapsulate them under the DASH protocol (by generating a `.mpd` manifest file) and utilize the `dash.js` player on the front end to achieve synchronized multi-track playback using MSE (Media Source Extensions).

For such single-file DASH tracks that encapsulate all segments, `dash.js` must obtain **Segment Base** metadata (including the `Initialization range` and `indexRange`) to dynamically request the respective audio/video subsegments via byte-range requests.

### Rationales & Trade-offs

To retrieve the Segment Base, we adopted an **online dynamic streaming extraction** approach in the background task processing service, rather than relying on the scraper to parse it beforehand or introducing heavy offline transcoding.

- **Dynamic Streaming Read vs. Full Memory Buffering**:
  In the background `TaskService.processMedia`, the media file stream is downloaded and uploaded to S3 simultaneously. We intercept the stream, buffering only the **first 32KB of data** in memory to parse the `sidx` box structure and locate the index ranges. Once parsed, the cached header data is prepended to the remaining stream to rebuild the original stream (Reconstructed Stream) for uploading.
  - **Memory Efficiency**: Fixed 32KB memory consumption. Even for gigabyte-scale videos, it introduces no extra memory overhead or OOM risks from buffering large files.
  - **Network & I/O Overhead**: The parsing is done completely inline during the existing stream transfer, requiring zero extra network requests and zero local temporary file write/read cycles.
  - **CPU Usage**: The offset comparison logic is extremely simple, taking less than 0.05ms on typical server CPUs, making the overhead virtually unnoticeable.

- **Closed-loop Database Metadata**:
  The extracted `segment_base` is stored in the `MediaFile.metadata` column, and the exact physical size is synchronized to the `File.size` column. This eliminates the `416 Range Not Satisfiable` playback errors caused by hardcoded fallback ranges when generating the `.mpd` file on the fly, ensuring absolute playback stability across different codecs and header sizes.

- **Progressive Enhancement & Silent Fallback**:
  If the downloaded media is not in fMP4 format (e.g., standard progressive MP4 files, cover JPGs, WebVTT subtitles), the parser safely aborts and returns the original stream once it has read the first 32KB and verified the absence of a `sidx` box, introducing no side effects to the S3 upload sequence.

