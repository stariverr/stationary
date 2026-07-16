import { defineStore } from "pinia";
import { ref } from "vue";
import { useApi } from "@/composables/useApi";

export interface DraftFileItem {
    id: string;
    file_id: string;
    name: string;
    size: number;
    mime_type: string;
    url: string;
    create_time: string;
}

export interface UploadQueueItem {
    id: string;
    name: string;
    size: number;
    progress: number;
    status: "pending" | "uploading" | "success" | "error";
    error?: string;
}

export const useImportStore = defineStore("import", () => {
    const draftFiles = ref<DraftFileItem[]>([]);
    const uploadQueue = ref<UploadQueueItem[]>([]);
    const isLoadingDrafts = ref(false);
    const isTrayOpen = ref(false);
    const isMinimized = ref(false);

    const fetchDraftFiles = async (libraryId: string) => {
        if (!libraryId) return;
        isLoadingDrafts.value = true;
        try {
            const response = await useApi<{ success: boolean; data: DraftFileItem[] }>(`/import/draft/files?library_id=${libraryId}`);
            if (response && response.success) {
                draftFiles.value = response.data;
            }
        } catch (e) {
            console.error("Failed to fetch draft files:", e);
        } finally {
            isLoadingDrafts.value = false;
        }
    };

    const uploadFile = async (libraryId: string, file: File): Promise<DraftFileItem> => {
        const queueId = crypto.randomUUID();
        const queueItem = ref<UploadQueueItem>({
            id: queueId,
            name: file.name,
            size: file.size,
            progress: 0,
            status: "pending",
        });
        uploadQueue.value.push(queueItem.value);
        isTrayOpen.value = true;

        try {
            // 1. Get S3 Presigned URL
            queueItem.value.status = "uploading";
            const presignRes = await useApi<{
                success: boolean;
                data: { url: string; path: string; bucket: string; mime_type: string; upload_token: string; draft_file_id: string };
            }>("/import/draft/presign", {
                method: "POST",
                body: { library_id: libraryId, fileName: file.name },
            });

            if (!presignRes || !presignRes.success) {
                throw new Error("Failed to get presigned URL");
            }

            const { url, path, bucket, mime_type, upload_token, draft_file_id } = presignRes.data;

            // Extract basic dimensions for images/videos in browser
            let width: number | null = null;
            let height: number | null = null;
            let duration: number | null = null;

            if (file.type.startsWith("image/")) {
                try {
                    const img = new Image();
                    img.src = URL.createObjectURL(file);
                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                    });
                    width = img.width;
                    height = img.height;
                    URL.revokeObjectURL(img.src);
                } catch (err) {
                    console.warn("Failed to read image dimensions:", err);
                }
            } else if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
                try {
                    const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
                    media.src = URL.createObjectURL(file);
                    await new Promise((resolve, reject) => {
                        media.onloadedmetadata = () => {
                            if (media instanceof HTMLVideoElement) {
                                width = media.videoWidth;
                                height = media.videoHeight;
                            }
                            duration = media.duration;
                            resolve(null);
                        };
                        media.onerror = reject;
                    });
                    URL.revokeObjectURL(media.src);
                } catch (err) {
                    console.warn("Failed to read video/audio metadata:", err);
                }
            }

            // 2. Perform S3 Upload using XMLHttpRequest to track progress
            await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("PUT", url);
                xhr.setRequestHeader("Content-Type", mime_type);

                xhr.upload.onprogress = (event) => {
                    if (event.lengthComputable) {
                        queueItem.value.progress = Math.round((event.loaded / event.total) * 100);
                    }
                };

                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(null);
                    } else {
                        reject(new Error(`S3 upload failed with status ${xhr.status}`));
                    }
                };

                xhr.onerror = () => reject(new Error("Network error during S3 upload"));
                xhr.send(file);
            });

            // 3. Confirm upload
            const confirmRes = await useApi<{ success: boolean; data: DraftFileItem }>("/import/draft/confirm", {
                method: "POST",
                body: {
                    library_id: libraryId,
                    draft_file_id,
                    fileName: file.name,
                    path,
                    bucket,
                    mime_type,
                    size: file.size,
                    width,
                    height,
                    duration,
                    upload_token,
                },
            });

            if (!confirmRes || !confirmRes.success) {
                throw new Error("Failed to confirm upload");
            }

            queueItem.value.status = "success";
            queueItem.value.progress = 100;

            const draftFile = confirmRes.data;
            draftFiles.value = [draftFile, ...draftFiles.value.filter((item) => item.id !== draftFile.id)];
            return draftFile;
        } catch (e: unknown) {
            console.error("Upload error for file", file.name, e);
            queueItem.value.status = "error";
            queueItem.value.error = e instanceof Error ? e.message : String(e);
            throw e;
        }
    };

    const deleteDraftFile = async (libraryId: string, draftFileId: string) => {
        try {
            const res = await useApi<{ success: boolean }>(`/import/draft/files/${draftFileId}/delete`, {
                method: "POST",
            });
            if (res && res.success) {
                await fetchDraftFiles(libraryId);
            }
        } catch (e) {
            console.error("Failed to delete draft file:", e);
            throw e;
        }
    };

    const commitMedia = async (libraryId: string, payload: any) => {
        const res = await useApi<{ success: boolean; data: any }>("/import/draft/commit-media", {
            method: "POST",
            body: {
                library_id: libraryId,
                ...payload,
            },
        });
        if (res && res.success) {
            await fetchDraftFiles(libraryId);
            return res.data;
        }
        throw new Error("Failed to commit media");
    };

    return {
        draftFiles,
        uploadQueue,
        isLoadingDrafts,
        isTrayOpen,
        isMinimized,
        fetchDraftFiles,
        uploadFile,
        deleteDraftFile,
        commitMedia,
    };
});
