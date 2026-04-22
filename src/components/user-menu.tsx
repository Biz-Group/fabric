"use client";

import Link from "next/link";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Settings } from "lucide-react";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";

function rootHostname(): string {
  return ROOT_DOMAIN.split(":")[0] ?? "";
}

export function UserMenu() {
  const membership = useQuery(api.users.getMyMembership);
  const role = membership?.role ?? "viewer";

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
    <div className="flex items-center gap-2">
      <OrganizationSwitcher
        hidePersonal
        afterSelectOrganizationUrl={afterSelectUrl}
        appearance={{
          elements: {
            rootBox: "flex items-center",
            organizationSwitcherTrigger:
              "h-7 rounded-md px-2 text-xs font-medium hover:bg-muted",
          },
        }}
      />
      {role === "admin" && (
        <Link
          href="/admin"
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Settings className="size-3.5" />
          <span className="hidden sm:inline">Admin</span>
        </Link>
      )}
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
        {role}
      </span>
      <UserButton />
    </div>
  );
}
