import type { AIJsonSchema } from "./aiProvider";

/**
 * Prompts, schemas, and normalizers for staged process-flow generation.
 *
 * The single-call design failed two independent ways — it hit the 32,768-token
 * output cap on complex processes, and it hit the clock on slow ones — and both
 * failures were total. Splitting the output into a cheap graph pass plus small
 * bounded detail batches removes both walls: no single call is large enough to
 * truncate, and every call is sized to finish well inside its timeout.
 *
 * Budgets here are sized by TIME against the worst measured throughput; see
 * MEASURED_THROUGHPUT in ./aiProvider and the budgets table in
 * docs/process-flow-generation-v3-plan.md. The assertions live in tests.
 */

export const GRAPH_MAX_TOKENS = 6144;
export const GRAPH_TIMEOUT_MS = 210_000;
export const GRAPH_MAX_RETRIES = 1;

export const NODE_DETAILS_MAX_TOKENS = 4096;
export const NODE_DETAILS_TIMEOUT_MS = 150_000;
export const NODE_DETAILS_MAX_RETRIES = 2;

/** Nodes per detail batch. Halved once if a batch truncates. */
export const NODE_DETAILS_BATCH_SIZE = 6;

/**
 * Raised from 2,048 after real runs truncated ("Automation-opportunity analysis
 * hit the token limit") — a process with a handful of substantial opportunities
 * does not fit 2k tokens of structured JSON. The timeout moves with it:
 * `minTimeoutMsForMaxTokens(4096)` is 130,031 ms, so 120 s would leave the call
 * over its time budget. Worst case is still (1 + 2) x 135 s = 405 s, inside the
 * 10-minute action ceiling.
 */
export const INSIGHTS_MAX_TOKENS = 4096;
export const INSIGHTS_TIMEOUT_MS = 135_000;
export const INSIGHTS_MAX_RETRIES = 2;

/**
 * Soft ceiling on graph size. Enforcement is deliberately soft: the normalizer
 * accepts whatever arrives and warns past this, because a count-based reject
 * would reintroduce exactly the total-failure mode this design exists to
 * remove. The hard guard is truncation detection.
 */
export const SOFT_MAX_NODES = 60;

const GRAPH_TOOL_NAME = "return_process_graph";
const NODE_DETAILS_TOOL_NAME = "return_node_details";

export type FlowNodeCategory =
  "start" | "end" | "action" | "decision" | "handoff" | "wait";
export type FlowEdgeType =
  "sequential" | "conditional" | "parallel" | "fallback";
export type FlowAutomationPotential = "none" | "low" | "medium" | "high";
export type FlowConfidence = "high" | "medium" | "low";

export type FlowNodeDetail = {
  description: string;
  actors: string[];
  tools: string[];
  estimatedDuration?: string;
  painPoints: string[];
  automationPotential: FlowAutomationPotential;
  confidence: FlowConfidence;
  isBottleneck: boolean;
  isTribalKnowledge: boolean;
  riskIndicators: string[];
  sources: string[];
};

export type GraphNode = {
  id: string;
  label: string;
  category: FlowNodeCategory;
};

export type AutomationOpportunityKind =
  "agent" | "workflow" | "integration" | "other";

/**
 * A candidate for transforming part of the process, identified across the whole
 * enriched graph rather than per step.
 *
 * This is the payload the product is ultimately for: understanding how work
 * happens today in order to change it. It has to be rich enough to build from
 * later — an opportunity spanning three approval steps is one agent, not three
 * — which is why it names the nodes it covers and says what kind of automation
 * it is, instead of being a sentence.
 */
export type AutomationOpportunity = {
  title: string;
  kind: AutomationOpportunityKind;
  /** The graph nodes this opportunity would replace or assist. */
  nodeIds: string[];
  rationale: string;
  expectedBenefit?: string;
  prerequisites: string[];
  confidence: FlowConfidence;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: FlowEdgeType;
  label?: string;
  isHappyPath: boolean;
};

