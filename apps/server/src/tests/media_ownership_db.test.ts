import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";
import {
    AvFile,
    AvStream,
    AvStreamType,
    File as DbFile,
    JobQueue,
    Library,
    Media,
    MediaCaption,
    MediaCover,
    MediaOriginal,
    MediaType,
    Post,
    PostSource,
    SourceErrorKind,
    SyncStatus,
} from "@/db/schema";
import { saveIngestMetadata } from "@/features/ingest/persistence";
import { refreshMediaSyncStatus } from "@/features/media/composition";
import { PostItemSchema } from "@/features/ingest/schema";
import { changeType, deleteCaption, deleteOriginal, MediaEditError, removeCover, retrySource, setCover } from "@/features/media/edit";
import { updateMediaInfo } from "@/features/media/update-info";
import { PostService } from "@/features/post/post-service";
import { db } from "@/global/db";

/**
 * Ownership of imported media and the editor's repairs (docs/failure_handling.zh-Hans.md, 8, 9.1): what the user
 * deletes, replaces or edits stays that way through later imports. Run with RUN_DOWNLOAD_DB_TESTS=1 and DB_URL pointing
 * at a disposable instance.
 */
const databaseTest = process.env.RUN_DOWNLOAD_DB_TESTS === "1" ? test : test.skip;

let libraryId = crypto.randomUUID();

afterEach(async () => {
    if (process.env.RUN_DOWNLOAD_DB_TESTS !== "1") return;
    const media = await db.select({ id: Media.id }).from(Media).where(eq(Media.library_id, libraryId));
    const mediaIds = media.map((row) => row.id);
    const posts = await db.select({ id: Post.id }).from(Post).where(eq(Post.library_id, libraryId));
    if (mediaIds.length > 0) {
        for (const table of [MediaOriginal, MediaCaption, MediaCover]) await db.delete(table).where(inArray(table.media_id, mediaIds));
    }
    await db.delete(JobQueue).where(inArray(JobQueue.subject_id, [...mediaIds, ...posts.map((post) => post.id), libraryId]));
    await db.delete(Media).where(eq(Media.library_id, libraryId));
    await db.delete(Post).where(eq(Post.library_id, libraryId));
    await db.delete(Library).where(eq(Library.id, libraryId));
    libraryId = crypto.randomUUID();
});

const source = (name: string) => `https://cdn.example/${name}?sig=${crypto.randomUUID()}`;

type ImportedMedia = {
    type: MediaType;
    originals: { source_key: string; kind: "IMAGE" | "VIDEO" | "AUDIO" | "PDF" }[];
    cover?: string;
    captions?: string[];
    title?: string;
};

/** Imports one post with one media through the import's own path, as the scraper would. */
async function importPost(eid: string, media: ImportedMedia) {
    await db.insert(Library).values({ id: libraryId, name: "test", description: "", owner_id: crypto.randomUUID() }).onConflictDoNothing();
    const post = v.parse(PostItemSchema, {
        title: "post",
        external_id: eid,
        author: {},
        platform: PostSource.XHS,
        media: [
            {
                external_id: "m1",
                title: media.title ?? "imported title",
                type: media.type,
                originals: media.originals.map((original) => ({ ...original, url: source(original.source_key) })),
                cover: media.cover ? { url: source(media.cover), source_key: media.cover } : null,
                captions: (media.captions ?? []).map((key) => ({ url: source(key), source_key: key })),
            },
        ],
    });
    const saved = await db.transaction((tx) => saveIngestMetadata(post, libraryId, "run", tx));
    return { postId: saved.postId, mediaId: saved.mediaIds[0]! };
}

const mediaOf = async (mediaId: string) => (await db.select().from(Media).where(eq(Media.id, mediaId)))[0]!;
const postOf = async (postId: string) => (await db.select().from(Post).where(eq(Post.id, postId)))[0]!;
const originalsOf = (mediaId: string) => db.select().from(MediaOriginal).where(eq(MediaOriginal.media_id, mediaId));
const captionsOf = (mediaId: string) => db.select().from(MediaCaption).where(eq(MediaCaption.media_id, mediaId));
const coverOf = async (mediaId: string) => (await db.select().from(MediaCover).where(eq(MediaCover.media_id, mediaId)))[0];
const keysOf = async (mediaId: string) => (await originalsOf(mediaId)).map((original) => original.source_key).sort();

async function storedFile(mime: string, extension: string) {
    const [file] = await db
        .insert(DbFile)
        .values({ path: `test/${crypto.randomUUID()}.${extension}`, bucket: "test", mime_type: mime, extension, size: 1 })
        .returning({ id: DbFile.id });
    return file!.id;
}

