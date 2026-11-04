import { Hono, type Context } from "hono";
import { AuthEnv, ownedLibrary, requireAuth } from "@/lib/auth/middleware";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import * as v from "valibot";
import { validate } from "@/lib/validation/validator";
import { PIPELINE_NAMES, type PipelineName } from "@/infra/queue/pipelines";
import { listFailures, pipelineStatus, retryFailures } from "@/infra/queue/status";
import { setLibraryPaused } from "@/infra/queue/store";

export const jobsApp = new Hono<AuthEnv>();

/** Resolves `:library_id/:pipeline` to an owned library and a known pipeline. */
async function resolvePipelineParams(c: Context<AuthEnv>, userId: string, libraryId: string, pipelineParam: string) {
    if (!PIPELINE_NAMES.includes(pipelineParam as PipelineName)) return null;
    const library = await ownedLibrary(c, userId, libraryId);
    return library ? { library, pipeline: pipelineParam as PipelineName } : null;
}

/** Every jobs listing is scoped to one library the user owns. */
const LibraryQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
});

const LibraryParamSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
});

const PipelineParamSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
    pipeline: v.string(),
});

const PausedBodySchema = v.strictObject({
    paused: v.boolean(),
});

const FailuresQuerySchema = v.object({
    limit: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(200)), "50"),
});

// GET /api/jobs/pipelines?library_id - Whether the library is paused and, per pipeline, its queued, running, retrying and failed subjects
jobsApp.get("/pipelines", requireAuth, validate("query", LibraryQuerySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const library = await ownedLibrary(c, user.id, c.req.valid("query").library_id);
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);

    const status = await pipelineStatus([library.id]);
    const pipelines = (status.get(library.id) ?? []).map(({ oldestSeconds, blockedSeconds, ...counts }) => ({
        ...counts,
        oldest_seconds: oldestSeconds,
        blocked_seconds: blockedSeconds,
    }));
    return c.json(success(Code.SUCCESS, { paused: library.jobs_paused, pipelines }));
});

// PUT /api/jobs/pipelines/:library_id/paused - Put the library's background work on hold, or let it go on
jobsApp.put(
    "/pipelines/:library_id/paused",
    requireAuth,
    validate("param", LibraryParamSchema),
    validate("json", PausedBodySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

        const library = await ownedLibrary(c, user.id, c.req.valid("param").library_id);
        if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);

        const { paused } = c.req.valid("json");
        await setLibraryPaused(library.id, paused);
        return c.json(success(Code.SUCCESS, { paused }));
    },
);

// GET /api/jobs/pipelines/:library_id/:pipeline/failures - Subjects whose failure still applies
jobsApp.get(
    "/pipelines/:library_id/:pipeline/failures",
    requireAuth,
    validate("param", PipelineParamSchema),
    validate("query", FailuresQuerySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

        const params = c.req.valid("param");
        const target = await resolvePipelineParams(c, user.id, params.library_id, params.pipeline);
        if (!target) return c.json(error(Code.NOT_FOUND, "Library or pipeline not found"), 404);

        const failures = await listFailures(target.library.id, target.pipeline, Number(c.req.valid("query").limit));
        return c.json(
            success(Code.SUCCESS, {
                items: failures.map((failure) => ({
                    subject_id: failure.subjectId,
                    label: failure.label,
                    error: failure.error,
                    time: failure.time?.toString() ?? null,
                })),
            }),
        );
    },
);

// POST /api/jobs/pipelines/:library_id/:pipeline/retry-failed - Queue every current failure again
jobsApp.post("/pipelines/:library_id/:pipeline/retry-failed", requireAuth, validate("param", PipelineParamSchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const params = c.req.valid("param");
    const target = await resolvePipelineParams(c, user.id, params.library_id, params.pipeline);
    if (!target) return c.json(error(Code.NOT_FOUND, "Library or pipeline not found"), 404);

    const retried = await retryFailures(target.library.id, target.pipeline);
    return c.json(success(Code.SUCCESS, { retried }));
});
