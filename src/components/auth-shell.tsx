import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type FabricHeroProps = {
  className?: string;
};

export function FabricHero({ className }: FabricHeroProps) {
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
          <h1 className="text-6xl font-bold leading-tight tracking-tight">
            Fabric.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-neutral-600">
            Capture how your organization works through conversations. Build a
            living knowledge base, effortlessly.
          </p>
        </div>

        <p className="text-sm text-neutral-400">
          &copy; {new Date().getFullYear()} Fabric. All rights reserved.
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

export function AuthShell({
  title,
  description,
  children,
}: AuthShellProps) {
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
      <FabricHero className="hidden min-h-screen p-12 lg:flex" />

      <div className="flex min-h-screen items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-8">
          <div className="space-y-3 text-center lg:text-left">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-neutral-500 lg:hidden">
              Fabric.
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>

          <div className="rounded-3xl border border-border/70 bg-background p-6 shadow-sm sm:p-8">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export const clerkAuthAppearance = {
  elements: {
    rootBox: "w-full",
    cardBox: "w-full shadow-none",
    card: "w-full bg-transparent p-0 shadow-none",
    header: "hidden",
    footer: "mt-6",
    footerAction: "justify-center",
    footerActionText: "text-sm text-muted-foreground",
    footerActionLink:
      "text-foreground underline underline-offset-4 hover:text-foreground/80",
    dividerLine: "bg-border",
    dividerText: "text-xs uppercase tracking-[0.2em] text-muted-foreground",
    formFieldLabel: "text-sm font-medium text-foreground",
    formFieldInput:
      "h-11 rounded-xl border-border bg-background text-sm shadow-none focus:ring-2 focus:ring-ring",
    formButtonPrimary:
      "h-11 rounded-xl bg-foreground text-sm font-medium text-background hover:bg-foreground/90",
    socialButtonsBlockButton:
      "h-11 rounded-xl border-border bg-background text-sm font-medium hover:bg-muted",
    identityPreviewEditButton: "text-foreground hover:text-foreground/80",
    formResendCodeLink:
      "text-foreground underline underline-offset-4 hover:text-foreground/80",
    alertText: "text-sm",
    formFieldWarningText: "text-xs",
    formFieldSuccessText: "text-xs",
    otpCodeFieldInput:
      "h-11 rounded-xl border-border bg-background text-sm shadow-none focus:ring-2 focus:ring-ring",
  },
};
