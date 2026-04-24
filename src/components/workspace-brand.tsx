"use client";

import { useOrganization } from "@clerk/nextjs";
import { WorkspaceBrandLockup } from "@/components/workspace-brand-lockup";

export function WorkspaceBrand({ className }: { className?: string }) {
  const { organization } = useOrganization();

  return (
    <WorkspaceBrandLockup className={className} organization={organization} />
  );
}
