import { StyleSheet } from "@react-pdf/renderer";
import type {
  AutomationPotential,
  Confidence,
  FlowNode,
} from "@/features/insights/insights-derivations";
import type { OverviewState } from "@/features/overview/overview-view-model";
import type { SummaryEvidenceLevel } from "../../../../convex/summaryV2";

// Design tokens for the process PDF export. Kept self-contained (no external
// fonts) so generation works fully offline and deterministically. Colors mirror
// the in-app flow/insights palette so the export reads as the same product.

export const COLORS = {
  ink: "#0f172a", // slate-900 — headings
  body: "#334155", // slate-700 — body copy
  muted: "#64748b", // slate-500 — secondary
  faint: "#94a3b8", // slate-400 — tertiary / captions
  hair: "#e2e8f0", // slate-200 — hairline borders
  hairStrong: "#cbd5e1", // slate-300
  surface: "#f8fafc", // slate-50 — panel fills
  surfaceAlt: "#f1f5f9", // slate-100
  white: "#ffffff",
  accent: "#4f46e5", // indigo-600 — brand accent
  accentDark: "#3730a3", // indigo-800
  accentSoft: "#eef2ff", // indigo-50
  danger: "#b91c1c",
  dangerSoft: "#fef2f2",
} as const;

export type CategoryTone = {
  base: string;
  soft: string;
  text: string;
};

// Category palette mirrors process-flow-nodes.tsx / the minimap colors.
export const CATEGORY_TONES: Record<FlowNode["category"], CategoryTone> = {
  start: { base: "#10b981", soft: "#ecfdf5", text: "#047857" },
  end: { base: "#64748b", soft: "#f1f5f9", text: "#475569" },
  action: { base: "#3b82f6", soft: "#eff6ff", text: "#1d4ed8" },
  decision: { base: "#f59e0b", soft: "#fffbeb", text: "#b45309" },
  handoff: { base: "#8b5cf6", soft: "#f5f3ff", text: "#6d28d9" },
  wait: { base: "#f97316", soft: "#fff7ed", text: "#c2410c" },
};

export const CATEGORY_LABELS: Record<FlowNode["category"], string> = {
  start: "Start",
  end: "End",
  action: "Action",
  decision: "Decision",
  handoff: "Handoff",
  wait: "Wait",
};

export const CONFIDENCE_TONES: Record<Confidence, CategoryTone & { label: string }> = {
  high: { base: "#10b981", soft: "#ecfdf5", text: "#047857", label: "High" },
  medium: { base: "#f59e0b", soft: "#fffbeb", text: "#b45309", label: "Medium" },
  low: { base: "#ef4444", soft: "#fef2f2", text: "#b91c1c", label: "Low" },
};

export const AUTOMATION_TONES: Record<
  AutomationPotential,
  CategoryTone & { label: string }
> = {
  high: { base: "#10b981", soft: "#ecfdf5", text: "#047857", label: "High" },
  medium: { base: "#eab308", soft: "#fefce8", text: "#a16207", label: "Medium" },
  low: { base: "#94a3b8", soft: "#f1f5f9", text: "#475569", label: "Low" },
  none: { base: "#cbd5e1", soft: "#f8fafc", text: "#64748b", label: "None" },
};

// Evidence strength for overview findings. Mirrors the in-app chip semantics:
// corroborated reads as settled, single-source as neutral, and an evidence gap
// takes the same amber the app reserves for attention states.
export const EVIDENCE_TONES: Record<SummaryEvidenceLevel, CategoryTone> = {
  corroborated: { base: "#10b981", soft: "#ecfdf5", text: "#047857" },
  single_source: { base: "#cbd5e1", soft: "#f1f5f9", text: "#475569" },
  inferred_gap: { base: "#f59e0b", soft: "#fffbeb", text: "#b45309" },
};

// Overview lifecycle. Amber covers every "read this with care" state, matching
// the app's stale/partial treatment.
export const OVERVIEW_STATE_TONES: Record<OverviewState, CategoryTone> = {
  missing: { base: "#cbd5e1", soft: "#f1f5f9", text: "#475569" },
  current: { base: "#10b981", soft: "#ecfdf5", text: "#047857" },
  stale: { base: "#f59e0b", soft: "#fffbeb", text: "#b45309" },
  refreshing: { base: "#6366f1", soft: "#eef2ff", text: "#4338ca" },
  partial: { base: "#f59e0b", soft: "#fffbeb", text: "#b45309" },
  failed: { base: "#ef4444", soft: "#fef2f2", text: "#b91c1c" },
};

// Page geometry (A4). Margins leave room for the fixed footer.
export const PAGE = {
  marginX: 40,
  marginTop: 40,
  marginBottom: 54,
} as const;

export const s = StyleSheet.create({
  page: {
    paddingTop: PAGE.marginTop,
    paddingBottom: PAGE.marginBottom,
    paddingHorizontal: PAGE.marginX,
    fontFamily: "Helvetica",
    fontSize: 9.5,
    // NOTE: do NOT set lineHeight here. An inherited lineHeight on the page
    // makes react-pdf render wrapped text taller than the box it measured,
    // causing overflow/overlap. lineHeight is set per-Text instead.
    color: COLORS.body,
    backgroundColor: COLORS.white,
  },

  // --- Footer (fixed) ---
  footer: {
    position: "absolute",
    bottom: 24,
    left: PAGE.marginX,
    right: PAGE.marginX,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: COLORS.hair,
    paddingTop: 6,
  },
  footerText: { fontSize: 7.5, color: COLORS.faint },

  // --- Section scaffolding ---
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  sectionAccent: {
    width: 4,
    height: 16,
    borderRadius: 2,
    backgroundColor: COLORS.accent,
    marginRight: 8,
  },
  sectionTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 14,
    color: COLORS.ink,
    letterSpacing: 0.2,
  },
  sectionKicker: {
    fontSize: 8,
    color: COLORS.faint,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.4,
    marginLeft: "auto",
  },

  // --- Generic surfaces ---
  card: {
    borderWidth: 1,
    borderColor: COLORS.hair,
    borderRadius: 7,
    backgroundColor: COLORS.white,
    padding: 11,
  },
  cardSoft: {
    borderWidth: 1,
    borderColor: COLORS.hair,
    borderRadius: 7,
    backgroundColor: COLORS.surface,
    padding: 11,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 5,
  },
  cardTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    color: COLORS.ink,
  },

  eyebrow: {
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.8,
    color: COLORS.muted,
    textTransform: "uppercase",
    marginBottom: 3,
  },
  body: { fontSize: 9.5, color: COLORS.body, lineHeight: 1.5 },
  muted: { fontSize: 9, color: COLORS.muted, lineHeight: 1.5 },
  faint: { fontSize: 8.5, color: COLORS.faint, lineHeight: 1.4 },

  // --- Chips / badges ---
  chip: {
    borderRadius: 9,
    paddingVertical: 2,
    paddingHorizontal: 6,
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
  },
  chipOutline: {
    borderWidth: 1,
    borderColor: COLORS.hairStrong,
    borderRadius: 9,
    paddingVertical: 2,
    paddingHorizontal: 6,
    fontSize: 7.5,
    color: COLORS.muted,
  },

  // --- Bullets ---
  // Plain block text with an inline marker — identical structure to the
  // summary paragraphs that render correctly. No flex row, no textIndent
  // (both miscompute height in react-pdf and cause overlap).
  bulletText: {
    fontSize: 9,
    color: COLORS.body,
    lineHeight: 1.45,
    marginBottom: 3,
  },
});
