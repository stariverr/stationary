import type { AsyncTaskType } from "@/db/schema";
import type { TaskHandler } from "@/infra/jobs/types";

/** Registry map for decoupled task handler strategy instances */
const taskHandlers = new Map<AsyncTaskType, TaskHandler>();

export const HandlerRegistry = {
    /**
     * Register a TaskHandler strategy for a specific AsyncTaskType.
     *
     * @param type The unique task type string (e.g. COVER_BATCH, COVER_RECONCILE, POST_PROCESS)
     * @param handler The strategy implementation conforming to TaskHandler interface
     */
    register(type: AsyncTaskType, handler: TaskHandler): void {
        const existing = taskHandlers.get(type);
        if (existing && existing !== handler) {
            throw new Error(`A different task handler is already registered for '${type}'`);
        }
        taskHandlers.set(type, handler);
    },

    /**
     * Retrieve a registered TaskHandler strategy instance by task type.
     *
     * @param type The task type identifier
     */
    get(type: AsyncTaskType): TaskHandler | undefined {
        return taskHandlers.get(type);
    },

    /**
     * Clear all registered handlers (mainly for testing).
     */
    clear(): void {
        taskHandlers.clear();
    },
};

/** Alias helper functions for convenience and readability */
export const registerTaskHandler = HandlerRegistry.register.bind(HandlerRegistry);
export const getTaskHandler = HandlerRegistry.get.bind(HandlerRegistry);
