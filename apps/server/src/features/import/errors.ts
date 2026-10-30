export type ImportErrorKind = "NOT_FOUND" | "INVALID_PARAMETER" | "CONFLICT";

export class ImportError extends Error {
    constructor(
        public readonly kind: ImportErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "ImportError";
    }
}
