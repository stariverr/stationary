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
