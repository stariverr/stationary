<script setup lang="ts">
import { ref, computed, watch } from "vue";
import {
    Plus,
    Upload,
    Play,
    Music,
    FileText,
    Image as ImageIcon,
    Video as VideoIcon,
    FileImage,
    Layers,
    Link as LinkIcon,
    Trash2,
    Loader2,
    Pencil,
} from "@lucide/vue";
import { useMediaStore } from "@/stores/media";
import { toast } from "@/components/ui/sonner";
import { useApi } from "@/composables/useApi";
import { getOptimizedImageUrl } from "@/utils/image";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

interface Props {
    mediaId: string;
}

const props = defineProps<Props>();

const store = useMediaStore();
const { t } = useI18n();

const tracksList = ref<any[]>([]);
const isLoadingTracks = ref(false);
const isUploadingTrack = ref(false);
const showAdvancedSettings = ref(false);

const newTrackParams = ref({
    type: "",
    purpose: "",
    quality: "",
    priority: 0,
    variant_key: "",
    is_default: false,
    display_name: "",
    language: "none",
    codec: "",
    metadata: {
        format: "vtt",
    } as Record<string, any>,
});

// Watch purpose to enforce constraints, defaults and force type to IMAGE when purpose is COVER or THUMBNAIL
watch(
    () => newTrackParams.value.purpose,
    (newPurpose) => {
        if (!newPurpose) {
            newTrackParams.value.type = "";
            newTrackParams.value.quality = "";
        } else {
            if (newPurpose === "COVER" || newPurpose === "THUMBNAIL") {
                newTrackParams.value.type = "IMAGE";
            } else if (!newTrackParams.value.type || newTrackParams.value.type === "IMAGE") {
                newTrackParams.value.type = "VIDEO";
            }
            if (!newTrackParams.value.quality) {
                newTrackParams.value.quality = "ORIGINAL";
            }
        }
    },
);

const editingTrackId = ref<string | null>(null);
const editParams = ref({
    display_name: "",
    variant_key: "",
    purpose: "",
    codec: "",
    language: "none",
    priority: 0,
    quality: "",
});

const startEditingTrack = (item: any) => {
    editingTrackId.value = item.id;
    editParams.value = {
        display_name: item.display_name || "",
        variant_key: item.variant_key || "",
        purpose: item.purpose || "",
        codec: item.codec || "",
        language: item.language || "none",
        priority: item.priority || 0,
        quality: item.quality || "",
    };
};

const cancelEditingTrack = () => {
    setTimeout(() => {
        editingTrackId.value = null;
    }, 0);
};

const saveEditingTrack = async (trackId: string) => {
    if (!props.mediaId) return;
    try {
        const body = {
            display_name: editParams.value.display_name.trim() || null,
            variant_key: editParams.value.variant_key.trim() || undefined,
            purpose: editParams.value.purpose || undefined,
            codec: editParams.value.codec.trim() || null,
            language: editParams.value.language && editParams.value.language !== "none" ? editParams.value.language.trim() || null : null,
            priority: editParams.value.priority,
            quality: editParams.value.quality || undefined,
        };
        const res = await useApi<{ success: boolean }>(`/media/${props.mediaId}/tracks/${trackId}/update`, {
            method: "POST",
            body,
        });
        if (res && res.success) {
            toast.success("Track updated successfully");
            editingTrackId.value = null;
            await fetchTracks();
            store.refetchMedia();
        } else {
            throw new Error("Failed to update track");
        }
    } catch (err: any) {
        console.error("Update track error:", err);
        toast.error(err.message || "Failed to update track");
    }
};

const isUploadDisabled = computed(() => {
    return !newTrackParams.value.purpose || !newTrackParams.value.type || !newTrackParams.value.quality || isUploadingTrack.value;
});

const groupedTracks = computed(() => {
    const groups = {
        images: [] as any[],
        videos: [] as any[],
        covers: [] as any[],
        audios: [] as any[],
        subtitles: [] as any[],
        others: [] as any[],
    };

    for (const item of tracksList.value) {
        if (item.type === "IMAGE" && item.purpose === "CONTENT") {
            groups.images.push(item);
        } else if (item.type === "VIDEO" && item.purpose === "CONTENT") {
            groups.videos.push(item);
        } else if (item.purpose === "COVER" || item.purpose === "THUMBNAIL") {
            groups.covers.push(item);
        } else if (item.type === "AUDIO") {
            groups.audios.push(item);
        } else if (item.type === "SUBTITLE") {
            groups.subtitles.push(item);
        } else {
            groups.others.push(item);
        }
    }
    return groups;
});

const fetchTracks = async () => {
    if (!props.mediaId) return;
    isLoadingTracks.value = true;
    try {
        const res = await useApi<{ success: boolean; data: any[] }>(`/media/${props.mediaId}/tracks`);
        if (res && res.success) {
            tracksList.value = res.data;
        }
    } catch (err) {
        console.error("Failed to fetch tracks:", err);
    } finally {
        isLoadingTracks.value = false;
    }
};

