import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

<<<<<<< Updated upstream
export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
=======
// Root domain, with port for local dev. Dev: "lvh.me:3000", prod: "fabric.com".
// Unset = treat every request as apex (legacy single-tenant dev without subdomains).
const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";

/** Returns the subdomain (e.g. "biz-group") or null if on apex / www / app. */
function getSubdomain(host: string | null): string | null {
  if (!host || !ROOT_DOMAIN) return null;
  const hostname = host.split(":")[0];
  const rootHostname = ROOT_DOMAIN.split(":")[0];
  if (hostname === rootHostname || hostname === `www.${rootHostname}`) return null;
  if (!hostname.endsWith(`.${rootHostname}`)) return null;
  const sub = hostname.slice(0, -rootHostname.length - 1);
  if (!sub || sub === "www" || sub === "app") return null;
  return sub;
}

export default clerkMiddleware(
  async (auth, req) => {
    const host = req.headers.get("host");
    const subdomain = getSubdomain(host);

    // Apex request → marketing landing + auth pages.
    if (!subdomain) {
      if (!isPublicPath(req)) await auth.protect();
      return;
    }

    // Public paths on a subdomain (sign-in / sign-up) must pass through to the
    // root route tree, not the `[org]` tree. Without this, auth.protect() below
    // would infinite-redirect unauthenticated visitors: / → /sign-in → /sign-in
    // rewrites to /:slug/sign-in → auth.protect → /sign-in → loop.
    if (isPublicPath(req)) return;

    // Subdomain request → rewrite internally to /<subdomain>/<path> so the
    // Next.js `src/app/[org]/...` tree resolves. Clerk's organizationSyncOptions
    // (below) then matches against the rewritten path and auto-activates the
    // matching org on the session.
    const url = req.nextUrl.clone();
    if (
      url.pathname === `/${subdomain}` ||
      url.pathname.startsWith(`/${subdomain}/`)
    ) {
      // Defensive — path already rewritten; don't double-prefix.
      await auth.protect();
      return;
    }
    url.pathname = `/${subdomain}${url.pathname}`;

    // auth.protect() must run for non-public paths. Running it before returning
    // the rewrite means Clerk has a chance to redirect to /sign-in if not
    // authenticated. All subdomain paths are considered protected.
>>>>>>> Stashed changes
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
