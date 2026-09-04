"use client";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

const TOKEN_REFRESH_LEAD_MS = 30_000;

export function useConversationAudioUrl(
  clerkOrgId: string | null | undefined,
  conversationId: Id<"conversations">,
): string | null {
  const getAudioPlaybackToken = useAction(api.postCall.getAudioPlaybackToken);
  const requestKey = `${clerkOrgId ?? ""}:${conversationId}`;
  const [audioState, setAudioState] = useState<{
    requestKey: string;
    url: string | null;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    async function refreshToken() {
      try {
        const token = await getAudioPlaybackToken({ conversationId });
        if (disposed) return;
        if (!token) {
          setAudioState({ requestKey, url: null });
          return;
        }

        const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
        if (!convexUrl) {
          setAudioState({ requestKey, url: null });
          return;
        }

        const siteUrl = convexUrl.replace(".cloud", ".site");
        const url = new URL(
          `/audio/${encodeURIComponent(token.clerkOrgId)}/${encodeURIComponent(conversationId)}`,
          siteUrl,
        );
        url.searchParams.set("exp", String(token.exp));
        url.searchParams.set("mid", token.membershipId);
        url.searchParams.set("sig", token.sig);
        setAudioState({ requestKey, url: url.toString() });

        const refreshIn = Math.max(
          1_000,
          token.exp - Date.now() - TOKEN_REFRESH_LEAD_MS,
        );
        refreshTimer = setTimeout(() => void refreshToken(), refreshIn);
      } catch {
        if (!disposed) setAudioState({ requestKey, url: null });
      }
    }

    if (clerkOrgId) void refreshToken();

    return () => {
      disposed = true;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [clerkOrgId, conversationId, getAudioPlaybackToken, requestKey]);

  return audioState?.requestKey === requestKey ? audioState.url : null;
}
