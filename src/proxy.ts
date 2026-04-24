import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getTenantSubdomain } from "@/lib/subdomain";

// Auth pages live only on tenant subdomains, never on apex. Apex is pure
// marketing.
const isAuthPath = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);
const isJoinOrganizationPath = createRouteMatcher([
  "/join-organization(.*)",
  "/api/join-subdomain-organization",
]);
// `isPublicPath` is what middleware lets through without an auth.protect.
// On the apex, only the marketing landing. On a subdomain, only auth pages and
// the signup org-join handoff are public — tenant `/` stays the workspace
// entrypoint and redirects signed-out users to `/sign-in`.
const isApexPublicPath = createRouteMatcher(["/"]);
const isSubdomainPublicPath = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

// Root domain, with port for local dev. Dev: "lvh.me:3000", prod: "bizfabric.ai".
// Unset = treat every request as apex (legacy single-tenant dev without subdomains).
const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";

export default clerkMiddleware(
  async (auth, req) => {
    const host = req.headers.get("host");
    const subdomain = getTenantSubdomain(host, ROOT_DOMAIN);

    // Apex request — marketing landing only. Anyone hitting /sign-in or
    // /sign-up on the apex gets redirected to the marketing page (sign-in is
    // a per-tenant flow, not a global one).
    if (!subdomain) {
      if (isAuthPath(req) || isJoinOrganizationPath(req)) {
        const url = req.nextUrl.clone();
        url.pathname = "/";
        return NextResponse.redirect(url);
      }
      if (!isApexPublicPath(req)) await auth.protect();
      return;
    }

    // Subdomain request → rewrite internally to /<subdomain>/<path> so the
    // Next.js `src/app/[org]/...` tree resolves. Auth pages and the signup
    // org-join handoff are NOT rewritten — they live at top-level routes and
    // render directly on each subdomain.
    if (isAuthPath(req) || isJoinOrganizationPath(req)) return;

    const url = req.nextUrl.clone();
    if (
      url.pathname === `/${subdomain}` ||
      url.pathname.startsWith(`/${subdomain}/`)
    ) {
      // Defensive — path already rewritten; don't double-prefix.
      if (!isSubdomainPublicPath(req)) await auth.protect();
      return;
    }
    url.pathname = `/${subdomain}${url.pathname}`;

    if (!isSubdomainPublicPath(req)) await auth.protect();
    return NextResponse.rewrite(url);
  },
  {
    // Clerk matches organization patterns against the incoming request path.
    // Since this app carries the org in the subdomain and only rewrites the
    // pathname later, the client-side `setActive` fallback in `[org]/layout`
    // is still needed for initial hits to `/` on a tenant subdomain.
    organizationSyncOptions: {
      organizationPatterns: ["/:slug", "/:slug/(.*)"],
    },
  },
);

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
