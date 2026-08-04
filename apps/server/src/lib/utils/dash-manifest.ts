export interface DashSegmentBase {
    initialization: string;
    index_range: string;
    timescale?: number;
    earliest_presentation_time?: string;
}

export interface DashVideoRepresentation {
    id: string;
    url: string;
    codec: string;
    bandwidth: number;
    width: number;
    height: number;
    frame_rate?: number | null;
    segment_base: DashSegmentBase;
}

export interface DashAudioRepresentation {
    id: string;
    url: string;
    codec: string;
    bandwidth: number;
    language: string | null;
    label: string;
    role: string;
    channels: number;
    sample_rate?: number | null;
    audio_group_id?: string | null;
    segment_base: DashSegmentBase;
}

export interface DashManifestInput {
    duration: number;
    video: DashVideoRepresentation[];
    audio: DashAudioRepresentation[];
}

export const escapeXml = (value: string | number) =>
    String(value).replace(/[<>&'"]/g, (character) => {
        if (character === "<") return "&lt;";
        if (character === ">") return "&gt;";
        if (character === "&") return "&amp;";
        if (character === "'") return "&apos;";
        return "&quot;";
    });

const segmentBaseXml = (segmentBase: DashSegmentBase, indentation: string) => {
    const attributes = [`indexRange="${escapeXml(segmentBase.index_range)}"`];
    if (segmentBase.timescale != null) attributes.push(`timescale="${escapeXml(segmentBase.timescale)}"`);
    if (segmentBase.earliest_presentation_time != null) {
        attributes.push(`presentationTimeOffset="${escapeXml(segmentBase.earliest_presentation_time)}"`);
    }

    return `${indentation}<SegmentBase ${attributes.join(" ")}>
${indentation}  <Initialization range="${escapeXml(segmentBase.initialization)}" />
${indentation}</SegmentBase>`;
};

const videoRepresentationXml = (representation: DashVideoRepresentation) => {
    const frameRate = representation.frame_rate ? ` frameRate="${escapeXml(representation.frame_rate)}"` : "";
    return `      <Representation id="${escapeXml(representation.id)}" codecs="${escapeXml(representation.codec)}" bandwidth="${escapeXml(representation.bandwidth)}" width="${escapeXml(representation.width)}" height="${escapeXml(representation.height)}"${frameRate}>
        <BaseURL>${escapeXml(representation.url)}</BaseURL>
${segmentBaseXml(representation.segment_base, "        ")}
      </Representation>`;
};

const audioGroupKey = (representation: DashAudioRepresentation) =>
    representation.audio_group_id ||
    [representation.language || "und", representation.role, representation.label, representation.channels].join("\u0000");

const groupAudioRepresentations = (representations: DashAudioRepresentation[]) => {
    const groups = new Map<string, DashAudioRepresentation[]>();
    for (const representation of representations) {
        const key = audioGroupKey(representation);
        const group = groups.get(key) ?? [];
        group.push(representation);
        groups.set(key, group);
    }
    return [...groups.values()];
};

const audioAdaptationSetXml = (representations: DashAudioRepresentation[], index: number) => {
    const first = representations[0]!;
    const language = first.language ? ` lang="${escapeXml(first.language)}"` : "";
    const representationXml = representations
        .map((representation) => {
            const sampleRate = representation.sample_rate ? ` audioSamplingRate="${escapeXml(representation.sample_rate)}"` : "";
            return `      <Representation id="${escapeXml(representation.id)}" codecs="${escapeXml(representation.codec)}" bandwidth="${escapeXml(representation.bandwidth)}"${sampleRate}>
        <BaseURL>${escapeXml(representation.url)}</BaseURL>
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23001:3:audio_channel_configuration:2011" value="${escapeXml(representation.channels)}" />
${segmentBaseXml(representation.segment_base, "        ")}
      </Representation>`;
        })
        .join("\n");

    return `    <AdaptationSet id="audio-${index + 1}" contentType="audio" mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1"${language}>
      <Label>${escapeXml(first.label)}</Label>
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="${escapeXml(first.role)}" />
${representationXml}
    </AdaptationSet>`;
};

export function buildDashManifest(input: DashManifestInput) {
    const duration = Number.isFinite(input.duration) && input.duration > 0 ? input.duration : 0;
    const video = input.video.map(videoRepresentationXml).join("\n");
    const audio = groupAudioRepresentations(input.audio).map(audioAdaptationSetXml).join("\n");
    const audioSection = audio ? `\n${audio}` : "";

    return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT${escapeXml(duration)}S" minBufferTime="PT1.5S">
  <Period>
    <AdaptationSet id="video" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
${video}
    </AdaptationSet>${audioSection}
  </Period>
</MPD>`;
}
