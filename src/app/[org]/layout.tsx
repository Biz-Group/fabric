"use client";

import {
  useAuth,
  useOrganization,
  useOrganizationList,
  useUser,
} from "@clerk/nextjs";
import { useConvexAuth } from "convex/react";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { OrganizationList } from "@clerk/nextjs";

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

  // Active org exists but doesn't match the URL subdomain → show the picker.
  // This covers: user visits a subdomain they aren't a member of.
  if (organization && organization.slug !== slugFromUrl) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
        <div className="max-w-md text-center">
          <h2 className="text-xl font-semibold">
            You&apos;re not a member of &quot;{slugFromUrl}&quot;
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Pick an organization you have access to:
          </p>
        </div>
        <OrganizationList hidePersonal afterSelectOrganizationUrl={`/`} />
      </div>
    );
  }

  // Signed in but no active org selected yet. If a matching membership exists,
  // the useEffect above is mid-flight calling setActive — render a spinner
  // rather than the picker (flashing a picker for single-org users is ugly).
  // If no matching membership, surface the picker so the user can pick
  // something they're actually in.
  if (!organization) {
    const hasMatchingMembership = userMemberships.data?.some(
      (m) => m.organization.slug === slugFromUrl,
    );
    if (hasMatchingMembership) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          <p className="text-sm text-muted-foreground">
            Activating your workspace...
          </p>
        </div>
      );
    }
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
        <div className="max-w-md text-center">
          <h2 className="text-xl font-semibold">Select an organization</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            You need to pick an organization before using Fabric.
          </p>
        </div>
        <OrganizationList hidePersonal afterSelectOrganizationUrl={`/`} />
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
