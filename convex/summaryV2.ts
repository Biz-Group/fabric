import { type Infer, v } from "convex/values";

/**
 * Immutable prompt identifiers. Bump the relevant identifier whenever its
 * prompt or strict tool contract changes; never reinterpret an existing ID.
 */
export const SUMMARY_V2_PROMPT_VERSIONS = {
  // v2 restated the evidence output budget in the prompt and tightened the
  // strict tool caps. v1 invited up to ~28k tokens of JSON on a 1,536-token
  // budget, so any conversation with real content truncated and produced no
  // evidence at all. Re-extraction is required, and wanted: every v1 row that
  // truncated has nothing stored.
  conversationEvidence: "summary-v2-conversation-evidence-v2",
  // v2 replaced the ordered stage timeline with non-sequential scope and
  // participant findings. Process Flow owns step order; two independently
  // generated sequences over the same transcripts always disagreed.
  // v3 asks the brief to emphasize its load-bearing facts with `**bold**` so a
  // reader can scan it. Stored v2 artifacts stay valid and simply render
  // unemphasized until they are next rebuilt.
  processOverview: "summary-v2-process-overview-v3",
  // v2 restated the rollup output budget in the prompt and moved both rollup
  // schemas onto their own tighter caps. v1 reused the process caps — five
  // sections of eight 1,200-character findings, ~17.9k tokens of contract — on
  // a 3,072-token budget, so any department with more than one child process
  // truncated and stored nothing.
  // v3 adds the same executive-brief emphasis instruction as the process
  // overview.
  departmentOverview: "summary-v2-department-overview-v3",
  functionOverview: "summary-v2-function-overview-v3",
  legacyMarkdown: "summary-v2-legacy-markdown-v2",
} as const;

/**
 * Bounded persistence and prompt-output limits locked in Phase 0.
 *
 * The `conversation*` caps are the strict tool contract for evidence
 * extraction, so they are also an output-size *request*: a model asked for 40
 * steps of 800 characters will try to deliver them. Keep them proportional to
 * `SUMMARY_V2_AI_BUDGETS.conversationEvidence.maxTokens` — see
 * `conversationEvidenceMaxOutputTokens()` below, which is asserted in tests.
 *
 * The `hierarchy*` caps are the same kind of request for the department and
 * function rollups. They are separate from `findingGroup` / `findingBodyChars`
 * because the two contracts answer to different budgets and different input:
 * the process overview reduces raw interview evidence one process at a time,
 * while a rollup reduces N child artifacts that are already summaries. Sharing
 * one set of caps is what put a ~17.9k-token contract on the smallest budget
 * of the three reduce stages.
 */
export const SUMMARY_V2_CAPS = {
  findingGroup: 8,
  sourcesPerFinding: 8,
  headlineChars: 120,
  findingTitleChars: 120,
  findingBodyChars: 1_200,
  executiveBriefChars: 1_800,
  sourceLabelChars: 120,
  hierarchyFindingGroup: 5,
  hierarchyFindingBodyChars: 700,
  hierarchyExecutiveBriefChars: 1_600,
  conversationSteps: 18,
  conversationEvidenceGroup: 10,
  conversationStepTitleChars: 120,
  conversationStepBodyChars: 400,
  conversationEvidenceItemChars: 200,
  reduceChunkSources: 20,
} as const;

/** Conservative characters-per-token for dense, escaped JSON tool arguments. */
const JSON_CHARS_PER_TOKEN = 3.5;

/** The six flat string arrays in the evidence contract. */
const CONVERSATION_EVIDENCE_GROUP_COUNT = 6;

/**
 * Finding sections in each rollup schema — `crossProcessDependencies`,
 * `sharedPatterns`, `variationsAndTensions`, `gaps`, `notable` for a
 * department, and the function schema's equivalents.
 */
const HIERARCHY_OVERVIEW_SECTION_COUNT = 5;

/**
 * Output tokens the evidence schema demands if the model fills every cap.
 *
 * This is the check that was missing when the stage shipped: nothing compared
 * the size of the contract against the budget that has to hold it. A truncated
 * call is billed work that produces nothing — extraction throws rather than
 * persist half an evidence document — so the contract cannot be allowed to
 * outgrow the budget again.
 */
export function conversationEvidenceMaxOutputTokens(): number {
  const caps = SUMMARY_V2_CAPS;
  // Per step: `{"title":"…","body":"…"},` — 30 chars of JSON scaffolding.
  const stepChars =
    caps.conversationSteps *
    (caps.conversationStepTitleChars + caps.conversationStepBodyChars + 30);
  const groupChars =
    CONVERSATION_EVIDENCE_GROUP_COUNT *
    caps.conversationEvidenceGroup *
    (caps.conversationEvidenceItemChars + 5);
  return Math.ceil((stepChars + groupChars + 200) / JSON_CHARS_PER_TOKEN);
}

/**
 * How far `conversationEvidenceMaxOutputTokens()` may exceed the budget.
 *
 * Not 1.0, because the caps are per-item ceilings that real content never
 * saturates — no contributor supplies 18 four-hundred-character steps *and* ten
 * items in all six groups — and holding the worst case under budget would mean
 * discarding detail from every ordinary interview to insure against one
 * extreme. Truncation on that extreme is recoverable: extraction retries once
 * with a tightened instruction. The shipped configuration was 18x, which is not
 * an extreme, it is a routine failure.
 */
