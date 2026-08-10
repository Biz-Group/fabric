import type { AIJsonSchema, AIRequest } from "./aiProvider";
import {
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_CAPS,
  type DepartmentOverviewArtifactV2,
  type ProcessOverviewArtifactV2,
} from "../summaryV2";

export const DEPARTMENT_OVERVIEW_V2_OPERATION =
  "department-summary-v2-final";
export const FUNCTION_OVERVIEW_V2_OPERATION = "function-summary-v2-final";
export const DEPARTMENT_OVERVIEW_V2_TOOL = "return_department_overview";
export const FUNCTION_OVERVIEW_V2_TOOL = "return_function_overview";

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

function overviewSchema(sectionNames: readonly string[]): AIJsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["headline", "executiveBrief", ...sectionNames],
    properties: {
      headline: {
        type: "string",
        maxLength: SUMMARY_V2_CAPS.headlineChars,
      },
      executiveBrief: {
        type: "string",
        maxLength: SUMMARY_V2_CAPS.executiveBriefChars,
      },
      ...Object.fromEntries(
        sectionNames.map((name) => [
          name,
          {
            type: "array",
            maxItems: SUMMARY_V2_CAPS.findingGroup,
            items: findingSchema,
          },
        ]),
      ),
    },
  };
}

export const DEPARTMENT_OVERVIEW_V2_SCHEMA = overviewSchema([
  "crossProcessDependencies",
  "sharedPatterns",
  "variationsAndTensions",
  "gaps",
  "notable",
]);

export const FUNCTION_OVERVIEW_V2_SCHEMA = overviewSchema([
  "crossDepartmentDependencies",
  "strategicPatterns",
  "variationsAndTensions",
  "gaps",
  "notable",
]);

// Exported so the Phase 10 measured-language gate can assert the instruction
// is still present in the prompt that produces the artifacts it scores.
export const HIERARCHY_OVERVIEW_SYSTEM_PROMPT = `You create an evidence-backed organizational overview from current child overview artifacts.

Content ownership:
- Summarize cross-child dependencies, shared patterns, variations, tensions, gaps, and notable context.
- Do not reproduce process-flow topology, node details, bottleneck scoring, risk scoring, automation recommendations, or improvement plans.

Evidence rules:
- Every factual finding must cite one or more supplied source keys.
- Use corroborated only when at least two distinct child sources support the finding.
- Use single_source for a finding supported by one child.
- Use inferred_gap only for explicitly missing, unknown, unclear, or unconfirmed knowledge; it may have no source key.
- Preserve disagreements rather than selecting a canonical account.
- Never claim measured frequency, throughput, conformance, rework rate, or timing.
- Treat partial child artifacts as incomplete reported knowledge and do not fill their gaps.
- Return only the required tool call.`;

export type DepartmentOverviewPromptSource = {
  key: string;
  label: string;
  state: "current" | "partial";
  artifact: ProcessOverviewArtifactV2;
};

export type FunctionOverviewPromptSource = {
  key: string;
  label: string;
  state: "current" | "partial";
  artifact: DepartmentOverviewArtifactV2;
};

function findingsForPrompt(
  findings: Array<{
    title: string;
    body: string;
    evidenceLevel: string;
    supportCount: number;
  }>,
) {
  return findings.map(({ title, body, evidenceLevel, supportCount }) => ({
    title,
    body,
    evidenceLevel,
    supportCount,
  }));
}

function processArtifactForPrompt(source: DepartmentOverviewPromptSource) {
  const artifact = source.artifact;
  return {
    sourceKey: source.key,
    process: source.label,
    state: source.state,
    headline: artifact.headline,
    executiveBrief: artifact.executiveBrief,
    scope: findingsForPrompt(artifact.scope),
    consensus: findingsForPrompt(artifact.consensus),
    variations: findingsForPrompt(artifact.variations),
    gaps: findingsForPrompt(artifact.gaps),
    notable: findingsForPrompt(artifact.notable),
    coverage: artifact.coverage,
  };
}

function departmentArtifactForPrompt(source: FunctionOverviewPromptSource) {
  const artifact = source.artifact;
  return {
    sourceKey: source.key,
    department: source.label,
    state: source.state,
    headline: artifact.headline,
    executiveBrief: artifact.executiveBrief,
    crossProcessDependencies: findingsForPrompt(
      artifact.crossProcessDependencies,
    ),
    sharedPatterns: findingsForPrompt(artifact.sharedPatterns),
    variationsAndTensions: findingsForPrompt(
      artifact.variationsAndTensions,
    ),
    gaps: findingsForPrompt(artifact.gaps),
    notable: findingsForPrompt(artifact.notable),
    coverage: artifact.coverage,
  };
}

