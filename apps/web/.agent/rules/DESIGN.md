# Frontend Dual-Track Architecture & Media Assets Lightbox

## 1. Overview
The application uses a **Dual-Track (Dual-View)** experience for managing and viewing content, inspired by Pinterest:
1. **Media Assets (资产大盘 - `/`)**: Focuses on individual digital assets (images, videos).
2. **Post Collections (社交合集 - `/posts`)**: Focuses on the social context (tweets, authors, original text).

## 2. Media Assets & Display Modes
The Media Assets view supports two modes:
- **Flat (平铺模式)**: Displays all media items globally, regardless of their parent post.
- **Stacked (堆叠模式)**: Groups media by their parent post. Only standalone media or the first media item of a post is shown. A badge indicates the total number of media items in the stack.

## 3. Immersive Lightbox (详情展示)
Media details are shown in an immersive, full-screen **Lightbox**. The Lightbox differentiates its navigation behavior based on the current display mode:

### In Flat Mode
- Context: Global linear browsing.
- Navigation (Prev/Next): Moves to the previous or next media asset in the global list (`store.medias`), ignoring post boundaries.

### In Stacked Mode
- Context: Depth browsing (Post-bound).
- Navigation (Prev/Next): When a stacked media (with a `post_uid`) is opened, the Lightbox automatically fetches the full post detail (using `/api/post/detail/:uid`).
- The Lightbox displays a bottom **Filmstrip** of sibling media from the same post.
- Prev/Next navigation operates strictly *within* the siblings of that post.

### Provenance (溯源)
- The Lightbox includes a right sidebar showing the asset's raw properties (Type, Source, Dimensions, Date).
- A **"Part of Post" (所属贴文)** section appears if the media belongs to a post. It shows a snippet of the original author and text, with a direct link to transition into the Social Context (`/posts/:id`).

## 4. State Management
- `useMediaStore` (Pinia) tracks the `selectedMediaId` and provides computed properties to access the `selectedMedia`.
- The `MediaLightbox.vue` component listens to `selectedMediaId` and independently fetches the post siblings when in Stacked mode.
