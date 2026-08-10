import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOrgMember, resolveOrgForAction } from "./lib/orgAuth";
import {
  isAIConfigured,
  isTokenLimitFinishReason,
  type AICompletion,
} from "./lib/aiProvider";
import { meteredCompletion } from "./lib/aiUsageMeter";
import { extractDataCollection } from "./lib/conversationAnalysis";
import {
  buildFlowInsightsAIRequest,
  buildGraphAIRequest,
  buildNodeDetailsAIRequest,
  deriveFlowInsights,
  GRAPH_MAX_TOKENS,
  INSIGHTS_MAX_TOKENS,
  NODE_DETAILS_BATCH_SIZE,
  NODE_DETAILS_MAX_TOKENS,
  normalizeAutomationOpportunities,
  normalizeGraphResponse,
  normalizeNodeDetailsResponse,
  placeholderNodeDetail,
  SOFT_MAX_NODES,
  type AutomationOpportunity,
  type FlowNodeDetail,
} from "./lib/flowStages";
import {
  buildFlowQualityReport,
  compareFlowQualityReports,
  type FlowQualityComparison,
  type FlowQualityReport,
  type FlowQualitySnapshot,
} from "./lib/flowQuality";
import {
  automationOpportunityValidator,
  flowEdgeFields,
  flowNodeCategoryValidator,
  flowNodeDetailFields,
} from "./schema";
import { flowSummarySourceSnapshotValidator } from "./summaryV2";

// ---------------------------------------------------------------------------
// Response parsing shared by both generation stages.
//
// The 32,768-token single-call request that used to live here is gone: it was
// the thing that truncated on complex processes and timed out on slow ones.
// Prompts and budgets now live in lib/flowStages.ts, one per stage.
// ---------------------------------------------------------------------------

const FLOW_TOKEN_LIMIT_ERROR_MESSAGE =
  "Process flow response was too large for the AI response limit. Please try again; if it keeps failing, this process needs simplified flow generation.";

type ParsedFlowResponse = {
  nodes?: unknown[];
  edges?: unknown[];
  insights?: Record<string, unknown>;
};

function contentBlocksToText(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }

  if (!Array.isArray(content)) return null;

  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();

  return text ? text : null;
}

function extractBalancedJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i++) {
    const char = content[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return content.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseJsonObjectText(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed
    .match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
    ?.trim();
  const balanced = extractBalancedJsonObject(fenced ?? trimmed);
  const candidates = [trimmed, fenced, balanced].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Flow response was not valid JSON.");
}

export function parseFlowResponsePayload(payload: unknown): ParsedFlowResponse {
  let parsed: unknown;
  const text = contentBlocksToText(payload);

  if (text) {
    parsed = parseJsonObjectText(text);
  } else {
    parsed = payload;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Flow response was not a JSON object.");
  }

  return parsed as ParsedFlowResponse;
}

// ---------------------------------------------------------------------------
// Helpers: safely parse JSON fields from ElevenLabs analysis
// ---------------------------------------------------------------------------

interface StructuredStep {
  id?: string;
  name?: string;
  type?: string;
  actor?: string;
  tools?: string[];
  duration?: string | null;
}

interface StepConnection {
  from?: string;
  to?: string;
  condition?: string | null;
}

interface StepIssue {
  step_id?: string;
  pain_point?: string | null;
  is_bottleneck?: boolean;
  bottleneck_reason?: string | null;
  automation_potential?: string | null;
  workaround?: string | null;
}

function tryParseJson<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function formatConversationData(
  conv: {
    contributorName: string;
    analysis: Record<string, unknown> | null;
    creationTime: number;
  },
  index: number,
): string {
  // Normalized rather than read directly: agent-mode conversations carry these
  // fields inside ElevenLabs' envelopes, and reading `data_collection` meant
  // every one of them reached this stage as "no structured data".
  const dc = extractDataCollection(conv.analysis);

  if (!dc) {
    return `[Conversation ${index} — ${conv.contributorName}]\nNo structured data available.`;
  }

  const structuredSteps = tryParseJson<StructuredStep[]>(dc.process_steps);
  const connections = tryParseJson<StepConnection[]>(dc.step_connections);
  const issues = tryParseJson<StepIssue[]>(dc.step_issues);

  if (structuredSteps && structuredSteps.length > 0) {
    const parts: string[] = [
      `[Conversation ${index} — ${conv.contributorName}] (structured)`,
      `Steps Graph: ${JSON.stringify(structuredSteps)}`,
    ];
    if (connections && connections.length > 0) {
      parts.push(`Connections: ${JSON.stringify(connections)}`);
    }
    if (issues && issues.length > 0) {
      parts.push(`Issues: ${JSON.stringify(issues)}`);
    }
    if (dc.dependencies) parts.push(`Dependencies: ${dc.dependencies}`);
    if (dc.frequency) parts.push(`Frequency: ${dc.frequency}`);
    if (dc.edge_cases) parts.push(`Edge Cases: ${dc.edge_cases}`);
    if (dc.compliance_or_approvals)
      parts.push(`Approvals: ${dc.compliance_or_approvals}`);
    if (dc.total_process_duration)
      parts.push(`Total Duration: ${dc.total_process_duration}`);
    return parts.join("\n");
  }

  const parts: string[] = [
    `[Conversation ${index} — ${conv.contributorName}] (legacy)`,
  ];
  if (dc.steps_described) {
    const steps = Array.isArray(dc.steps_described)
      ? dc.steps_described.join("\n  - ")
      : dc.steps_described;
    parts.push(`Steps:\n  - ${steps}`);
  }
  if (dc.tools_mentioned) {
    const tools = Array.isArray(dc.tools_mentioned)
      ? dc.tools_mentioned.join(", ")
      : dc.tools_mentioned;
    parts.push(`Tools: ${tools}`);
  }
  if (dc.dependencies) {
    const deps = Array.isArray(dc.dependencies)
      ? dc.dependencies.join(", ")
      : dc.dependencies;
    parts.push(`Dependencies: ${deps}`);
  }
  if (dc.frequency) parts.push(`Frequency: ${dc.frequency}`);
  if (dc.edge_cases) {
    const cases = Array.isArray(dc.edge_cases)
      ? dc.edge_cases.join("\n  - ")
      : dc.edge_cases;
    parts.push(`Edge Cases:\n  - ${cases}`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Internal queries — org-scoped via explicit clerkOrgId arg
// ---------------------------------------------------------------------------

/**
 * The evidence block both stages read from: the rolling summary plus each
 * conversation's structured analysis.
 */
function buildEvidenceBlock(data: {
  rollingSummary: string | null;
  conversations: Array<{
    contributorName: string;
    analysis: Record<string, unknown> | null;
    creationTime: number;
  }>;
}): string {
  const conversationBlocks = data.conversations
    .map((c, i) => formatConversationData(c, i + 1))
    .join("\n\n---\n\n");

  return data.rollingSummary
    ? `Process Summary:\n${data.rollingSummary}\n\n---\n\nConversation Data:\n\n${conversationBlocks}`
    : `Conversation Data:\n\n${conversationBlocks}`;
}

/**
 * The detail pass sees the settled graph, the same evidence the graph pass saw,
 * and the specific nodes it is responsible for. The graph goes in compact form
 * — the model needs the topology for context, not a second copy of the prose.
 */
function buildNodeDetailsUserContent(
  graph: {
    nodes: Array<{ id: string; label: string; category: string }>;
    edges: Array<{ source: string; target: string; type: string }>;
  },
  data: {
    rollingSummary: string | null;
    conversations: Array<{
      contributorName: string;
      analysis: Record<string, unknown> | null;
      creationTime: number;
    }>;
  },
  nodeIds: readonly string[],
): string {
  const graphOutline = graph.nodes
    .map((node) => `- ${node.id} (${node.category}): ${node.label}`)
    .join("\n");
  const edgeOutline = graph.edges
    .map((edge) => `- ${edge.source} -> ${edge.target} (${edge.type})`)
    .join("\n");
  const requested = graph.nodes
    .filter((node) => nodeIds.includes(node.id))
    .map((node) => `- ${node.id}: ${node.label}`)
    .join("\n");

  return [
    `Process graph (settled — do not change it):\nSteps:\n${graphOutline}\n\nConnections:\n${edgeOutline}`,
    `Describe ONLY these ${nodeIds.length} steps:\n${requested}`,
    `Evidence:\n\n${buildEvidenceBlock(data)}`,
  ].join("\n\n---\n\n");
}

/**
 * The whole enriched process in one block: every step with what contributors
 * said about it, plus the connections. The automation pass needs to see all of
 * it at once — that is the point of it being its own stage.
 */
function buildInsightsUserContent(flow: {
  nodes: Array<{
    id: string;
    label: string;
    category: string;
    detail: FlowNodeDetail | null;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    label?: string;
  }>;
}): string {
  const steps = flow.nodes
    .map((node) => {
      const lines = [`### ${node.id} — ${node.label} (${node.category})`];
      const detail = node.detail;
      if (!detail) {
        lines.push("No description available for this step.");
        return lines.join("\n");
      }
      lines.push(detail.description);
      if (detail.actors.length)
        lines.push(`Actors: ${detail.actors.join(", ")}`);
      if (detail.tools.length) lines.push(`Tools: ${detail.tools.join(", ")}`);
      if (detail.estimatedDuration) {
        lines.push(`Duration: ${detail.estimatedDuration}`);
      }
      if (detail.painPoints.length) {
        lines.push(`Pain points: ${detail.painPoints.join(" | ")}`);
      }
      if (detail.riskIndicators.length) {
        lines.push(`Risks: ${detail.riskIndicators.join(" | ")}`);
      }
      lines.push(
        `Automation potential: ${detail.automationPotential}; bottleneck: ${detail.isBottleneck}; tribal knowledge: ${detail.isTribalKnowledge}; confidence: ${detail.confidence}`,
      );
      if (detail.sources.length) {
        lines.push(`Described by: ${detail.sources.join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  const connections = flow.edges
    .map(
      (edge) =>
        `- ${edge.source} -> ${edge.target} (${edge.type}${edge.label ? `: ${edge.label}` : ""})`,
    )
    .join("\n");

  return `## Process steps\n\n${steps}\n\n## Connections\n\n${connections}`;
}

export const getFlowByProcess = internalQuery({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("processId", args.processId),
      )
      .first();
  },
});

/**
 * Cap on how many conversations feed one flow generation. Convex reads whole
 * documents, so every conversation row costs its transcript whether or not the
 * caller wants it — the only lever a query has is how many rows it touches.
 * Keep in step with MAX_CONVERSATIONS_PER_SUMMARY in postCall.ts.
 */
const MAX_CONVERSATIONS_PER_FLOW = 50;

export const getFlowGenerationData = internalQuery({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Process not found in this organization");
    }
    const rollingSummary = process.rollingSummary ?? null;
    const summarySourceSnapshot = process.summaryV2
      ? {
          sourceSnapshotHash:
            process.summaryV2.provenance.sourceSnapshotHash,
          summaryGeneratedAt: process.summaryV2.provenance.generatedAt,
          summaryPromptVersion: process.summaryV2.provenance.promptVersion,
        }
      : null;

    // Bounded read. This used to `.collect()` every conversation row for the
    // process — full transcripts included — only to keep the `done` ones and
    // project their analysis. Filter on the index instead, and cap the count,
    // so a process with a long recording history cannot walk into the query
    // read limit.
    const doneRows = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId_and_status", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("processId", args.processId)
          .eq("status", "done"),
      )
      .order("asc")
      .take(MAX_CONVERSATIONS_PER_FLOW + 1);

    if (doneRows.length > MAX_CONVERSATIONS_PER_FLOW) {
      // Loud rather than silent: a flow generated from a truncated evidence
      // set is still a flow, and would otherwise look complete.
      console.warn("Process exceeds the flow-generation conversation cap", {
        processId: args.processId,
        cap: MAX_CONVERSATIONS_PER_FLOW,
      });
    }

    const doneConversations = doneRows
      .slice(0, MAX_CONVERSATIONS_PER_FLOW)
      .map((c) => ({
        contributorName: c.contributorName,
        analysis: (c.analysis ?? null) as Record<string, unknown> | null,
        creationTime: c._creationTime,
      }));

    return {
      rollingSummary,
      summarySourceSnapshot,
      conversations: doneConversations,
    };
  },
});

// ---------------------------------------------------------------------------
// Quality-parity gate support.
//
// Regenerating patches the flow row in place, so the single-call flow a new run
// replaces is gone the moment the new graph saves. Capture the report BEFORE
// regenerating, then compare:
//
//   npx convex run processFlows:flowQualityReport '{"processId":"<id>","clerkOrgId":"<org>"}' > before.json
//   # regenerate the flow in the app, wait for detailsStatus: "ready"
//   npx convex run processFlows:compareFlowQuality '{"processId":"<id>","clerkOrgId":"<org>","before":<paste before.json>}'
// ---------------------------------------------------------------------------

async function buildQualitySnapshot(
  ctx: { db: QueryCtx["db"] },
  processId: Id<"processes">,
  clerkOrgId: string,
): Promise<FlowQualitySnapshot | null> {
  const process = await ctx.db.get(processId);
  if (!process || process.clerkOrgId !== clerkOrgId) return null;

  const flow = await ctx.db
    .query("processFlows")
    .withIndex("by_clerkOrgId_and_processId", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("processId", processId),
    )
    .first();
  if (!flow) return null;

  // Detail rows are overlaid the same way the read path does it, so the report
  // measures what a user would actually see.
  const detailRows =
    flow.generationId === undefined
      ? []
      : await ctx.db
          .query("processFlowNodeDetails")
          .withIndex(
            "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
            (q) =>
              q
                .eq("clerkOrgId", clerkOrgId)
                .eq("processFlowId", flow._id)
                .eq("generationId", flow.generationId!),
          )
          .take(SOFT_MAX_NODES * 4);
  const rowByNodeId = new Map(detailRows.map((row) => [row.nodeId, row]));

  return {
    processName: process.name,
    generationVersion: flow.generationVersion ?? null,
    status: flow.status,
    detailsStatus: flow.detailsStatus ?? null,
    conversationCount: flow.conversationCount,
    nodes: flow.nodes.map((node) => {
      const row = rowByNodeId.get(node.id);
      const detail = row?.detail;
      return {
        id: node.id,
        label: node.label,
        category: node.category,
        description: detail?.description ?? node.description,
        actors: detail?.actors ?? node.actors,
        tools: detail?.tools ?? node.tools,
        painPoints: detail?.painPoints ?? node.painPoints,
        riskIndicators: detail?.riskIndicators ?? node.riskIndicators,
        sources: detail?.sources ?? node.sources,
        detailStatus: row?.status ?? (flow.generationId ? "pending" : "ready"),
      };
    }),
    edges: flow.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
    })),
    criticalPath: flow.insights.criticalPath,
    automationOpportunities: flow.insights.automationOpportunities,
    automationOpportunityDetails:
      flow.insights.automationOpportunityDetails?.map((opportunity) => ({
        kind: opportunity.kind,
        nodeIds: opportunity.nodeIds,
      })),
    automationOpportunitiesSource:
      flow.insights.automationOpportunitiesSource ?? null,
    topBottlenecks: flow.insights.topBottlenecks,
    rollingSummary: process.rollingSummary ?? null,
  };
}

export const flowQualityReport = internalQuery({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<FlowQualityReport | null> => {
    const snapshot = await buildQualitySnapshot(
      ctx,
      args.processId,
      args.clerkOrgId,
    );
    return snapshot === null ? null : buildFlowQualityReport(snapshot);
  },
});

export const compareFlowQuality = internalQuery({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    /** A report captured by `flowQualityReport` before regenerating. */
    before: v.any(),
  },
  handler: async (ctx, args): Promise<FlowQualityComparison | null> => {
    const snapshot = await buildQualitySnapshot(
      ctx,
      args.processId,
      args.clerkOrgId,
    );
    if (snapshot === null) return null;
    return compareFlowQualityReports(
      args.before as FlowQualityReport,
      buildFlowQualityReport(snapshot),
    );
  },
});

