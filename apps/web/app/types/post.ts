export const enum Platform {
    XHS = 'XHS',
    X = 'X',
    DOUYIN = 'DOUYIN',
    YOUTUBE = 'YOUTUBE',
    TIKTOK = 'TIKTOK',
    INSTAGRAM = 'INSTAGRAM',
    INTERNAL = 'INTERNAL',
    BILIBILI = 'BILIBILI',
    UNKNOWN = 'UNKNOWN'
}

export interface PostMedia {
    id?: number | string;
    eid?: string;
    post_eid?: string;
    source?: string;
    title?: string;
    description?: string;
    type: 'VIDEO' | 'IMAGE' | 'LIVE_PHOTO'; // Upper case from API
    index?: number;
    url: string;
    url2?: string | null;
    live_url?: string | null;
    thumbnail?: string; // Client-side mapped
    poster?: string;    // Client-side mapped
    width?: number;     // Client-side populated if available or needed
    height?: number;    // Client-side populated
}

export interface Post {
    id: number | string;
    eid: string;
    title: string;
    description?: string;
    source: string; // "XHS", "DOUYIN" etc.
    tags?: string[];
    author_name?: string;
    author_external_id?: string;
    create_time?: string; // Stationary record creation time
    published_time?: string | null; // Original platform publish time
    media_count?: number;
    url?: string; // Original URL

    // List specific fields from API example
    media_url?: string;
    media_type?: 'VIDEO' | 'IMAGE' | 'LIVE_PHOTO';
    media_title?: string;
    media_description?: string;

    // Unified media array for UI
    media?: PostMedia[];

    // Client-side / Legacy compatibility
    platform?: Platform; // Mapped from source
    date?: string;       // Formatted date
    width?: number;      // From media or default
    height?: number;     // From media or default
    size?: string;       // Placeholder
    author?: string;     // Mapped from author_name
    type?: string;       // 'video' | 'image' | 'text'
    originalUrl?: string; // Mapped from url or specific field
}