/** Completes an imported original as if its download passed, with a file of `kind`. */
async function complete(mediaId: string, sourceKey: string, kind: "IMAGE" | "VIDEO") {
    const fileId = kind === "IMAGE" ? await storedFile("image/jpeg", "jpg") : await storedFile("video/mp4", "mp4");
    if (kind === "VIDEO") {
        const [avFile] = await db.insert(AvFile).values({ file_id: fileId, container: "mp4", duration: 3, fragmented: false }).returning();
        await db
            .insert(AvStream)
            .values({ av_file_id: avFile!.id, stream_index: 0, type: AvStreamType.VIDEO, codec: "h264", width: 1080, height: 1920 });
    }
    await db
        .update(MediaOriginal)
        .set({ file_id: fileId, status: SyncStatus.COMPLETED })
        .where(and(eq(MediaOriginal.media_id, mediaId), eq(MediaOriginal.source_key, sourceKey)));
}

/** Fails an imported source on its current URL. */
async function fail(table: typeof MediaOriginal | typeof MediaCaption | typeof MediaCover, id: string, kind: SourceErrorKind) {
    const [row] = await db.select({ url: table.source_url }).from(table).where(eq(table.id, id));
    await db
        .update(table)
        .set({ status: SyncStatus.FAILED, last_error: "x", error_kind: kind, error_source_url: row!.url })
        .where(eq(table.id, id));
}

const LIVE_PHOTO: ImportedMedia = {
    type: MediaType.LIVE_PHOTO,
    originals: [
        { source_key: "image", kind: "IMAGE" },
        { source_key: "video", kind: "VIDEO" },
    ],
};

