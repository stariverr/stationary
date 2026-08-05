import { Temporal } from "@js-temporal/polyfill";
import * as v from "valibot";

export const toIsoTimestamp = (value: Temporal.Instant | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Temporal.Instant) {
        return value.toString();
    }
    const str = typeof value === "string" ? value : String(value);
    const normalized = str.includes("T") ? str : str.replace(" ", "T");
    const withTimeZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
    try {
        return Temporal.Instant.from(withTimeZone).toString();
    } catch {
        return normalized;
    }
};

export const FormTimestampSchema = v.pipe(
    v.optional(v.nullable(v.string())),
    v.check((val) => {
        if (val === undefined || val === null) return true;
        try {
            Temporal.Instant.from(val);
            return true;
        } catch {
            return false;
        }
    }, "Invalid ISO 8601 timestamp string"),
    v.transform((val) => {
        if (val === undefined) return undefined;
        if (val === null) return null;
        return Temporal.Instant.from(val);
    }),
);