export const CONVERSATION_EVIDENCE_CAP_BUDGET_RATIO = 2;

/**
 * Output tokens the department and function rollup schemas demand if the model
 * fills every cap. Both share `overviewSchema()`, so one number covers both.
 *
 * This is the check `conversationEvidenceMaxOutputTokens()` got and the rollup
 * stage did not. The configuration it rules out is the one that shipped: the
 * process caps (five sections of eight findings at 1,200 characters, ~17.9k
 * tokens) against `finalReduce`'s 3,072, which is 5.8x. Measured against that,
 * a department of five processes truncated on both attempts and stored
 * nothing, and departments of one child spent 76-83% of the budget — so the
 * ceiling was not merely exceeded at the extreme, it was exceeded by two
 * children.
 */
export function hierarchyOverviewMaxOutputTokens(): number {
  const caps = SUMMARY_V2_CAPS;
  // Per finding: `{"title":"…","body":"…","evidenceLevel":"corroborated",
  // "sourceKeys":["P12",…]},` — 90 chars of JSON scaffolding and key names,
  // the longest enum value, and the source-key array at its cap.
  const findingChars =
    caps.findingTitleChars +
    caps.hierarchyFindingBodyChars +
    "corroborated".length +
    caps.sourcesPerFinding * 8 +
    90;
  const sectionChars =
    HIERARCHY_OVERVIEW_SECTION_COUNT *
    caps.hierarchyFindingGroup *
    findingChars;
  return Math.ceil(
    (sectionChars +
      caps.headlineChars +
      caps.hierarchyExecutiveBriefChars +
      200) /
      JSON_CHARS_PER_TOKEN,
  );
}

/**
 * How far `hierarchyOverviewMaxOutputTokens()` may exceed its budget.
 *
 * Same reasoning as `CONVERSATION_EVIDENCE_CAP_BUDGET_RATIO`, and the same
 * value: the caps are per-item ceilings, and no real rollup fills five
 * sections with five 700-character findings each. Unlike evidence extraction,
 * a truncated rollup is not retried into a tightened prompt — the retry reuses
 * the same prompt at temperature 0 — so the headroom here is the only thing
 * standing between a wide contract and a deterministic failure.
 */
export const HIERARCHY_OVERVIEW_CAP_BUDGET_RATIO = 2;

/**
 * Initial request budgets; generation phases consume these constants later.
 *
 * `conversationEvidence` was 1,536 tokens against a schema that invited ~28k.
 * A 16-minute interview (4.7k input tokens) came back `stop_reason:
 * "max_tokens"` at exactly 1,536 output tokens in 19s of a 120s allowance:
 * budget-bound, with 6x the clock to spare. The budget is now the most the
 * 120s timeout supports at the worst measured throughput
 * (`maxTokensForTimeout(120_000)` = 3,770), and the caps above were cut to
 * match it.
 */
export const SUMMARY_V2_AI_BUDGETS = {
  conversationEvidence: {
    maxTokens: 3_584,
    timeoutMs: 120_000,
    maxRetries: 2,
  },
  chunkReduce: { maxTokens: 4_096, timeoutMs: 150_000, maxRetries: 2 },
  finalReduce: { maxTokens: 5_632, timeoutMs: 180_000, maxRetries: 1 },
  /**
   * The department and function rollups reduce child artifacts rather than raw
   * evidence, and they were the one stage running the widest schema on the
   * smallest budget: `finalReduce`'s 3,072 tokens, which is *less* than
   * `chunkReduce` gets for a narrower contract.
   *
   * 5,632 is the most a 180s timeout supports at the worst measured throughput
   * (`maxTokensForTimeout(180_000)` = 5,720). `maxRetries` drops to 1 because
   * the ceiling is per attempt: 2 x 180s = 360s leaves room under the 10-minute
   * Convex action limit, where 3 x 180s = 540s would not once prompt paging is
   * counted. Transient provider failures are still covered — the run-level
   * retry in `failHierarchyFinal` reschedules a fresh action.
   */
  hierarchyFinalReduce: {
    maxTokens: 5_632,
    timeoutMs: 180_000,
    maxRetries: 1,
  },
} as const;

/** Per-artifact section caps, so the schema and the normalizer cannot drift. */
export type OverviewSectionCaps = {
  readonly group: number;
  readonly bodyChars: number;
  readonly briefChars: number;
};

const PROCESS_OVERVIEW_SECTION_CAPS: OverviewSectionCaps = {
  group: SUMMARY_V2_CAPS.findingGroup,
  bodyChars: SUMMARY_V2_CAPS.findingBodyChars,
  briefChars: SUMMARY_V2_CAPS.executiveBriefChars,
};

/** Exported so `overviewSchema()` requests exactly what normalization keeps. */
export const HIERARCHY_OVERVIEW_SECTION_CAPS: OverviewSectionCaps = {
  group: SUMMARY_V2_CAPS.hierarchyFindingGroup,
  bodyChars: SUMMARY_V2_CAPS.hierarchyFindingBodyChars,
  briefChars: SUMMARY_V2_CAPS.hierarchyExecutiveBriefChars,
};

