import { Context, Next } from "hono";
import { auth } from "./index";
import { db } from "@/global/db";
import { User } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Code } from "@/lib/code";
import { error } from "@/lib/response";

export type AuthEnv = {
    Variables: {
        user: typeof User.$inferSelect | null;
        authUser: typeof auth.$Infer.Session.user | null;
        session: typeof auth.$Infer.Session.session | null;
    };
};

export const authMiddleware = async (c: Context<AuthEnv>, next: Next) => {
    const session = await auth.api.getSession({
        headers: c.req.raw.headers,
    });

    if (!session) {
        c.set("authUser", null);
        c.set("user", null);
        c.set("session", null);
        return next();
    }

    const businessUsers = await db.select().from(User).where(eq(User.auth_id, session.user.id)).limit(1);
    const user = businessUsers[0] || null;

    c.set("authUser", session.user);
    c.set("user", user);
    c.set("session", session.session);
    return next();
};

export const requireAuth = async (c: Context<AuthEnv>, next: Next) => {
    const session = await auth.api.getSession({
        headers: c.req.raw.headers,
    });

    if (!session) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const businessUsers = await db.select().from(User).where(eq(User.auth_id, session.user.id)).limit(1);
    const user = businessUsers[0];

    if (!user) {
        // This shouldn't happen due to the hook, but good for safety
        return c.json(error(Code.UNAUTHORIZED, "User profile not found"), 401);
    }

    c.set("authUser", session.user);
    c.set("user", user);
    c.set("session", session.session);
    return next();
};
