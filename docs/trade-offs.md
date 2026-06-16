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

## 3. Four-Tier Clarity Architecture & Transcoding Specifications

### Core Decision: The Four-Tier Schema

To support the diverse layouts and bandwidth conditions of Stationary (mobile displays, high-res desktop lightboxes, network fluctuations, AI text-enrichment/OCR, and lossless downloading), the platform establishes a unified **Four-Tier Clarity Schema** for all media. Whether implemented through server-side offline post-transcoding or on-the-fly CDN calculations, the system must retain and plan for these four levels:

| Tier | Role Name | Video Specification | Image Specification | Core Use Case & Objective |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1** | **Original / Master** | Original source video<br>(e.g., 4K/HEVC, split fMP4) | Original photo file<br>(e.g., 4K JPG/PNG, raw HEIC) | **Lossless archiving and master downloading.** Playback or preview compatibility is not strictly enforced on all browser clients (e.g., ProRes or raw formats); it acts purely as a pristine master backup. |
| **Tier 2** | **HD / Preview** | **1080p (1920x1080)**<br>H.264 MP4 (AAC audio) | **1600px width proportional**<br>AVIF / WebP / JPEG | **Primary display in details view & lightbox.** Balances maximum visual fidelity with efficient web transmission. 100% browser compatible. |
| **Tier 3** | **LD / Mobile Stream** | **480p (854x480)**<br>H.264 MP4 (AAC audio) | **800px width proportional**<br>AVIF / WebP | **Default mobile player and previews**, weak network (4G/3G) streaming. Ensures near-instant playback startup, saves user data, and looks sharp on smaller screens. |
| **Tier 4** | **Thumbnail / Cover** | **1st second video frame**<br>AVIF / WebP (400px aspect) | **320px ~ 400px width**<br>AVIF / WebP (smart cropped) | **Board card covers and masonry grids.** Extremely compressed (<20KB per image, video cover alignment) to ensure hundreds of grid assets load concurrently in milliseconds. |

---

### Implementation Trade-offs: Two Technical Paths

Depending on the deployment requirements, these four tiers can be implemented through two distinct strategies:

#### Path 1: CDN On-Demand Dynamic Resizing (Current Platform Default)

* **Storage Footprint**: S3 physically stores only **Tier 1 (Original / Master)**. For videos, it also stores an asynchronously captured frame for **Tier 4 (Video Cover)**.
* **Clarity Generation**:
  - **Images (HD, LD, Thumbnail)**: The front end loads the original URL but appends transformation query keys (e.g., `/cdn-cgi/image/width=400,format=avif/...`), allowing the CDN edge nodes to resize, convert formats (AVIF/WebP), and cache the variants on-the-fly.
  - **Videos (HD, LD)**: The player loads the original file using standard HTTP Range byte requests. Under weak network profiles, the client can fall back to the scraped lower-definition stream via the `ALTERNATIVE` role.
* **Trade-offs**:
  - *Pros*: Minimal S3 storage cost (no redundant duplicates), absolute layout agility (changing UI dimensions requires no batch re-runs), and instant import availability.
  - *Cons*: Development bypasses/localhost fall back to loading full originals, and HEIC source images or huge videos lack optimizations without Cloudflare or similar proxies.

#### Path 2: Server-Side Offline Post-Transcoding (Fully Self-Hosted / Private Deployments)

* **Storage Footprint**: The backend runs a Redis/QStash-driven async pipeline using `sharp` and `ffmpeg`. Every asset generates **4 separate physical files** stored in S3, mapped to dedicated schema roles in the `MediaFile` database table (e.g., `PRIMARY` for Original, `PREVIEW` for HD Preview, `ALTERNATIVE` for LD Stream, and `THUMBNAIL` for grid covers).
* **Clarity Generation**:
  - **Images**: The backend `sharp` task pre-processes the original master into 1600px (HD) and 400px (Thumbnail) AVIF/WebP files.
  - **Videos**: The backend `ffmpeg` task transcodes the master into standard H.264 MP4s at 1080p (HD) and 480p (LD), appending `-movflags +faststart` to move indexes to the header for instant progressive playing.
* **Trade-offs**:
  - *Pros*: Zero vendor lock-in, fully compatible with local intranets and private VPC architectures. Pre-handles HEIC conversion and codec normalization natively before S3 upload.
  - *Cons*: High computational load (CPU/GPU-intensive video encoding) causes queuing during batch imports. Modifying front-end grid dimensions requires migrating and regenerating all historical S3 assets.

### Variant Simplification Strategy for Self-Hosted & Local Area Network (NAS) Environments (Dual-Tier Configuration)

In self-hosted (Self-Hosted) or local network (e.g., home NAS, personal workstations) scenarios, the network bandwidth and hardware environments change fundamentally, requiring the system to support **adjustable and dynamically simplified** variant configurations.

#### 1. Why Self-Hosted/Local Deployments Can Simplify to "Dual-Tier"
- **Abundant Local Bandwidth**: Within a Gigabit or 10-Gigabit LAN, network throughput is no longer a bottleneck. Loading hundred-megabyte videos or multi-megabyte raw camera photos happens almost instantaneously, eliminating cellular data costs and low-bandwidth buffering concerns.
- **Constrained Computational Resources**: Home NAS devices (e.g., Synology, QNAP, Raspberry Pi) often feature lower-powered CPUs and lack dedicated GPU hardware acceleration. Forcing the system to transcode 4 different variants for every single imported asset (especially video files) would cause CPUs to peg at 100% indefinitely, degrading server responsiveness and backlogging imports for hours.
- **High Storage Sensitivity**: Home server users often want to keep their media library tidy and avoid bloating local disks with multiple duplicate preview files of the same asset.

#### 2. Recommended "Dual-Tier" Minimal Configuration
For self-hosted deployments, the platform recommends introducing an environment configuration (e.g., `MEDIA_VARIANTS_PROFILE=minimal`) that automatically condenses the 4-tier schema down to **two tiers**:

1. **Tier 1: Original (Master)**: Used for downloads and main lossless viewing.
2. **Tier 2: Thumbnail (Preview/Thumbnail)**:
   - **Images**: Generates only a single **400px** small thumbnail for fast grid listing scrolling (to prevent DOM/UI rendering lag). The full-detail lightbox loads the original image directly.
   - **Videos**: Extracts only a single **cover frame** for grid renders. Full video playback streams the original file directly via HTTP Range requests, bypassing all HD/LD transcode steps to keep CPU usage at absolute zero.

By employing this "Original + Minimal Thumbnail" dual-tier approach, self-hosted deployments leverage high local LAN speeds to stream the original files directly while fully bypassing the severe CPU bottlenecks of video transcoding on low-power NAS hardware.