export const summaryEvidenceLevelValidator = v.union(
  v.literal("corroborated"),
  v.literal("single_source"),
  v.literal("inferred_gap"),
);

export const summarySourceRefValidator = v.union(
  v.object({
    kind: v.literal("conversation"),
    conversationId: v.id("conversations"),
    label: v.string(),
  }),
  v.object({
    kind: v.literal("process"),
    processId: v.id("processes"),
    label: v.string(),
  }),
  v.object({
    kind: v.literal("department"),
    departmentId: v.id("departments"),
    label: v.string(),
  }),
);

export const summaryFindingValidator = v.object({
  id: v.string(),
  title: v.string(),
  body: v.string(),
  evidenceLevel: summaryEvidenceLevelValidator,
  supportCount: v.number(),
  sources: v.array(summarySourceRefValidator),
});

export const summaryCoverageValidator = v.object({
  includedSources: v.number(),
  totalEligibleSources: v.number(),
  uniqueContributors: v.optional(v.number()),
  complete: v.boolean(),
});

export const summaryProvenanceValidator = v.object({
  sourceSnapshotHash: v.string(),
  generatedAt: v.number(),
  promptVersion: v.string(),
  provider: v.string(),
  model: v.string(),
});

const artifactBaseValidators = {
  schemaVersion: v.literal("v2"),
  sourceMode: v.literal("interview_evidence"),
  headline: v.string(),
  executiveBrief: v.string(),
  coverage: summaryCoverageValidator,
  provenance: summaryProvenanceValidator,
};

export const processOverviewArtifactV2Validator = v.object({
  ...artifactBaseValidators,
  /**
   * What the process covers and who runs it: trigger, completion, owning roles,
   * systems of record, and upstream/downstream dependencies. Deliberately
   * unordered — the Process Flow graph is the only surface that states sequence.
   */
  scope: v.array(summaryFindingValidator),
  consensus: v.array(summaryFindingValidator),
  variations: v.array(summaryFindingValidator),
  gaps: v.array(summaryFindingValidator),
  notable: v.array(summaryFindingValidator),
});

export const departmentOverviewArtifactV2Validator = v.object({
  ...artifactBaseValidators,
  crossProcessDependencies: v.array(summaryFindingValidator),
  sharedPatterns: v.array(summaryFindingValidator),
  variationsAndTensions: v.array(summaryFindingValidator),
  gaps: v.array(summaryFindingValidator),
  notable: v.array(summaryFindingValidator),
});

export const functionOverviewArtifactV2Validator = v.object({
  ...artifactBaseValidators,
  crossDepartmentDependencies: v.array(summaryFindingValidator),
  strategicPatterns: v.array(summaryFindingValidator),
  variationsAndTensions: v.array(summaryFindingValidator),
  gaps: v.array(summaryFindingValidator),
  notable: v.array(summaryFindingValidator),
});

export const conversationEvidenceStepV2Validator = v.object({
  id: v.string(),
  title: v.string(),
  body: v.string(),
});

export const processSummaryEvidenceV2Validator = v.object({
  schemaVersion: v.literal("v2"),
  sourceMode: v.literal("interview_evidence"),
  steps: v.array(conversationEvidenceStepV2Validator),
  actors: v.array(v.string()),
  tools: v.array(v.string()),
  handoffsAndDependencies: v.array(v.string()),
  reportedVariations: v.array(v.string()),
  frictionPoints: v.array(v.string()),
  uncertainties: v.array(v.string()),
  transcriptHash: v.string(),
  promptVersion: v.string(),
  generatedAt: v.number(),
  provider: v.string(),
  model: v.string(),
});

export const conversationEvidenceFailureCodeV2Validator = v.union(
  v.literal("not_configured"),
  v.literal("truncated"),
  v.literal("invalid_output"),
  v.literal("generation_failed"),
);

export const conversationEvidenceFailureV2Validator = v.object({
  transcriptHash: v.string(),
  promptVersion: v.string(),
  generationId: v.string(),
  failedAt: v.number(),
  code: conversationEvidenceFailureCodeV2Validator,
});

export const summaryRunStateValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("partial"),
  v.literal("failed"),
);

export const summaryRunStageValidator = v.union(
  v.literal("evidence"),
  v.literal("chunk_reduce"),
  v.literal("final_reduce"),
  v.literal("rollup_reduce"),
);

export const summaryRunProgressValidator = v.object({
  stage: summaryRunStageValidator,
  completed: v.number(),
  total: v.number(),
});

export const summaryRunErrorValidator = v.object({
  code: v.string(),
  message: v.string(),
  retryable: v.boolean(),
});

export const summaryRunSourceSnapshotValidator = v.object({
  hash: v.string(),
  includedSources: v.number(),
  totalEligibleSources: v.number(),
  currentSources: v.optional(v.number()),
  complete: v.optional(v.boolean()),
});

export const processSummarySourceInputValidator = v.object({
  key: v.string(),
  conversationId: v.id("conversations"),
  label: v.string(),
  transcriptHash: v.string(),
  promptVersion: v.string(),
});