watch(
    () => props.mediaId,
    (newId) => {
        tracksList.value = [];
        if (newId) {
            fetchTracks();
        }
    },
    { immediate: true },
);

const calculateAspectRatio = (w: number, h: number): string => {
    if (!w || !h) return "";
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const divisor = gcd(w, h);
    const aspectX = w / divisor;
    const aspectY = h / divisor;

    if (aspectX === 16 && aspectY === 9) return "16:9";
    if (aspectX === 9 && aspectY === 16) return "9:16";
    if (aspectX === 4 && aspectY === 3) return "4:3";
    if (aspectX === 3 && aspectY === 4) return "3:4";
    if (aspectX === 1 && aspectY === 1) return "1:1";
    if (aspectX === 21 && aspectY === 9) return "21:9";
    if (aspectX === 9 && aspectY === 21) return "9:21";
    if (aspectX === 2 && aspectY === 3) return "2:3";
    if (aspectX === 3 && aspectY === 2) return "3:2";
    if (aspectX === 4 && aspectY === 5) return "4:5";
    if (aspectX === 5 && aspectY === 4) return "5:4";

    const val = (w / h).toFixed(2);
    return `${parseFloat(val).toString()}:1`;
};

const getFileMetadata = (file: File): Promise<{ width?: number; height?: number; duration?: number }> => {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        if (file.type.startsWith("image/")) {
            const img = new Image();
            img.onload = () => {
                resolve({ width: img.naturalWidth, height: img.naturalHeight });
                URL.revokeObjectURL(url);
            };
            img.onerror = () => {
                resolve({});
                URL.revokeObjectURL(url);
            };
            img.src = url;
        } else if (file.type.startsWith("video/")) {
            const video = document.createElement("video");
            video.preload = "metadata";
            video.onloadedmetadata = () => {
                resolve({
                    width: video.videoWidth,
                    height: video.videoHeight,
                    duration: video.duration,
                });
                URL.revokeObjectURL(url);
            };
            video.onerror = () => {
                resolve({});
                URL.revokeObjectURL(url);
            };
            video.src = url;
        } else {
            resolve({});
        }
    });
};

const detectTrackType = (file: File): "VIDEO" | "IMAGE" | "AUDIO" | "SUBTITLE" => {
    if (file.type) {
        if (file.type.startsWith("video/")) return "VIDEO";
        if (file.type.startsWith("image/")) return "IMAGE";
        if (file.type.startsWith("audio/")) return "AUDIO";
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext) {
        if (["mp4", "webm", "mov", "mkv", "avi", "3gp", "flv"].includes(ext)) return "VIDEO";
        if (["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "jxl"].includes(ext)) return "IMAGE";
        if (["mp3", "m4a", "wav", "flac", "aac", "ogg"].includes(ext)) return "AUDIO";
        if (["vtt", "srt", "ass"].includes(ext)) return "SUBTITLE";
    }
    return "SUBTITLE";
};

const handleUploadTrack = async (
    event: Event,
    customParams?: {
        type: string;
        purpose: string;
        quality: string;
        priority: number;
        variant_key?: string;
        is_default?: boolean;
        display_name?: string;
        language?: string | null;
        codec?: string | null;
        metadata?: any;
    },
    replaceTrackId?: string,
) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file || !props.mediaId) return;

    isUploadingTrack.value = true;
    try {
        const metadata = await getFileMetadata(file);

        const detectedType = detectTrackType(file);

        const params = customParams || {
            type: detectedType,
            purpose: "CONTENT",
            quality: "ORIGINAL",
            priority: 0,
            variant_key: "",
            is_default: false,
            display_name: "",
            language: "none",
            codec: "",
            metadata: {},
        };

        if (customParams && !replaceTrackId) {
            customParams.type = detectedType;
        }

        const presignRes = await useApi<{
            success: boolean;
            data: { url: string; path: string; bucket: string; mime_type: string; extension: string };
        }>(`/media/${props.mediaId}/tracks/presign-upload`, {
            method: "POST",
            body: {
                type: params.type,
                purpose: params.purpose,
                quality: params.quality,
                priority: params.priority,
                fileName: file.name,
            },
        });

        if (!presignRes?.success || !presignRes?.data) {
            throw new Error("Failed to get upload signature");
        }

        const { url: uploadUrl, path, bucket, mime_type, extension } = presignRes.data;

        const uploadResponse = await fetch(uploadUrl, {
            method: "PUT",
            body: file,
            headers: {
                "Content-Type": mime_type,
            },
        });

        if (!uploadResponse.ok) {
            throw new Error("Failed to upload file to S3");
        }

        const mergedMetadata = {
            ...params.metadata,
            width: metadata.width || null,
            height: metadata.height || null,
            duration: metadata.duration || null,
        };

        const registerRes = replaceTrackId
            ? await useApi<{ success: boolean }>(`/media/${props.mediaId}/tracks/${replaceTrackId}/replace-file`, {
                  method: "POST",
                  body: {
                      file: {
                          path,
                          bucket,
                          mime_type,
                          extension,
                          size: file.size,
                          width: metadata.width || null,
                          height: metadata.height || null,
                          duration: metadata.duration || null,
                      },
                  },
              })
            : await useApi<{ success: boolean }>(`/media/${props.mediaId}/tracks/add-or-replace`, {
                  method: "POST",
                  body: {
                      type: params.type,
                      purpose: params.purpose,
                      quality: params.quality,
                      priority: params.priority,
                      variant_key: params.variant_key || undefined,
                      is_default: params.is_default || undefined,
                      display_name: params.display_name || undefined,
                      language: params.language && params.language !== "none" ? params.language : undefined,
                      codec: params.codec || undefined,
                      metadata: mergedMetadata,
                      file: {
                          path,
                          bucket,
                          mime_type,
                          extension,
                          size: file.size,
                          width: metadata.width || null,
                          height: metadata.height || null,
                          duration: metadata.duration || null,
                      },
                  },
              });

        if (registerRes?.success) {
            toast.success(replaceTrackId ? "File replaced successfully" : "Track uploaded and registered successfully");
            await fetchTracks();
            store.refetchMedia();
        } else {
            throw new Error(replaceTrackId ? "Failed to replace file in database" : "Failed to register track in database");
        }
    } catch (err: any) {
        console.error("Upload error:", err);
        toast.error(err.message || "Failed to upload track");
    } finally {
        isUploadingTrack.value = false;
        target.value = "";
    }
};

