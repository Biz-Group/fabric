import type { ReactNode } from "react";
import { clerkClient } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { getTenantSubdomain } from "@/lib/subdomain";
import { cn } from "@/lib/utils";
import {
  WorkspaceBrandLockup,
  type WorkspaceBrandOrganization,
} from "@/components/workspace-brand-lockup";

type FabricHeroProps = {
  className?: string;
  organization?: WorkspaceBrandOrganization | null;
};

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "";

async function getSubdomainOrganization(): Promise<
  WorkspaceBrandOrganization | null
> {
  const host = (await headers()).get("host");
  const slug = getTenantSubdomain(host, ROOT_DOMAIN);

  if (!slug) return null;

  try {
    const client = await clerkClient();
    const organization = await client.organizations.getOrganization({ slug });

    return {
      name: organization.name,
      hasImage: organization.hasImage,
      imageUrl: organization.imageUrl,
    };
  } catch {
    return null;
  }
}

export function FabricHero({ className, organization }: FabricHeroProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-neutral-100 text-black",
        className,
      )}
    >
      <div className="absolute inset-0 opacity-[0.2]">
        <svg
          className="absolute -right-32 top-1/4 h-[600px] w-[600px]"
          viewBox="0 0 600 600"
          fill="none"
        >
          <circle cx="300" cy="300" r="200" stroke="black" strokeWidth="1" />
          <circle cx="300" cy="300" r="260" stroke="black" strokeWidth="0.5" />
          <circle cx="300" cy="300" r="140" stroke="black" strokeWidth="0.5" />
        </svg>
      </div>

      <div className="relative z-10 flex h-full flex-col justify-between gap-12">
        <div className="mt-16 max-w-2xl">
          <WorkspaceBrandLockup
            as="h1"
            organization={organization}
            className="gap-4"
            fabricClassName="text-6xl font-bold leading-tight tracking-tight"
            dividerClassName="h-12 bg-black/15"
            logoContainerClassName="h-14 max-w-56 px-0"
            initialsClassName="text-xl text-neutral-500"
          />
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-neutral-600">
            Capture how your organization works through conversations. Build a living knowledge base, effortlessly.
          </p>
        </div>

        <p className="text-sm text-neutral-400">
          &copy; {new Date().getFullYear()} Fabric. All rights reserved. Built by Biz Group.
        </p>
      </div>
    </div>
  );
}

type AuthShellProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export async function AuthShell({
  title,
  description,
  children,
}: AuthShellProps) {
  const organization = await getSubdomainOrganization();

  return (
    <div className="min-h-screen overflow-x-hidden bg-background lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
      <FabricHero
        className="hidden min-h-screen p-12 lg:flex"
        organization={organization}
      />

      <div className="flex min-h-screen w-full min-w-0 items-center justify-center px-4 py-10 sm:px-6 sm:py-12">
        <div className="w-full min-w-0 max-w-md space-y-6 sm:space-y-8">
          <div className="space-y-3 text-center lg:text-left">
            <WorkspaceBrandLockup
              as="p"
              organization={organization}
              className="justify-center gap-2 lg:hidden"
              fabricClassName="text-xs font-semibold uppercase tracking-[0.28em] text-neutral-500"
              dividerClassName="h-4 bg-border"
              logoContainerClassName="h-5 max-w-24 px-0"
              initialsClassName="text-[9px]"
            />
            <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {title}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border/70 bg-background p-4 shadow-sm sm:rounded-3xl sm:p-8">
            <div className="auth-clerk-content w-full min-w-0 max-w-full">
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const clerkAuthAppearance = {
  elements: {
    rootBox: "!w-full !min-w-0 !max-w-full",
    cardBox: "!w-full !min-w-0 !max-w-full shadow-none",
    card: "!w-full !min-w-0 !max-w-full bg-transparent p-0 shadow-none",
    main: "!w-full !min-w-0 !max-w-full",
    header: "!hidden",
    footer: "mt-6 !w-full !min-w-0 !max-w-full",
    footerAction: "justify-center",
    footerActionText: "text-sm text-muted-foreground",
    footerActionLink:
      "text-foreground underline underline-offset-4 hover:text-foreground/80",
    dividerLine: "bg-border",
    dividerText: "text-xs uppercase tracking-[0.2em] text-muted-foreground",
    form: "!w-full !min-w-0 !max-w-full",
    formField: "!w-full !min-w-0 !max-w-full",
    formFieldLabel: "text-sm font-medium text-foreground",
    formFieldInput:
      "h-11 !w-full !min-w-0 !max-w-full rounded-xl border-border bg-background text-sm shadow-none focus:ring-2 focus:ring-ring",
    formButtonPrimary:
      "h-11 !w-full !min-w-0 !max-w-full rounded-xl bg-foreground text-sm font-medium text-background hover:bg-foreground/90",
    socialButtonsBlockButton:
      "h-11 !w-full !min-w-0 !max-w-full rounded-xl border-border bg-background text-sm font-medium hover:bg-muted",
    identityPreviewEditButton: "text-foreground hover:text-foreground/80",
    formResendCodeLink:
      "text-foreground underline underline-offset-4 hover:text-foreground/80",
    alertText: "text-sm",
    formFieldWarningText: "text-xs",
    formFieldSuccessText: "text-xs",
    otpCodeFieldInput:
      "h-11 !min-w-0 !max-w-full rounded-xl border-border bg-background text-sm shadow-none focus:ring-2 focus:ring-ring",
  },
};
