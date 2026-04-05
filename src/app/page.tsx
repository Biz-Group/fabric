"use client";

import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { useEffect } from "react";
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
    return null; // Clerk middleware will redirect to sign-in
  }

  return <AuthenticatedApp />;
}