export const processSummarySourceScanValidator = v.object({
  cursor: v.optional(v.string()),
  eligibleSources: v.number(),
  includedSources: v.number(),
  nextOrdinal: v.number(),
  nextChunkIndex: v.number(),
  hashFirst: v.number(),
  hashSecond: v.number(),
  hashLength: v.number(),
  pendingSources: v.array(processSummarySourceInputValidator),
});

export const hierarchyChildStateValidator = v.union(
  v.literal("current"),
  v.literal("partial"),
  v.literal("refreshing"),
  v.literal("stale"),
  v.literal("missing"),
  v.literal("failed"),
);

export const hierarchySummarySourceInputValidator = v.union(
  v.object({
    kind: v.literal("process"),
    key: v.string(),
    processId: v.id("processes"),
    label: v.string(),
    state: v.union(v.literal("current"), v.literal("partial")),
    artifactSnapshotHash: v.string(),
    artifactPromptVersion: v.string(),
    artifactGeneratedAt: v.number(),
  }),
  v.object({
    kind: v.literal("department"),
    key: v.string(),
    departmentId: v.id("departments"),
    label: v.string(),
    state: v.union(v.literal("current"), v.literal("partial")),
    artifactSnapshotHash: v.string(),
    artifactPromptVersion: v.string(),
    artifactGeneratedAt: v.number(),
  }),
);

export const hierarchySummaryRollupPhaseValidator = v.union(
  v.literal("refresh_children"),
  v.literal("wait_children"),
  v.literal("scan_sources"),
  v.literal("final_reduce"),
);

export const hierarchySummarySourceScanValidator = v.object({
  cursor: v.optional(v.string()),
  eligibleSources: v.number(),
  includedSources: v.number(),
  currentSources: v.number(),
  completedSources: v.number(),
  nextOrdinal: v.number(),
  nextChunkIndex: v.number(),
  hashFirst: v.number(),
  hashSecond: v.number(),
  hashLength: v.number(),
  pendingSources: v.array(hierarchySummarySourceInputValidator),
});

export const summaryChunkStateValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
);

export const summaryChunkSectionKeyValidator = v.union(
  v.literal("scope"),
  v.literal("consensus"),
  v.literal("variations"),
  v.literal("cross_process_dependencies"),
  v.literal("shared_patterns"),
  v.literal("cross_department_dependencies"),
  v.literal("strategic_patterns"),
  v.literal("variations_and_tensions"),
  v.literal("gaps"),
  v.literal("notable"),
);

export const summaryChunkOutputV2Validator = v.object({
  schemaVersion: v.literal("v2"),
  headline: v.optional(v.string()),
  executiveBrief: v.optional(v.string()),
  sections: v.array(
    v.object({
      key: summaryChunkSectionKeyValidator,
      findings: v.array(summaryFindingValidator),
    }),
  ),
  coverage: summaryCoverageValidator,
});

/** The exact successful summary snapshot used by a new Process Flow run. */
export const flowSummarySourceSnapshotValidator = v.object({
  sourceSnapshotHash: v.string(),
  summaryGeneratedAt: v.number(),
  summaryPromptVersion: v.string(),
});

export type SummaryEvidenceLevel = Infer<typeof summaryEvidenceLevelValidator>;
export type SummarySourceRef = Infer<typeof summarySourceRefValidator>;
export type SummaryFinding = Infer<typeof summaryFindingValidator>;
export type SummaryCoverage = Infer<typeof summaryCoverageValidator>;
export type SummaryProvenance = Infer<typeof summaryProvenanceValidator>;
export type ProcessOverviewArtifactV2 = Infer<
  typeof processOverviewArtifactV2Validator
>;
export type DepartmentOverviewArtifactV2 = Infer<
  typeof departmentOverviewArtifactV2Validator
>;
export type FunctionOverviewArtifactV2 = Infer<
  typeof functionOverviewArtifactV2Validator
>;
export type SummaryArtifactV2 =
  | ProcessOverviewArtifactV2
  | DepartmentOverviewArtifactV2
  | FunctionOverviewArtifactV2;
export type ProcessSummaryEvidenceV2 = Infer<
  typeof processSummaryEvidenceV2Validator
>;
export type ConversationEvidenceFailureCodeV2 = Infer<
  typeof conversationEvidenceFailureCodeV2Validator
>;
export type SummaryRunState = Infer<typeof summaryRunStateValidator>;
export type SummaryRunProgress = Infer<typeof summaryRunProgressValidator>;
export type SummaryRunError = Infer<typeof summaryRunErrorValidator>;
export type SummaryChunkOutputV2 = Infer<typeof summaryChunkOutputV2Validator>;
export type ProcessSummarySourceInput = Infer<
  typeof processSummarySourceInputValidator
>;
export type HierarchyChildState = Infer<typeof hierarchyChildStateValidator>;
export type HierarchySummarySourceInput = Infer<
  typeof hierarchySummarySourceInputValidator
>;
export type HierarchySummaryRollupPhase = Infer<
  typeof hierarchySummaryRollupPhaseValidator
>;

export const summaryEntityRefValidator = v.union(
  v.object({ kind: v.literal("process"), processId: v.id("processes") }),
  v.object({
    kind: v.literal("department"),
    departmentId: v.id("departments"),
  }),
  v.object({ kind: v.literal("function"), functionId: v.id("functions") }),
);

export type SummaryEntityRef = Infer<typeof summaryEntityRefValidator>;

