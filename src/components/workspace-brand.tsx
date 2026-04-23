"use client";

import { useOrganization } from "@clerk/nextjs";
import { cn } from "@/lib/utils";

function getInitials(name: string) {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) return "FB";

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export function WorkspaceBrand({ className }: { className?: string }) {
  const { organization } = useOrganization();
  const orgName = organization?.name ?? "";
  const showOrgMark = Boolean(organization);

  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <span className="truncate text-lg font-semibold tracking-tight">
        Fabric.
      </span>
      {showOrgMark && (
        <>
          <span aria-hidden="true" className="h-5 w-px bg-border" />
          <div
            className="flex h-8 max-w-32 shrink-0 items-center justify-center overflow-hidden px-2"
            title={orgName}
            aria-label={orgName ? `${orgName} workspace` : "Workspace"}
          >
            {organization?.hasImage ? (
              <img
                src={organization.imageUrl}
                alt={orgName ? `${orgName} logo` : "Workspace logo"}
                className="block max-h-full w-auto max-w-full object-contain"
              />
            ) : (
              <span className="text-[11px] font-semibold uppercase text-muted-foreground">
                {getInitials(orgName)}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
