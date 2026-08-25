import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Result } from "better-result";
import { Code } from "./code";

/** Response Schema */
export interface Response<T> {
    success: boolean;
    /** Inner Code */
    code: number;
    message: string;

    data: T | null;
}

/** Success Response */
export function success<T>(code: Code, data: T, message: string = "Success"): Response<T> {
    return {
        success: true,
        code: code,
        message: message,
        data: data,
    };
}

/** Error Response */
export function error(code: Code, message: string) {
    return {
        success: false,
        code: code,
        message: message,
        data: null,
    };
}

export interface ErrorLike {
    message?: string;
    code?: Code;
    httpStatus?: number;
}

/**
 * Handle a better-result Result and return a unified Hono JSON response.
 */
export function respondWithResult<T, E extends ErrorLike | Error | unknown>(
    c: Context,
    result: Result<T, E>,
    options?: {
        successCode?: Code;
        successStatus?: ContentfulStatusCode;
        successMessage?: string;
    },
): globalThis.Response {
    if (result.isOk()) {
        return c.json(
            success(options?.successCode ?? Code.SUCCESS, result.value, options?.successMessage ?? "Success"),
            (options?.successStatus ?? 200) as any,
        );
    }

    const err: any = result.error;
    const code: Code = typeof err?.code === "number" ? err.code : Code.INTERNAL_SERVER_ERROR;
    const status: ContentfulStatusCode = (typeof err?.httpStatus === "number" ? err.httpStatus : 400) as any;
    const message: string =
        typeof err?.message === "string" && err.message.length > 0 ? err.message : typeof err === "string" ? err : "An error occurred";
    return c.json(error(code, message), status as any);
}
