import type { AIJsonSchema, AIRequest } from "./aiProvider";
import {
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_CAPS,
  type ProcessOverviewArtifactV2,
  type ProcessSummaryEvidenceV2,
  type SummaryChunkOutputV2,
  type SummaryFinding,
} from "../summaryV2";

export const PROCESS_OVERVIEW_V2_TOOL_NAME = "return_process_overview";
export const PROCESS_OVERVIEW_V2_CHUNK_OPERATION =
  "process-summary-v2-chunk";
export const PROCESS_OVERVIEW_V2_FINAL_OPERATION =
  "process-summary-v2-final";

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body", "evidenceLevel", "sourceKeys"],
  properties: {
    title: { type: "string", maxLength: SUMMARY_V2_CAPS.findingTitleChars },
    body: { type: "string", maxLength: SUMMARY_V2_CAPS.findingBodyChars },
    evidenceLevel: {
      type: "string",
      enum: ["corroborated", "single_source", "inferred_gap"],
    },
    sourceKeys: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.sourcesPerFinding,
      items: { type: "string" },
    },
  },
} as const;

export const PROCESS_OVERVIEW_V2_SCHEMA: AIJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline",
    "executiveBrief",
    "scope",
    "consensus",
    "variations",
    "gaps",
    "notable",
  ],
  properties: {
    headline: {
      type: "string",
      maxLength: SUMMARY_V2_CAPS.headlineChars,
    },
    executiveBrief: {
      type: "string",
      maxLength: SUMMARY_V2_CAPS.executiveBriefChars,
    },
    scope: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.findingGroup,
      items: findingSchema,
    },
    consensus: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.findingGroup,
      items: findingSchema,
    },
    variations: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.findingGroup,
      items: findingSchema,
    },
    gaps: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.findingGroup,
      items: findingSchema,
    },
    notable: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.findingGroup,
      items: findingSchema,
    },
  },
};

// Exported so the Phase 10 measured-language gate can assert the instruction
// is still present in the prompt that produces the artifacts it scores.
export const PROCESS_OVERVIEW_SYSTEM_PROMPT = `You create an evidence-backed overview of a business process from employee interview evidence.

Content ownership:
- Overview explains what the process covers, who runs it, and how much the accounts agree.
- The process flow surface owns step order. Never return an ordered sequence, a numbered stage list, or ordering language such as first, next, then, or finally.
- Do not produce flow topology, node-level inspection, bottleneck scoring, risk scoring, automation recommendations, or improvement plans. Those belong to other product surfaces.

The scope section carries the orientation facts the flow graph cannot state at process level. Return at most one finding for each that the evidence supports:
- What triggers the process.
- What counts as finished.
- Which roles or teams do the work.
- Which systems or records the work runs on.
- What the process depends on upstream or feeds downstream.

Evidence rules:
- Every factual finding must cite one or more supplied source keys.
- Use corroborated only when at least two distinct contributors support the finding.
- Use single_source for a finding reported by one contributor.
- Use inferred_gap only for explicitly missing, unknown, unclear, or unconfirmed knowledge; it may have no source key.
- Preserve contradictions and variations instead of choosing a canonical account.
- Never claim measured frequency, throughput, conformance, rework rate, or timing. This is reported interview knowledge, not event-log analysis.
- Do not invent actors, tools, steps, dependencies, or certainty.
- Return only the required tool call.`;

export type ProcessSourceInput = {
  key: string;
  conversationId: string;
  label: string;
  transcriptHash: string;
  promptVersion: string;
};

export type ProcessEvidencePromptSource = ProcessSourceInput & {
  evidence: ProcessSummaryEvidenceV2;
};

function tool() {
  return {
    name: PROCESS_OVERVIEW_V2_TOOL_NAME,
    description:
      "Return a bounded, source-backed process overview with no diagnostic or improvement analysis.",
    inputSchema: PROCESS_OVERVIEW_V2_SCHEMA,
  };
}

function evidenceForPrompt(source: ProcessEvidencePromptSource) {
  return {
    sourceKey: source.key,
    contributor: source.label,
    steps: source.evidence.steps.map(({ title, body }) => ({ title, body })),
    actors: source.evidence.actors,
    tools: source.evidence.tools,
    handoffsAndDependencies: source.evidence.handoffsAndDependencies,
    reportedVariations: source.evidence.reportedVariations,
    frictionPoints: source.evidence.frictionPoints,
    uncertainties: source.evidence.uncertainties,
  };
}

