export type QueueAiErrorKind = "FORBIDDEN" | "INVALID_PARAMETER";

export class QueueAiError extends Error {
    constructor(
        public readonly kind: QueueAiErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "QueueAiError";
    }
}
