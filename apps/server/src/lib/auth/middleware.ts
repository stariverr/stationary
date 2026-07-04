import { Context, Next } from "hono";
import { auth } from "./index";
import { db } from "@/global/db";
import { User, ExternalApiToken } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Code } from "@/lib/code";
import { error } from "@/lib/response";
import { ApiTokenService } from "@/services/apiToken";

export type AuthEnv = {
    Variables: {
        user: typeof User.$inferSelect | null;
        authUser: typeof auth.$Infer.Session.user | null;
        session: typeof auth.$Infer.Session.session | null;
        apiToken: typeof ExternalApiToken.$inferSelect | null;
    };
};

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

    // 1. Try resolving via Developer API Token first
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const rawToken = authHeader.substring(7);
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
