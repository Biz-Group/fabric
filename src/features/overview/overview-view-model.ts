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
  hasEvidenceSource = true,
  childUnit?: string,
): string | null {
  if (state !== "stale" && state !== "missing" && state !== "partial") {
    return null;
  }
  if (!hasEvidenceSource) {
    // No control changes this state, whoever is reading. Recording a
    // conversation — or building one child, a level up — is the only step that
    // does, so the hint names that instead of promising a build that would find
    // nothing to read.
    return childUnit
      ? `Build one of its ${childUnit} before rolling this overview up.`
      : "Complete a process conversation before building this overview.";
  }
  const action =
    state === "missing" ? "Build the overview" : "Rebuild the overview";
  return canRefresh
    ? `${action} when you are ready.`
    : `A contributor or admin can ${action.toLowerCase()}.`;
}

export function overviewProgressText(
  progress: { completed: number; total: number } | null | undefined,
  unit?: string,
): string | null {
  if (!progress) return null;
  return `${Math.min(progress.completed, progress.total)} of ${progress.total}${
    unit ? ` ${unit}` : ""
  } complete`;
}

/**
 * The explanation behind the status chip. The overview itself leads the page, so
 * this text is disclosed on demand rather than printed as a banner above the
 * content. `null` means the state needs no explanation — the chip stays a plain
 * label. `failed` is excluded on purpose: an error carries its own message and
 * stays visible instead of being collapsed.
 */
export function overviewStatusDetail(
  state: OverviewState,
  progress: { completed: number; total: number } | null | undefined,
  unit: string | undefined,
  canRefresh: boolean,
  hasEvidenceSource = true,
): string | null {
  if (state !== "stale" && state !== "partial" && state !== "missing") {
    return null;
  }
  const progressText = overviewProgressText(progress, unit);
  return [
    OVERVIEW_STATE_META[state].description,
    progressText ? `${progressText}.` : null,
    overviewActionHint(state, canRefresh, hasEvidenceSource, unit),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Why the rebuild control is inert, or `null` when it is live.
 *
 * Generation is the expensive step, so the read model turns the control off
 * once the overview already reflects every source available to it — a second
 * pass would re-derive the same brief at full token cost. A dead control with
 * no explanation reads as a bug, so the reason travels with it.
 */
export function refreshUnavailableReason(
  state: OverviewState,
  refreshAvailable: boolean,
  childUnit?: string,
  hasEvidenceSource = true,
): string | null {
  // `refreshing` hides the control rather than disabling it.
  if (refreshAvailable || state === "refreshing") return null;
  if (!hasEvidenceSource) {
    // Nothing to build from at all: a process with no completed conversation,
    // or a rollup whose children hold no overview to read. Pressing Build used
    // to reach the source scan, find nothing, and report a failed refresh; the
    // control now names the one thing that unblocks it instead.
    //
    // Only a rollup surface passes a child unit, which is what separates the
    // two — the same signal the `partial` message below reads.
    return childUnit
      ? `No ${childUnit} have an overview to roll up yet. Build becomes available once one is built.`
      : "No conversation has been completed for this process yet. Build becomes available once one is recorded.";
  }
  if (state === "partial") {
    // A rollup left incomplete by children that have no overview of their own —
    // a process nobody has recorded a conversation for yet, most often. Naming
    // the actual next step beats repeating that nothing has changed, because
    // something can be done about this one.
    return `Some ${childUnit ?? "children"} have no overview of their own yet. Rebuild becomes available once they are built.`;
  }
  return "This overview already covers every source available to it. Rebuild becomes available once new evidence is recorded.";
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