/**
 * Internal query used by the public generateProcessFlow action to assert
 * that the caller's org owns the given processId before scheduling work.
 */
export const assertProcessInOrg = internalQuery({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.processId);
    if (!doc || doc.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Process not found");
    }
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// Staged generation — mutation layer
//
// Every write after the first is a field-scoped `patch`, never a `replace`.
// A `replace` that forgets to carry `generationId`, `detailsStatus`, or the
// counters silently wipes them, which is the single most likely regression in
// this migration: the pipeline would keep running while its own bookkeeping
// vanished.
// ---------------------------------------------------------------------------

/** A regeneration requested while a run is this fresh joins it instead. */
const FLOW_GENERATION_STALE_MS = 120_000;

/** Detail rows deleted per cleanup pass, to stay inside transaction limits. */
const DETAIL_CLEANUP_BATCH = 100;

/**
 * True when this write belongs to the run that currently owns the flow. A
 * superseded run's writes are dropped rather than applied — the user clicked
 * regenerate, and the older pipeline is still draining.
 */
function ownsGeneration(
  flow: Doc<"processFlows"> | null,
  generationId: string,
): flow is Doc<"processFlows"> {
  return flow !== null && flow.generationId === generationId;
}

async function startFlowGenerationForOrg(
  ctx: MutationCtx,
  args: { processId: Id<"processes">; clerkOrgId: string },
): Promise<{
  generationId: string;
  processFlowId: Id<"processFlows">;
  joined: boolean;
}> {
  const existing = await ctx.db
    .query("processFlows")
    .withIndex("by_clerkOrgId_and_processId", (q) =>
      q.eq("clerkOrgId", args.clerkOrgId).eq("processId", args.processId),
    )
    .first();

  const now = Date.now();

  // Duplicate-trigger guard. `generationId` already stops stale *writes*, but
  // two clicks would still burn two full pipelines of tokens, so the second
  // joins the first. A run whose heartbeat has gone stale may be superseded —
  // that is the escape hatch for a wedged generation.
  if (
    existing &&
    existing.generationId !== undefined &&
    (existing.status === "generating" ||
      existing.detailsStatus === "generating") &&
    now - (existing.lastProgressAt ?? 0) < FLOW_GENERATION_STALE_MS
  ) {
    return {
      generationId: existing.generationId,
      processFlowId: existing._id,
      joined: true,
    };
  }

  const generationId = crypto.randomUUID();

  if (existing) {
    // The previous graph is deliberately left in place: if this run fails,
    // the user still has the flow they had before. Nothing renders it while
    // `status` is "generating".
    await ctx.db.patch(existing._id, {
      status: "generating",
      stale: false,
      generationVersion: "v3",
      generationId,
      detailsStatus: "pending",
      detailNodeCount: undefined,
      detailCompletedCount: undefined,
      detailFailedCount: undefined,
      detailsGeneratedAt: undefined,
      detailErrorMessage: undefined,
      errorMessage: undefined,
      lastProgressAt: now,
      resumeAttempts: 0,
    });
    return { generationId, processFlowId: existing._id, joined: false };
  }

  const processFlowId = await ctx.db.insert("processFlows", {
    processId: args.processId,
    clerkOrgId: args.clerkOrgId,
    status: "generating",
    stale: false,
    generatedAt: now,
    conversationCount: 0,
    nodes: [],
    edges: [],
    insights: {
      criticalPath: [],
      handoffCount: 0,
      toolCount: 0,
      automationOpportunities: [],
      topBottlenecks: [],
    },
    generationVersion: "v3",
    generationId,
    detailsStatus: "pending",
    lastProgressAt: now,
    resumeAttempts: 0,
  });

  return { generationId, processFlowId, joined: false };
}

export const startFlowGeneration = internalMutation({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: startFlowGenerationForOrg,
});

/**
 * Starts the staged pipeline with no authenticated caller, for the automatic
 * trigger that fires when a conversation finishes recording.
 *
 * Same body as the public `generateProcessFlow` action minus the auth gate:
 * the caller has already established which org the finished conversation
 * belongs to, and there is no human to authorize. The duplicate-trigger guard
 * inside `startFlowGenerationForOrg` still applies, so several conversations
 * landing together join one run rather than buying one pipeline each.
 */
export const requestFlowGeneration = internalMutation({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ scheduled: boolean; generationId: string }> => {
    const started = await startFlowGenerationForOrg(ctx, args);
    if (started.joined) {
      return { scheduled: false, generationId: started.generationId };
    }

    await ctx.scheduler.runAfter(
      0,
      internal.processFlows.generateGraphInternal,
      {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId: started.generationId,
      },
    );
    return { scheduled: true, generationId: started.generationId };
  },
});

