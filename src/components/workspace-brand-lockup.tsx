import { cn } from "@/lib/utils";

export type WorkspaceBrandOrganization = {
  name?: string | null;
  hasImage?: boolean | null;
  imageUrl?: string | null;
};

type WorkspaceBrandLockupProps = {
  as?: "div" | "h1" | "p";
  className?: string;
  organization?: WorkspaceBrandOrganization | null;
  fabricClassName?: string;
  dividerClassName?: string;
  logoContainerClassName?: string;
  initialsClassName?: string;
};

function getInitials(name: string) {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) return "FB";

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function getSafeImageSrc(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function WorkspaceBrandLockup({
  as: Component = "div",
  className,
  organization,
  fabricClassName,
  dividerClassName,
  logoContainerClassName,
  initialsClassName,
}: WorkspaceBrandLockupProps) {
  const orgName = organization?.name ?? "";
  const imageSrc = getSafeImageSrc(organization?.imageUrl ?? "");
  const showOrgMark = Boolean(organization);
  const showOrgLogo = Boolean(organization?.hasImage && imageSrc);

  return (
    <Component className={cn("flex min-w-0 items-center gap-3", className)}>
      <span
        className={cn(
          "truncate text-lg font-semibold tracking-tight",
          fabricClassName,
        )}
      >
        Fabric.
      </span>
      {showOrgMark && (
        <>
          <span
            aria-hidden="true"
            className={cn("h-5 w-px bg-border", dividerClassName)}
          />
          <span
            className={cn(
              "flex h-8 max-w-32 shrink-0 items-center justify-center overflow-hidden px-2",
              logoContainerClassName,
            )}
            title={orgName}
            aria-label={orgName ? `${orgName} workspace` : "Workspace"}
          >
            {showOrgLogo ? (
              <img
                src={imageSrc}
                alt={orgName ? `${orgName} logo` : "Workspace logo"}
                className="block max-h-full w-auto max-w-full object-contain"
              />
            ) : (
              <span
                className={cn(
                  "text-[11px] font-semibold uppercase text-muted-foreground",
                  initialsClassName,
                )}
              >
                {getInitials(orgName)}
              </span>
            )}
          </span>
        </>
      )}
    </Component>
  );
}
