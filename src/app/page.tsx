"use client";

import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { useEffect } from "react";
import { SignIn } from "@clerk/nextjs";
import { api } from "../../convex/_generated/api";
import { MillerColumns } from "@/components/miller-columns";
import { ProfileOnboarding } from "@/components/profile-onboarding";

function AuthenticatedApp() {
  const user = useQuery(api.users.getMe);
  const storeUser = useMutation(api.users.store);

  useEffect(() => {
    storeUser();
  }, [storeUser]);

  if (user === undefined) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading your workspace...</p>
      </div>
    );
  }

  if (user === null || !user.profileComplete) {
    return <ProfileOnboarding />;
  }

  return (
    <div className="flex h-screen flex-col">
      <MillerColumns />
    </div>
  );
}

function LandingPage() {
  return (
    <div className="flex min-h-screen">
      {/* Left panel — branding */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden bg-neutral-100 flex-col justify-between p-12 text-black">
        {/* Decorative arcs */}
        <div className="absolute inset-0 opacity-[0.2]">
          <svg className="absolute -right-32 top-1/4 h-[600px] w-[600px]" viewBox="0 0 600 600" fill="none">
            <circle cx="300" cy="300" r="200" stroke="black" strokeWidth="1" />
            <circle cx="300" cy="300" r="260" stroke="black" strokeWidth="0.5" />
            <circle cx="300" cy="300" r="140" stroke="black" strokeWidth="0.5" />
          </svg>
        </div>

        <div className="relative z-10">
          <h1 className="text-5xl font-bold tracking-tight leading-tight mt-16">
            Fabric.
          </h1>
          <p className="mt-6 text-lg text-neutral-600 max-w-md leading-relaxed">
            Capture how your organization works through voice conversations. Build a living knowledge base, effortlessly.
          </p>
        </div>

        <p className="relative z-10 text-sm text-neutral-400">
          &copy; {new Date().getFullYear()} Fabric. All rights reserved.
        </p>
      </div>

      {/* Right panel — Clerk sign-in */}
      <div className="flex w-full lg:w-1/2 flex-col items-center justify-center px-6 py-12 bg-background">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-2 text-center lg:text-center">
            <h2 className="text-3xl font-bold tracking-tight lg:hidden">Fabric.</h2>
            <p className="text-2xl font-semibold">Welcome Back!</p>
            <p className="text-sm text-muted-foreground">
              Sign in to continue to your workspace
            </p>
          </div>
          <SignIn
            appearance={{
              elements: {
                rootBox: "w-full",
                cardBox: "w-full shadow-none",
                card: "w-full shadow-none p-0 bg-transparent",
                header: "hidden",
                footer: "hidden",
                formButtonPrimary:
                  "bg-foreground hover:bg-foreground/90 text-background rounded-lg h-11 text-sm font-medium",
                formFieldInput:
                  "rounded-lg border-border bg-background h-11 text-sm focus:ring-2 focus:ring-ring",
                socialButtonsBlockButton:
                  "rounded-lg border-border bg-background hover:bg-muted h-11 text-sm font-medium",
                dividerLine: "bg-border",
                dividerText: "text-muted-foreground text-xs",
                formFieldLabel: "text-sm font-medium text-foreground",
                identityPreviewEditButton: "text-primary",
                formResendCodeLink: "text-primary",
                footerActionLink: "text-primary hover:text-primary/80",
              },
            }}
            routing="hash"
            forceRedirectUrl="/"
          />
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LandingPage />;
  }

  return <AuthenticatedApp />;
}
