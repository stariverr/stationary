import { defineRelations } from "drizzle-orm";
import * as schema from "./index";

export const relations = defineRelations(schema, (r) => ({
    Author: {
        posts: r.many.Post(),
        avatarFile: r.one.File({
            from: [r.Author.avatar_file_id],
            to: [r.File.id],
            alias: 'author_avatar',
        }),
        avatarThumbFile: r.one.File({
            from: [r.Author.avatar_thumb_file_id],
            to: [r.File.id],
            alias: 'author_avatar_thumb',
        }),
    },
    Post: {
        author: r.one.Author({
            from: [r.Post.author_id],
            to: [r.Author.id],
        }),
        media: r.many.Media(),
    },
    Media: {
        post: r.one.Post({
            from: [r.Media.post_id],
            to: [r.Post.id],
        }),
        mediaFiles: r.many.MediaFile(),
    },
    MediaFile: {
        media: r.one.Media({
            from: [r.MediaFile.media_id],
            to: [r.Media.id],
        }),
        file: r.one.File({
            from: [r.MediaFile.file_id],
            to: [r.File.id],
            alias: 'media_file_file',
        }),
    },
    File: {
        mediaFiles: r.many.MediaFile({ alias: 'media_file_file' }),
        authorsAsAvatar: r.many.Author({ alias: 'author_avatar' }),
        authorsAsThumb: r.many.Author({ alias: 'author_avatar_thumb' }),
    },
}));
