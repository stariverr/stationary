export type TagErrorKind = "FORBIDDEN" | "NOT_FOUND" | "INVALID_PARAMETER" | "CONFLICT";

export class TagError extends Error {
    constructor(
        public readonly kind: TagErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "TagError";
    }
}
