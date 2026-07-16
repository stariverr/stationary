import { Hono } from "hono";
import { cors } from "hono/cors";
import post from "@/api/post";
import media from "@/api/media";
import task from "@/api/task";
import { env } from "@/global/env";
import user from "@/api/user";
import library from "@/api/library";
import search from "@/api/search";
import tag from "@/api/tag";
import authRouter from "@/api/auth";
import importRouter from "@/api/import";

const app = new Hono();

app.get("/", (c) => {
    return c.text("Hello Hono!");
});

app.use(
    "*",
    cors({
        origin: env.TRUSTED_ORIGINS,
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["POST", "GET", "OPTIONS"],
        exposeHeaders: ["Content-Length"],
        maxAge: 600,
        credentials: true,
    }),
);

// 自定义日志中间件：记录请求并监控响应
app.use("*", async (c, next) => {
    const { method, path } = c.req;
    console.log(`[Request] ${method} ${path}`);

    await next(); // 执行后续处理器

    const status = c.res.status;
    // 检查重定向 Location 头
    if (status >= 300 && status < 400) {
        const redirectUrl = c.res.headers.get("Location");
        console.log(`[Redirect] -> ${redirectUrl}`);
    }
});

// Mount all routes to the app
app.route("/api/auth", authRouter);
app.route("/api/post", post);
app.route("/api/media", media);
app.route("/api/import", importRouter);
app.route("/api/task", task);
app.route("/api/user", user);
app.route("/api/library", library);
app.route("/api/search", search);
app.route("/api/tag", tag);

const port = 9400;
console.log(`Server is running on port ${port}`);

export default {
    port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
};
