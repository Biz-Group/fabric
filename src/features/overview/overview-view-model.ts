export type OverviewState =
  | "missing"
  | "current"
  | "stale"
  | "refreshing"
  | "partial"
  | "failed";

export type EvidenceLevel =
  | "corroborated"
  | "single_source"
  | "inferred_gap";

export type SurfaceReadiness = {
  available: boolean;
  stale: boolean;
  generationStatus: "idle" | "generating" | "ready" | "failed";
} | null;

export const OVERVIEW_STATE_META: Record<
  OverviewState,
  { label: string; description: string }
> = {
  missing: {
    label: "Not documented",
    description: "No overview has been generated from process evidence yet.",
  },
  current: {
    label: "Current",
    description: "This overview reflects the latest available evidence.",
  },
  stale: {
    label: "New evidence",
    description:
      "New evidence has been recorded since this overview was generated. The previous overview is shown until it is rebuilt.",
  },
  refreshing: {
    label: "Refreshing",
    description: "New evidence is being synthesized in the background.",
  },
  partial: {
    label: "Partial coverage",
    description: "The overview is useful, but not every eligible source was included.",
  },
  failed: {
    label: "Refresh failed",
    description: "The latest refresh failed; the previous overview remains available.",
  },
};

export function evidenceStrengthLabel(
  level: EvidenceLevel,
  supportCount: number,
): string {
  if (level === "corroborated") {
    return `Corroborated · ${supportCount} ${supportCount === 1 ? "source" : "sources"}`;
  }
  if (level === "inferred_gap") return "Evidence gap";
  return "Single source";
}

export function surfaceReadinessLabel(
  readiness: SurfaceReadiness,
): string {
  if (!readiness) return "Not available";
  if (readiness.generationStatus === "generating") return "Generating";
  if (readiness.generationStatus === "failed") return "Generation failed";
  if (readiness.stale) return "New evidence available";
  if (readiness.available) return "Ready";
  return "Not generated";
}

/**
 * What to do about a state that will not resolve on its own. Generation is a
 * human action, so a state needing one says so — and says who, since Rebuild is
 * contributor and admin only.
 */
export function overviewActionHint(
  state: OverviewState,
  canRefresh: boolean,
): string | null {
  if (state !== "stale" && state !== "missing" && state !== "partial") {
    return null;
  }
  const action =
    state === "missing" ? "Build the overview" : "Rebuild the overview";
  return canRefresh
    ? `${action} when you are ready.`
    : `A contributor or admin can ${action.toLowerCase()}.`;
}

export function refreshActionLabel(
  state: OverviewState,
  hasContent: boolean,
): string {
  if (state === "refreshing") return "Refreshing";
  if (!hasContent || state === "missing") return "Build overview";
  if (state === "stale" || state === "partial" || state === "failed") {
    return "Refresh overview";
  }
  return "Rebuild overview";
}

export function formatGeneratedTime(epochMs: number | null): string {
  if (epochMs === null) return "Not generated yet";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochMs));
}

export type OverviewCopyContent = {
  format: "v2" | "legacy" | "none";
  markdown: string | null;
};

/**
 * Clipboard output is the deterministic Markdown projection the read model
 * derives from the structured artifact — the same projection stored for legacy
 * consumers and rendered by the PDF fallback. Copy therefore never reorders,
 * re-words, or omits artifact content, and identical artifacts always copy
 * identically.
 */
export function overviewCopyText(content: OverviewCopyContent): string | null {
  const markdown = content.markdown?.trim();
  return markdown ? markdown : null;
}

export function legacyPreviewText(markdown: string | null): string {
  if (!markdown) return "No overview has been generated yet.";
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}
