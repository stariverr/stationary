export type LibraryMoveErrorKind = "NOT_FOUND" | "INVALID_PARAMETER";

export class LibraryMoveError extends Error {
    constructor(
        public readonly kind: LibraryMoveErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "LibraryMoveError";
    }
}

export type LibraryDeleteErrorKind = "NOT_FOUND" | "NOT_EMPTY" | "INTERNAL";

export class LibraryDeleteError extends Error {
    constructor(
        public readonly kind: LibraryDeleteErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "LibraryDeleteError";
    }
}