const VALID_CATEGORIES = new Set<string>([
  "start",
  "end",
  "action",
  "decision",
  "handoff",
  "wait",
]);
const VALID_EDGE_TYPES = new Set<string>([
  "sequential",
  "conditional",
  "parallel",
  "fallback",
]);
const VALID_AUTOMATION = new Set<string>(["none", "low", "medium", "high"]);
const VALID_CONFIDENCE = new Set<string>(["high", "medium", "low"]);

// ---------------------------------------------------------------------------
// Stage 1 — the graph
// ---------------------------------------------------------------------------

export const GRAPH_SYSTEM_PROMPT = `You are a process analyst converting business process documentation into the SKELETON of a flow diagram. You receive:
1. A synthesized rolling summary written from conversation transcripts
2. Per-conversation structured data — some conversations have pre-extracted graph fragments (process_steps, step_connections, step_issues as JSON), while older conversations have only flat lists (steps_described, tools_mentioned)

Your job is the shape of the process only: which steps exist, and how they connect. A later pass describes each step in detail, so do NOT write descriptions, actors, tools, pain points, or assessments here. Spend your output budget on getting the topology right.

## Node rules
- Each node is a discrete, actionable step in the process.
- Merge duplicate or overlapping steps described by different contributors into a single node.
- Use deterministic kebab-case IDs (e.g., "pull-workday-data", "validate-comp-bands").
- Give each node a short label in Title Case (2-6 words).
- Assign "category" based on the step's nature:
  - "start": the trigger or entry point of the process
  - "action": a task someone performs
  - "decision": a point where the process branches based on a condition
  - "handoff": where responsibility transfers to a different person or team
  - "wait": where the process blocks on an external dependency
  - "end": the process completion point
- Every flow must have exactly one "start" and at least one "end" node.
- Aim for at most ${SOFT_MAX_NODES} nodes. If the process is larger, consolidate related micro-steps into coherent steps rather than dropping any part of the process.

## Edge rules
- "sequential": the default — one step follows another
- "conditional": a decision branches based on a condition (the label should state the condition)
- "parallel": steps that happen simultaneously
- "fallback": exception or error handling path
- isHappyPath: true for the primary expected flow, false for exception paths

## Merging strategy
- When Conversation A describes steps 1-5 and Conversation B describes steps 4-8, connect them at the overlap point
- Use the dependencies field to identify handoff connections between contributors
- Prefer structured data (process_steps JSON) over flat lists when both exist
- When contributors disagree on step ordering, use the majority view — the detail pass records the disagreement

## Insights rules
- criticalPath: ordered node IDs of the longest/most common path
- totalEstimatedDuration: end-to-end duration if stated or inferable, otherwise omit

Use the provided tool to return the graph.`;

const GRAPH_RESPONSE_SCHEMA: AIJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          category: {
            type: "string",
            enum: ["start", "end", "action", "decision", "handoff", "wait"],
          },
        },
        required: ["id", "label", "category"],
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          source: { type: "string" },
          target: { type: "string" },
          type: {
            type: "string",
            enum: ["sequential", "conditional", "parallel", "fallback"],
          },
          label: { type: "string" },
          isHappyPath: { type: "boolean" },
        },
        required: ["id", "source", "target", "type", "isHappyPath"],
      },
    },
    insights: {
      type: "object",
      additionalProperties: false,
      properties: {
        totalEstimatedDuration: { type: "string" },
        criticalPath: { type: "array", items: { type: "string" } },
      },
      required: ["criticalPath"],
    },
  },
  required: ["nodes", "edges", "insights"],
};

