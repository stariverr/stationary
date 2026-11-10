import { defineRelations } from "drizzle-orm";
import * as schema from "./index";

export const relations = defineRelations(schema, (r) => ({
    Author: {
        posts: r.many.Post(),
        library: r.one.Library({
            from: [r.Author.library_id],
            to: [r.Library.id],
        }),
        avatarFile: r.one.File({
            from: [r.Author.avatar_file_id],
            to: [r.File.id],
            alias: "author_avatar",
        }),
        avatarThumbFile: r.one.File({
            from: [r.Author.avatar_thumb_file_id],
            to: [r.File.id],
            alias: "author_avatar_thumb",
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
    },
    File: {
        authorsAsAvatar: r.many.Author({ alias: "author_avatar" }),
        authorsAsThumb: r.many.Author({ alias: "author_avatar_thumb" }),
    },
}));
