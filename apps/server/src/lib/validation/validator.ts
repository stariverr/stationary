import * as v from "valibot";
import { validator } from "hono/validator";
import { ValidationTargets } from "hono";
import { Code } from "@/lib/code";
import { error } from "@/lib/response";

/**
 * Standardized Valibot validator middleware for Hono routes.
 * Preserves schema type inference for `c.req.valid(...)` while
 * returning unified API error response with Code.INVALID_PARAMETER on validation failure.
 */
export function validate<T extends keyof ValidationTargets, S extends v.GenericSchema>(target: T, schema: S) {
    return validator(target, (value, c) => {
        const parsed = v.safeParse(schema, value);
        if (!parsed.success) {
            const firstIssue = parsed.issues[0];
            const msg = firstIssue?.message || "Invalid request parameters";
            return c.json(error(Code.INVALID_PARAMETER, msg), 400);
        }
        return parsed.output;
    });
}