export function buildGraphAIRequest(userContent: string) {
  return {
    capability: "synthesis" as const,
    operation: "process-flow-graph",
    system: GRAPH_SYSTEM_PROMPT,
    user: userContent,
    temperature: 0,
    maxTokens: GRAPH_MAX_TOKENS,
    timeoutMs: GRAPH_TIMEOUT_MS,
    maxRetries: GRAPH_MAX_RETRIES,
    tool: {
      name: GRAPH_TOOL_NAME,
      description:
        "Return the skeleton of the process flow: nodes, edges, and the critical path.",
      inputSchema: GRAPH_RESPONSE_SCHEMA,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — node details, one small batch at a time
// ---------------------------------------------------------------------------

export const NODE_DETAILS_SYSTEM_PROMPT = `You are a process analyst describing specific steps of a business process that has already been mapped. You receive the full process graph for context, the evidence gathered from contributor interviews, and a list of node IDs to describe.

Describe ONLY the nodes you are asked about. The graph is already settled — do not propose new steps, rename steps, or change connections.

For each requested node provide:
- description: 1-3 sentences on what happens at this step, grounded in what contributors actually said
- actors: roles, teams, or named people who perform this step
- tools: systems, forms, or documents used at this step
- estimatedDuration: if stated or inferable, otherwise omit
- painPoints: specific frustrations — quote contributors where possible
- automationPotential: "high" if repetitive/manual/rule-based, "medium" if partially automatable, "low" if it requires human judgment, "none" if already automated
- confidence: "high" if described by 2+ contributors, "medium" if described clearly by 1, "low" if inferred
- isBottleneck: true if contributors mention delays, rework, waiting, or frustration here
- isTribalKnowledge: true if only one contributor described this step and it seems undocumented
- riskIndicators: what could go wrong at this step
- sources: which contributors described this step, as "Name, Conv. N"

Rules:
- Ground every field in the evidence. If contributors did not cover something, leave the array empty rather than inventing it.
- Where contributors disagreed about this step, record the disagreement in painPoints.
- Return one entry per requested node ID, and no entries for any other node.

Use the provided tool to return the details.`;

const NODE_DETAILS_RESPONSE_SCHEMA: AIJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    details: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodeId: { type: "string" },
          description: { type: "string" },
          actors: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
          estimatedDuration: { type: "string" },
          painPoints: { type: "array", items: { type: "string" } },
          automationPotential: {
            type: "string",
            enum: ["none", "low", "medium", "high"],
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          isBottleneck: { type: "boolean" },
          isTribalKnowledge: { type: "boolean" },
          riskIndicators: { type: "array", items: { type: "string" } },
          sources: { type: "array", items: { type: "string" } },
        },
        required: [
          "nodeId",
          "description",
          "actors",
          "tools",
          "painPoints",
          "automationPotential",
          "confidence",
          "isBottleneck",
          "isTribalKnowledge",
          "riskIndicators",
          "sources",
        ],
      },
    },
  },
  required: ["details"],
};

