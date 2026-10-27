import { avatarPipeline } from "@/features/author/avatar-pipeline";
import { downloadPipeline } from "@/features/ingest/download-pipeline";
import { coverPipeline } from "@/features/media/cover-pipeline";
import type { PipelineHandlers } from "@/infra/queue/types";

export const pipelineHandlers: PipelineHandlers = {
    download: downloadPipeline,
    avatar: avatarPipeline,
    cover: coverPipeline,
};
