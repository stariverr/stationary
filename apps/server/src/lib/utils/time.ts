import { Temporal } from "@js-temporal/polyfill";

export const nowDbTimestamp = () => Temporal.Now.instant();

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