export const saveFlowGraph = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
    conversationCount: v.number(),
    nodes: v.array(
      v.object({
        id: v.string(),
        label: v.string(),
        category: flowNodeCategoryValidator,
      }),
    ),
    edges: v.array(v.object(flowEdgeFields)),
    criticalPath: v.array(v.string()),
    totalEstimatedDuration: v.optional(v.string()),
    summarySourceSnapshot: v.optional(flowSummarySourceSnapshotValidator),
  },
  handler: async (ctx, args): Promise<Id<"processFlows"> | null> => {
    const flow = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("processId", args.processId),
      )
      .first();
    if (!ownsGeneration(flow, args.generationId)) return null;

    if (args.nodes.length > SOFT_MAX_NODES) {
      // Soft on purpose: a count-based reject would turn a large process back
      // into a total failure, which is what this whole design removes. Surface
      // it for product review instead.
      console.warn("Process flow exceeded the soft node target", {
        processId: args.processId,
        nodeCount: args.nodes.length,
        target: SOFT_MAX_NODES,
      });
    }

    const now = Date.now();
    await ctx.db.patch(flow._id, {
      status: "ready",
      stale: false,
      generatedAt: now,
      conversationCount: args.conversationCount,
      summarySourceSnapshot: args.summarySourceSnapshot,
      errorMessage: undefined,
      // Detail-bearing fields carry placeholders until their batch lands; the
      // read overlays real values from the child table.
      nodes: args.nodes.map((node) => ({
        ...node,
        ...placeholderNodeDetail(),
      })),
      edges: args.edges,
      insights: {
        totalEstimatedDuration: args.totalEstimatedDuration,
        criticalPath: args.criticalPath,
        handoffCount: args.nodes.filter((n) => n.category === "handoff").length,
        toolCount: 0,
        automationOpportunities: [],
        topBottlenecks: [],
      },
      detailsStatus: "generating",
      detailNodeCount: args.nodes.length,
      detailCompletedCount: 0,
      detailFailedCount: 0,
      lastProgressAt: now,
    });

    for (const node of args.nodes) {
      await ctx.db.insert("processFlowNodeDetails", {
        clerkOrgId: args.clerkOrgId,
        processId: args.processId,
        processFlowId: flow._id,
        generationId: args.generationId,
        nodeId: node.id,
        status: "pending",
      });
    }

    return flow._id;
  },
});

export const getNodeDetailBatch = internalQuery({
  args: {
    clerkOrgId: v.string(),
    processFlowId: v.id("processFlows"),
    generationId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.processFlowId);
    if (!ownsGeneration(flow, args.generationId)) return null;
    if (flow.clerkOrgId !== args.clerkOrgId) return null;

    const pending = await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_status",
        (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("processFlowId", args.processFlowId)
            .eq("generationId", args.generationId)
            .eq("status", "pending"),
      )
      .take(args.limit);

    return {
      nodeIds: pending.map((row) => row.nodeId),
      graph: {
        nodes: flow.nodes.map((n) => ({
          id: n.id,
          label: n.label,
          category: n.category,
        })),
        edges: flow.edges,
      },
    };
  },
});

export const saveNodeDetailBatch = internalMutation({
  args: {
    clerkOrgId: v.string(),
    processFlowId: v.id("processFlows"),
    generationId: v.string(),
    results: v.array(
      v.object({
        nodeId: v.string(),
        detail: v.optional(v.object(flowNodeDetailFields)),
        errorMessage: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    const flow = await ctx.db.get(args.processFlowId);
    if (!ownsGeneration(flow, args.generationId)) return;

    const now = Date.now();

    for (const result of args.results) {
      const row = await ctx.db
        .query("processFlowNodeDetails")
        .withIndex(
          "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
          (q) =>
            q
              .eq("clerkOrgId", args.clerkOrgId)
              .eq("processFlowId", args.processFlowId)
              .eq("generationId", args.generationId)
              .eq("nodeId", result.nodeId),
        )
        .first();
      if (!row) continue;

      if (result.detail) {
        await ctx.db.patch(row._id, {
          status: "ready",
          detail: result.detail,
          generatedAt: now,
          errorMessage: undefined,
        });
      } else {
        await ctx.db.patch(row._id, {
          status: "failed",
          errorMessage: result.errorMessage ?? "No detail returned.",
        });
      }
    }

    // Counts are recomputed from the rows rather than incremented, so a
    // resumed or retried batch cannot double-count.
    const rows = await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
        (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("processFlowId", args.processFlowId)
            .eq("generationId", args.generationId),
      )
      .take(SOFT_MAX_NODES * 4);

    await ctx.db.patch(flow._id, {
      detailCompletedCount: rows.filter((r) => r.status === "ready").length,
      detailFailedCount: rows.filter((r) => r.status === "failed").length,
      lastProgressAt: now,
    });
  },
});

export const finalizeNodeDetails = internalMutation({
  args: {
    clerkOrgId: v.string(),
    processFlowId: v.id("processFlows"),
    generationId: v.string(),
    // Supplied by the insights stage. Absent means that stage failed or was
    // skipped (the watchdog finalizes without it), and the rollup falls back to
    // flagging automatable-looking steps.
    automationOpportunityDetails: v.optional(
      v.array(automationOpportunityValidator),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    const flow = await ctx.db.get(args.processFlowId);
    if (!ownsGeneration(flow, args.generationId)) return;

    const rows = await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
        (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("processFlowId", args.processFlowId)
            .eq("generationId", args.generationId),
      )
      .take(SOFT_MAX_NODES * 4);

    const detailsByNodeId = new Map<string, FlowNodeDetail>();
    for (const row of rows) {
      if (row.status === "ready" && row.detail) {
        detailsByNodeId.set(row.nodeId, row.detail);
      }
    }

    const completed = detailsByNodeId.size;
    const failed = rows.filter((r) => r.status === "failed").length;
    const unfinished = rows.length - completed - failed;

    // No LLM call here on purpose: finalizing must not itself be able to fail
    // on a timeout or a token cap, or the pipeline would have a last step that
    // can strand a finished generation. The analysed opportunities are produced
    // by the insights stage and handed in.
    const insights = deriveFlowInsights(flow.nodes, detailsByNodeId, {
      criticalPath: flow.insights.criticalPath,
      totalEstimatedDuration: flow.insights.totalEstimatedDuration,
      automationOpportunityDetails: args.automationOpportunityDetails,
    });

    const detailsStatus =
      completed === 0 && rows.length > 0
        ? "failed"
        : failed + unfinished > 0
          ? "partial"
          : "ready";

    await ctx.db.patch(flow._id, {
      insights,
      detailsStatus,
      detailNodeCount: rows.length,
      detailCompletedCount: completed,
      detailFailedCount: failed + unfinished,
      detailsGeneratedAt: Date.now(),
      detailErrorMessage:
        detailsStatus === "ready"
          ? undefined
          : `${failed + unfinished} of ${rows.length} steps could not be described.`,
      lastProgressAt: Date.now(),
    });
  },
});

export const failFlowGeneration = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
    stage: v.union(v.literal("graph"), v.literal("details")),
    errorMessage: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const flow = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("processId", args.processId),
      )
      .first();
    if (!ownsGeneration(flow, args.generationId)) return;

    const now = Date.now();

    if (args.stage === "graph") {
      // `nodes`, `edges`, `insights`, `conversationCount` and `generatedAt` are
      // all left alone on purpose. A failed refresh keeps whatever flow the user
      // already had, intact and still describing the conversations it was
      // actually built from — writing the *attempted* conversation count here
      // would make the retained flow claim coverage it never had.
      await ctx.db.patch(flow._id, {
        status: "failed",
        errorMessage: args.errorMessage,
        detailsStatus: undefined,
        lastProgressAt: now,
      });
      return;
    }

    // The graph survived, so the flow stays usable — only enrichment failed.
    await ctx.db.patch(flow._id, {
      detailsStatus: "failed",
      detailErrorMessage: args.errorMessage,
      lastProgressAt: now,
    });
  },
});

