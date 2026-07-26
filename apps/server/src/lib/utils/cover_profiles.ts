import { Quality } from "@/lib/types";

export const RECIPE_VERSION = 1;

export interface CoverProfile {
    maxEdge: number;
    crf: number;
    quality: number;
}

export const COVER_PROFILES: Record<Quality, CoverProfile> = {
    [Quality.LOW]: {
        maxEdge: 360,
        crf: 35,
        quality: 50,
    },
    [Quality.MEDIUM]: {
        maxEdge: 720,
        crf: 28,
        quality: 60,
    },
    [Quality.HIGH]: {
        maxEdge: 1440,
        crf: 22,
        quality: 75,
    },
};
