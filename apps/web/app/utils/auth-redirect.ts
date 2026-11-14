// Where to go after signing in: the in-app path the user originally asked for,
// carried in the login page's `redirect` query. Anything that is not a same-site
// path (e.g. "//evil.com" or "https://...") falls back to the home page.
export function authRedirectTarget(value: unknown): string {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
