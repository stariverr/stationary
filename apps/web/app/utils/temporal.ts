import { Temporal } from "@js-temporal/polyfill";

/**
 * Format an ISO 8601 timestamp string into a localized date-time representation using Temporal API.
 */
export function formatTemporalDateTime(
    isoString: string | null | undefined,
    locale = "zh-CN",
    options?: Intl.DateTimeFormatOptions,
): string {
    if (!isoString) return "-";
    try {
        const instant = Temporal.Instant.from(isoString);
        return instant.toZonedDateTimeISO(Temporal.Now.timeZoneId()).toLocaleString(
            locale,
            options || {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            },
        );
    } catch {
        return isoString;
    }
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
];

/**
 * Format an ISO timestamp as a localized relative time ("5 minutes ago"). Older than 30 days falls back to a date.
 */
export function formatTemporalRelative(isoString: string | null | undefined, locale: string): string {
    if (!isoString) return "-";
    try {
        const instant = Temporal.Instant.from(isoString);
        const diffSeconds = Math.max(0, Math.round(Temporal.Now.instant().since(instant).total({ unit: "second" })));
        if (diffSeconds >= 30 * 86400) {
            return formatTemporalDateTime(isoString, locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        }
        const [unit, size] = RELATIVE_UNITS.find(([, size]) => diffSeconds >= size) ?? ["second", 1];
        return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-Math.floor(diffSeconds / size), unit);
    } catch {
        return isoString;
    }
}

/**
 * Format the localized duration between two timestamps (or between start and now), e.g. "1h 5m".
 */
export function formatTemporalDuration(startIso: string | null | undefined, endIso: string | null | undefined, locale: string): string {
    if (!startIso) return "-";
    try {
        const start = Temporal.Instant.from(startIso);
        const end = endIso ? Temporal.Instant.from(endIso) : Temporal.Now.instant();
        const totalSeconds = Math.max(0, Math.round(end.since(start).total({ unit: "second" })));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = hours > 0 ? 0 : totalSeconds % 60;
        return Temporal.Duration.from({ hours, minutes, seconds }).toLocaleString(locale, {
            style: "narrow",
        });
    } catch {
        return "-";
    }
}
