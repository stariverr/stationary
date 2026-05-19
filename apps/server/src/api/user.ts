import { Hono } from "hono";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { success } from "@/lib/response";
import { Code } from "@/lib/code";

const router = new Hono<AuthEnv>();

router.use("*", requireAuth);

router.get("/", (c) => {
    const user = c.get("user");
    return c.json(success(Code.SUCCESS, user));
});

export default router;
