import { Temporal } from "@js-temporal/polyfill";

export const nowDbTimestamp = () => Temporal.Now.instant();
