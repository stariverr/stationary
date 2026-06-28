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

export const authMiddleware = async (c: Context<AuthEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const rawToken = authHeader.substring(7);
        const tokenRecord = await ApiTokenService.verifyToken(rawToken);
        if (tokenRecord) {
            const businessUsers = await db.select().from(User).where(eq(User.id, tokenRecord.owner_id)).limit(1);
            const user = businessUsers[0] || null;
            c.set("user", user);
            c.set("apiToken", tokenRecord);
            c.set("authUser", null);
            c.set("session", null);
            return next();
        }
    }

    const session = await auth.api.getSession({
        headers: c.req.raw.headers,
    });

    if (!session) {
        c.set("authUser", null);
        c.set("user", null);
        c.set("session", null);
        c.set("apiToken", null);
        return next();
    }

    const businessUsers = await db.select().from(User).where(eq(User.auth_id, session.user.id)).limit(1);
    const user = businessUsers[0] || null;

    c.set("authUser", session.user);
    c.set("user", user);
    c.set("session", session.session);
    c.set("apiToken", null);
    return next();
};

export const requireAuth = async (c: Context<AuthEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader) {
        if (!authHeader.startsWith("Bearer ")) {
            return c.json(error(Code.UNAUTHORIZED, "Invalid authorization format"), 401);
        }
        const rawToken = authHeader.substring(7);
        const tokenRecord = await ApiTokenService.verifyToken(rawToken);
        if (!tokenRecord) {
            return c.json(error(Code.UNAUTHORIZED, "Invalid or expired API token"), 401);
        }

        const businessUsers = await db.select().from(User).where(eq(User.id, tokenRecord.owner_id)).limit(1);
        const user = businessUsers[0];
        if (!user) {
            return c.json(error(Code.UNAUTHORIZED, "User profile not found"), 401);
        }

        c.set("user", user);
        c.set("apiToken", tokenRecord);
        c.set("authUser", null);
        c.set("session", null);
        return next();
    }

    const session = await auth.api.getSession({
        headers: c.req.raw.headers,
    });

    if (!session) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const businessUsers = await db.select().from(User).where(eq(User.auth_id, session.user.id)).limit(1);
    const user = businessUsers[0];

    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "User profile not found"), 401);
    }

    c.set("authUser", session.user);
    c.set("user", user);
    c.set("session", session.session);
    c.set("apiToken", null);
    return next();
};
