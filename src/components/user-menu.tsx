"use client";

import Link from "next/link";
import {
  OrganizationSwitcher,
  UserButton,
  useOrganizationList,
} from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Settings } from "lucide-react";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";

function rootHostname(): string {
  return ROOT_DOMAIN.split(":")[0] ?? "";
}

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const membership = useQuery(api.users.getMyMembership);
  const role = membership?.role ?? "viewer";
  const { userMemberships } = useOrganizationList({ userMemberships: true });
  // Show the switcher only to users who actually have somewhere to switch to —
  // i.e. super-admins fanned out across multiple tenants. Single-org users
  // never need it.
  const isMultiOrgUser = (userMemberships.data?.length ?? 0) > 1;

  // When the user picks a different org in the switcher, Clerk redirects to
  // this URL. We use the current port so local dev on lvh.me works.
  const afterSelectUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol}//:slug.${
          window.location.port
            ? `${rootHostname()}:${window.location.port}`
            : rootHostname()
        }/`
      : undefined;

  return (
    <div className={compact ? "flex min-w-0 items-center gap-1.5" : "flex items-center gap-2"}>
      {isMultiOrgUser && (
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl={afterSelectUrl}
          appearance={{
            elements: {
              rootBox: compact ? "flex min-w-0 items-center" : "flex items-center",
              organizationSwitcherTrigger:
                compact
                  ? "h-8 max-w-36 rounded-lg px-2 text-xs font-medium hover:bg-muted"
                  : "h-7 rounded-md px-2 text-xs font-medium hover:bg-muted",
            },
          }}
        />
      )}
      {role === "admin" && (
        <Link
          href="/admin"
          aria-label="Admin settings"
          className={
            compact
              ? "flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              : "flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          }
        >
          <Settings className="size-3.5" />
          <span className={compact ? "sr-only" : "hidden sm:inline"}>Admin</span>
        </Link>
      )}
      <span className={compact ? "hidden" : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground"}>
        {role}
      </span>
      <UserButton />
    </div>
  );
}
