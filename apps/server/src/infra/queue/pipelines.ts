/**
 * The declaration table (docs/job_queue.zh-Hans.md, section 5): which aspects of the source data each
 * pipeline reads and which it produces. Writers only report what changed through markChanged(); this table decides
 * which pipelines follow. Pipelines never enqueue each other.
 */

export const Aspect = {
    /** Remote source URLs of a media's content tracks. */
    MEDIA_SOURCE: "media.source",
    /** Content track files of a media are ready or replaced. */
    MEDIA_CONTENT: "media.content",
    /** A media moved to another library. */
    MEDIA_LIBRARY: "media.library",
    /** The original cover of a media (a user upload or a downloaded platform cover) was set, replaced or removed. */
    MEDIA_COVER: "media.cover",
    /** The preview images of a media changed. */
    MEDIA_PREVIEW: "media.preview",
    /** Title, description or tags of a media, of its post, or of a tag group it carries. */
    MEDIA_META: "media.meta",
    /** The stored AI description of a media. */
    MEDIA_DESCRIPTION: "media.description",
    /** The search document of a media. */
    MEDIA_SEARCH_DOC: "media.search_doc",
    /** Where an author's avatar should come from. */
    AUTHOR_AVATAR_SOURCE: "author.avatar_source",
    /** Description model, language or prompt of a library, or a request to re-describe. */
    LIBRARY_AI_CONFIG: "library.ai_config",
    /** Embedding spaces a library writes (ACTIVE and BUILDING). */
    LIBRARY_SPACES: "library.spaces",
} as const;
export type Aspect = (typeof Aspect)[keyof typeof Aspect];

export type SubjectKind = "media" | "author";

/** Embedding role whose spaces a per-space pipeline writes. */
export type SpaceRole = "textEmbedding" | "imageEmbedding";

export interface PipelineDeclaration {
    readonly subject: SubjectKind;
    /**
     * Runs once per embedding space of this role that the library writes (ACTIVE and BUILDING). Each space has its
     * own queue, named `<pipeline>:<space row id>`, so a space is filled and counted on its own.
     */
    readonly perSpace?: SpaceRole;
    /** Subject-level aspects enqueue the subject; library-level aspects (`library.*`) enqueue a scan of the library. */
    readonly inputs: readonly Aspect[];
    readonly outputs: readonly Aspect[];
}

export const PIPELINES = {
    download: { subject: "media", inputs: [Aspect.MEDIA_SOURCE], outputs: [Aspect.MEDIA_CONTENT, Aspect.MEDIA_COVER] },
    avatar: { subject: "author", inputs: [Aspect.AUTHOR_AVATAR_SOURCE], outputs: [] },
    preview: { subject: "media", inputs: [Aspect.MEDIA_CONTENT, Aspect.MEDIA_COVER], outputs: [Aspect.MEDIA_PREVIEW] },
    "ai.describe": {
        subject: "media",
        // AI looks at the large preview, never at the content or the cover directly.
        inputs: [Aspect.MEDIA_PREVIEW, Aspect.MEDIA_LIBRARY, Aspect.LIBRARY_AI_CONFIG],
        outputs: [Aspect.MEDIA_DESCRIPTION],
    },
    "ai.index": {
        subject: "media",
        inputs: [Aspect.MEDIA_DESCRIPTION, Aspect.MEDIA_META, Aspect.MEDIA_LIBRARY],
        outputs: [Aspect.MEDIA_SEARCH_DOC],
    },
    "ai.text": {
        subject: "media",
        perSpace: "textEmbedding",
        inputs: [Aspect.MEDIA_SEARCH_DOC, Aspect.MEDIA_LIBRARY, Aspect.LIBRARY_SPACES],
        outputs: [],
    },
    "ai.image": {
        subject: "media",
        perSpace: "imageEmbedding",
        inputs: [Aspect.MEDIA_PREVIEW, Aspect.MEDIA_LIBRARY, Aspect.LIBRARY_SPACES],
        outputs: [],
    },
} as const satisfies Record<string, PipelineDeclaration>;

