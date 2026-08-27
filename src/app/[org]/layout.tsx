"use client";

import {
  useClerk,
  useOrganization,
  useOrganizationList,
  useUser,
} from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { OrgThemeProvider } from "@/features/theming/org-theme-provider";
import { ThemeToaster } from "@/features/theming/theme-toaster";
import { LoadingScreen } from "@/components/ui/loading-screen";

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
    useOrganizationList({
      userMemberships: { infinite: true, pageSize: 100 },
    });
  const {
    hasNextPage: hasMoreMemberships,
    isFetching: fetchingMemberships,
    fetchNext: fetchNextMemberships,
  } = userMemberships;
  const activeOrg = useQuery(api.users.getActiveOrg);
  const matchingMembership = userMemberships.data?.find(
    (m) => m.organization.slug === slugFromUrl,
  );
  const targetOrgId = matchingMembership?.organization.id;

  // Clerk paginates userMemberships (default page size). Platform staff are
  // fanned out to every tenant, so a user can have more memberships than one
  // page holds — drain all pages before concluding non-membership, otherwise a
  // real member of a later page hits the "not in this workspace" screen.
  useEffect(() => {
    if (hasMoreMemberships && !fetchingMemberships) {
      fetchNextMemberships();
    }
  }, [hasMoreMemberships, fetchingMemberships, fetchNextMemberships]);

  // Clerk's organization sync patterns only match pathnames. Since this app
  // encodes the org in the subdomain and rewrites `/` to `/<slug>` later in
  // proxy, we still need a client-side `setActive` fallback for initial hits.
  useEffect(() => {
    if (!orgListLoaded || !orgLoaded || !userLoaded || !setActive) return;
    if (!isSignedIn || !slugFromUrl) return;
    if (!targetOrgId) return;

    const clerkOrgReady = organization?.id === targetOrgId;
    const convexOrgReady = activeOrg?.orgId === targetOrgId;
    if (clerkOrgReady && convexOrgReady) return;

    void setActive({ organization: targetOrgId });
  }, [
    orgListLoaded,
    orgLoaded,
    userLoaded,
    isSignedIn,
    slugFromUrl,
    targetOrgId,
    organization?.id,
    activeOrg?.orgId,
    setActive,
  ]);

  if (authLoading || !userLoaded || !orgLoaded || !orgListLoaded) {
    return <LoadingScreen message="Loading workspace..." />;
  }

  // Middleware.auth.protect() should have redirected unauthenticated requests
  // to /sign-in. This is a belt-and-braces guard.
  if (!isAuthenticated || !isSignedIn) {
    return <LoadingScreen message="Redirecting to sign in..." showSpinner={false} />;
  }

  // Don't conclude non-membership until every membership page has loaded —
  // the target org may still be on a not-yet-fetched page.
  if (
    !matchingMembership &&
    (userMemberships.hasNextPage || userMemberships.isFetching)
  ) {
    return <LoadingScreen message="Loading workspace..." />;
  }

  // User is signed in but isn't a member of this subdomain's org yet.
  // Enrollment is open: offer to join this workspace directly (same API the
  // sign-up/sign-in handoff uses), and list the subdomains they already have
  // access to. The Clerk session cookie is scoped to the apex, so those links
  // work without a fresh login.
  if (!matchingMembership) {
    const orgs = userMemberships.data ?? [];
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 p-6 text-center">
        <h2 className="text-xl font-semibold">
          You&apos;re not in this workspace yet
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Your account isn&apos;t a member of {slugFromUrl}. You can join it
          now, or switch to a workspace you already belong to.
        </p>
        <JoinWorkspaceButton />
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

  // Don't mount org-scoped children until Convex confirms the JWT actually
  // carries the target org. This prevents first-render queries from throwing
  // "No active organization" while Clerk finishes activating the session.
  if (organization?.id !== targetOrgId || activeOrg?.orgId !== targetOrgId) {
    return <LoadingScreen message="Activating your workspace..." />;
  }

  return (
    <OrgThemeProvider>
      {children}
      <ThemeToaster />
    </OrgThemeProvider>
  );
}

function JoinWorkspaceButton() {
  const { setActive } = useClerk();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = async () => {
    setJoining(true);
    setError(null);
    try {
      const response = await fetch("/api/join-subdomain-organization", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          data?.error ?? "We could not join this workspace. Please try again.",
        );
      }
      const data = (await response.json()) as { organizationId: string };
      await setActive({ organization: data.organizationId });
      // Full reload so useOrganizationList picks up the new membership and
      // the layout re-evaluates from a clean slate.
      window.location.reload();
    } catch (joinError) {
      setError(
        joinError instanceof Error
          ? joinError.message
          : "We could not join this workspace. Please try again.",
      );
      setJoining(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => void handleJoin()}
        disabled={joining}
        className="h-11 rounded-xl bg-foreground px-5 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-60"
      >
        {joining ? "Joining..." : "Join this workspace"}
      </button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function SignOutLink() {
  const { signOut } = useClerk();
  return (
    <button
      type="button"
      onClick={() => signOut({ redirectUrl: "/sign-in" })}
      className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      Sign out
    </button>
  );
}