/**
 * Deletes detail rows left behind by superseded generations, one bounded batch
 * per call. Without this the child table accumulates every previous run's rows
 * forever.
 */
export const cleanupSupersededDetailRows = internalMutation({
  args: {
    clerkOrgId: v.string(),
    processFlowId: v.id("processFlows"),
    keepGenerationId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const rows = await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
        (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("processFlowId", args.processFlowId),
      )
      .take(DETAIL_CLEANUP_BATCH * 2);

    const stale = rows
      .filter((row) => row.generationId !== args.keepGenerationId)
      .slice(0, DETAIL_CLEANUP_BATCH);

    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    if (stale.length === DETAIL_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.processFlows.cleanupSupersededDetailRows,
        args,
      );
    }
  },
});

// ---------------------------------------------------------------------------
// Watchdog.
//
// Staging multiplies the number of scheduled actions from one to N+2, so
// recovery is part of the design rather than an afterthought. The case that
// try/catch cannot cover is an action killed *between* writing its batch and
// scheduling the next one — platform kill, OOM — which leaves pending rows with
// nothing scheduled and no error anywhere.
// ---------------------------------------------------------------------------

/** No heartbeat for this long means the run is gone, not slow. */
const FLOW_STUCK_AFTER_MS = 600_000;

/** Resume a wedged detail stage at most this many times before finalizing. */
const MAX_RESUME_ATTEMPTS = 2;

/** Flows examined per sweep. Bounded so the cron cannot blow a transaction. */
const REAP_BATCH = 25;

export const reapStuckFlowGenerations = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const cutoff = Date.now() - FLOW_STUCK_AFTER_MS;

    const stuckGraphRuns = await ctx.db
      .query("processFlows")
      .withIndex("by_status_and_lastProgressAt", (q) =>
        q.eq("status", "generating").lt("lastProgressAt", cutoff),
      )
      .take(REAP_BATCH);

    for (const flow of stuckGraphRuns) {
      // Deliberately not re-run from here. Re-issuing the graph call would
      // spend tokens on a run the user may have abandoned; the UI's retry is
      // the recovery path, and it is now reachable because the row is terminal.
      console.warn("Reaping a flow stuck in the graph stage", {
        processId: flow.processId,
        lastProgressAt: flow.lastProgressAt,
      });
      await ctx.db.patch(flow._id, {
        status: "failed",
        errorMessage: "Flow generation stopped unexpectedly. Please try again.",
        detailsStatus: undefined,
        lastProgressAt: Date.now(),
      });
    }

    const stuckDetailRuns = await ctx.db
      .query("processFlows")
      .withIndex("by_detailsStatus_and_lastProgressAt", (q) =>
        q.eq("detailsStatus", "generating").lt("lastProgressAt", cutoff),
      )
      .take(REAP_BATCH);

    for (const flow of stuckDetailRuns) {
      if (flow.generationId === undefined) continue;

      const attempts = flow.resumeAttempts ?? 0;
      const pending = await ctx.db
        .query("processFlowNodeDetails")
        .withIndex(
          "by_clerkOrgId_and_processFlowId_and_generationId_and_status",
          (q) =>
            q
              .eq("clerkOrgId", flow.clerkOrgId)
              .eq("processFlowId", flow._id)
              .eq("generationId", flow.generationId!)
              .eq("status", "pending"),
        )
        .take(1);

      // Nothing left to enrich, or out of attempts: finalize. The graph stays
      // usable and the row lands on partial/failed instead of generating
      // forever.
      if (pending.length === 0 || attempts >= MAX_RESUME_ATTEMPTS) {
        console.warn("Finalizing a flow stuck in the detail stage", {
          processId: flow.processId,
          resumeAttempts: attempts,
          pendingRemaining: pending.length,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.processFlows.finalizeNodeDetails,
          {
            clerkOrgId: flow.clerkOrgId,
            processFlowId: flow._id,
            generationId: flow.generationId,
          },
        );
        continue;
      }

      console.warn("Resuming a flow stuck in the detail stage", {
        processId: flow.processId,
        resumeAttempts: attempts + 1,
      });
      await ctx.db.patch(flow._id, {
        resumeAttempts: attempts + 1,
        lastProgressAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.processFlows.generateNodeDetailsBatchInternal,
        {
          processId: flow.processId,
          clerkOrgId: flow.clerkOrgId,
          processFlowId: flow._id,
          generationId: flow.generationId,
        },
      );
    }
  },
});

/**
 * Marks a flow as needing regeneration.
 *
 * The `trigger` matters, because the two callers know different things:
 *
 * - `evidenceChanged` — a conversation was removed or altered. The caller knows
 *   content the flow may cite is gone, so this always flags. Counting would not
 *   be enough: add a conversation, delete an older one, and the count returns to
 *   what it was while the flow still describes a deleted interview.
 *
 * - `summaryRebuilt` — the rolling summary was rewritten. This only flags when
 *   the number of completed conversations differs from what the flow was built
 *   from. Rebuilds became slow once they ran map-reduce, so one triggered by the
 *   same conversations the flow was just generated from lands minutes later;
 *   flagging there told the user to regenerate for a byte-identical result, and
 *   the UI explained it as a count mismatch when the counts were equal.
 *
 * Known gap: a conversation re-transcribed in place reaches neither trigger from
 * the summary path. Catching that needs a content fingerprint on the flow, the
 * way `processSummaryInputHash` does for summaries.
 */
/**
 * Puts a single failed node back in the queue.
 *
 * Without this, one step whose batch failed forces a full regeneration — every
 * other node re-described, and the automation analysis re-run, to recover one
 * description. Returns false when there is nothing to retry so the caller can
 * tell "already fine" from "did something".
 */
