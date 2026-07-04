import { Hono } from "hono";
import { auth } from "@/lib/auth/index";

const authRouter = new Hono();

/**
 * 1. Mobile Social Auth Callback (GET /api/auth/mobile-callback)
 *
 * This endpoint acts as the bridge between standard Web OAuth and the Flutter client.
 *
 * Flow:
 * - The social provider (e.g. GitHub/Google) redirects back to the server.
 * - better-auth completes login and sets the session cookie in the browser/webview.
 * - better-auth then redirects to this callback.
 * - This endpoint retrieves the authenticated session, extracts the bearer token,
 *   and redirects the user using the custom scheme `stationary://auth?token=<TOKEN>`.
 * - The Flutter client intercepts this URI scheme to retrieve and store the session token.
 */
authRouter.get("/mobile-callback", async (c) => {
    const session = await auth.api.getSession({
        headers: c.req.raw.headers,
    });
    if (!session) {
        return c.text("Authentication failed. No session found.", 401);
    }
    const token = session.session.token;
    console.log(`[Mobile Callback] Success, redirecting with token to app...`);
    return c.redirect(`stationary://auth?token=${encodeURIComponent(token)}`);
});

/**
 * 2. Initiate Social Login for Mobile (GET /api/auth/login/social/:provider)
 *
 * Initiates the social login flow for mobile clients.
 *
 * Why this is needed:
 * - better-auth's sign-in endpoint (/api/auth/sign-in/social) is a POST endpoint requiring JSON payload.
 * - In-app webviews or system browsers opened from a mobile app can only initiate GET requests.
 * - This endpoint serves an HTML wrapper that performs the POST request using fetch
 *   and redirects the webview to the social provider's authorization page.
 */
authRouter.get("/login/social/:provider", async (c) => {
    const provider = c.req.param("provider");
    const callbackURL = c.req.query("callbackURL");
    return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Redirecting...</title>
        </head>
        <body>
            <p>Connecting to ${provider}... Please wait.</p>
            <script>
                fetch('/api/auth/sign-in/social', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        provider: "${provider}",
                        callbackURL: "${callbackURL}"
                    })
                })
                .then(res => {
                    if (!res.ok) {
                        return res.text().then(text => { throw new Error(text) });
                    }
                    return res.json();
                })
                .then(data => {
                    if (data.url) {
                        window.location.href = data.url;
                    } else {
                        document.body.innerHTML = "<p>Error: No redirect URL returned from authentication server.</p>";
                    }
                })
                .catch(err => {
                    console.error(err);
                    document.body.innerHTML = "<p>Error: " + err.message + "</p>";
                });
            </script>
        </body>
        </html>
    `);
});

/**
 * 3. better-auth Catch-All Handler (ALL /api/auth/*)
 *
 * Passes all other requests (such as /api/auth/sign-in/email, /api/auth/session, etc.)
 * directly to the better-auth library handler.
 *
 * Note: Hono matches routes sequentially. This catch-all must remain last so the custom
 * GET routes above are matched and processed first.
 */
authRouter.all("/*", (c) => auth.handler(c.req.raw));

export default authRouter;
