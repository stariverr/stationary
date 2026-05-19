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
