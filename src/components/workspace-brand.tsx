"use client";

import { useOrganization } from "@clerk/nextjs";
import { WorkspaceBrandLockup } from "@/components/workspace-brand-lockup";

type WorkspaceBrandProps = {
  className?: string;
  showOrganization?: boolean;
  fabricClassName?: string;
  dividerClassName?: string;
  logoContainerClassName?: string;
  initialsClassName?: string;
};

export function WorkspaceBrand({
  className,
  showOrganization = true,
  fabricClassName,
  dividerClassName,
  logoContainerClassName,
  initialsClassName,
}: WorkspaceBrandProps) {
  const { organization } = useOrganization();

  return (
    <WorkspaceBrandLockup
      className={className}
      organization={showOrganization ? organization : null}
      fabricClassName={fabricClassName}
      dividerClassName={dividerClassName}
      logoContainerClassName={logoContainerClassName}
      initialsClassName={initialsClassName}
    />
  );
}