describe("media ownership", () => {
    databaseTest("a live photo with a broken video becomes an image, and later imports keep it one", async () => {
        const eid = crypto.randomUUID();
        const { postId, mediaId } = await importPost(eid, LIVE_PHOTO);
        await complete(mediaId, "image", "IMAGE");
        const video = (await originalsOf(mediaId)).find((original) => original.source_key === "video")!;
        await fail(MediaOriginal, video.id, SourceErrorKind.KIND_MISMATCH);
        await db.transaction((tx) => refreshMediaSyncStatus(tx, [mediaId]));
        expect((await mediaOf(mediaId)).sync_status).toBe(SyncStatus.FAILED);
        expect((await postOf(postId)).sync_status).toBe(SyncStatus.FAILED);

        // The type and the originals are checked as a whole: an image keeping the video is no image.
        await expect(changeType(await mediaOf(mediaId), MediaType.IMAGE, [])).rejects.toThrow(MediaEditError);
        await changeType(await mediaOf(mediaId), MediaType.IMAGE, [video.id]);

        expect(await mediaOf(mediaId)).toMatchObject({
            type: MediaType.IMAGE,
            user_edited_fields: ["type"],
            excluded_source_keys: ["original:video"],
            sync_status: SyncStatus.COMPLETED,
            duration: null,
        });
        expect((await postOf(postId)).sync_status).toBe(SyncStatus.COMPLETED);
        expect(await keysOf(mediaId)).toEqual(["image"]);

        // The scraper still sends a live photo, even with a new key for its video: the media takes only what an image
        // takes.
        await importPost(eid, {
            ...LIVE_PHOTO,
            originals: [
                { source_key: "image", kind: "IMAGE" },
                { source_key: "video_v2", kind: "VIDEO" },
            ],
        });
        expect((await mediaOf(mediaId)).type).toBe(MediaType.IMAGE);
        expect(await keysOf(mediaId)).toEqual(["image"]);
        expect((await mediaOf(mediaId)).sync_status).toBe(SyncStatus.COMPLETED);
    });

    databaseTest("a deleted original stays deleted, and the composition still has to hold", async () => {
        const eid = crypto.randomUUID();
        const video: ImportedMedia = {
            type: MediaType.VIDEO,
            originals: [
                { source_key: "video", kind: "VIDEO" },
                { source_key: "audio:en", kind: "AUDIO" },
            ],
        };
        const { mediaId } = await importPost(eid, video);
        const originals = await originalsOf(mediaId);
        const audio = originals.find((original) => original.source_key === "audio:en")!;
        const main = originals.find((original) => original.source_key === "video")!;

        await expect(deleteOriginal(await mediaOf(mediaId), main.id)).rejects.toThrow("incomplete");
        await deleteOriginal(await mediaOf(mediaId), audio.id);
        expect((await mediaOf(mediaId)).excluded_source_keys).toEqual(["original:audio:en"]);

        await importPost(eid, video);
        expect(await keysOf(mediaId)).toEqual(["video"]);
    });

    databaseTest("an uploaded original keeps its place against imported ones", async () => {
        const eid = crypto.randomUUID();
        const { mediaId } = await importPost(eid, { type: MediaType.VIDEO, originals: [{ source_key: "video_1080", kind: "VIDEO" }] });
        // The user's own video, as a replacement leaves it: no source, completed.
        const [original] = await originalsOf(mediaId);
        await db.delete(MediaOriginal).where(eq(MediaOriginal.id, original!.id));
        await db
            .update(Media)
            .set({ excluded_source_keys: ["original:video_1080"] })
            .where(eq(Media.id, mediaId));
        const fileId = await storedFile("video/mp4", "mp4");
        const [avFile] = await db.insert(AvFile).values({ file_id: fileId, container: "mp4", duration: 3, fragmented: false }).returning();
        await db
            .insert(AvStream)
            .values({ av_file_id: avFile!.id, stream_index: 0, type: AvStreamType.VIDEO, codec: "h264", width: 1, height: 1 });
        await db.insert(MediaOriginal).values({ media_id: mediaId, file_id: fileId, status: SyncStatus.COMPLETED });

        await importPost(eid, {
            type: MediaType.VIDEO,
            originals: [
                { source_key: "video_4k", kind: "VIDEO" },
                { source_key: "audio", kind: "AUDIO" },
            ],
        });

        expect(await keysOf(mediaId)).toEqual(["audio", null]);
    });

    databaseTest("an uploaded cover keeps out the imported one; a replaced or deleted imported cover stays out", async () => {
        const eid = crypto.randomUUID();
        const video = { type: MediaType.VIDEO, originals: [{ source_key: "video", kind: "VIDEO" as const }], cover: "cover" };
        const { mediaId } = await importPost(eid, video);
        expect(await coverOf(mediaId)).toMatchObject({ source_key: "cover", status: SyncStatus.PENDING });

        await removeCover(await mediaOf(mediaId));
        expect((await mediaOf(mediaId)).excluded_source_keys).toEqual(["cover:cover"]);
        await importPost(eid, video);
        expect(await coverOf(mediaId)).toBeUndefined();

        const upload = { path: `test/${crypto.randomUUID()}.jpg`, bucket: "test", mime_type: "image/jpeg", extension: "jpg", size: 1 };
        await setCover(await mediaOf(mediaId), upload);
        await importPost(eid, { ...video, cover: "cover_v2" });
        expect(await coverOf(mediaId)).toMatchObject({ source_key: null, status: SyncStatus.COMPLETED });
    });

    databaseTest("a deleted imported caption stays deleted", async () => {
        const eid = crypto.randomUUID();
        const video = { type: MediaType.VIDEO, originals: [{ source_key: "video", kind: "VIDEO" as const }], captions: ["zh-CN", "en"] };
        const { mediaId } = await importPost(eid, video);
        const zh = (await captionsOf(mediaId)).find((caption) => caption.source_key === "zh-CN")!;

        await deleteCaption(await mediaOf(mediaId), zh.id);
        await importPost(eid, video);

        expect((await captionsOf(mediaId)).map((caption) => caption.source_key)).toEqual(["en"]);
    });

    databaseTest("only a source that failed for a retryable reason can be retried, one at a time", async () => {
        const { mediaId } = await importPost(crypto.randomUUID(), LIVE_PHOTO);
        const [image, video] = await originalsOf(mediaId).then((rows) => rows.sort((a, b) => a.source_key!.localeCompare(b.source_key!)));
        await fail(MediaOriginal, image!.id, SourceErrorKind.NETWORK);
        await fail(MediaOriginal, video!.id, SourceErrorKind.SOURCE_UNAVAILABLE);
        await db.transaction((tx) => refreshMediaSyncStatus(tx, [mediaId]));

        await expect(retrySource(await mediaOf(mediaId), "original", video!.id)).rejects.toThrow("network or server error");
        await retrySource(await mediaOf(mediaId), "original", image!.id);

        expect((await originalsOf(mediaId)).find((original) => original.id === image!.id)).toMatchObject({
            status: SyncStatus.PENDING,
            error_kind: null,
        });
        expect((await originalsOf(mediaId)).find((original) => original.id === video!.id)).toMatchObject({
            status: SyncStatus.FAILED,
            error_kind: SourceErrorKind.SOURCE_UNAVAILABLE,
        });
        expect((await mediaOf(mediaId)).sync_status).toBe(SyncStatus.PENDING);
        const queued = await db.select().from(JobQueue).where(eq(JobQueue.subject_id, mediaId));
        expect(queued.map((row) => row.pipeline)).toContain("download");
    });

    databaseTest("what the user edits of a media or post, imports leave alone", async () => {
        const eid = crypto.randomUUID();
        const { postId, mediaId } = await importPost(eid, LIVE_PHOTO);
        const media = await mediaOf(mediaId);

        // The client sends every field; only the changed ones become the user's.
        await updateMediaInfo(mediaId, { title: "my title", description: media.description });
        await PostService.updateInfo(postId, { title: "post", description: "my description" });
        expect((await mediaOf(mediaId)).user_edited_fields).toEqual(["title"]);
        expect((await postOf(postId)).user_edited_fields).toEqual(["description"]);

        await importPost(eid, { ...LIVE_PHOTO, title: "new imported title" });

        expect((await mediaOf(mediaId)).title).toBe("my title");
        expect(await postOf(postId)).toMatchObject({ title: "post", description: "my description" });
    });
});
