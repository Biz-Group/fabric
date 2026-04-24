"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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

export function JoinSubdomainOrganization() {
  const router = useRouter();
  const { setActive } = useClerk();
  const { isLoaded, userId } = useAuth({ treatPendingAsSignedOut: false });
  const hasStarted = useRef(false);
  const [error, setError] = useState<string | null>(null);

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
      await setActive({ organization: data.organizationId });
      router.replace("/");
      router.refresh();
    }

    void joinOrganization().catch((joinError: unknown) => {
      setError(
        joinError instanceof Error
          ? joinError.message
          : "We could not join this workspace. Please try again.",
      );
    });
  }, [isLoaded, router, setActive, userId]);

  if (error) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm leading-6 text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => {
            hasStarted.current = false;
            setError(null);
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