export const requeueNodeDetail = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    nodeId: v.string(),
  },
  handler: async (ctx, args): Promise<{ requeued: boolean }> => {
    const flow = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("processId", args.processId),
      )
      .first();
    if (!flow || flow.generationId === undefined) return { requeued: false };

    const row = await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
        (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("processFlowId", flow._id)
            .eq("generationId", flow.generationId!)
            .eq("nodeId", args.nodeId),
      )
      .first();
    if (!row || row.status === "ready" || row.status === "generating") {
      return { requeued: false };
    }

    await ctx.db.patch(row._id, {
      status: "pending",
      errorMessage: undefined,
    });
    // Back to "generating" so the UI shows work in flight and the watchdog will
    // reap this run if the retry itself dies.
    await ctx.db.patch(flow._id, {
      detailsStatus: "generating",
      detailErrorMessage: undefined,
      lastProgressAt: Date.now(),
      resumeAttempts: 0,
    });

    return { requeued: true };
  },
});

export const retryNodeDetail = action({
  args: { processId: v.id("processes"), nodeId: v.string() },
  handler: async (ctx, args): Promise<{ message: string | null }> => {
    const { orgId } = await resolveOrgForAction(ctx);
    await ctx.runQuery(internal.postCall.requireOrgContributorInternal, {});
    await ctx.runQuery(internal.processFlows.assertProcessInOrg, {
      processId: args.processId,
      clerkOrgId: orgId,
    });

    const { requeued } = await ctx.runMutation(
      internal.processFlows.requeueNodeDetail,
      { processId: args.processId, clerkOrgId: orgId, nodeId: args.nodeId },
    );
    if (!requeued) {
      return { message: "This step has nothing to retry." };
    }

    const flow = await ctx.runQuery(internal.processFlows.getFlowByProcess, {
      processId: args.processId,
      clerkOrgId: orgId,
    });
    if (!flow || flow.generationId === undefined) {
      return { message: "This flow is no longer available." };
    }

    // Batch size 1: this is one node, and asking for a batch would pull in
    // unrelated pending nodes the user did not ask about.
    await ctx.scheduler.runAfter(
      0,
      internal.processFlows.generateNodeDetailsBatchInternal,
      {
        processId: args.processId,
        clerkOrgId: orgId,
        processFlowId: flow._id,
        generationId: flow.generationId,
        batchSize: 1,
      },
    );

    return { message: null };
  },
});

export const markFlowStale = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    trigger: v.union(v.literal("evidenceChanged"), v.literal("summaryRebuilt")),
  },
  handler: async (ctx, args) => {
    const flow = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("processId", args.processId),
      )
      .first();
    if (!flow || flow.status !== "ready") return;

    if (args.trigger === "summaryRebuilt") {
      const process = await ctx.db.get(args.processId);
      const generatedFromSnapshot = flow.summarySourceSnapshot;
      const currentSnapshot = process?.summaryV2?.provenance;

      // New flows carry an exact overview snapshot. Once both sides have it,
      // compare hashes instead of falling back to conversation counts. Legacy
      // rows keep the established count-based behavior until regenerated.
      if (generatedFromSnapshot && currentSnapshot) {
        if (
          generatedFromSnapshot.sourceSnapshotHash ===
          currentSnapshot.sourceSnapshotHash
        ) {
          return;
        }
        await ctx.db.patch(flow._id, { stale: true });
        return;
      }

      const done = await ctx.db
        .query("conversations")
        .withIndex("by_clerkOrgId_and_processId_and_status", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("processId", args.processId)
            .eq("status", "done"),
        )
        .take(MAX_CONVERSATIONS_PER_FLOW + 1);

      if (done.length === flow.conversationCount) return;
    }

    await ctx.db.patch(flow._id, { stale: true });
  },
});

export const deleteForProcess = internalMutation({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const flow = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("processId", args.processId),
      )
      .first();
    if (!flow) return;

    // Children first, in bounded batches: deleting the parent first would
    // orphan rows that nothing can find again.
    const rows = await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
        (q) =>
          q.eq("clerkOrgId", args.clerkOrgId).eq("processFlowId", flow._id),
      )
      .take(DETAIL_CLEANUP_BATCH);

    for (const row of rows) {
      await ctx.db.delete(row._id);
    }

    if (rows.length === DETAIL_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.processFlows.deleteForProcess,
        args,
      );
      return;
    }

    await ctx.db.delete(flow._id);
  },
});

// ---------------------------------------------------------------------------
// Public query: read the flow for a process
// ---------------------------------------------------------------------------

export const getProcessFlow = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== caller.orgId) return null;

    const flow = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
      )
      .first();
    if (!flow) return null;

    // A legacy single-call flow already carries its details inline. Absent
    // `generationVersion` is the discriminator; every node reads as ready, and
    // the shape returned is byte-for-byte what it was before staging existed.
    if (
      flow.generationVersion === undefined ||
      flow.generationId === undefined
    ) {
      return {
        ...flow,
        detailsStatus: "ready" as const,
        nodes: flow.nodes.map((node) => ({
          ...node,
          detailStatus: "ready" as const,
          detailErrorMessage: undefined as string | undefined,
        })),
      };
    }

    // Staged flow: the aggregate row holds the topology with placeholder
    // details, and the real details live in the child table scoped to this
    // generation. Filtering on `generationId` is what stops a superseded run's
    // rows from bleeding into the read.
    const detailRows = await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
        (q) =>
          q
            .eq("clerkOrgId", caller.orgId)
            .eq("processFlowId", flow._id)
            .eq("generationId", flow.generationId!),
      )
      .take(SOFT_MAX_NODES * 4);

    const rowByNodeId = new Map(detailRows.map((row) => [row.nodeId, row]));

    return {
      ...flow,
      detailsStatus: flow.detailsStatus ?? "pending",
      nodes: flow.nodes.map((node) => {
        const row = rowByNodeId.get(node.id);
        // No row at all means the graph landed but this node was never seeded —
        // report it as pending rather than silently as ready.
        if (!row) {
          return {
            ...node,
            detailStatus: "pending" as const,
            detailErrorMessage: undefined as string | undefined,
          };
        }
        return {
          ...node,
          ...(row.detail ?? {}),
          detailStatus: row.status,
          detailErrorMessage: row.errorMessage,
        };
      }),
    };
  },
});

// ---------------------------------------------------------------------------
// Internal action: the actual LLM call (expects clerkOrgId threaded through)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stage 1: the graph. Topology only — cheap, bounded, and the thing the user
// actually waits for.
// ---------------------------------------------------------------------------