function request(args: {
  operation: string;
  entityLabel: string;
  sourceLabel: string;
  sources: unknown[];
  toolName: string;
  schema: AIJsonSchema;
}): AIRequest {
  return {
    capability: "synthesis",
    operation: args.operation,
    system: HIERARCHY_OVERVIEW_SYSTEM_PROMPT,
    user: `${args.entityLabel}\n${args.sourceLabel}:\n${JSON.stringify(args.sources)}`,
    maxTokens: SUMMARY_V2_AI_BUDGETS.finalReduce.maxTokens,
    timeoutMs: SUMMARY_V2_AI_BUDGETS.finalReduce.timeoutMs,
    maxRetries: SUMMARY_V2_AI_BUDGETS.finalReduce.maxRetries,
    temperature: 0,
    tool: {
      name: args.toolName,
      description:
        "Return one bounded, source-backed hierarchy overview with no process diagnostics or recommendations.",
      inputSchema: args.schema,
    },
  };
}

export function buildDepartmentOverviewRequest(args: {
  departmentName: string;
  sources: DepartmentOverviewPromptSource[];
}): AIRequest {
  return request({
    operation: DEPARTMENT_OVERVIEW_V2_OPERATION,
    entityLabel: `Department: ${args.departmentName}`,
    sourceLabel: "Current process overview sources",
    sources: args.sources.map(processArtifactForPrompt),
    toolName: DEPARTMENT_OVERVIEW_V2_TOOL,
    schema: DEPARTMENT_OVERVIEW_V2_SCHEMA,
  });
}

export function buildFunctionOverviewRequest(args: {
  functionName: string;
  sources: FunctionOverviewPromptSource[];
}): AIRequest {
  return request({
    operation: FUNCTION_OVERVIEW_V2_OPERATION,
    entityLabel: `Function: ${args.functionName}`,
    sourceLabel: "Current or explicitly partial department overview sources",
    sources: args.sources.map(departmentArtifactForPrompt),
    toolName: FUNCTION_OVERVIEW_V2_TOOL,
    schema: FUNCTION_OVERVIEW_V2_SCHEMA,
  });
}

export type HierarchySnapshotHashState = {
  first: number;
  second: number;
  length: number;
};

export type HierarchySnapshotSource = {
  childId: string;
  label: string;
  state: string;
  artifactSnapshotHash: string;
  artifactPromptVersion: string;
  artifactGeneratedAt: number;
};

export function initialHierarchySnapshotHashState(): HierarchySnapshotHashState {
  return { first: 0x811c9dc5, second: 0x9e3779b9, length: 0 };
}

export function updateHierarchySnapshotHashState(
  state: HierarchySnapshotHashState,
  source: HierarchySnapshotSource,
): HierarchySnapshotHashState {
  const value = `${source.childId}\u0000${source.label}\u0000${source.state}\u0000${source.artifactSnapshotHash}\u0000${source.artifactPromptVersion}\u0000${source.artifactGeneratedAt}\u0001`;
  let { first, second } = state;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(
      second ^ (code + index + state.length),
      0x85ebca6b,
    ) >>> 0;
  }
  return { first, second, length: state.length + value.length };
}

export function finishHierarchySnapshotHash(
  state: HierarchySnapshotHashState,
): string {
  return `hv2-${state.length.toString(36)}-${state.first.toString(36)}-${state.second.toString(36)}`;
}

export type HierarchyChildState =
  | "current"
  | "partial"
  | "refreshing"
  | "stale"
  | "missing"
  | "failed";

export function classifyHierarchyChild(input: {
  hasArtifact: boolean;
  artifactComplete?: boolean;
  sourceRevisionMatches?: boolean;
  refreshing?: boolean;
  lastRunFailed?: boolean;
  explicitStale?: boolean;
}): HierarchyChildState {
  if (input.refreshing) return "refreshing";
  if (!input.hasArtifact) return input.lastRunFailed ? "failed" : "missing";
  if (input.explicitStale || input.sourceRevisionMatches === false) return "stale";
  return input.artifactComplete === false ? "partial" : "current";
}

export function isUsableHierarchyChild(
  state: HierarchyChildState,
): state is "current" | "partial" {
  return state === "current" || state === "partial";
}