const handleDeleteTrack = async (trackId: string) => {
    if (!props.mediaId || !confirm("Are you sure you want to delete this track? This will also remove the associated S3 file.")) return;
    try {
        const res = await useApi<{ success: boolean }>(`/media/${props.mediaId}/tracks/${trackId}/delete`, {
            method: "POST",
        });
        if (res && res.success) {
            toast.success("Track deleted successfully");
            await fetchTracks();
            store.refetchMedia();
        } else {
            throw new Error("Failed to delete track");
        }
    } catch (err: any) {
        console.error("Delete track error:", err);
        toast.error(err.message || "Failed to delete track");
    }
};

const handleSetDefault = async (trackId: string) => {
    if (!props.mediaId) return;
    try {
        const res = await useApi<{ success: boolean }>(`/media/${props.mediaId}/tracks/${trackId}/update`, {
            method: "POST",
            body: { is_default: true },
        });
        if (res && res.success) {
            toast.success("Default variant updated successfully");
            await fetchTracks();
            store.refetchMedia();
        } else {
            throw new Error("Failed to set default track");
        }
    } catch (err: any) {
        console.error("Set default track error:", err);
        toast.error(err.message || "Failed to set default track");
    }
};

const formatFileSize = (bytes: number | null | undefined): string => {
    if (bytes === null || bytes === undefined) return "-";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const getFriendlyLanguage = (lang?: string | null) => {
    if (!lang) return "";
    const l = lang.toLowerCase().replace(/_/g, "-");
    if (l.startsWith("zh-cn")) return "简体中文";
    if (l.startsWith("zh-tw") || l.startsWith("zh-hk")) return "繁體中文";
    if (l.startsWith("en")) return "English";
    if (l.startsWith("ja")) return "日本語";
    if (l.startsWith("ko")) return "한국어";
    return lang;
};

const getFriendlyCodec = (codec?: string | null) => {
    if (!codec) return "";
    const c = codec.toLowerCase();
    if (c.includes("hvc") || c.includes("h265") || c.includes("h.265")) return "H.265 / HEVC";
    if (c.includes("avc") || c.includes("h264") || c.includes("h.264")) return "H.264 / AVC";
    if (c.includes("mp4a") || c.includes("aac")) return "AAC";
    if (c.includes("opus")) return "Opus";
    if (c.includes("vp9")) return "VP9";
    if (c.includes("av1")) return "AV1";
    return codec.toUpperCase();
};

const handleVideoMouseEnter = (e: Event) => {
    const video = e.target as HTMLVideoElement;
    if (video) {
        video.play().catch(() => {});
    }
};

const handleVideoMouseLeave = (e: Event) => {
    const video = e.target as HTMLVideoElement;
    if (video) {
        video.pause();
        video.currentTime = 0;
    }
};
</script>

<template>
    <div class="flex flex-col h-full overflow-hidden bg-white text-zinc-800">
        <!-- Scrollable Tracks Section -->
        <div class="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar">
            <div v-if="isLoadingTracks" class="flex flex-col items-center justify-center py-16 text-zinc-500">
                <Loader2 class="w-5 h-5 animate-spin mb-2 text-zinc-400" />
                <span class="text-xs">Loading tracks...</span>
            </div>
            <div v-else-if="tracksList.length === 0" class="text-center py-16 text-zinc-550 text-xs italic">
                No tracks configured for this media item.
            </div>
            <div v-else class="space-y-6">
                <template
                    v-for="group in [
                        { name: 'Images / 图片主体', icon: ImageIcon, items: groupedTracks.images },
                        { name: 'Videos / 视频主体', icon: VideoIcon, items: groupedTracks.videos },
                        { name: 'Covers & Thumbnails / 封面与缩略图', icon: FileImage, items: groupedTracks.covers },
                        { name: 'Audio Tracks / 独立音轨', icon: Music, items: groupedTracks.audios },
                        { name: 'Subtitles & Lyrics / 字幕与歌词', icon: FileText, items: groupedTracks.subtitles },
                        { name: 'Others / 其他轨道', icon: Layers, items: groupedTracks.others },
                    ]"
                    :key="group.name"
                >
                    <div v-if="group.items.length > 0" class="space-y-2.5">
                        <h3 class="text-xs font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5 px-1">
                            <component :is="group.icon" class="w-3.5 h-3.5 text-zinc-500" />
                            {{ group.name }}
                        </h3>
                        <div class="space-y-2.5">
                            <div
                                v-for="item in group.items"
                                :key="item.id"
                                class="group/track-card relative flex flex-col p-3 rounded-lg border transition-all duration-200 text-left bg-white"
                                :class="
                                    item.is_default
                                        ? 'border-zinc-300 shadow-2xs'
                                        : 'border-zinc-100 hover:border-zinc-200 hover:shadow-2xs'
                                "
                            >
                                <!-- Top Row: Preview & Primary Metadata -->
                                <div class="flex items-start gap-3">
                                    <!-- Visual Preview Thumbnail -->
                                    <div
                                        class="w-14 h-14 shrink-0 rounded-lg overflow-hidden bg-zinc-50 border border-zinc-150 flex items-center justify-center relative group/thumb select-none shadow-3xs self-start mt-0.5"
                                    >
                                        <HeicImage
                                            v-if="item.type === 'IMAGE' && item.file?.url"
                                            :src="getOptimizedImageUrl(item.file.url, { width: 120, height: 120, fit: 'cover' })"
                                            :mime-type="item.file.mime_type"
                                            class="w-full h-full object-cover"
                                        />
                                        <video
                                            v-else-if="item.type === 'VIDEO' && item.file?.url"
                                            :src="item.file.url"
                                            class="w-full h-full object-cover"
                                            muted
                                            preload="metadata"
                                            playsinline
                                            @mouseenter="handleVideoMouseEnter"
                                            @mouseleave="handleVideoMouseLeave"
                                        />
                                        <div
                                            v-if="item.type === 'VIDEO'"
                                            class="absolute inset-0 bg-black/10 flex items-center justify-center pointer-events-none group-hover/thumb:opacity-0 transition-opacity"
                                        >
                                            <Play class="w-4 h-4 text-white drop-shadow-sm fill-white" />
                                        </div>
                                        <div
                                            v-else-if="item.type === 'AUDIO'"
                                            class="w-full h-full bg-indigo-50/50 flex items-center justify-center"
                                        >
                                            <Music class="w-5 h-5 text-indigo-550" />
                                        </div>
                                        <div
                                            v-else-if="item.type === 'SUBTITLE'"
                                            class="w-full h-full bg-amber-50/50 flex items-center justify-center"
                                        >
                                            <FileText class="w-5 h-5 text-amber-700" />
                                        </div>
                                        <div v-if="!item.file?.url" class="w-full h-full bg-zinc-50 flex items-center justify-center">
                                            <FileImage class="w-5 h-5 text-zinc-500" />
                                        </div>
                                    </div>

                                    <!-- Main Title & Key & Default Status -->
                                    <div class="flex-1 min-w-0 flex flex-col justify-center">
                                        <div class="flex items-center gap-1.5 flex-wrap">
                                            <span class="text-sm font-semibold text-zinc-950 truncate">
                                                {{ item.display_name || item.variant_key || item.type }}
                                            </span>
                                            <span
                                                v-if="item.is_default"
                                                class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-250/30"
                                            >
                                                Default
                                            </span>
                                            <span
                                                v-if="item.is_stale"
                                                class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-250/30 animate-pulse"
                                            >
                                                Out of Sync
                                            </span>
                                        </div>

                                        <!-- Parameter List Key-Values (Aligned grid layout) -->
                                        <div v-if="editingTrackId !== item.id" class="flex flex-col gap-1.5 mt-2 text-xs">
                                            <div class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none">Purpose</span>
                                                <span class="text-zinc-800 uppercase font-semibold">{{ item.purpose }}</span>
                                            </div>
                                            <div class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none">Quality</span>
                                                <span class="text-zinc-800 font-semibold">{{
                                                    $t("media.quality." + item.quality?.toLowerCase(), item.quality)
                                                }}</span>
                                            </div>
                                            <div v-if="item.language" class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none">Language</span>
                                                <span class="text-zinc-800 font-semibold">{{ getFriendlyLanguage(item.language) }}</span>
                                            </div>
                                            <div v-if="item.codec" class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal font-sans select-none">Codec</span>
                                                <span class="text-zinc-800 font-semibold font-mono text-[11px]">{{
                                                    getFriendlyCodec(item.codec)
                                                }}</span>
                                            </div>
                                            <div v-if="item.file?.size" class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none">File Size</span>
                                                <span class="text-zinc-800 font-semibold">{{ formatFileSize(item.file?.size) }}</span>
                                            </div>
                                            <div v-if="item.file?.mime_type" class="flex items-start">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none mt-0.5">Format</span>
                                                <span
                                                    class="text-zinc-700 font-mono text-[10px] bg-zinc-50/85 px-1.5 py-0.5 rounded border border-zinc-200/50 break-all select-all leading-tight"
                                                >
                                                    {{ item.file.mime_type }}
                                                </span>
                                            </div>
                                            <div v-if="item.file?.width && item.file?.height" class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none">Resolution</span>
                                                <span class="text-zinc-800 font-semibold">
                                                    {{ item.file.width }} × {{ item.file.height }}
                                                    <span class="text-zinc-400 font-normal text-[11px]"
                                                        >({{ calculateAspectRatio(item.file.width, item.file.height) }})</span
                                                    >
                                                </span>
                                            </div>
                                            <div v-if="item.file?.duration" class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none">Duration</span>
                                                <span class="text-zinc-800 font-semibold">{{ item.file.duration }}s</span>
                                            </div>
                                            <div class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none">Origin</span>
                                                <span
                                                    class="font-semibold"
                                                    :class="item.is_generated ? 'text-zinc-700' : 'text-indigo-650'"
                                                >
                                                    {{ item.is_generated ? "Generated" : "Manual" }}
                                                </span>
                                            </div>
                                            <div v-if="item.variant_key && item.display_name" class="flex items-center">
                                                <span class="w-20 shrink-0 text-zinc-500 font-normal select-none">Variant Key</span>
                                                <span
                                                    class="font-mono text-[10px] text-zinc-650 bg-zinc-50 px-1 py-0.5 rounded border border-zinc-150/40"
                                                    >{{ item.variant_key }}</span
                                                >
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- EDIT MODE FORM -->
                                <div v-if="editingTrackId === item.id" class="space-y-3 mt-3 text-xs border-t border-zinc-100 pt-3">
                                    <div class="grid grid-cols-2 gap-3">
                                        <div class="space-y-1">
                                            <Label class="text-[10px] text-zinc-550 uppercase font-bold tracking-wider">Display Name</Label>
                                            <Input
                                                v-model="editParams.display_name"
                                                class="h-8 text-xs border-zinc-200 rounded-lg bg-white text-zinc-800"
                                                placeholder="Optional display name"
                                            />
                                        </div>
                                        <div class="space-y-1">
                                            <Label class="text-[10px] text-zinc-550 uppercase font-bold tracking-wider">Variant Key</Label>
                                            <Input
                                                v-model="editParams.variant_key"
                                                class="h-8 text-xs border-zinc-200 rounded-lg bg-white text-zinc-800"
                                                placeholder="e.g. original-video"
                                            />
                                        </div>
                                        <div class="space-y-1">
                                            <Label class="text-[10px] text-zinc-550 uppercase font-bold tracking-wider">Purpose</Label>
                                            <Select v-model="editParams.purpose">
                                                <SelectTrigger class="h-8 border-zinc-200 rounded-lg bg-white text-xs text-zinc-800">
                                                    <SelectValue placeholder="Select purpose" />
                                                </SelectTrigger>
                                                <SelectContent class="z-[300] bg-white border border-zinc-200 text-zinc-800">
                                                    <SelectItem value="CONTENT">Content</SelectItem>
                                                    <SelectItem value="COVER">Cover</SelectItem>
                                                    <SelectItem value="THUMBNAIL">Thumbnail</SelectItem>
                                                    <SelectItem value="PREVIEW">Preview</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div class="space-y-1">
                                            <Label class="text-[10px] text-zinc-550 uppercase font-bold tracking-wider">Quality</Label>
                                            <Select v-model="editParams.quality">
                                                <SelectTrigger class="h-8 border-zinc-200 rounded-lg bg-white text-xs text-zinc-800">
                                                    <SelectValue placeholder="Select quality" />
                                                </SelectTrigger>
                                                <SelectContent class="z-[300] bg-white border border-zinc-200 text-zinc-800">
                                                    <SelectItem value="ORIGINAL">Original</SelectItem>
                                                    <SelectItem value="HIGH">High</SelectItem>
                                                    <SelectItem value="MEDIUM">Medium</SelectItem>
                                                    <SelectItem value="LOW">Low</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div class="space-y-1">
                                            <Label class="text-[10px] text-zinc-550 uppercase font-bold tracking-wider">Language</Label>
                                            <Select v-model="editParams.language">
                                                <SelectTrigger class="h-8 border-zinc-200 rounded-lg bg-white text-xs text-zinc-800">
                                                    <SelectValue placeholder="Select language" />
                                                </SelectTrigger>
                                                <SelectContent class="z-[300] bg-white border border-zinc-200 text-zinc-800">
                                                    <SelectItem value="zh-CN">简体中文 (zh-CN)</SelectItem>
                                                    <SelectItem value="zh-TW">繁體中文 (zh-TW)</SelectItem>
                                                    <SelectItem value="en">English (en)</SelectItem>
                                                    <SelectItem value="ja">Japanese (ja)</SelectItem>
                                                    <SelectItem value="ko">Korean (ko)</SelectItem>
                                                    <SelectItem value="none">None / Unknown</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div class="space-y-1">
                                            <Label class="text-[10px] text-zinc-550 uppercase font-bold tracking-wider"
                                                >Codec / Encoding</Label
                                            >
                                            <Input
                                                v-model="editParams.codec"
                                                class="h-8 text-xs border-zinc-200 rounded-lg bg-white text-zinc-800"
                                                placeholder="e.g. h264, hevc"
                                            />
                                        </div>
                                        <div class="space-y-1 col-span-2">
                                            <Label class="text-[10px] text-zinc-550 uppercase font-bold tracking-wider"
                                                >Priority Rank</Label
                                            >
                                            <Input
                                                type="number"
                                                v-model.number="editParams.priority"
                                                min="0"
                                                class="h-8 text-xs border-zinc-200 rounded-lg bg-white text-zinc-800"
                                            />
                                        </div>
                                    </div>
                                    <div class="flex justify-end gap-2 pt-2">
                                        <button
                                            @click="cancelEditingTrack"
                                            class="px-3 py-1.5 text-xs font-semibold border border-zinc-200 rounded-lg hover:bg-zinc-50 text-zinc-700 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            @click="saveEditingTrack(item.id)"
                                            class="px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg shadow-sm transition-colors"
                                        >
                                            Save Changes
                                        </button>
                                    </div>
                                </div>

                                <!-- Action row at bottom of card -->
                                <div
                                    v-if="editingTrackId !== item.id"
                                    class="mt-3 pt-2.5 border-t border-zinc-100 flex items-center justify-between gap-3 text-xs text-zinc-500"
                                >
                                    <button
                                        v-if="!item.is_default"
                                        @click="handleSetDefault(item.id)"
                                        class="px-2.5 py-1 rounded-md text-[10px] font-semibold bg-zinc-50 hover:bg-zinc-100 active:bg-zinc-200/80 border border-zinc-200 text-zinc-700 transition-all cursor-pointer select-none active:scale-[0.98] transform flex items-center gap-1"
                                        title="Set as Default"
                                    >
                                        Set Default
                                    </button>
                                    <div class="flex items-center gap-1.5 ml-auto">
                                        <button
                                            @click="startEditingTrack(item)"
                                            class="p-1.5 rounded-md text-zinc-500 hover:text-zinc-800 hover:bg-zinc-55 border border-transparent hover:border-zinc-200/50 transition-all cursor-pointer flex items-center justify-center bg-white hover:shadow-3xs active:scale-95 duration-150"
                                            title="Edit properties"
                                        >
                                            <Pencil class="w-3.5 h-3.5" />
                                        </button>
                                        <label
                                            class="p-1.5 rounded-md text-zinc-500 hover:text-zinc-800 hover:bg-zinc-55 border border-transparent hover:border-zinc-200/50 transition-all cursor-pointer flex items-center justify-center bg-white hover:shadow-3xs active:scale-95 duration-150"
                                            title="Replace file"
                                        >
                                            <Upload class="w-3.5 h-3.5" />
                                            <input
                                                type="file"
                                                class="hidden"
                                                @change="
                                                    handleUploadTrack(
                                                        $event,
                                                        {
                                                            type: item.type,
                                                            purpose: item.purpose,
                                                            quality: item.quality,
                                                            priority: item.priority,
                                                        },
                                                        item.id,
                                                    )
                                                "
                                            />
                                        </label>
                                        <a
                                            v-if="item.file?.url"
                                            :href="item.file.url"
                                            target="_blank"
                                            class="p-1.5 rounded-md text-zinc-500 hover:text-zinc-800 hover:bg-zinc-55 border border-transparent hover:border-zinc-200/50 transition-all flex items-center justify-center bg-white hover:shadow-3xs active:scale-95 duration-150"
                                            title="Open original file"
                                        >
                                            <LinkIcon class="w-3.5 h-3.5" />
                                        </a>
                                        <button
                                            @click="handleDeleteTrack(item.id)"
                                            class="p-1.5 rounded-md text-zinc-500 hover:text-red-750 hover:bg-red-50/50 border border-transparent hover:border-red-150 transition-all cursor-pointer flex items-center justify-center bg-white hover:shadow-3xs active:scale-95 duration-150"
                                            title="Delete track"
                                        >
                                            <Trash2 class="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </template>
            </div>
        </div>

        <!-- Add Custom Variant Form (Footer Section) -->
        <div class="p-5 border-t border-zinc-100 bg-zinc-50/30 space-y-4 shrink-0 text-left overflow-y-auto max-h-[340px]">
            <h4 class="text-[11px] font-bold text-zinc-550 uppercase tracking-wider flex items-center gap-1.5">
                <Plus class="w-3.5 h-3.5 text-zinc-500" /> Add Custom Variant
            </h4>

            <div class="grid grid-cols-2 gap-3 text-xs">
                <!-- Purpose Selection (PRIORITIZED) -->
                <div class="space-y-1">
                    <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Purpose</Label>
                    <Select v-model="newTrackParams.purpose">
                        <SelectTrigger
                            class="w-full h-9 border-zinc-200 rounded-xl bg-white focus:ring-2 focus:ring-zinc-500/20 focus:border-zinc-500 transition-all text-xs text-zinc-800"
                        >
                            <SelectValue placeholder="Select purpose" />
                        </SelectTrigger>
                        <SelectContent class="z-[300] bg-white border border-zinc-200 text-zinc-800">
                            <SelectItem value="CONTENT">Content</SelectItem>
                            <SelectItem value="COVER">Cover</SelectItem>
                            <SelectItem value="THUMBNAIL">Thumbnail</SelectItem>
                            <SelectItem value="PREVIEW">Preview</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <!-- Type Selection -->
                <div class="space-y-1">
                    <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Type</Label>
                    <Select v-model="newTrackParams.type" :disabled="!newTrackParams.purpose">
                        <SelectTrigger
                            class="w-full h-9 border-zinc-200 rounded-xl bg-white focus:ring-2 focus:ring-zinc-500/20 focus:border-zinc-500 transition-all text-xs text-zinc-800"
                        >
                            <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent class="z-[300] bg-white border border-zinc-200 text-zinc-800">
                            <SelectItem value="IMAGE">Image</SelectItem>
                            <SelectItem v-if="newTrackParams.purpose !== 'COVER' && newTrackParams.purpose !== 'THUMBNAIL'" value="VIDEO"
                                >Video</SelectItem
                            >
                            <SelectItem v-if="newTrackParams.purpose !== 'COVER' && newTrackParams.purpose !== 'THUMBNAIL'" value="AUDIO"
                                >Audio</SelectItem
                            >
                            <SelectItem v-if="newTrackParams.purpose !== 'COVER' && newTrackParams.purpose !== 'THUMBNAIL'" value="SUBTITLE"
                                >Subtitle</SelectItem
                            >
                        </SelectContent>
                    </Select>
                </div>

                <!-- Quality Selection -->
                <div class="space-y-1">
                    <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">{{
                        $t("media.quality_label", "Quality")
                    }}</Label>
                    <Select v-model="newTrackParams.quality" :disabled="!newTrackParams.purpose">
                        <SelectTrigger
                            class="w-full h-9 border-zinc-200 rounded-xl bg-white focus:ring-2 focus:ring-zinc-500/20 focus:border-zinc-500 transition-all text-xs text-zinc-800"
                        >
                            <SelectValue placeholder="Select quality" />
                        </SelectTrigger>
                        <SelectContent class="z-[300] bg-white border border-zinc-200 text-zinc-800">
                            <SelectItem value="ORIGINAL">{{ $t("media.quality.original", "Original") }}</SelectItem>
                            <SelectItem value="HIGH">{{ $t("media.quality.high", "High") }}</SelectItem>
                            <SelectItem value="MEDIUM">{{ $t("media.quality.medium", "Medium") }}</SelectItem>
                            <SelectItem value="LOW">{{ $t("media.quality.low", "Low") }}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <!-- Is Default Checkbox -->
                <div class="flex items-center gap-2 pb-2.5 mt-auto">
                    <Checkbox
                        id="is-default-variant"
                        :checked="newTrackParams.is_default"
                        @update:checked="newTrackParams.is_default = $event"
                        :disabled="!newTrackParams.purpose"
                        class="border-zinc-300 data-[state=checked]:bg-zinc-900 data-[state=checked]:border-zinc-900 focus-visible:ring-zinc-900"
                    />
                    <Label
                        for="is-default-variant"
                        class="text-xs font-semibold text-zinc-700 cursor-pointer select-none"
                        :class="{ 'opacity-50 cursor-not-allowed': !newTrackParams.purpose }"
                    >
                        Is Default Variant
                    </Label>
                </div>

                <!-- Dynamic Field: Subtitle format (Subtitle only) -->
                <div v-if="newTrackParams.type === 'SUBTITLE'" class="space-y-1">
                    <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Format</Label>
                    <Select v-model="newTrackParams.metadata.format" :disabled="!newTrackParams.purpose">
                        <SelectTrigger
                            class="w-full h-9 border-zinc-200 rounded-xl bg-white focus:ring-2 focus:ring-zinc-500/20 focus:border-zinc-500 transition-all text-xs text-zinc-800"
                        >
                            <SelectValue placeholder="Select format" />
                        </SelectTrigger>
                        <SelectContent class="z-[300] bg-white border border-zinc-200 text-zinc-800">
                            <SelectItem value="vtt">WebVTT (.vtt)</SelectItem>
                            <SelectItem value="srt">SubRip (.srt)</SelectItem>
                            <SelectItem value="lrc">Lrc Lyrics (.lrc)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <!-- Dynamic Field: Language Selection (Subtitle/Audio only) -->
                <div v-if="['SUBTITLE', 'AUDIO'].includes(newTrackParams.type)" class="space-y-1">
                    <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Language</Label>
                    <Select v-model="newTrackParams.language" :disabled="!newTrackParams.purpose">
                        <SelectTrigger
                            class="w-full h-9 border-zinc-200 rounded-xl bg-white focus:ring-2 focus:ring-zinc-500/20 focus:border-zinc-500 transition-all text-xs text-zinc-800"
                        >
                            <SelectValue placeholder="Select language" />
                        </SelectTrigger>
                        <SelectContent class="z-[300] bg-white border border-zinc-200 text-zinc-800">
                            <SelectItem value="zh-CN">简体中文 (zh-CN)</SelectItem>
                            <SelectItem value="zh-TW">繁體中文 (zh-TW)</SelectItem>
                            <SelectItem value="en">English (en)</SelectItem>
                            <SelectItem value="ja">Japanese (ja)</SelectItem>
                            <SelectItem value="ko">Korean (ko)</SelectItem>
                            <SelectItem value="none">None / Unknown</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <!-- Dynamic Field: Codec (Video/Audio only) -->
                <div v-if="['VIDEO', 'AUDIO'].includes(newTrackParams.type)" class="space-y-1">
                    <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Codec / Encoding</Label>
                    <Input
                        type="text"
                        v-model="newTrackParams.codec"
                        :disabled="!newTrackParams.purpose"
                        placeholder="e.g. h264, hevc, aac"
                        class="w-full h-9 border-zinc-200 rounded-xl bg-white outline-none focus:ring-2 focus:ring-zinc-550/20 focus:border-zinc-500 transition-all text-xs text-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                </div>
            </div>

            <!-- Advanced Settings Collapsible -->
            <div class="border-t border-zinc-200/50 pt-3">
                <button
                    type="button"
                    @click="newTrackParams.purpose && (showAdvancedSettings = !showAdvancedSettings)"
                    :disabled="!newTrackParams.purpose"
                    class="text-[10px] font-bold text-zinc-500 hover:text-zinc-700 uppercase tracking-wider flex items-center gap-1 transition-colors cursor-pointer select-none"
                    :class="{ 'opacity-50 cursor-not-allowed': !newTrackParams.purpose }"
                >
                    <span>{{ showAdvancedSettings ? "▼" : "▶" }} Advanced Settings</span>
                </button>
                <div v-if="showAdvancedSettings && newTrackParams.purpose" class="grid grid-cols-2 gap-3 mt-3">
                    <div class="space-y-1">
                        <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Priority Rank</Label>
                        <Input
                            type="number"
                            v-model.number="newTrackParams.priority"
                            :disabled="!newTrackParams.purpose"
                            min="0"
                            class="w-full h-9 border-zinc-200 rounded-xl bg-white outline-none focus:ring-2 focus:ring-zinc-550/20 focus:border-zinc-500 transition-all text-xs text-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                    </div>
                    <div class="space-y-1">
                        <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Variant Key</Label>
                        <Input
                            type="text"
                            v-model="newTrackParams.variant_key"
                            :disabled="!newTrackParams.purpose"
                            placeholder="Auto-generated"
                            class="w-full h-9 border-zinc-200 rounded-xl bg-white outline-none focus:ring-2 focus:ring-zinc-550/20 focus:border-zinc-500 transition-all text-xs text-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                    </div>
                    <div class="space-y-1 col-span-2">
                        <Label class="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Display Name</Label>
                        <Input
                            type="text"
                            v-model="newTrackParams.display_name"
                            :disabled="!newTrackParams.purpose"
                            placeholder="Optional label"
                            class="w-full h-9 border-zinc-200 rounded-xl bg-white outline-none focus:ring-2 focus:ring-zinc-550/20 focus:border-zinc-500 transition-all text-xs text-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                    </div>
                </div>
            </div>

            <!-- Upload & Register Button -->
            <label
                class="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold uppercase tracking-wider rounded-xl transition-all select-none transform cursor-pointer"
                :class="
                    isUploadDisabled
                        ? 'bg-zinc-100 text-zinc-400 border border-zinc-200 pointer-events-none cursor-not-allowed'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.99] shadow-xs'
                "
            >
                <span v-if="isUploadingTrack" class="flex items-center gap-2">
                    <Loader2 class="w-3.5 h-3.5 animate-spin" /> Uploading...
                </span>
                <span v-else class="flex items-center gap-2"> <Upload class="w-3.5 h-3.5" /> Upload & Register File </span>
                <input type="file" class="hidden" @change="handleUploadTrack($event, newTrackParams)" :disabled="isUploadDisabled" />
            </label>
        </div>
    </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}

.custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
    background-color: rgba(0, 0, 0, 0.1);
    border-radius: 10px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: rgba(0, 0, 0, 0.2);
}
</style>