function buildRequest(args: {
  operation: string;
  processName: string;
  inputLabel: string;
  input: unknown;
  budget: (typeof SUMMARY_V2_AI_BUDGETS)["chunkReduce" | "finalReduce"];
}): AIRequest {
  return {
    capability: "synthesis",
    operation: args.operation,
    system: PROCESS_OVERVIEW_SYSTEM_PROMPT,
    user: `Process: ${args.processName}\n${args.inputLabel}:\n${JSON.stringify(
      args.input,
    )}`,
    maxTokens: args.budget.maxTokens,
    timeoutMs: args.budget.timeoutMs,
    maxRetries: args.budget.maxRetries,
    temperature: 0,
    tool: tool(),
  };
}

export function buildProcessOverviewChunkRequest(args: {
  processName: string;
  sources: ProcessEvidencePromptSource[];
}): AIRequest {
  return buildRequest({
    operation: PROCESS_OVERVIEW_V2_CHUNK_OPERATION,
    processName: args.processName,
    inputLabel: "Conversation evidence for this deterministic chunk",
    input: args.sources.map(evidenceForPrompt),
    budget: SUMMARY_V2_AI_BUDGETS.chunkReduce,
  });
}

function sourceKeysForFinding(
  finding: SummaryFinding,
  keyByConversationId: Readonly<Record<string, string>>,
): string[] {
  return finding.sources.flatMap((source) =>
    source.kind === "conversation"
      ? (keyByConversationId[source.conversationId] ?? [])
      : [],
  );
}

function findingForFinalPrompt(
  finding: SummaryFinding,
  keyByConversationId: Readonly<Record<string, string>>,
) {
  return {
    title: finding.title,
    body: finding.body,
    evidenceLevel: finding.evidenceLevel,
    sourceKeys: sourceKeysForFinding(finding, keyByConversationId),
  };
}

export function chunkOutputForFinalPrompt(
  output: SummaryChunkOutputV2,
  keyByConversationId: Readonly<Record<string, string>>,
) {
  return {
    headline: output.headline,
    executiveBrief: output.executiveBrief,
    sections: output.sections.map((section) => ({
      key: section.key,
      findings: section.findings.map((finding) =>
        findingForFinalPrompt(finding, keyByConversationId),
      ),
    })),
  };
}

export function buildProcessOverviewFinalRequest(args: {
  processName: string;
  directSources?: ProcessEvidencePromptSource[];
  chunks?: ReturnType<typeof chunkOutputForFinalPrompt>[];
}): AIRequest {
  const direct = args.directSources !== undefined;
  return buildRequest({
    operation: PROCESS_OVERVIEW_V2_FINAL_OPERATION,
    processName: args.processName,
    inputLabel: direct
      ? "Complete conversation evidence"
      : "Source-resolved chunk summaries covering the complete evidence set",
    input: direct
      ? args.directSources!.map(evidenceForPrompt)
      : (args.chunks ?? []),
    budget: SUMMARY_V2_AI_BUDGETS.finalReduce,
  });
}

export function processArtifactToChunkOutput(
  artifact: ProcessOverviewArtifactV2,
): SummaryChunkOutputV2 {
  return {
    schemaVersion: "v2",
    headline: artifact.headline,
    executiveBrief: artifact.executiveBrief,
    sections: [
      { key: "scope", findings: artifact.scope },
      { key: "consensus", findings: artifact.consensus },
      { key: "variations", findings: artifact.variations },
      { key: "gaps", findings: artifact.gaps },
      { key: "notable", findings: artifact.notable },
    ],
    coverage: artifact.coverage,
  };
}

export type SnapshotHashState = {
  first: number;
  second: number;
  length: number;
};

export function initialSnapshotHashState(): SnapshotHashState {
  return { first: 0x811c9dc5, second: 0x9e3779b9, length: 0 };
}

export function updateSnapshotHashState(
  state: SnapshotHashState,
  source: Pick<
    ProcessSourceInput,
    "conversationId" | "transcriptHash" | "promptVersion"
  >,
): SnapshotHashState {
  const value = `${source.conversationId}\u0000${source.transcriptHash}\u0000${source.promptVersion}\u0001`;
  let { first, second } = state;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index + state.length), 0x85ebca6b) >>> 0;
  }
  return { first, second, length: state.length + value.length };
}

export function finishSnapshotHash(state: SnapshotHashState): string {
  return `sv2-${state.length.toString(36)}-${state.first.toString(36)}-${state.second.toString(36)}`;
}
