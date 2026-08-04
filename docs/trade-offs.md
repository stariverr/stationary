# Architectural Trade-offs

This document details the architectural decisions, structural trade-offs, and processing strategies chosen during the development of Stationary.

---

## 1. Multi-Track Representation Model (`Track` and `File` separation)

### Context & Decision
A media asset can be physically complex. For example, videos are often served as split video and audio tracks (fragmented MP4). Live Photos consist of a static cover image and a short video clip. A video also needs a static cover frame and subtitle files.

Stationary uses a **Multi-Track model**:
- `Media` represents the logical asset container.
- `Track` represents a specific component or variant of that media (e.g. `IMAGE`, `VIDEO`, `AUDIO`, `SUBTITLE` under purpose `CONTENT`, `COVER`, `THUMBNAIL`, `PREVIEW`).
- `File` represents the physical file stored in S3, keyed by UUID.

### Rationales
- **Extensibility**: Allows media items to dynamically attach new files (such as multilingual subtitles, varying quality tracks, or AI-generated previews) without executing database migrations.
- **DASH Playback Integration**: Separate video and audio tracks are stored as individual `Track` rows and merged at playback time via a dynamically generated DASH manifest, avoiding expensive video merging or transcoding tasks on the backend.
- **Granular Change Detection**: If a secondary asset (such as an audio track or a subtitle file) changes or has an anti-leech token rotation, only that specific `Track` is updated, avoiding re-downloading the large primary video file.

---

## 2. Single-File DASH Video Playback & Dynamic SegmentBase Extraction

### Context & Decision
To play separate audio and video tracks synchronously without combining them into a single file on the server, Stationary uses the DASH protocol (`dash.js` player). For single-file DASH tracks, the player needs the `SegmentBase` metadata (the byte ranges for `Initialization` and `Index` boxes) to request segments on demand using HTTP Range requests.

Rather than requiring the external sync clients to compute these ranges or downloading the entire file to the server's disk to parse it, we use an **online dynamic streaming extraction** approach in the `TaskService.processMedia` workflow.

### Rationales & Trade-offs
- **Fixed Memory Buffering**: During stream piping from source to S3, we intercept and buffer only the **first 32KB of data** in memory. This is enough to parse the `sidx` box structure and extract the initialization and index ranges, storing them in `Track.metadata.segment_base`. Once parsed, the stream is reconstructed and written to S3.
- **Resource Efficiency**: Buffering only 32KB eliminates OOM risks for multi-gigabyte videos and avoids temporary disk writes.
- **No Performance Penalty**: The parsing logic completes in under 0.05ms, causing no noticeable delay in download speeds.
- **Silent Fallback**: For standard non-fragmented files (like progressive MP4s or JPEGs), the stream parser gracefully aborts and resumes normal piping after 32KB, ensuring zero operational issues.

---

## 3. Media-Centric Vectorization (No Direct Post Vectorization)

### Context & Decision
We index and embed search documents at the `Media` level (`entity_type: EntityType.MEDIA`) rather than the `Post` level, even though `Post` represents the top-level logical entity containing media.

### Rationales
- **Retrieval Granularity**: The application's primary UI is a Media Grid. Search results must resolve to specific, previewable image or video files.
- **Context Injection**: During the AI enrichment process (`enrichMediaItem`), the parent `Post`'s title and description are injected into the child `Media`'s `combinedFtsContent` before embedding. Thus, searching media embeddings implicitly queries the parent post's textual context.
- **Redundancy & Resource Efficiency**: Independent `Post` vectorization would introduce redundant embedding calculations and storage space without providing standalone visual modalities.

---

## 4. Server-Side Cover & Thumbnail Generation

### Context & Decision
To support different display layouts (board covers, masonry grid scrolling, lightboxes, and video playback), Stationary uses a lightweight **cover and thumbnail generation architecture**:

- **Tier 1 (Original Master)**: Original photo or video file, preserved for lossless archiving and downloads.
- **Tier 2 (Cover / Thumbnail)**: The backend automatically extracts video keyframes or resizes photos into compressed AVIF/WebP covers (e.g., 400px thumbnails) for responsive grid rendering.

### Rationales
* **Asynchronous Local Generation**: The background job engine (`CoverJobHandler`) extracts cover frames and generates derivative tracks asynchronously, uploading them to S3.
* **Minimal Computational Overhead**: Video playback streams the Tier 1 master file directly using HTTP Range requests, eliminating full video re-encoding costs.