export function buildNodeDetailsAIRequest(userContent: string) {
  return {
    capability: "synthesis" as const,
    operation: "process-flow-node-details",
    system: NODE_DETAILS_SYSTEM_PROMPT,
    user: userContent,
    temperature: 0,
    maxTokens: NODE_DETAILS_MAX_TOKENS,
    timeoutMs: NODE_DETAILS_TIMEOUT_MS,
    maxRetries: NODE_DETAILS_MAX_RETRIES,
    tool: {
      name: NODE_DETAILS_TOOL_NAME,
      description:
        "Return the detailed description of each requested process-flow node.",
      inputSchema: NODE_DETAILS_RESPONSE_SCHEMA,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — automation opportunities across the finished graph.
//
// This is a dedicated call rather than a per-node field or a mechanical rollup
// for two reasons. It needs to reason across steps: three manual approval
// handoffs are one agent, not three opportunities. And it is the output the
// product is for — downstream work (an agent library, workflow scaffolding)
// builds from these, so they cannot be `label + first pain point` strings.
//
// It is its own stage so that failing it costs only the opportunities, not the
// flow: finalize still lands the run, falling back to the mechanical rollup and
// recording that it did.
// ---------------------------------------------------------------------------

const INSIGHTS_TOOL_NAME = "return_automation_opportunities";

export const INSIGHTS_SYSTEM_PROMPT = `You are an automation analyst reviewing a fully mapped business process to find where it could be transformed. You receive the process graph and the detailed description of every step, all grounded in employee interviews.

Identify the automation opportunities a delivery team should act on. Think across steps, not step by step: several manual handoffs in a row are usually ONE opportunity, not several. Prefer a handful of substantial, buildable opportunities over a long list of thin ones.

For each opportunity provide:
- title: a short name for the thing that would be built (4-10 words)
- kind: what sort of automation it is
  - "agent": a conversational or task assistant that handles judgement, drafting, lookup, or Q&A on a person's behalf
  - "workflow": a deterministic rule-based flow — triggers, approvals, routing, notifications, data movement between systems
  - "integration": the work is mostly making two systems talk, removing manual re-entry
  - "other": genuine automation potential that is none of the above
- nodeIds: the graph node IDs this opportunity would replace or assist. Every ID must come from the graph you were given.
- rationale: 2-3 sentences on what is manual today and what the automation would do instead. Ground it in what contributors actually said — cite the friction, not a generic benefit.
- expectedBenefit: the concrete gain (time saved, errors avoided, wait removed) if the evidence supports one; omit it rather than inventing a number.
- prerequisites: what has to be true before this could be built — system access, a data source, a decision rule someone has to write down. Empty if there are none.
- confidence: "high" if multiple contributors described this friction, "medium" if one described it clearly, "low" if you are inferring it.

Rules:
- Ground every opportunity in the supplied evidence. Do not propose automation for steps nobody complained about and nothing suggests is repetitive.
- Do not invent steps, systems, or node IDs.
- A step already automated ("none" automation potential) is not an opportunity.
- If the process genuinely has no good candidates, return an empty list rather than padding it.

Use the provided tool to return the opportunities.`;

const INSIGHTS_RESPONSE_SCHEMA: AIJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    opportunities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          kind: {
            type: "string",
            enum: ["agent", "workflow", "integration", "other"],
          },
          nodeIds: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          expectedBenefit: { type: "string" },
          prerequisites: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: [
          "title",
          "kind",
          "nodeIds",
          "rationale",
          "prerequisites",
          "confidence",
        ],
      },
    },
  },
  required: ["opportunities"],
};

export function buildFlowInsightsAIRequest(userContent: string) {
  return {
    capability: "synthesis" as const,
    operation: "process-flow-automation-opportunities",
    system: INSIGHTS_SYSTEM_PROMPT,
    user: userContent,
    temperature: 0,
    maxTokens: INSIGHTS_MAX_TOKENS,
    timeoutMs: INSIGHTS_TIMEOUT_MS,
    maxRetries: INSIGHTS_MAX_RETRIES,
    tool: {
      name: INSIGHTS_TOOL_NAME,
      description:
        "Return the automation opportunities identified across this process.",
      inputSchema: INSIGHTS_RESPONSE_SCHEMA,
    },
  };
}

const VALID_OPPORTUNITY_KINDS = new Set<string>([
  "agent",
  "workflow",
  "integration",
  "other",
]);

/**
 * Opportunities restricted to node ids that exist in the graph. An opportunity
 * pointing at an invented step cannot be built from, so its ids are dropped;
 * one left pointing at nothing is discarded entirely.
 */
