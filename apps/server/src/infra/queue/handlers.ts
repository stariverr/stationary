import { avatarPipeline } from "@/features/author/avatar-pipeline";
import { describePipeline } from "@/features/ai/describe-pipeline";
import { imageEmbeddingPipeline, textEmbeddingPipeline } from "@/features/ai/embed-pipeline";
import { indexPipeline } from "@/features/ai/index-pipeline";
import { downloadPipeline } from "@/features/ingest/download-pipeline";
import { previewPipeline } from "@/features/media/preview-pipeline";
import type { PipelineHandlers } from "@/infra/queue/types";

export const pipelineHandlers: PipelineHandlers = {
    download: downloadPipeline,
    avatar: avatarPipeline,
    preview: previewPipeline,
    "ai.describe": describePipeline,
    "ai.index": indexPipeline,
    "ai.text": textEmbeddingPipeline,
    "ai.image": imageEmbeddingPipeline,
};
