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

/**
 * Format an ISO timestamp into a humanized relative time description (e.g., "5 秒前", "10 分钟前", "2 小时前")
 * using Temporal API.
 */
export function formatTemporalRelative(isoString: string | null | undefined, locale = "zh-CN"): string {
    if (!isoString) return "-";
    try {
        const instant = Temporal.Instant.from(isoString);
        const now = Temporal.Now.instant();
        const diffSeconds = Math.round(Number(now.since(instant, { largestUnit: "second" }).total({ unit: "second" })));

        if (diffSeconds < 0) return "刚刚";
        if (diffSeconds < 5) return "刚刚";
        if (diffSeconds < 60) return `${diffSeconds} 秒前`;
        const diffMinutes = Math.floor(diffSeconds / 60);
        if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
        const diffHours = Math.floor(diffMinutes / 60);
        if (diffHours < 24) return `${diffHours} 小时前`;
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 30) return `${diffDays} 天前`;

        return formatTemporalDateTime(isoString, locale, {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return isoString;
    }
}

/**
 * Format the duration between two timestamps (or between start and now) using Temporal API.
 */
export function formatTemporalDuration(startIso: string | null | undefined, endIso?: string | null | undefined): string {
    if (!startIso) return "-";
    try {
        const start = Temporal.Instant.from(startIso);
        const end = endIso ? Temporal.Instant.from(endIso) : Temporal.Now.instant();
        const diffSeconds = Math.max(0, Math.round(Number(end.since(start, { largestUnit: "second" }).total({ unit: "second" }))));

        if (diffSeconds < 1) return "< 1 秒";
        if (diffSeconds < 60) return `${diffSeconds} 秒`;
        const minutes = Math.floor(diffSeconds / 60);
        const remainingSeconds = diffSeconds % 60;
        if (minutes < 60) {
            return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
        }
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return `${hours} 小时 ${remMinutes} 分`;
    } catch {
        return "-";
    }
}
