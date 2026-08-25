import { describe, expect, test } from "bun:test";
import { Result, TaggedError } from "better-result";
import { Hono } from "hono";
import { Code } from "../src/lib/code";
import { respondWithResult, success, error } from "../src/lib/response";
import {
    NotFoundError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    ConflictError,
    InternalError,
    LibraryNotEmptyError,
    TagOperationError,
    MediaCompositionError,
    DraftFileError,
    PhysicalFileNotFoundError,
} from "../src/lib/errors";
import { DraftFileUnavailableError } from "../src/services/draft-file";

describe("better-result v3 integration in Stationary", () => {
    test("TaggedError classes instantiate with typed payloads and getters", () => {
        const notFound = new NotFoundError({ resource: "Library", id: "lib-123", message: "Library not found" });
        expect(notFound._tag).toBe("NotFoundError");
        expect(notFound.resource).toBe("Library");
        expect(notFound.id).toBe("lib-123");
        expect(notFound.message).toBe("Library not found");
        expect(notFound.code).toBe(Code.NOT_FOUND);
        expect(notFound.httpStatus).toBe(404);
        expect(NotFoundError.is(notFound)).toBe(true);

        const libNotEmpty = new LibraryNotEmptyError({
            libraryId: "lib-456",
            message: "Please empty posts and media in this library before deleting it.",
        });
        expect(libNotEmpty._tag).toBe("LibraryNotEmptyError");
        expect(libNotEmpty.libraryId).toBe("lib-456");
        expect(libNotEmpty.code).toBe(Code.LIBRARY_NOT_EMPTY);
        expect(libNotEmpty.httpStatus).toBe(400);
        expect(LibraryNotEmptyError.is(libNotEmpty)).toBe(true);

        const draftUnavailable = new DraftFileUnavailableError({
            draftFileId: "draft-789",
            message: "Draft file is invalid or already consumed",
        });
        expect(draftUnavailable._tag).toBe("DraftFileUnavailableError");
        expect(draftUnavailable.draftFileId).toBe("draft-789");
        expect(draftUnavailable.code).toBe(Code.INVALID_PARAMETER);
        expect(draftUnavailable.httpStatus).toBe(400);
        expect(DraftFileUnavailableError.is(draftUnavailable)).toBe(true);
    });

    test("TaggedError instance .match() provides exhaustive error matching", () => {
        type DomainErrors = NotFoundError | LibraryNotEmptyError;
        const err: DomainErrors = new LibraryNotEmptyError({ libraryId: "lib-1" });

        const mapped = err.match({
            NotFoundError: (e: NotFoundError) => `Not found: ${e.resource}`,
            LibraryNotEmptyError: (e: LibraryNotEmptyError) => `Not empty: ${e.libraryId}`,
        });

        expect(mapped).toBe("Not empty: lib-1");
    });

    test("Result.gen composes multi-step async operations seamlessly", async () => {
        const fetchUser = (id: string) =>
            Result.gen(async function* () {
                if (id === "unknown") {
                    yield* new NotFoundError({ resource: "User", id });
                }
                return Result.ok({ id, name: "Alice" });
            });

        const fetchUserLibrary = (userId: string) =>
            Result.gen(async function* () {
                const user = yield* Result.await(fetchUser(userId));
                return Result.ok({ libraryId: `lib-for-${user.id}`, owner: user.name });
            });

        const successResult = await fetchUserLibrary("user-1");
        expect(successResult.isOk()).toBe(true);
        if (successResult.isOk()) {
            expect(successResult.value).toEqual({ libraryId: "lib-for-user-1", owner: "Alice" });
        }

        const failResult = await fetchUserLibrary("unknown");
        expect(failResult.isErr()).toBe(true);
        if (failResult.isErr()) {
            expect(failResult.error._tag).toBe("NotFoundError");
        }
    });

    test("respondWithResult formats Ok into standard success response envelope", async () => {
        const app = new Hono();
        app.get("/test-ok", (c) => {
            const result = Result.ok({ postId: "post-123" });
            return respondWithResult(c, result);
        });

        const res = await app.request("/test-ok");
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({
            success: true,
            code: Code.SUCCESS,
            message: "Success",
            data: { postId: "post-123" },
        });
    });

    test("respondWithResult formats Err into standard error response envelope", async () => {
        const app = new Hono();
        app.get("/test-err", (c) => {
            const result = Result.err(
                new NotFoundError({
                    resource: "Media",
                    id: "media-404",
                    message: "Media not found",
                }),
            );
            return respondWithResult(c, result);
        });

        const res = await app.request("/test-err");
        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json).toEqual({
            success: false,
            code: Code.NOT_FOUND,
            message: "Media not found",
            data: null,
        });
    });

    test("respondWithResult formats domain LibraryNotEmptyError correctly", async () => {
        const app = new Hono();
        app.get("/test-not-empty", (c) => {
            const result = Result.err(
                new LibraryNotEmptyError({
                    libraryId: "lib-777",
                    message: "Please empty posts and media in this library before deleting it.",
                }),
            );
            return respondWithResult(c, result);
        });

        const res = await app.request("/test-not-empty");
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json).toEqual({
            success: false,
            code: Code.LIBRARY_NOT_EMPTY,
            message: "Please empty posts and media in this library before deleting it.",
            data: null,
        });
    });
});