export function getSummaryEntityKey(entity: SummaryEntityRef): string {
  if (entity.kind === "process") return `process:${entity.processId}`;
  if (entity.kind === "department") return `department:${entity.departmentId}`;
  return `function:${entity.functionId}`;
}

export type SummaryOverviewState =
  | "missing"
  | "current"
  | "stale"
  | "refreshing"
  | "partial"
  | "failed";

export type SummaryOverviewResponse = {
  entity: SummaryEntityRef;
  /** Bounded key for de-duplicating refresh-on-view attempts per source state. */
  refreshKey: string;
  state: SummaryOverviewState;
  /**
   * Whether a rebuild has any input the stored overview has not already read.
   * False on an overview that already reflects every available source, so the
   * control that spends a full generation can go quiet instead of re-deriving
   * the same brief.
   */
  refreshAvailable: boolean;
  content: SummaryCompatibilityRead;
  coverage: SummaryCoverage | null;
  lastSuccessfulGenerationAt: number | null;
  progress: SummaryRunProgress | null;
  error: SummaryRunError | null;
  flow: {
    available: boolean;
    stale: boolean;
    generationStatus: "idle" | "generating" | "ready" | "failed";
  } | null;
  insights: {
    available: boolean;
    stale: boolean;
    generationStatus: "idle" | "generating" | "ready" | "failed";
  } | null;
};

export type SummarySourceKeyMap = Readonly<Record<string, SummarySourceRef>>;

export type SummaryNormalizationContext = {
  sourceByKey: SummarySourceKeyMap;
  coverage: SummaryCoverage;
  provenance: SummaryProvenance;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function normalizeInlineText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxChars).trim();
}

function normalizeBlockText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, maxChars).trim();
}

/** Plain-text field: emphasis the prompt forbade here is dropped, not shown. */
function normalizePlainInlineText(
  value: unknown,
  maxChars: number,
): string | null {
  const normalized = normalizeInlineText(value, maxChars);
  if (normalized === null) return null;
  return stripEmphasisMarkers(normalized).trim() || null;
}

/** Plain-text block field, same rule as `normalizePlainInlineText`. */
function normalizePlainBlockText(
  value: unknown,
  maxChars: number,
): string | null {
  const normalized = normalizeBlockText(value, maxChars);
  if (normalized === null) return null;
  return stripEmphasisMarkers(normalized).trim() || null;
}

/** The one field allowed to keep emphasis, provided it is renderable. */
function normalizeEmphasizedBlockText(
  value: unknown,
  maxChars: number,
): string | null {
  const normalized = normalizeBlockText(value, maxChars);
  if (normalized === null) return null;
  return normalizeEmphasis(normalized).trim() || null;
}

const EMPHASIS_MARKER = /\*\*/g;

