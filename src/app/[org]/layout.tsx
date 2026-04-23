"use client";

import {
  useAuth,
  useClerk,
  useOrganization,
  useOrganizationList,
  useUser,
} from "@clerk/nextjs";
import { useConvexAuth } from "convex/react";
import { useParams } from "next/navigation";
import { useEffect } from "react";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";

function buildSubdomainUrl(slug: string): string {
  if (typeof window === "undefined") return "";
  const { protocol, port } = window.location;
  const rootHostname = ROOT_DOMAIN.split(":")[0];
  const host = port ? `${rootHostname}:${port}` : rootHostname;
  return `${protocol}//${slug}.${host}/`;
}

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ org: string }>();
  const slugFromUrl = params.org;
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { isLoaded: userLoaded, isSignedIn } = useUser();
  const { organization, isLoaded: orgLoaded } = useOrganization();
  const { setActive, isLoaded: orgListLoaded, userMemberships } =
    useOrganizationList({ userMemberships: true });
  // `useAuth().orgId` is the active org as recorded in the Clerk session —
  // i.e. what `{{org.id}}` will resolve to in the `convex` JWT template right
  // now. `useOrganization().organization` can lead this during the setActive
  // round-trip, which would let children mount and fire Convex queries with a
  // JWT that has an empty `orgId`, throwing "No active organization".
  const { orgId: sessionOrgId } = useAuth();

  // Clerk normally activates the correct org via middleware's
  // organizationSyncOptions once the URL path matches. In case the session
  // already held a stale active-org (e.g. the user was mid-session when the
  // slug appeared for the first time), fall back to matching the URL slug
  // against the user's memberships and activating it client-side.
  useEffect(() => {
    if (!orgListLoaded || !orgLoaded || !userLoaded || !setActive) return;
    if (!isSignedIn || !slugFromUrl) return;
    if (organization?.slug === slugFromUrl) return;

    const match = userMemberships.data?.find(
      (m) => m.organization.slug === slugFromUrl,
    );
    if (match) {
      setActive({ organization: match.organization.id });
    }
  }, [
    orgListLoaded,
    orgLoaded,
    userLoaded,
    isSignedIn,
    slugFromUrl,
    organization?.slug,
    userMemberships.data,
    setActive,
  ]);

  if (authLoading || !userLoaded || !orgLoaded) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // Middleware.auth.protect() should have redirected unauthenticated requests
  // to /sign-in. This is a belt-and-braces guard.
  if (!isAuthenticated || !isSignedIn) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Redirecting to sign in...</p>
      </div>
    );
  }

  const matchingMembership = userMemberships.data?.find(
    (m) => m.organization.slug === slugFromUrl,
  );

  // User is signed in but isn't a member of this subdomain's org. Render a
  // flat "no access" screen — never an org picker on this surface (the
  // picker is a nav-bar concern, only for multi-org admins inside the app).
  // List clickable links to whichever subdomains they DO have access to so
  // they can jump to a valid one without re-signing in. The Clerk session
  // cookie is scoped to the apex, so the link works without a fresh login.
  if (!matchingMembership) {
    const orgs = userMemberships.data ?? [];
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 p-6 text-center">
        <h2 className="text-xl font-semibold">No access to this workspace</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Your account isn&apos;t a member of {slugFromUrl}. Sign in from the
          subdomain that matches your organization.
        </p>
        {orgs.length > 0 && (
          <div className="mt-2 flex flex-col items-center gap-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Workspaces you can access
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {orgs
                .filter((m) => !!m.organization.slug)
                .map((m) => (
                  <a
                    key={m.organization.id}
                    href={buildSubdomainUrl(m.organization.slug!)}
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
                  >
                    {m.organization.name}
                  </a>
                ))}
            </div>
          </div>
        )}
        <SignOutLink />
      </div>
    );
  }

  // Signed in, has a matching membership, but Clerk hasn't activated the org
  // yet (the useEffect above is mid-flight calling setActive). Render a
  // spinner rather than mounting children with a stale JWT.
  if (!organization) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <p className="text-sm text-muted-foreground">
          Activating your workspace...
        </p>
      </div>
    );
  }

  // Clerk's local org state matches the URL, but the session cookie hasn't
  // committed the active org yet — so the JWT Convex will receive doesn't
  // carry `orgId` and any org-scoped query would throw. Wait it out instead
  // of mounting children.
  if (sessionOrgId !== organization.id) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <p className="text-sm text-muted-foreground">
          Activating your workspace...
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

function SignOutLink() {
  const { signOut } = useClerk();
  return (
    <button
      type="button"
      onClick={() => signOut({ redirectUrl: "/" })}
      className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      Sign out
    </button>
  );
}
