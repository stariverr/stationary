export type RetrySyncErrorKind = "FORBIDDEN" | "INVALID_PARAMETER";

export class RetrySyncError extends Error {
    constructor(
        public readonly kind: RetrySyncErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "RetrySyncError";
    }
}
