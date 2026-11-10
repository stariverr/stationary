/** Where the files of a media live in storage: under its post when it has one, else under the media itself. */
export function mediaStoragePath(media: { id: string; post_id: string | null }, name: string): string {
    return media.post_id
        ? `v2/p/${media.post_id.slice(-2)}/${media.post_id}/media_${media.id}/${name}`
        : `v2/m/${media.id.slice(-2)}/${media.id}/${name}`;
}