export type PipelineName = keyof typeof PIPELINES;
export const PIPELINE_NAMES = Object.keys(PIPELINES) as PipelineName[];

export function spaceRoleOf(pipeline: PipelineName): SpaceRole | null {
    const declaration: PipelineDeclaration = PIPELINES[pipeline];
    return declaration.perSpace ?? null;
}

const SCAN_PREFIX = "scan:";

/** Queue name of a pipeline's subject rows; per-space pipelines name the space row. */
export function queueName(pipeline: PipelineName, space: string | null = null): string {
    return space ? `${pipeline}:${space}` : pipeline;
}

/** Queue name of the library scan of a pipeline (in one space); its subject is the library id. */
export function scanQueueName(pipeline: PipelineName, space: string | null = null): string {
    return `${SCAN_PREFIX}${queueName(pipeline, space)}`;
}

/** LIKE pattern matching the queue names of a pipeline's subject rows, in every space of a per-space pipeline. */
export function subjectQueuePattern(pipeline: PipelineName): string {
    return spaceRoleOf(pipeline) ? `${pipeline}:_%` : pipeline;
}

/**
 * LIKE patterns matching exactly the queue names parseQueueName accepts. Claims use them so a worker of an older
 * version, briefly running beside a newer one, leaves the rows of a pipeline it does not know alone.
 */
export const KNOWN_QUEUE_PATTERNS = PIPELINE_NAMES.flatMap((pipeline) => {
    const own = subjectQueuePattern(pipeline);
    return [own, `${SCAN_PREFIX}${own}`];
});

export interface QueueName {
    readonly pipeline: PipelineName;
    readonly scan: boolean;
    /** Space row id of a per-space pipeline. */
    readonly space: string | null;
}

/** Splits a queue row's pipeline column into the pipeline it serves, its space, and whether it is a library scan. */
export function parseQueueName(name: string): QueueName | null {
    const scan = name.startsWith(SCAN_PREFIX);
    const rest = scan ? name.slice(SCAN_PREFIX.length) : name;
    const separator = rest.indexOf(":");
    const pipeline = separator < 0 ? rest : rest.slice(0, separator);
    const space = separator < 0 ? null : rest.slice(separator + 1);
    if (!(pipeline in PIPELINES)) return null;
    if ((spaceRoleOf(pipeline as PipelineName) !== null) !== (space !== null)) return null;
    return { pipeline: pipeline as PipelineName, scan, space };
}

/**
 * Where a queue comes in the order transactions lock queue rows: a pipeline before those that read its outputs, as a
 * run holds its own row when it queues them, and a scan before its pipeline, as a scan step holds its row when it
 * queues subjects. PIPELINES is declared in dependency order.
 */
export function queueLockOrder(name: string): number {
    const parsed = parseQueueName(name);
    return parsed ? PIPELINE_NAMES.indexOf(parsed.pipeline) * 2 + (parsed.scan ? 0 : 1) : -1;
}

export function isLibraryAspect(aspect: Aspect): boolean {
    return aspect.startsWith("library.");
}

export function pipelinesReading(aspect: Aspect): PipelineName[] {
    return PIPELINE_NAMES.filter((name) => (PIPELINES[name].inputs as readonly Aspect[]).includes(aspect));
}

/** Throws when following outputs to the pipelines that read them can lead back to the start. */
export function assertAcyclic(pipelines: Record<string, PipelineDeclaration>): void {
    const names = Object.keys(pipelines);
    const next = (name: string) =>
        names.filter((candidate) => pipelines[name]!.outputs.some((aspect) => pipelines[candidate]!.inputs.includes(aspect)));

    const done = new Set<string>();
    const visit = (name: string, path: string[]) => {
        if (path.includes(name)) throw new Error(`Pipeline declarations form a cycle: ${[...path, name].join(" -> ")}`);
        if (done.has(name)) return;
        for (const following of next(name)) visit(following, [...path, name]);
        done.add(name);
    };
    for (const name of names) visit(name, []);
}

assertAcyclic(PIPELINES);
