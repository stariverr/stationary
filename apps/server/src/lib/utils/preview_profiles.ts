import { PreviewSize } from "@/db/schema";

/** Bump when the rendered output changes; every preview rendered with an older recipe is rendered again. */
export const RECIPE_VERSION = 2;

export interface PreviewProfile {
    maxEdge: number;
    crf: number;
    quality: number;
}

export const PREVIEW_PROFILES: Record<PreviewSize, PreviewProfile> = {
    [PreviewSize.SMALL]: { maxEdge: 360, crf: 35, quality: 50 },
    [PreviewSize.MEDIUM]: { maxEdge: 720, crf: 28, quality: 60 },
    [PreviewSize.LARGE]: { maxEdge: 1440, crf: 22, quality: 75 },
};
