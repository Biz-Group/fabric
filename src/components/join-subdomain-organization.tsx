"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import { useAction, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";

type JoinResponse = {
  organizationId: string;
};

type ErrorResponse = {
  error?: string;
};

async function getErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as ErrorResponse;
    if (data.error) return data.error;
  } catch {
    // Fall through to the generic message.
  }
  return "We could not join this workspace. Please try again.";
}

const FABRIC_PROFILE_SYNC_ERROR =
  "We joined you to the workspace, but could not finish setting up your Fabric profile. Please try again.";

export function JoinSubdomainOrganization() {
  const router = useRouter();
  const { setActive } = useClerk();
  const { isLoaded, orgId, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const syncFabricProfile = useAction(api.users.syncCurrentUserFromClerk);
  const storeUser = useMutation(api.users.store);
  const hasStarted = useRef(false);
  const hasSynced = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [targetOrganizationId, setTargetOrganizationId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!isLoaded || hasStarted.current) return;

    if (!userId) {
      router.replace("/sign-in");
      return;
    }

    hasStarted.current = true;

    async function joinOrganization() {
      const response = await fetch("/api/join-subdomain-organization", {
        method: "POST",
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(await getErrorMessage(response));
      }

      const data = (await response.json()) as JoinResponse;
      setTargetOrganizationId(data.organizationId);
      await setActive({ organization: data.organizationId });
    }

    void joinOrganization().catch((joinError: unknown) => {
      setError(
        joinError instanceof Error
          ? joinError.message
          : "We could not join this workspace. Please try again.",
      );
    });
  }, [isLoaded, router, setActive, userId]);

  useEffect(() => {
    if (
      !isLoaded ||
      !targetOrganizationId ||
      orgId !== targetOrganizationId ||
      hasSynced.current
    ) {
      return;
    }

    hasSynced.current = true;

    async function syncProfile() {
      try {
        await syncFabricProfile();
      } catch (syncError) {
        console.error(
          "Failed to sync Fabric profile from Clerk; falling back to JWT profile",
          syncError,
        );
        await storeUser();
      }

      router.replace("/");
      router.refresh();
    }

    void syncProfile().catch((syncError: unknown) => {
      console.error("Failed to finish Fabric profile setup", syncError);
      setError(
        syncError instanceof Error
          ? FABRIC_PROFILE_SYNC_ERROR
          : "We could not join this workspace. Please try again.",
      );
    });
  }, [
    isLoaded,
    orgId,
    router,
    storeUser,
    syncFabricProfile,
    targetOrganizationId,
  ]);

  if (error) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm leading-6 text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => {
            hasStarted.current = false;
            hasSynced.current = false;
            setError(null);
            setTargetOrganizationId(null);
          }}
          className="h-11 rounded-xl bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-6">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      <p className="text-sm text-muted-foreground">
        Preparing your workspace...
      </p>
    </div>
  );
}
