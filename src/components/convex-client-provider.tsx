"use client"

import { ConvexProvider, ConvexReactClient } from "convex/react"
import { ReactNode, useMemo } from "react"

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const client = useMemo(
    () =>
      process.env.NEXT_PUBLIC_CONVEX_URL
        ? new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL)
        : null,
    []
  )

  if (!client) return <>{children}</>

  return <ConvexProvider client={client}>{children}</ConvexProvider>
}
