import type { DashVideoElement } from "@videojs/html/media/dash-video";

type DashEngine = DashVideoElement["engine"];
type DashAudioInfo = ReturnType<DashEngine["getTracksFor"]>[number];
type MediaAudioTrack = ReturnType<DashVideoElement["addAudioTrack"]>;
type MediaAudioTrackList = DashVideoElement["audioTracks"];

const trackId = (info: DashAudioInfo) => info.id || `index:${info.index}`;

const trackKind = (info: DashAudioInfo) => (info.roles?.some((role) => role.value === "main") ? "main" : "alternative");

/**
 * Video.js 10.3's `<dash-video>` mirrors dash.js video representations into the media tracks API but never fills
 * `audioTracks`, so the player's audio track menu stays empty under DASH. This mirrors the audio adaptation sets of the
 * active stream into `audioTracks` and sends a selection made there back to dash.js.
 *
 * Delete this module once `@videojs/dash-video` fills `audioTracks` itself.
 */
export function bridgeDashAudioTracks(media: DashVideoElement): () => void {
    const engine = media.engine;
    const bridged = new Map<MediaAudioTrack, DashAudioInfo>();
    let src = media.src;
    // The adapter replaces its track list whenever it re-attaches to a <video>, so the list is bound per stream.
    let trackList: MediaAudioTrackList | null = null;

    const clear = () => {
        trackList?.removeEventListener("change", onAudioTracksChange);
        trackList = null;
        for (const track of bridged.keys()) media.removeAudioTrack(track);
        bridged.clear();
    };

    const markEnabled = (info: DashAudioInfo | null | undefined) => {
        const enabledId = info ? trackId(info) : null;
        for (const track of bridged.keys()) track.enabled = track.id === enabledId;
    };

    const onStreamInitialized = (event: { error?: unknown }) => {
        if (event.error) return;
        clear();
        for (const info of engine.getTracksFor("audio")) {
            const track = media.addAudioTrack(trackKind(info), info.labels[0]?.text ?? "", info.lang ?? "");
            track.id = trackId(info);
            bridged.set(track, info);
        }
        markEnabled(engine.getCurrentTrackFor("audio"));
        trackList = media.audioTracks;
        trackList.addEventListener("change", onAudioTracksChange);
    };

    const onTrackChangeRendered = (event: { mediaType: string; newMediaInfo: DashAudioInfo }) => {
        if (event.mediaType === "audio") markEnabled(event.newMediaInfo);
    };

    // The player store enables the chosen track and disables the rest; hand the chosen one to dash.js.
    function onAudioTracksChange() {
        const current = engine.getCurrentTrackFor("audio");
        const currentId = current ? trackId(current) : null;
        const enabled = [...bridged.keys()].filter((track) => track.enabled);
        const selected = enabled.find((track) => track.id !== currentId) ?? enabled[0];
        if (!selected) return;
        for (const track of enabled) if (track !== selected) track.enabled = false;
        const info = bridged.get(selected);
        // Skip the cached-preference write so one video's audio choice does not steer the next video.
        if (info && selected.id !== currentId) engine.setCurrentTrack(info, true);
    }

    const onSourceChange = () => {
        if (media.src === src) return;
        src = media.src;
        clear();
    };

    engine.on("streamInitialized", onStreamInitialized);
    engine.on("trackChangeRendered", onTrackChangeRendered);
    media.addEventListener("sourcechange", onSourceChange);

    return () => {
        engine.off("streamInitialized", onStreamInitialized);
        engine.off("trackChangeRendered", onTrackChangeRendered);
        media.removeEventListener("sourcechange", onSourceChange);
        clear();
    };
}
