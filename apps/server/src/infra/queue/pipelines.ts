/**
 * The declaration table (docs/async_task_improvements.zh-Hans.md §11.4): which aspects of the source data each
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
    /** Generated cover tracks of a media changed. */
    MEDIA_COVER: "media.cover",
    /** Where an author's avatar should come from. */
    AUTHOR_AVATAR_SOURCE: "author.avatar_source",
    /** Cover qualities of a library. */
    LIBRARY_COVER_CONFIG: "library.cover_config",
} as const;
export type Aspect = (typeof Aspect)[keyof typeof Aspect];

export type SubjectKind = "media" | "author";

export interface PipelineDeclaration {
    readonly subject: SubjectKind;
    /** Subject-level aspects enqueue the subject; library-level aspects (`library.*`) enqueue a scan of the library. */
    readonly inputs: readonly Aspect[];
    readonly outputs: readonly Aspect[];
}

export const PIPELINES = {
    download: { subject: "media", inputs: [Aspect.MEDIA_SOURCE], outputs: [Aspect.MEDIA_CONTENT] },
    avatar: { subject: "author", inputs: [Aspect.AUTHOR_AVATAR_SOURCE], outputs: [] },
    cover: {
        subject: "media",
        inputs: [Aspect.MEDIA_CONTENT, Aspect.MEDIA_LIBRARY, Aspect.LIBRARY_COVER_CONFIG],
        outputs: [Aspect.MEDIA_COVER],
    },
} as const satisfies Record<string, PipelineDeclaration>;

export type PipelineName = keyof typeof PIPELINES;
export const PIPELINE_NAMES = Object.keys(PIPELINES) as PipelineName[];

const SCAN_PREFIX = "scan:";

/** Queue name of the library scan of a pipeline; its subject is the library id. */
export function scanQueueName(pipeline: PipelineName): string {
    return `${SCAN_PREFIX}${pipeline}`;
}

/** Splits a queue row's pipeline column into the pipeline it serves and whether it is that pipeline's library scan. */
export function parseQueueName(name: string): { pipeline: PipelineName; scan: boolean } | null {
    const scan = name.startsWith(SCAN_PREFIX);
    const pipeline = scan ? name.slice(SCAN_PREFIX.length) : name;
    return pipeline in PIPELINES ? { pipeline: pipeline as PipelineName, scan } : null;
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
