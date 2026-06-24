# Architectural Trade-offs

This document details the architectural decisions, structural trade-offs, and processing strategies chosen during the development of Stationary.

---

## 1. Multi-Track Representation Model (`Track` and `File` separation)

### Context & Decision
A media asset synced from social media can be physically complex. For example, Bilibili or YouTube videos are often served as split video and audio tracks (fragmented MP4). Live Photos consist of a static cover image and a short video clip. A video also needs a static cover frame and multiple subtitle files.

Rather than storing direct URLs as columns in the `Media` table (such as `primary_url`, `alternative_url`, `cover_url`, which are now deprecated), we introduced a **Multi-Track model**:
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

Rather than requiring the scraper clients to compute these ranges or downloading the entire file to the server's disk to parse it, we use an **online dynamic streaming extraction** approach in the `TaskService.processMedia` workflow.

### Rationales & Trade-offs
- **Fixed Memory Buffering**: During stream piping from source to S3, we intercept and buffer only the **first 32KB of data** in memory. This is enough to parse the `sidx` box structure and extract the initialization and index ranges, storing them in `Track.metadata.segment_base`. Once parsed, the stream is reconstructed and written to S3.
- **Resource Efficiency**: Buffering only 32KB eliminates OOM risks for multi-gigabyte videos and avoids temporary disk writes.
- **No Performance Penalty**: The parsing logic completes in under 0.05ms, causing no noticeable delay in download speeds.
- **Silent Fallback**: For standard non-fragmented files (like progressive MP4s or JPEGs), the stream parser gracefully aborts and resumes normal piping after 32KB, ensuring zero operational issues.

---

## 3. Automated Subtitle WebVTT Conversion

### Context & Decision
Platform scrapers frequently retrieve subtitles in platform-specific formats (such as Bilibili JSON). Browsers cannot play these subtitles natively.

During the synchronization pipeline in `TaskService.processMedia`, when a track of type `SUBTITLE` with metadata format `json` is fetched, the backend automatically intercepts and converts it to standard **WebVTT format (`.vtt`)** in-memory before uploading it to S3 as a WebVTT track.

### Rationales
- **Native Browser Playback**: The player can directly load the converted `.vtt` file in standard HTML5 `<track>` tags, avoiding client-side parsing libraries.
- **Zero Disk Overhead**: Conversion is performed completely in-memory, bypassing local temporary files.

---

## 4. Media-Centric Vectorization (No Direct Post Vectorization)

### Context & Decision
We index and embed search documents at the `Media` level (`entity_type: EntityType.MEDIA`) rather than the `Post` level, even though `Post` represents the top-level logical entity containing media.

### Rationales
- **Retrieval Granularity**: The application's primary UI is a Media Grid. Search results must resolve to specific, previewable image or video files.
- **Context Injection**: During the AI enrichment process (`enrichMediaItem`), the parent `Post`'s title and description are injected into the child `Media`'s `combinedFtsContent` before embedding. Thus, searching media embeddings implicitly queries the parent post's textual context.
- **Redundancy & Resource Efficiency**: Independent `Post` vectorization would introduce redundant embedding calculations and storage space without providing standalone visual modalities.

---

## 5. Four-Tier Clarity Architecture & Transcoding Specifications

### Core Decision: The Four-Tier Schema
To support the diverse layouts and bandwidth conditions of Stationary, the platform establishes a unified **Four-Tier Clarity Schema** for all media:

| Tier | Role Name | Video Specification | Image Specification | Core Use Case & Objective |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1** | **Original / Master** | Original source video | Original photo file | **Lossless archiving and master downloading.** Playback compatibility is not strictly enforced. |
| **Tier 2** | **HD / Preview** | 1080p H.264 MP4 | 1600px width AVIF / WebP | **Primary display in details view & lightbox.** Balances fidelity with web performance. |
| **Tier 3** | **LD / Mobile Stream** | 480p H.264 MP4 | 800px width AVIF / WebP | **Default mobile player and previews** on weak network profiles. |
| **Tier 4** | **Thumbnail / Cover** | Video frame AVIF / WebP | 400px width AVIF / WebP | **Board card covers and masonry grids.** Highly compressed to ensure fast page loads. |

---

### Implementation Trade-offs: Two Technical Paths

#### Path 1: CDN On-Demand Dynamic Resizing (Current Platform Default)
* **Storage Footprint**: S3 physically stores only **Tier 1 (Original / Master)**. For videos, it also stores an asynchronously captured frame for **Tier 4 (Video Cover)**.
* **Clarity Generation**: Resizing and format translation (AVIF/WebP) are handled dynamically at the CDN edge (e.g. Cloudflare Images) using query parameters, saving massive storage costs and batch conversion runs.

#### Path 2: Server-Side Offline Post-Transcoding (Self-Hosted / LAN / NAS Environments)
* **Dual-Tier Configuration**: In LAN or home NAS environments where local network speed is high but computational power is low, the platform condenses the 4-tier schema to **two tiers**:
  1. **Tier 1: Original (Master)**: Used for lossless viewing and downloads.
  2. **Tier 2: Thumbnail (Preview/Thumbnail)**: A single 400px image thumbnail for grid view scrolling, and a video cover frame. Video playback streams the original file directly via HTTP Range requests, keeping NAS CPU usage at absolute zero.
