import * as v from 'valibot';

// Define the schema for our public environment variables
const PublicEnvSchema = v.object({
    apiBaseUrl: v.pipe(v.string(), v.minLength(1, "API Base URL is required")),
    cdnBaseUrl: v.pipe(v.string(), v.minLength(1, "CDN Base URL is required")),
});

/**
 * Get validated public environment variables.
 * This must be called within a Nuxt context (e.g., inside a component, middleware, or plugin).
 */
export const useSafeEnv = () => {
    const config = useRuntimeConfig();
    
    try {
        return v.parse(PublicEnvSchema, {
            apiBaseUrl: config.public.apiBaseUrl,
            cdnBaseUrl: config.public.cdnBaseUrl,
        });
    } catch (e) {
        console.error("Invalid environment variables:", e);
        // In development, we want to know immediately
        if (process.dev) {
            throw e;
        }
        // Fallback or handle error gracefully in production
        return config.public as v.InferOutput<typeof PublicEnvSchema>;
    }
};