export function normalizeAutomationOpportunities(
  payload: unknown,
  knownNodeIds: readonly string[],
): AutomationOpportunity[] {
  const known = new Set(knownNodeIds);
  const parsed = (payload ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(parsed.opportunities)
    ? parsed.opportunities
    : [];

  const opportunities: AutomationOpportunity[] = [];

  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const title = String(entry.title ?? "").trim();
    const rationale = String(entry.rationale ?? "").trim();
    if (!title || !rationale) continue;

    const nodeIds = asStringArray(entry.nodeIds).filter((id) => known.has(id));
    if (nodeIds.length === 0) continue;

    const kind = String(entry.kind);
    const confidence = String(entry.confidence);
    const expectedBenefit = entry.expectedBenefit
      ? String(entry.expectedBenefit).trim()
      : undefined;

    opportunities.push({
      title,
      kind: (VALID_OPPORTUNITY_KINDS.has(kind)
        ? kind
        : "other") as AutomationOpportunityKind,
      nodeIds,
      rationale,
      expectedBenefit: expectedBenefit || undefined,
      prerequisites: asStringArray(entry.prerequisites),
      confidence: (VALID_CONFIDENCE.has(confidence)
        ? confidence
        : "medium") as FlowConfidence,
    });
  }

  return opportunities;
}

/** The one-line form the existing Insights tab renders. */
export function summarizeAutomationOpportunity(
  opportunity: AutomationOpportunity,
): string {
  return `${opportunity.title}: ${opportunity.rationale}`;
}

// ---------------------------------------------------------------------------
// Normalizers — every field is coerced, because a provider that drifts from
// the schema must degrade a field, never fail a whole generation.
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function normalizeGraphResponse(payload: unknown): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  criticalPath: string[];
  totalEstimatedDuration?: string;
} {
  const parsed = (payload ?? {}) as Record<string, unknown>;

  const nodes: GraphNode[] = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
    .map((raw) => {
      const node = (raw ?? {}) as Record<string, unknown>;
      const category = String(node.category);
      return {
        id: String(node.id ?? ""),
        label: String(node.label ?? ""),
        category: (VALID_CATEGORIES.has(category)
          ? category
          : "action") as FlowNodeCategory,
      };
    })
    .filter((node) => node.id && node.label);

  // Duplicate ids would make detail rows ambiguous, and the detail pass keys
  // off node id. First occurrence wins.
  const seen = new Set<string>();
  const uniqueNodes = nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });

  const edges: GraphEdge[] = (Array.isArray(parsed.edges) ? parsed.edges : [])
    .map((raw) => {
      const edge = (raw ?? {}) as Record<string, unknown>;
      const type = String(edge.type);
      return {
        id: String(edge.id ?? `${edge.source}-${edge.target}`),
        source: String(edge.source ?? ""),
        target: String(edge.target ?? ""),
        type: (VALID_EDGE_TYPES.has(type)
          ? type
          : "sequential") as FlowEdgeType,
        label: edge.label ? String(edge.label) : undefined,
        isHappyPath: edge.isHappyPath !== false,
      };
    })
    .filter(
      (edge) =>
        edge.source &&
        edge.target &&
        seen.has(edge.source) &&
        seen.has(edge.target),
    );

  const rawInsights = (parsed.insights ?? {}) as Record<string, unknown>;

  return {
    nodes: uniqueNodes,
    edges,
    criticalPath: asStringArray(rawInsights.criticalPath).filter((id) =>
      seen.has(id),
    ),
    totalEstimatedDuration: rawInsights.totalEstimatedDuration
      ? String(rawInsights.totalEstimatedDuration)
      : undefined,
  };
}

/**
 * Details keyed by node id, restricted to the nodes that were requested.
 *
 * A model that returns details for a node we did not ask about would otherwise
 * write over another batch's work, so extras are dropped rather than trusted.
 */
