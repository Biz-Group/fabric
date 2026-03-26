"use client";

import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { ReactNode, useMemo } from "react";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const client = useMemo(
    () =>
      process.env.NEXT_PUBLIC_CONVEX_URL
        ? new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL)
        : null,
    [],
  );

  if (!client) return <>{children}</>;

  return (
    <ConvexProviderWithClerk client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
