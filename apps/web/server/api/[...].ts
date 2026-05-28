// import { defineEventHandler, proxyRequest } from 'h3';

const config = useRuntimeConfig();
export default defineEventHandler(async (event) => {
    // 1. 动态获取后端配置，避免写死 127.0.0.1:9400
    const apiBaseUrl = config.public.apiBaseUrl || "http://127.0.0.1:9400";
    const targetUrl = `${apiBaseUrl}${event.path}`;

    // 3. 完美恢复使用您最熟悉的 proxyRequest 方式，并开启 manual 重定向透传
    return proxyRequest(event, targetUrl, {
        fetchOptions: {
            // 🌟 魔法就在这里：禁止代理服务器在服务端自动跟随重定向！
            // 必须设为 manual，才能让 302 状态码和 Set-Cookie 穿透代理，真正到达用户的浏览器
            // 否则 OAuth (Better Auth) 登录成功之后的 Set-Cookie 和 302 重定向会被 Nitro 内部消化
            redirect: "manual",
        },
    });
});