export function normalizeNodeDetailsResponse(
  payload: unknown,
  requestedNodeIds: readonly string[],
): Map<string, FlowNodeDetail> {
  const requested = new Set(requestedNodeIds);
  const parsed = (payload ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(parsed.details) ? parsed.details : [];
  const byNodeId = new Map<string, FlowNodeDetail>();

  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const nodeId = String(entry.nodeId ?? "");
    if (!requested.has(nodeId) || byNodeId.has(nodeId)) continue;

    const automationPotential = String(entry.automationPotential);
    const confidence = String(entry.confidence);

    byNodeId.set(nodeId, {
      description: String(entry.description ?? ""),
      actors: asStringArray(entry.actors),
      tools: asStringArray(entry.tools),
      estimatedDuration: entry.estimatedDuration
        ? String(entry.estimatedDuration)
        : undefined,
      painPoints: asStringArray(entry.painPoints),
      // "none" means "already automated" in this taxonomy, so an unknown value
      // must fall back to a weak candidate — never to none, which would hide
      // the step from the Insights tab's automation candidates entirely.
      automationPotential: (VALID_AUTOMATION.has(automationPotential)
        ? automationPotential
        : "low") as FlowAutomationPotential,
      confidence: (VALID_CONFIDENCE.has(confidence)
        ? confidence
        : "medium") as FlowConfidence,
      isBottleneck: entry.isBottleneck === true,
      isTribalKnowledge: entry.isTribalKnowledge === true,
      riskIndicators: asStringArray(entry.riskIndicators),
      sources: asStringArray(entry.sources),
    });
  }

  return byNodeId;
}

/** The detail a node carries before its batch has run. */
export function placeholderNodeDetail(): FlowNodeDetail {
  return {
    description: "",
    actors: [],
    tools: [],
    painPoints: [],
    automationPotential: "low",
    confidence: "medium",
    isBottleneck: false,
    isTribalKnowledge: false,
    riskIndicators: [],
    sources: [],
  };
}

/**
 * Recomputes the detail-derived half of `insights` once the batches are in.
 *
 * The counting parts (tools, bottlenecks) are mechanical so that finalizing a
 * run cannot itself fail on a timeout or a token cap. Automation opportunities
 * are NOT mechanical: they come from the insights stage and are passed in.
 * `source` records which you got, because a mechanical fallback is a placeholder
 * for a human to look at — downstream work must not mistake it for an analysed
 * opportunity.
 */
export function deriveFlowInsights(
  nodes: ReadonlyArray<{
    id: string;
    label: string;
    category: FlowNodeCategory;
  }>,
  detailsByNodeId: ReadonlyMap<string, FlowNodeDetail>,
  base: {
    criticalPath: string[];
    totalEstimatedDuration?: string;
    automationOpportunityDetails?: AutomationOpportunity[];
  },
): {
  totalEstimatedDuration?: string;
  criticalPath: string[];
  handoffCount: number;
  toolCount: number;
  automationOpportunities: string[];
  automationOpportunityDetails?: AutomationOpportunity[];
  automationOpportunitiesSource: "ai" | "derived";
  topBottlenecks: string[];
} {
  const tools = new Set<string>();
  const bottlenecks: string[] = [];
  const fallbackOpportunities: string[] = [];

  for (const node of nodes) {
    const detail = detailsByNodeId.get(node.id);
    if (!detail) continue;
    for (const tool of detail.tools) tools.add(tool);
    if (detail.isBottleneck) bottlenecks.push(node.label);
    if (
      detail.automationPotential === "high" ||
      detail.automationPotential === "medium"
    ) {
      // Only reached when the insights stage failed. Enough to show the user
      // which steps looked automatable, and explicitly not a substitute for the
      // analysed opportunity.
      const reason = detail.painPoints[0] ?? detail.description;
      fallbackOpportunities.push(
        reason ? `${node.label}: ${reason}` : node.label,
      );
    }
  }

  const analysed = base.automationOpportunityDetails ?? [];
  const hasAnalysed = analysed.length > 0;

  return {
    totalEstimatedDuration: base.totalEstimatedDuration,
    criticalPath: base.criticalPath,
    handoffCount: nodes.filter((node) => node.category === "handoff").length,
    toolCount: tools.size,
    automationOpportunities: hasAnalysed
      ? analysed.map(summarizeAutomationOpportunity)
      : fallbackOpportunities,
    automationOpportunityDetails: hasAnalysed ? analysed : undefined,
    automationOpportunitiesSource: hasAnalysed ? "ai" : "derived",
    topBottlenecks: bottlenecks,
  };
}
