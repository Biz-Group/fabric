"use client";

import { useQuery, useMutation } from "convex/react";
import { useEffect } from "react";
import { api } from "../../../convex/_generated/api";
import { MillerColumns } from "@/components/miller-columns";
import { ProfileOnboarding } from "@/components/profile-onboarding";

export default function OrgHomePage() {
  const user = useQuery(api.users.getMe);
  const storeUser = useMutation(api.users.store);

  useEffect(() => {
    void storeUser();
  }, [storeUser]);

  if (user === undefined) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading your workspace...</p>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <p className="text-sm text-muted-foreground">
          Setting up your workspace...
        </p>
      </div>
    );
  }

  if (!user.profileComplete) {
    return <ProfileOnboarding />;
  }

  return (
    <div className="flex h-screen flex-col">
      <MillerColumns />
    </div>
  );
}
