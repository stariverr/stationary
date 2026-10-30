export class RetrySyncError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RetrySyncError";
    }
}
