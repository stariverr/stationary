import { Context, Next } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { timingSafeEqual } from "hono/utils/buffer";
import { auth } from "./index";
import { db } from "@/global/db";
import { env } from "@/global/env";
import { User, ExternalApiToken } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Code } from "@/lib/code";
import { error } from "@/lib/response";
import { ApiTokenService } from "@/features/auth/api-token";
import { findOwnedLibrary } from "@/features/library/access";

export type AuthEnv = {
    Variables: {
        user: typeof User.$inferSelect | null;
        authUser: typeof auth.$Infer.Session.user | null;
        session: typeof auth.$Infer.Session.session | null;
        apiToken: typeof ExternalApiToken.$inferSelect | null;
    };
};

/** Resolves a library the caller owns and its API token may reach; a miss stays a 404 so it never reveals that the library exists. */
export function ownedLibrary(c: Context<AuthEnv>, userId: string, libraryId: string) {
    return findOwnedLibrary(libraryId, { ownerId: userId, scopedLibraryId: c.get("apiToken")?.library_id });
}

/**
 * Common helper to resolve authentication from either:
 * 1. Developer API Tokens (Authorization: Bearer st_...)
 * 2. Better-Auth Sessions (via Cookie or Authorization: Bearer <session_token>)
 */
async function resolveAuth(c: Context<AuthEnv>) {
    let user: typeof User.$inferSelect | null = null;
    let authUser: typeof auth.$Infer.Session.user | null = null;
    let session: typeof auth.$Infer.Session.session | null = null;
    let apiToken: typeof ExternalApiToken.$inferSelect | null = null;

    const authHeader = c.req.header("Authorization");
    const queryToken = c.req.query("token") || c.req.query("api_token");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
    const rawToken = bearerToken || queryToken;

    // 1. Try resolving via Developer API Token first
    if (rawToken) {
        const tokenRecord = await ApiTokenService.verifyToken(rawToken);
        if (tokenRecord) {
            const businessUsers = await db.select().from(User).where(eq(User.id, tokenRecord.owner_id)).limit(1);
            user = businessUsers[0] || null;
            apiToken = tokenRecord;
        }
    }

    // 2. If not a developer token, retrieve session via better-auth
    // (better-auth's bearer plugin automatically handles Bearer tokens in addition to Cookies)
    if (!apiToken) {
        const sessionResult = await auth.api.getSession({
            headers: c.req.raw.headers,
        });
        if (sessionResult) {
            const businessUsers = await db.select().from(User).where(eq(User.auth_id, sessionResult.user.id)).limit(1);
            user = businessUsers[0] || null;
            authUser = sessionResult.user;
            session = sessionResult.session;
        }
    }

    return { user, authUser, session, apiToken };
}

export const authMiddleware = async (c: Context<AuthEnv>, next: Next) => {
    const authData = await resolveAuth(c);
    c.set("user", authData.user);
    c.set("authUser", authData.authUser);
    c.set("session", authData.session);
    c.set("apiToken", authData.apiToken);
    return next();
};

export const requireAuth = async (c: Context<AuthEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader && !authHeader.startsWith("Bearer ")) {
        return c.json(error(Code.UNAUTHORIZED, "Invalid authorization format"), 401);
    }

    const { user, authUser, session, apiToken } = await resolveAuth(c);

    // If neither session nor apiToken was resolved
    if (!session && !apiToken) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    // If authenticated but profile creation is not completed
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "User profile not found"), 401);
    }

    c.set("user", user);
    c.set("authUser", authUser);
    c.set("session", session);
    c.set("apiToken", apiToken);
    return next();
};

const cronAuthFailure = { message: error(Code.UNAUTHORIZED, "Unauthorized") };

/**
 * Guards routes called by a scheduler rather than a user (Authorization: Bearer <CRON_SECRET>).
 * Every request is refused while CRON_SECRET is unset, in all environments.
 */
export const requireCronSecret = bearerAuth({
    verifyToken: (token) => !!env.CRON_SECRET && timingSafeEqual(env.CRON_SECRET, token),
    noAuthenticationHeader: cronAuthFailure,
    invalidAuthenticationHeader: cronAuthFailure,
    invalidToken: cronAuthFailure,
});
