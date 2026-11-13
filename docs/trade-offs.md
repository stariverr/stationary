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
- **Granular Change Detection**: If a secondary asset (such as an audio track or a subtitle file) changes or has an anti-leech token rotation, only that specific `Track` is updated, avoiding re-downloading the large primary video file.

---

## 2. Playback: Original First, Manifests and Just-in-Time Packaging When Needed

### Context & Decision
A video may come as one plain MP4, as an MP4 with several audio tracks inside, or as a video plus separate audio files (MP4, M4A, fMP4) and captions. Stationary never stores a transcoded or remuxed copy. It plays the original whenever that gives the viewer what they need, and only otherwise uses an HLS or DASH manifest built at request time. Details are in [media_refactor.zh-Hans.md](./media_refactor.zh-Hans.md) §8 (Chinese).

- **The server offers, the client chooses.** `direct_url` is always present. `hls_url` and `dash_url` are added when there are several originals, several audio tracks or captions, and the video stream can go into a manifest.
- **Manifest sources.** A single-stream fMP4 with a `sidx` is referenced by byte range straight from the CDN. A plain MP4/MOV/M4A is packaged just in time: the server reads `moov` with Range requests, writes `moof` itself and streams the sample bytes from S3 as fMP4 segments. Other formats (MP3, MKV, fMP4 without `sidx`) stay out of manifests. The `sidx` and fragmentation facts are found at probe time with Range requests and stored on `av_file`; per-segment indexes are cached in Redis.
- **Web player.** The picked audio track decides the source. A track the original gives plays from the original in a plain `<video>`: Safari switches embedded tracks in place (`audioTracks`), other browsers only play a file's first audio track. Any other track plays through the manifest (hls.js; dash.js is an advanced setting). Switching goes both ways and resumes at the same position, with the last frame, time and play state held until the new source plays.
- **Flutter and external players.** Flutter plays one original directly, switching embedded tracks in the player, and uses HLS for external tracks (AVPlayer has no DASH). External players get the original's address, or the manifest address when there are external tracks or captions.

### Rationales & Trade-offs
- **Most playback never touches the server.** The original streams from the CDN with HTTP Range requests. Packaged segments, by contrast, pass through the server and cost bandwidth there; only media that needs a manifest pays this.
- **No stored copies.** Originals are never modified and no derived audio/video files exist, so there is nothing to keep in sync or migrate. The packaging index can be recomputed any time.
- **Interleaved originals are read in a few ranges.** ffmpeg interleaves audio and video sample by sample, so one 6-second segment is scattered over ~180 byte runs. Runs less than 32 KiB apart are merged into reads of up to 1 MiB, read ahead in parallel. This takes a segment from about 6 s down to 0.2–0.4 s.
- **Clear support boundaries.** Formats outside them are listed in the player as unavailable, with the reason, rather than being worked around (media_refactor §16). Transcoding is a later option.

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
* **Asynchronous Local Generation**: The `cover` pipeline on the background job queue extracts cover frames and generates derivative tracks asynchronously, uploading them to S3.
* **Minimal Computational Overhead**: Video playback streams the Tier 1 master file directly using HTTP Range requests, eliminating full video re-encoding costs.
