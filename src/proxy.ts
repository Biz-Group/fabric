import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// `isPublicPath` matches routes that do not require an active org:
// marketing landing at apex and the Clerk sign-in/up pages.
const isPublicPath = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
    return NextResponse.rewrite(url);
  },
  {
    // After rewrite, the URL path starts with `/<slug>`. Clerk matches this
    // against the patterns below and sets the slug as the active org on the
    // session, so `identity.orgId` flows through to Convex.
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