export const generateGraphInternal = internalAction({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!isAIConfigured("synthesis")) {
      console.error(
        "AI synthesis is not configured — skipping flow generation",
      );
      await ctx.runMutation(internal.processFlows.failFlowGeneration, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId: args.generationId,
        stage: "graph",
        errorMessage: "Flow generation is not configured (missing API key).",
      });
      return;
    }

    const data: {
      rollingSummary: string | null;
      summarySourceSnapshot: {
        sourceSnapshotHash: string;
        summaryGeneratedAt: number;
        summaryPromptVersion: string;
      } | null;
      conversations: Array<{
        contributorName: string;
        analysis: Record<string, unknown> | null;
        creationTime: number;
      }>;
    } = await ctx.runQuery(internal.processFlows.getFlowGenerationData, {
      processId: args.processId,
      clerkOrgId: args.clerkOrgId,
    });

    if (data.conversations.length === 0) {
      await ctx.runMutation(internal.processFlows.failFlowGeneration, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId: args.generationId,
        stage: "graph",
        errorMessage:
          "No completed conversations available. Record conversations first.",
      });
      return;
    }

    const conversationBlocks = data.conversations
      .map((c, i) => formatConversationData(c, i + 1))
      .join("\n\n---\n\n");

    let userContent = "";
    if (data.rollingSummary) {
      userContent += `Process Summary:\n${data.rollingSummary}\n\n---\n\nConversation Data:\n\n${conversationBlocks}`;
    } else {
      userContent += `Conversation Data:\n\n${conversationBlocks}`;
    }

    let completion: AICompletion;
    try {
      completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: args.clerkOrgId,
          entityType: "process",
          entityId: args.processId,
          // Every stage of one generation shares this, so "what did this flow
          // cost end to end" is a single query on by_runId.
          runId: args.generationId,
        },
        buildGraphAIRequest(userContent),
      );
    } catch (error) {
      console.error("AI process flow graph request failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      await ctx.runMutation(internal.processFlows.failFlowGeneration, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId: args.generationId,
        stage: "graph",
        errorMessage: "Failed to generate process flow. Please try again.",
      });
      return;
    }

    if (isTokenLimitFinishReason(completion.finishReason)) {
      // The graph pass is budgeted at a fraction of the cap, so hitting it
      // means the process is far larger than the soft node target — not that
      // the budget is wrong.
      console.error("Process flow graph hit the AI response token limit", {
        finishReason: completion.finishReason,
        maxTokens: GRAPH_MAX_TOKENS,
      });
      await ctx.runMutation(internal.processFlows.failFlowGeneration, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId: args.generationId,
        stage: "graph",
        errorMessage: FLOW_TOKEN_LIMIT_ERROR_MESSAGE,
      });
      return;
    }

    const payload = completion.toolInput ?? completion.text;
    let graph: ReturnType<typeof normalizeGraphResponse> | null = null;

    if (payload !== null && !(typeof payload === "string" && !payload.trim())) {
      try {
        graph = normalizeGraphResponse(
          completion.toolInput ?? parseFlowResponsePayload(payload),
        );
      } catch (e) {
        console.error("Failed to parse flow graph JSON:", {
          error: e instanceof Error ? e.message : "Unknown parse error",
          payloadType: Array.isArray(payload) ? "array" : typeof payload,
        });
      }
    }

    if (graph === null || graph.nodes.length === 0) {
      await ctx.runMutation(internal.processFlows.failFlowGeneration, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId: args.generationId,
        stage: "graph",
        errorMessage:
          graph === null
            ? "Failed to parse AI response. Please try again."
            : "The AI did not identify any process steps. Please try again.",
      });
      return;
    }

    const processFlowId = await ctx.runMutation(
      internal.processFlows.saveFlowGraph,
      {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId: args.generationId,
        conversationCount: data.conversations.length,
        nodes: graph.nodes,
        edges: graph.edges,
        criticalPath: graph.criticalPath,
        totalEstimatedDuration: graph.totalEstimatedDuration,
        summarySourceSnapshot: data.summarySourceSnapshot ?? undefined,
      },
    );
    // Null means another run took ownership while this one was generating.
    if (processFlowId === null) return;

    // Now that this generation has its own rows, the previous run's are dead
    // weight. Bounded, self-continuing, and independent of the pipeline.
    await ctx.scheduler.runAfter(
      0,
      internal.processFlows.cleanupSupersededDetailRows,
      {
        clerkOrgId: args.clerkOrgId,
        processFlowId,
        keepGenerationId: args.generationId,
      },
    );

    await ctx.scheduler.runAfter(
      0,
      internal.processFlows.generateNodeDetailsBatchInternal,
      {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        processFlowId,
        generationId: args.generationId,
      },
    );
  },
});

// ---------------------------------------------------------------------------
// Stage 2: enrich the graph a few nodes at a time.
//
// One LLM call per action, and the chain re-schedules itself. A crash loses one
// small batch rather than the run, the 10-minute action ceiling never binds,
// and each call's full retry budget fits inside a single action.
// ---------------------------------------------------------------------------

export const generateNodeDetailsBatchInternal = internalAction({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    processFlowId: v.id("processFlows"),
    generationId: v.string(),
    batchSize: v.optional(v.number()),
    halved: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const batchSize = args.batchSize ?? NODE_DETAILS_BATCH_SIZE;

    const batch = await ctx.runQuery(internal.processFlows.getNodeDetailBatch, {
      clerkOrgId: args.clerkOrgId,
      processFlowId: args.processFlowId,
      generationId: args.generationId,
      limit: batchSize,
    });
    // Superseded by a newer generation — stop, and leave the new run alone.
    if (batch === null) return;

    if (batch.nodeIds.length === 0) {
      // Every node is described, so the automation analysis can now see the
      // whole enriched process. It finalizes the run when it is done.
      await ctx.scheduler.runAfter(
        0,
        internal.processFlows.generateFlowInsightsInternal,
        {
          processId: args.processId,
          clerkOrgId: args.clerkOrgId,
          processFlowId: args.processFlowId,
          generationId: args.generationId,
        },
      );
      return;
    }

    const scheduleNextBatch = async () => {
      await ctx.scheduler.runAfter(
        0,
        internal.processFlows.generateNodeDetailsBatchInternal,
        {
          processId: args.processId,
          clerkOrgId: args.clerkOrgId,
          processFlowId: args.processFlowId,
          generationId: args.generationId,
        },
      );
    };

    const failBatch = async (errorMessage: string) => {
      await ctx.runMutation(internal.processFlows.saveNodeDetailBatch, {
        clerkOrgId: args.clerkOrgId,
        processFlowId: args.processFlowId,
        generationId: args.generationId,
        results: batch.nodeIds.map((nodeId) => ({ nodeId, errorMessage })),
      });
      // Keep going: one unenriched step leaves the flow usable, and finalize
      // reports it as partial rather than pretending it is complete.
      await scheduleNextBatch();
    };

    const data: {
      rollingSummary: string | null;
      conversations: Array<{
        contributorName: string;
        analysis: Record<string, unknown> | null;
        creationTime: number;
      }>;
    } = await ctx.runQuery(internal.processFlows.getFlowGenerationData, {
      processId: args.processId,
      clerkOrgId: args.clerkOrgId,
    });

    const userContent = buildNodeDetailsUserContent(
      batch.graph,
      data,
      batch.nodeIds,
    );

    let completion: AICompletion;
    try {
      completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: args.clerkOrgId,
          entityType: "process",
          entityId: args.processId,
          runId: args.generationId,
        },
        buildNodeDetailsAIRequest(userContent),
      );
    } catch (error) {
      console.error("AI node detail request failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
        nodeCount: batch.nodeIds.length,
      });
      await failBatch("Could not describe this step. Try regenerating.");
      return;
    }

    if (isTokenLimitFinishReason(completion.finishReason)) {
      // Halve once, then give up on the batch. Recursive bisection would add a
      // mechanism to chase a case that time-sized batches make rare, and the
      // per-node retry in Phase 2 covers the tail.
      if (!args.halved && batchSize > 1) {
        console.warn("Node detail batch truncated; halving once", {
          batchSize,
          maxTokens: NODE_DETAILS_MAX_TOKENS,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.processFlows.generateNodeDetailsBatchInternal,
          {
            processId: args.processId,
            clerkOrgId: args.clerkOrgId,
            processFlowId: args.processFlowId,
            generationId: args.generationId,
            batchSize: Math.max(1, Math.floor(batchSize / 2)),
            halved: true,
          },
        );
        return;
      }
      await failBatch("This step's description was too long to generate.");
      return;
    }

    const payload = completion.toolInput ?? completion.text;
    let details = new Map<string, FlowNodeDetail>();
    if (payload !== null && !(typeof payload === "string" && !payload.trim())) {
      try {
        details = normalizeNodeDetailsResponse(
          completion.toolInput ?? parseFlowResponsePayload(payload),
          batch.nodeIds,
        );
      } catch (e) {
        console.error("Failed to parse node detail JSON:", {
          error: e instanceof Error ? e.message : "Unknown parse error",
        });
      }
    }

    await ctx.runMutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: args.clerkOrgId,
      processFlowId: args.processFlowId,
      generationId: args.generationId,
      results: batch.nodeIds.map((nodeId) => {
        const detail = details.get(nodeId);
        return detail
          ? { nodeId, detail }
          : {
              nodeId,
              errorMessage: "The AI returned no detail for this step.",
            };
      }),
    });

    await scheduleNextBatch();
  },
});

