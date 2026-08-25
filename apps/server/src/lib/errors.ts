import { TaggedError } from "better-result";
import { Code } from "./code";

export class NotFoundError extends TaggedError("NotFoundError")<{
    resource: string;
    id?: string;
    message?: string;
}> {
    get code(): Code {
        return Code.NOT_FOUND;
    }
    get httpStatus(): number {
        return 404;
    }
}

export class UnauthorizedError extends TaggedError("UnauthorizedError")<{
    message?: string;
}> {
    get code(): Code {
        return Code.UNAUTHORIZED;
    }
    get httpStatus(): number {
        return 401;
    }
}

export class ForbiddenError extends TaggedError("ForbiddenError")<{
    message?: string;
}> {
    get code(): Code {
        return Code.FORBIDDEN;
    }
    get httpStatus(): number {
        return 403;
    }
}

export class ValidationError extends TaggedError("ValidationError")<{
    message: string;
    field?: string;
}> {
    get code(): Code {
        return Code.INVALID_PARAMETER;
    }
    get httpStatus(): number {
        return 400;
    }
}

export class ConflictError extends TaggedError("ConflictError")<{
    message: string;
}> {
    get code(): Code {
        return Code.ALREADY_EXISTS;
    }
    get httpStatus(): number {
        return 409;
    }
}

export class InternalError extends TaggedError("InternalError")<{
    message: string;
    cause?: unknown;
}> {
    get code(): Code {
        return Code.INTERNAL_SERVER_ERROR;
    }
    get httpStatus(): number {
        return 500;
    }
}

export class ServiceUnavailableError extends TaggedError("ServiceUnavailableError")<{
    message?: string;
}> {
    get code(): Code {
        return Code.SERVICE_UNAVAILABLE;
    }
    get httpStatus(): number {
        return 503;
    }
}

export class TimeoutError extends TaggedError("TimeoutError")<{
    message?: string;
    timeoutMs?: number;
}> {
    get code(): Code {
        return Code.TIMEOUT;
    }
    get httpStatus(): number {
        return 504;
    }
}

// Domain Specific Errors

export class LibraryNotEmptyError extends TaggedError("LibraryNotEmptyError")<{
    libraryId: string;
    message?: string;
}> {
    get code(): Code {
        return Code.LIBRARY_NOT_EMPTY;
    }
    get httpStatus(): number {
        return 400;
    }
}

export class TagOperationError extends TaggedError("TagOperationError")<{
    code: Code;
    message: string;
    httpStatus?: number;
}> {
    get httpStatus(): number {
        return this.httpStatusOverride ?? 400;
    }
    private get httpStatusOverride(): number | undefined {
        return (this as any)._payload?.httpStatus;
    }
}

export class MediaCompositionError extends TaggedError("MediaCompositionError")<{
    mediaId: string;
    message: string;
}> {
    get code(): Code {
        return Code.INVALID_PARAMETER;
    }
    get httpStatus(): number {
        return 400;
    }
}

export class DraftFileError extends TaggedError("DraftFileError")<{
    message: string;
    draftId?: string;
}> {
    get code(): Code {
        return Code.INVALID_PARAMETER;
    }
    get httpStatus(): number {
        return 400;
    }
}

export class PhysicalFileNotFoundError extends TaggedError("PhysicalFileNotFoundError")<{
    fileId?: string;
    message?: string;
}> {
    get code(): Code {
        return Code.NOT_FOUND;
    }
    get httpStatus(): number {
        return 404;
    }
}

export class IngestError extends TaggedError("IngestError")<{
    message: string;
    cause?: unknown;
}> {
    get code(): Code {
        return Code.INTERNAL_SERVER_ERROR;
    }
    get httpStatus(): number {
        return 500;
    }
}

export class CoverRenderError extends TaggedError("CoverRenderError")<{
    message: string;
    cause?: unknown;
}> {
    get code(): Code {
        return Code.INTERNAL_SERVER_ERROR;
    }
    get httpStatus(): number {
        return 500;
    }
}