/** Removing markup leaves gaps behind; close them without touching newlines. */
function tidySpacing(value: string): string {
  return value
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * `**bold**` is generated for the executive brief only. Every other string in
 * an artifact is rendered as plain text — finding rows, PDF text nodes, the
 * headline — where a marker would show as literal asterisks, so it is removed
 * at the boundary rather than trusted to the prompt.
 */
export function stripEmphasisMarkers(value: string): string {
  return tidySpacing(value.replace(EMPHASIS_MARKER, ""));
}

/**
 * Emphasis that survives storage has to be renderable. Truncating the brief at
 * its character cap can cut a `**` pair in half, and an empty `****` span
 * renders as asterisks too, so both are dropped: the words are kept and only
 * the unusable markup goes.
 */
function normalizeEmphasis(value: string): string {
  const withoutEmptySpans = value.replace(/\*{4,}/g, "");
  const markers = withoutEmptySpans.match(EMPHASIS_MARKER)?.length ?? 0;
  if (markers % 2 === 0) return tidySpacing(withoutEmptySpans);
  const orphan = withoutEmptySpans.lastIndexOf("**");
  return tidySpacing(
    `${withoutEmptySpans.slice(0, orphan)}${withoutEmptySpans.slice(orphan + 2)}`,
  );
}

function normalizedSemanticText(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? ""
  );
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function sourceIdentity(source: SummarySourceRef): string {
  if (source.kind === "conversation") {
    return `conversation:${source.conversationId}`;
  }
  if (source.kind === "process") return `process:${source.processId}`;
  return `department:${source.departmentId}`;
}

function normalizeSource(source: SummarySourceRef): SummarySourceRef | null {
  const label = normalizeInlineText(
    source.label,
    SUMMARY_V2_CAPS.sourceLabelChars,
  );
  if (!label) return null;
  if (source.kind === "conversation") return { ...source, label };
  if (source.kind === "process") return { ...source, label };
  return { ...source, label };
}

function resolveSources(
  rawKeys: unknown,
  sourceByKey: SummarySourceKeyMap,
): SummarySourceRef[] {
  if (!Array.isArray(rawKeys)) return [];
  const sources: SummarySourceRef[] = [];
  const seen = new Set<string>();
  for (const rawKey of rawKeys) {
    if (typeof rawKey !== "string") continue;
    const source = sourceByKey[rawKey];
    if (!source) continue;
    const normalized = normalizeSource(source);
    if (!normalized) continue;
    const identity = sourceIdentity(normalized);
    if (seen.has(identity)) continue;
    seen.add(identity);
    sources.push(normalized);
    if (sources.length === SUMMARY_V2_CAPS.sourcesPerFinding) break;
  }
  return sources;
}

const EXPLICIT_GAP_PATTERN =
  /\b(unknown|unclear|unconfirmed|not documented|not captured|not established|not specified|missing (?:evidence|detail|information|step|steps)|insufficient evidence|needs? clarification|open question|no evidence|no source)\b/i;

export function isExplicitMissingEvidenceFinding(
  title: string,
  body: string,
): boolean {
  return EXPLICIT_GAP_PATTERN.test(`${title} ${body}`);
}

function normalizeFinding(
  rawValue: unknown,
  sourceByKey: SummarySourceKeyMap,
  sectionKey: string,
  bodyChars: number,
): SummaryFinding | null {
  const raw = asRecord(rawValue);
  if (!raw) return null;
  const title = normalizePlainInlineText(
    raw.title,
    SUMMARY_V2_CAPS.findingTitleChars,
  );
  const body = normalizePlainBlockText(raw.body, bodyChars);
  if (!title || !body) return null;

  const requestedEvidenceLevel = raw.evidenceLevel;
  if (
    requestedEvidenceLevel !== "corroborated" &&
    requestedEvidenceLevel !== "single_source" &&
    requestedEvidenceLevel !== "inferred_gap"
  ) {
    return null;
  }

  const sources = resolveSources(raw.sourceKeys, sourceByKey);
  if (sources.length === 0) {
    if (
      requestedEvidenceLevel !== "inferred_gap" ||
      !isExplicitMissingEvidenceFinding(title, body)
    ) {
      return null;
    }
  }

  const evidenceLevel: SummaryEvidenceLevel =
    requestedEvidenceLevel === "inferred_gap"
      ? "inferred_gap"
      : sources.length >= 2
        ? "corroborated"
        : "single_source";
  const identity = `${sectionKey}|${normalizedSemanticText(title)}|${sources
    .map(sourceIdentity)
    .sort()
    .join("|")}`;
  return {
    // IDs are derived after source resolution so duplicate or unstable IDs
    // returned by a model can never leak into UI keys or persistence.
    id: `${sectionKey}-${stableHash(identity)}`,
    title,
    body,
    evidenceLevel,
    supportCount: sources.length,
    sources,
  };
}

function normalizeFindingGroup(
  value: unknown,
  sourceByKey: SummarySourceKeyMap,
  sectionKey: string,
  caps: OverviewSectionCaps,
): SummaryFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: SummaryFinding[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const finding = normalizeFinding(
      raw,
      sourceByKey,
      sectionKey,
      caps.bodyChars,
    );
    if (!finding) continue;
    const dedupeKey = `${normalizedSemanticText(finding.title)}|${finding.sources
      .map(sourceIdentity)
      .sort()
      .join("|")}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    findings.push(finding);
    if (findings.length === caps.group) break;
  }
  return findings;
}

function normalizeCoverage(value: SummaryCoverage): SummaryCoverage | null {
  if (
    !Number.isFinite(value.includedSources) ||
    !Number.isFinite(value.totalEligibleSources)
  ) {
    return null;
  }
  const totalEligibleSources = Math.max(
    0,
    Math.floor(value.totalEligibleSources),
  );
  const includedSources = Math.min(
    totalEligibleSources,
    Math.max(0, Math.floor(value.includedSources)),
  );
  const uniqueContributors =
    value.uniqueContributors === undefined
      ? undefined
      : Number.isFinite(value.uniqueContributors)
        ? Math.min(
            includedSources,
            Math.max(0, Math.floor(value.uniqueContributors)),
          )
        : undefined;
  return {
    includedSources,
    totalEligibleSources,
    ...(uniqueContributors === undefined ? {} : { uniqueContributors }),
    complete:
      value.complete === true && includedSources === totalEligibleSources,
  };
}

function normalizeProvenance(
  value: SummaryProvenance,
): SummaryProvenance | null {
  const sourceSnapshotHash = normalizeInlineText(value.sourceSnapshotHash, 256);
  const promptVersion = normalizeInlineText(value.promptVersion, 120);
  const provider = normalizeInlineText(value.provider, 160);
  const model = normalizeInlineText(value.model, 200);
  if (
    !sourceSnapshotHash ||
    !promptVersion ||
    !provider ||
    !model ||
    !Number.isFinite(value.generatedAt)
  ) {
    return null;
  }
  return {
    sourceSnapshotHash,
    generatedAt: Math.max(0, Math.floor(value.generatedAt)),
    promptVersion,
    provider,
    model,
  };
}

function normalizeArtifactBase(
  value: unknown,
  context: SummaryNormalizationContext,
  caps: OverviewSectionCaps,
) {
  const raw = asRecord(value);
  if (!raw) return null;
  const headline = normalizePlainInlineText(
    raw.headline,
    SUMMARY_V2_CAPS.headlineChars,
  );
  const executiveBrief = normalizeEmphasizedBlockText(
    raw.executiveBrief,
    caps.briefChars,
  );
  const coverage = normalizeCoverage(context.coverage);
  const provenance = normalizeProvenance(context.provenance);
  if (!headline || !executiveBrief || !coverage || !provenance) return null;
  return { raw, headline, executiveBrief, coverage, provenance };
}

export function normalizeProcessOverviewArtifactV2(
  value: unknown,
  context: SummaryNormalizationContext,
): ProcessOverviewArtifactV2 | null {
  const caps = PROCESS_OVERVIEW_SECTION_CAPS;
  const base = normalizeArtifactBase(value, context, caps);
  if (!base) return null;
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: base.headline,
    executiveBrief: base.executiveBrief,
    scope: normalizeFindingGroup(
      base.raw.scope,
      context.sourceByKey,
      "scope",
      caps,
    ),
    consensus: normalizeFindingGroup(
      base.raw.consensus,
      context.sourceByKey,
      "consensus",
      caps,
    ),
    variations: normalizeFindingGroup(
      base.raw.variations,
      context.sourceByKey,
      "variation",
      caps,
    ),
    gaps: normalizeFindingGroup(
      base.raw.gaps,
      context.sourceByKey,
      "gap",
      caps,
    ),
    notable: normalizeFindingGroup(
      base.raw.notable,
      context.sourceByKey,
      "notable",
      caps,
    ),
    coverage: base.coverage,
    provenance: base.provenance,
  };
}

export function normalizeDepartmentOverviewArtifactV2(
  value: unknown,
  context: SummaryNormalizationContext,
): DepartmentOverviewArtifactV2 | null {
  const caps = HIERARCHY_OVERVIEW_SECTION_CAPS;
  const base = normalizeArtifactBase(value, context, caps);
  if (!base) return null;
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: base.headline,
    executiveBrief: base.executiveBrief,
    crossProcessDependencies: normalizeFindingGroup(
      base.raw.crossProcessDependencies,
      context.sourceByKey,
      "cross-process-dependency",
      caps,
    ),
    sharedPatterns: normalizeFindingGroup(
      base.raw.sharedPatterns,
      context.sourceByKey,
      "shared-pattern",
      caps,
    ),
    variationsAndTensions: normalizeFindingGroup(
      base.raw.variationsAndTensions,
      context.sourceByKey,
      "variation-and-tension",
      caps,
    ),
    gaps: normalizeFindingGroup(
      base.raw.gaps,
      context.sourceByKey,
      "gap",
      caps,
    ),
    notable: normalizeFindingGroup(
      base.raw.notable,
      context.sourceByKey,
      "notable",
      caps,
    ),
    coverage: base.coverage,
    provenance: base.provenance,
  };
}

export function normalizeFunctionOverviewArtifactV2(
  value: unknown,
  context: SummaryNormalizationContext,
): FunctionOverviewArtifactV2 | null {
  const caps = HIERARCHY_OVERVIEW_SECTION_CAPS;
  const base = normalizeArtifactBase(value, context, caps);
  if (!base) return null;
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: base.headline,
    executiveBrief: base.executiveBrief,
    crossDepartmentDependencies: normalizeFindingGroup(
      base.raw.crossDepartmentDependencies,
      context.sourceByKey,
      "cross-department-dependency",
      caps,
    ),
    strategicPatterns: normalizeFindingGroup(
      base.raw.strategicPatterns,
      context.sourceByKey,
      "strategic-pattern",
      caps,
    ),
    variationsAndTensions: normalizeFindingGroup(
      base.raw.variationsAndTensions,
      context.sourceByKey,
      "variation-and-tension",
      caps,
    ),
    gaps: normalizeFindingGroup(
      base.raw.gaps,
      context.sourceByKey,
      "gap",
      caps,
    ),
    notable: normalizeFindingGroup(
      base.raw.notable,
      context.sourceByKey,
      "notable",
      caps,
    ),
    coverage: base.coverage,
    provenance: base.provenance,
  };
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

function renderFinding(finding: SummaryFinding) {
  const sourceLabels = finding.sources.map(
    (source) => `[${escapeMarkdownLabel(source.label)}]`,
  );
  const sourceSuffix =
    sourceLabels.length > 0 ? ` Sources: ${sourceLabels.join(", ")}.` : "";
  return `- **${finding.title}** — ${finding.body}${sourceSuffix}`;
}

// Every group is a set of findings, never a sequence: ordered output would imply
// a step order this artifact does not establish.
function renderSection(
  heading: string,
  findings: SummaryFinding[],
): string | null {
  if (findings.length === 0) return null;
  return `## ${heading}\n\n${findings.map(renderFinding).join("\n")}`;
}

export function renderSummaryV2AsLegacyMarkdown(
  artifact: SummaryArtifactV2,
): string {
  const sections: Array<string | null> = [
    `# ${artifact.headline}\n\n${artifact.executiveBrief}`,
  ];
  if ("scope" in artifact) {
    sections.push(
      renderSection("Scope and participants", artifact.scope),
      renderSection("Agreements", artifact.consensus),
      renderSection("Reported ways of working", artifact.variations),
      renderSection("Knowledge gaps", artifact.gaps),
      renderSection("Notable context", artifact.notable),
    );
  } else if ("crossProcessDependencies" in artifact) {
    sections.push(
      renderSection(
        "Cross-process dependencies",
        artifact.crossProcessDependencies,
      ),
      renderSection("Shared patterns", artifact.sharedPatterns),
      renderSection(
        "Variations and tensions",
        artifact.variationsAndTensions,
      ),
      renderSection("Knowledge gaps", artifact.gaps),
      renderSection("Notable context", artifact.notable),
    );
  } else {
    sections.push(
      renderSection(
        "Cross-department dependencies",
        artifact.crossDepartmentDependencies,
      ),
      renderSection("Strategic patterns", artifact.strategicPatterns),
      renderSection(
        "Variations and tensions",
        artifact.variationsAndTensions,
      ),
      renderSection("Knowledge gaps", artifact.gaps),
      renderSection("Notable context", artifact.notable),
    );
  }

  const coverage = artifact.coverage;
  sections.push(
    `## Evidence coverage\n\n${coverage.includedSources} of ${coverage.totalEligibleSources} eligible sources included${
      coverage.uniqueContributors === undefined
        ? ""
        : ` across ${coverage.uniqueContributors} contributors`
    }. Coverage is ${coverage.complete ? "complete" : "partial"}.`,
  );
  return sections.filter((section): section is string => section !== null).join("\n\n");
}

export type SummaryCompatibilityRead =
  | {
      format: "v2";
      artifact: SummaryArtifactV2;
      markdown: string;
    }
  | { format: "legacy"; artifact: null; markdown: string }
  | { format: "none"; artifact: null; markdown: null };

/** Prefer a structured artifact and retain a deterministic Markdown projection. */
export function readCompatibleSummary(input: {
  summaryV2?: SummaryArtifactV2;
  legacyMarkdown?: string | null;
}): SummaryCompatibilityRead {
  if (input.summaryV2) {
    return {
      format: "v2",
      artifact: input.summaryV2,
      markdown: renderSummaryV2AsLegacyMarkdown(input.summaryV2),
    };
  }
  const legacyMarkdown = normalizeBlockText(
    input.legacyMarkdown,
    Number.MAX_SAFE_INTEGER,
  );
  return legacyMarkdown
    ? { format: "legacy", artifact: null, markdown: legacyMarkdown }
    : { format: "none", artifact: null, markdown: null };
}

export type SummaryListMetadata = {
  format: "v2" | "legacy" | "none";
  state:
    | "missing"
    | "current"
    | "stale"
    | "refreshing"
    | "partial"
    | "failed";
  generatedAt: number | null;
  coverage: {
    includedSources: number;
    totalEligibleSources: number;
    complete: boolean;
  } | null;
};

export function getSummaryListMetadata(input: {
  summaryV2?: SummaryArtifactV2;
  legacyMarkdown?: string | null;
  legacyGeneratedAt?: number | null;
  stale?: boolean;
  refreshScheduledAt?: number;
  lastRunState?: SummaryRunState;
  lastRunCompletedAt?: number;
  now?: number;
}): SummaryListMetadata {
  const generatedAt = input.summaryV2?.provenance.generatedAt ??
    (input.legacyMarkdown?.trim() ? (input.legacyGeneratedAt ?? null) : null);
  const now = input.now ?? Date.now();
  const refreshing =
    input.refreshScheduledAt !== undefined &&
    now - input.refreshScheduledAt < 10 * 60_000;
  const failed =
    !refreshing &&
    input.lastRunState === "failed" &&
    (input.lastRunCompletedAt === undefined ||
      generatedAt === null ||
      input.lastRunCompletedAt >= generatedAt);

  if (input.summaryV2) {
    const coverage = input.summaryV2.coverage;
    return {
      format: "v2",
      state: refreshing
        ? "refreshing"
        : failed
          ? "failed"
          : input.stale
            ? "stale"
            : coverage.complete
              ? "current"
              : "partial",
      generatedAt,
      coverage: {
        includedSources: coverage.includedSources,
        totalEligibleSources: coverage.totalEligibleSources,
        complete: coverage.complete,
      },
    };
  }
  const hasLegacy = Boolean(input.legacyMarkdown?.trim());
  return {
    format: hasLegacy ? "legacy" : "none",
    state: refreshing
      ? "refreshing"
      : failed
        ? "failed"
        : hasLegacy
          ? input.stale
            ? "stale"
            : "current"
          : "missing",
    generatedAt,
    coverage: null,
  };
}

/**
 * List queries use this projection so a future V2 artifact does not multiply
 * the cost of hierarchy navigation. Existing legacy fields stay in place until
 * their UI consumers migrate.
 */
export function toLightweightSummaryListRow<
  T extends {
    summaryV2?: SummaryArtifactV2;
    summaryRegenScheduledAt?: number;
    summaryV2LastRunState?: SummaryRunState;
    summaryV2LastCompletedAt?: number;
  },
>(
  row: T,
  input: Omit<Parameters<typeof getSummaryListMetadata>[0], "summaryV2">,
): Omit<T, "summaryV2"> & { summaryOverview: SummaryListMetadata } {
  const { summaryV2, ...lightweight } = row;
  return {
    ...lightweight,
    summaryOverview: getSummaryListMetadata({
      ...input,
      summaryV2,
      refreshScheduledAt: row.summaryRegenScheduledAt,
      lastRunState: row.summaryV2LastRunState,
      lastRunCompletedAt: row.summaryV2LastCompletedAt,
    }),
  };
}