// ---------------------------------------------------------------------------
// Stage 3: what to do about it.
//
// Understanding how the work happens today is only half the product — the
// output that matters is where it could be transformed. That needs one pass over
// the *whole* enriched graph: several manual handoffs in a row are one thing to
// build, which no per-node call can see.
//
// Its own stage so that failing it costs only the opportunities. Finalize runs
// either way, and records whether what it stored was analysed or fallback.
// ---------------------------------------------------------------------------

export const getFlowForInsights = internalQuery({
  args: {
    clerkOrgId: v.string(),
    processFlowId: v.id("processFlows"),
    generationId: v.string(),
  },
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.processFlowId);
    if (!ownsGeneration(flow, args.generationId)) return null;
    if (flow.clerkOrgId !== args.clerkOrgId) return null;

    const rows = await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
        (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("processFlowId", args.processFlowId)
            .eq("generationId", args.generationId),
      )
      .take(SOFT_MAX_NODES * 4);

    const detailByNodeId = new Map(
      rows
        .filter((row) => row.status === "ready" && row.detail)
        .map((row) => [row.nodeId, row.detail!]),
    );

    return {
      nodes: flow.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        category: node.category,
        detail: detailByNodeId.get(node.id) ?? null,
      })),
      edges: flow.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        label: edge.label,
      })),
    };
  },
});

export const generateFlowInsightsInternal = internalAction({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    processFlowId: v.id("processFlows"),
    generationId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const finalize = async (
      automationOpportunityDetails?: AutomationOpportunity[],
    ) => {
      await ctx.runMutation(internal.processFlows.finalizeNodeDetails, {
        clerkOrgId: args.clerkOrgId,
        processFlowId: args.processFlowId,
        generationId: args.generationId,
        automationOpportunityDetails,
      });
    };

    const flow = await ctx.runQuery(internal.processFlows.getFlowForInsights, {
      clerkOrgId: args.clerkOrgId,
      processFlowId: args.processFlowId,
      generationId: args.generationId,
    });
    // Superseded by a newer generation — that run owns the flow now.
    if (flow === null) return;

    if (!isAIConfigured("synthesis")) {
      await finalize();
      return;
    }

    const enriched = flow.nodes.filter((node) => node.detail !== null);
    if (enriched.length === 0) {
      // Nothing was described, so there is nothing to analyse. Finalize will
      // land this as failed details.
      await finalize();
      return;
    }

    let completion: AICompletion;
    try {
      completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: args.clerkOrgId,
          entityType: "process",
          entityId: args.processId,
          runId: args.generationId,
        },
        buildFlowInsightsAIRequest(buildInsightsUserContent(flow)),
      );
    } catch (error) {
      console.error("AI automation-opportunity request failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      await finalize();
      return;
    }

    if (isTokenLimitFinishReason(completion.finishReason)) {
      console.error("Automation-opportunity analysis hit the token limit", {
        maxTokens: INSIGHTS_MAX_TOKENS,
      });
      await finalize();
      return;
    }

    const payload = completion.toolInput ?? completion.text;
    let opportunities: AutomationOpportunity[] = [];
    if (payload !== null && !(typeof payload === "string" && !payload.trim())) {
      try {
        opportunities = normalizeAutomationOpportunities(
          completion.toolInput ?? parseFlowResponsePayload(payload),
          flow.nodes.map((node) => node.id),
        );
      } catch (e) {
        console.error("Failed to parse automation-opportunity JSON:", {
          error: e instanceof Error ? e.message : "Unknown parse error",
        });
      }
    }

    if (opportunities.length === 0) {
      // A process with genuinely no candidates is a valid answer, but so is a
      // response we could not use — log so the two are distinguishable.
      console.warn("Automation-opportunity analysis returned nothing usable", {
        processId: args.processId,
        enrichedNodes: enriched.length,
      });
    }

    await finalize(opportunities.length > 0 ? opportunities : undefined);
  },
});

// ---------------------------------------------------------------------------
// Public action: trigger flow generation (called from frontend)
// ---------------------------------------------------------------------------

export const generateProcessFlow = action({
  args: { processId: v.id("processes") },
  handler: async (ctx, args): Promise<{ message: string | null }> => {
    const { orgId } = await resolveOrgForAction(ctx);

    // Assert caller is a contributor in this org AND the process belongs to
    // this org before we burn any LLM tokens.
    await ctx.runQuery(internal.postCall.requireOrgContributorInternal, {});
    await ctx.runQuery(internal.processFlows.assertProcessInOrg, {
      processId: args.processId,
      clerkOrgId: orgId,
    });

    const started: { scheduled: boolean; generationId: string } =
      await ctx.runMutation(internal.processFlows.requestFlowGeneration, {
        processId: args.processId,
        clerkOrgId: orgId,
      });

    // Two clicks must not buy two pipelines. The second joins the first rather
    // than starting a competing run — as does a click that lands while the
    // automatic post-recording trigger is already running.
    if (!started.scheduled) {
      return {
        message: "This process flow is already being generated.",
      };
    }

    return { message: null as string | null };
  },
});
