# Metadata Sync Workflow & API Specification

> [简体中文](./external_api.contract.zh-Hans.md)

This specification defines the communication schema, synchronization lifecycles, and idempotency guarantees between external synchronization clients (e.g. integration agents) and the Stationary backend (`TaskService`).

---

## 1. Core Principles

The synchronization pipeline is designed around **Separation of Concerns** and **Contract-First Validation** to maintain reliability and idempotency over repetitive synchronization runs.

* **Client Responsibilities**: Resolves source platform metadata, strips anti-leech query tokens, formats standard payloads, and **provides stable, unique identifiers (`external_id`)** for posts and media assets.
* **Server (`TaskService`) Responsibilities**: Records metadata payloads, coordinates background queues, handles state machines (PENDING, IN_PROGRESS, SUCCESS, FAILED), detects updates, and manages physical files in storage (S3).

---

## 2. Unique Identifier (`external_id`) Specifications

Every asset synced into the system must use a stable `external_id`. **Do not use array indices (index)** as identifiers, as edits to posts on the source platform can reorder arrays and corrupt existing records.

### 2.1 Fallback Pseudo-ID Generation

If the source platform does not provide a native media identifier, the client must compute a **Pseudo-ID** using the following steps:

1. **URL Cleaning**: Extract the resource URL's base path, **stripping all dynamic query parameters** (such as `?x-expires=...`, tokens, or anti-leech signatures).
2. **Hash Computation**: Calculate a **BLAKE3** hash of the cleaned URL. Use the resulting 32-character hexadecimal string as the `external_id`.

### 2.2 Composite Asset Anchoring

For logical assets composed of multiple physical files (like a Live Photo or a video with a cover image), the `external_id` **must be generated from the primary asset only**.

- **Live Photo (`type: "LIVE_PHOTO"`)**
  - **Primary Asset**: Static image.
  - **Secondary Asset**: Dynamic video track (`live_photo_video_url`).
  - **Rule**: `external_id = BLAKE3(cleaned static image URL)`. The dynamic video URL is ignored during ID calculation.
- **Video (`type: "VIDEO"`)**
  - **Primary Asset**: Video file.
  - **Secondary Asset**: Cover frame image (`cover_file_url`).
  - **Rule**: `external_id = BLAKE3(cleaned video URL)`. The cover image URL is ignored during ID calculation.

> [!IMPORTANT]
> **Why this matters**: If an anti-leech token changes on a secondary asset (such as the dynamic video track of a Live Photo), the primary asset's `external_id` remains unchanged. This allows the server to perform a clean update (updating only the video URL) without deleting and re-downloading the entire Live Photo asset.

---

## 3. Streaming Media Adaptations

Streaming media addresses (e.g., live streams, segmented M3U8/HLS endpoints) differ from static media files: **they are highly transient, token-dependent, and do not map to a single file hash.**

For streaming media, the synchronization flow adapts as follows:

1. **Identity Anchoring**: If a media item is a stream and lacks a native ID, its `external_id` is generated as `parentPostId + "_video_stream"`.
2. **Bypassing Change Detection**: Because stream URLs rotate frequently, the server updates only the database URL records. It skips the physical file cleanup and S3 deletion rules that apply to normal static URLs.
3. **Asynchronous Recording**: Stream recording is flagged under `STREAM_PROCESSING` and handled by a separate background capture runner. The primary metadata sync workflow does not wait for it.

---

## 4. API Contract & Payload Schema

### 4.1 Create Task Endpoint

- **Endpoint**: `POST /api/task/create`
- **Content-Type**: `application/json`

#### Request Payload JSON Schema Example

```json
{
  "library_id": "uuid-of-target-library",
  "posts": [
    {
      "title": "Post Title",
      "url": "https://platform.com/post/12345",
      "description": "Post description details",
      "external_id": "platform_post_unique_id",
      "tags": ["tag1", "tag2"],
      "platform": "XHS",
      "published_time": "2026-05-19T10:00:00Z",
      "author": {
        "name": "Author Nickname",
        "short_id": "123456",
        "external_id": "author_platform_unique_id",
        "avatar_file_url": "https://platform.com/avatar.jpg"
      },
      "media": [
        {
          "external_id": "media_unique_id",
          "title": "Sub-title for media",
          "description": "Media description",
          "type": "IMAGE",
          "primary_file_url": "https://platform.com/media_primary.jpg",
          "alternative_file_url": null,
          "live_photo_video_url": null,
          "cover_file_url": null,
          "duration": null,
          "published_time": "2026-05-19T10:00:00Z"
        }
      ]
    }
  ]
}
```

#### Key Field Rules

| Field Path | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `library_id` | String | Yes | UUID of the target library where the post batch is imported. |
| `posts[].platform` | String | Yes | Enum: `UNKNOWN`, `X`, `XHS`, `BILIBILI`, `DOUYIN`, `TIKTOK`, `INSTAGRAM` |
| `posts[].published_time` | String | No | ISO-8601 string or a 10/13-digit UNIX timestamp (parsed automatically by the backend) |
| `posts[].media[].type` | String | Yes | Enum: `IMAGE`, `VIDEO`, `LIVE_PHOTO` |
| `posts[].media[].primary_file_url` | String | Yes | Direct hotlink URL to the main file. |
| `posts[].media[].live_photo_video_url` | String | No | URL to the video track (only valid when type is `LIVE_PHOTO`). |
| `posts[].media[].cover_file_url` | String | No | URL to the cover frame (only valid when type is `VIDEO`). |

---

## 5. Integration Checklist (for Synchronization Clients)

- [ ] Have all media items been assigned valid `external_id` tags?
- [ ] Are query parameters stripped from URLs before calculating Pseudo-IDs?
- [ ] For Live Photos, is only the static image URL used to calculate the Pseudo-ID?
- [ ] Are `external_id` values unique within a single post's media list?