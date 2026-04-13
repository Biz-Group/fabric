import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAuth, requireRole, checkRoleFromUser } from "./lib/auth";

// ---------------------------------------------------------------------------
// System prompt for process flow extraction
// ---------------------------------------------------------------------------

const FLOW_EXTRACTION_SYSTEM_PROMPT = `You are a process analyst converting business process documentation into a structured flow diagram. You receive:
1. A synthesized rolling summary written from conversation transcripts
2. Per-conversation structured data — some conversations have pre-extracted graph fragments (process_steps, step_connections, step_issues as JSON), while older conversations have only flat lists (steps_described, tools_mentioned)

Your job is to produce a single JSON object representing the merged process flow diagram.

## Node rules
- Each node is a discrete, actionable step in the process.
- Merge duplicate or overlapping steps described by different contributors into a single node.
- Use deterministic kebab-case IDs (e.g., "pull-workday-data", "validate-comp-bands").
- Assign "category" based on the step's nature:
  - "start": the trigger or entry point of the process
  - "action": a task someone performs
  - "decision": a point where the process branches based on a condition
  - "handoff": where responsibility transfers to a different person or team
  - "wait": where the process blocks on an external dependency
  - "end": the process completion point
- Every flow must have exactly one "start" and at least one "end" node.
- For each node assess:
  - automationPotential: "high" if repetitive/manual/rule-based, "medium" if partially automatable, "low" if requires human judgment, "none" if already automated
  - confidence: "high" if described by 2+ contributors, "medium" if described clearly by 1, "low" if inferred
  - isBottleneck: true if contributors mention delays, rework, waiting, or frustration at this step
  - isTribalKnowledge: true if only one contributor described this step and it seems undocumented
  - painPoints: specific frustrations — quote contributors where possible
  - riskIndicators: what could go wrong at this step
  - estimatedDuration: if mentioned or inferable, otherwise omit

## Edge rules
- "sequential": the default — one step follows another
- "conditional": a decision branches based on a condition (the label should state the condition)
- "parallel": steps that happen simultaneously
- "fallback": exception or error handling path
- isHappyPath: true for the primary expected flow, false for exception paths

## Insights rules
- criticalPath: ordered node IDs of the longest/most common path
- automationOpportunities: 2-3 sentences each, describing the best automation candidates
- topBottlenecks: labels of the most impactful bottleneck nodes

## Merging strategy
- When Conversation A describes steps 1-5 and Conversation B describes steps 4-8, connect them at the overlap point
- Use the dependencies field to identify handoff connections between contributors
- Prefer structured data (process_steps JSON) over flat lists when both exist
- When contributors disagree on step ordering, note the conflict in painPoints and use the majority view

## Output format
Return ONLY a valid JSON object with this exact shape (no markdown fences, no explanation):
{
  "nodes": [
    {
      "id": "string",
      "label": "string",
      "description": "string",
      "category": "start" | "end" | "action" | "decision" | "handoff" | "wait",
      "actors": ["string"],
      "tools": ["string"],
      "estimatedDuration": "string or omit",
      "painPoints": ["string"],
      "automationPotential": "none" | "low" | "medium" | "high",
      "confidence": "high" | "medium" | "low",
      "isBottleneck": boolean,
      "isTribalKnowledge": boolean,
      "riskIndicators": ["string"],
      "sources": ["string"]
    }
  ],
  "edges": [
    {
      "id": "string",
      "source": "string",
      "target": "string",
      "type": "sequential" | "conditional" | "parallel" | "fallback",
      "label": "string or omit",
      "isHappyPath": boolean
    }
  ],
  "insights": {
    "totalEstimatedDuration": "string or omit",
    "criticalPath": ["node-id-1", "node-id-2"],
    "handoffCount": number,
    "toolCount": number,
    "automationOpportunities": ["string"],
    "topBottlenecks": ["string"]
  }
}`;

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
  const dc = (conv.analysis as { data_collection?: Record<string, unknown> } | null)
    ?.data_collection;

  if (!dc) {
    return `[Conversation ${index} — ${conv.contributorName}]\nNo structured data available.`;
  }

  // Try structured JSON fields first (new format)
  const structuredSteps = tryParseJson<StructuredStep[]>(dc.process_steps);
  const connections = tryParseJson<StepConnection[]>(dc.step_connections);
  const issues = tryParseJson<StepIssue[]>(dc.step_issues);

  if (structuredSteps && structuredSteps.length > 0) {
    // New structured format
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
    if (dc.compliance_or_approvals) parts.push(`Approvals: ${dc.compliance_or_approvals}`);
    if (dc.total_process_duration) parts.push(`Total Duration: ${dc.total_process_duration}`);
    return parts.join("\n");
  }

  // Legacy flat format
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
// Internal queries
// ---------------------------------------------------------------------------

export const getFlowByProcess = internalQuery({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("processFlows")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .first();
  },
});

export const getFlowGenerationData = internalQuery({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    const rollingSummary = process?.rollingSummary ?? null;

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .order("asc")
      .collect();

    const doneConversations = conversations
      .filter((c) => c.status === "done")
      .map((c) => ({
        contributorName: c.contributorName,
        analysis: (c.analysis ?? null) as Record<string, unknown> | null,
        creationTime: c._creationTime,
      }));

    return { rollingSummary, conversations: doneConversations };
  },
});

// ---------------------------------------------------------------------------
// Internal mutations
// ---------------------------------------------------------------------------

export const saveProcessFlow = internalMutation({
  args: {
    processId: v.id("processes"),
    status: v.union(
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    nodes: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          description: v.string(),
          category: v.union(
            v.literal("start"),
            v.literal("end"),
            v.literal("action"),
            v.literal("decision"),
            v.literal("handoff"),
            v.literal("wait"),
          ),
          actors: v.array(v.string()),
          tools: v.array(v.string()),
          estimatedDuration: v.optional(v.string()),
          painPoints: v.array(v.string()),
          automationPotential: v.union(
            v.literal("none"),
            v.literal("low"),
            v.literal("medium"),
            v.literal("high"),
          ),
          confidence: v.union(
            v.literal("high"),
            v.literal("medium"),
            v.literal("low"),
          ),
          isBottleneck: v.boolean(),
          isTribalKnowledge: v.boolean(),
          riskIndicators: v.array(v.string()),
          sources: v.array(v.string()),
        }),
      ),
    ),
    edges: v.optional(
      v.array(
        v.object({
          id: v.string(),
          source: v.string(),
          target: v.string(),
          type: v.union(
            v.literal("sequential"),
            v.literal("conditional"),
            v.literal("parallel"),
            v.literal("fallback"),
          ),
          label: v.optional(v.string()),
          isHappyPath: v.boolean(),
        }),
      ),
    ),
    insights: v.optional(
      v.object({
        totalEstimatedDuration: v.optional(v.string()),
        criticalPath: v.array(v.string()),
        handoffCount: v.number(),
        toolCount: v.number(),
        automationOpportunities: v.array(v.string()),
        topBottlenecks: v.array(v.string()),
      }),
    ),
    conversationCount: v.number(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("processFlows")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .first();

    const doc = {
      processId: args.processId,
      status: args.status,
      stale: false,
      generatedAt: Date.now(),
      conversationCount: args.conversationCount,
      errorMessage: args.errorMessage,
      nodes: args.nodes ?? [],
      edges: args.edges ?? [],
      insights: args.insights ?? {
        criticalPath: [],
        handoffCount: 0,
        toolCount: 0,
        automationOpportunities: [],
        topBottlenecks: [],
      },
    };

    if (existing) {
      await ctx.db.replace(existing._id, doc);
    } else {
      await ctx.db.insert("processFlows", doc);
    }
  },
});

export const markFlowStale = internalMutation({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const flow = await ctx.db
      .query("processFlows")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .first();
    if (flow && flow.status === "ready") {
      await ctx.db.patch(flow._id, { stale: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Public query: read the flow for a process
// ---------------------------------------------------------------------------

export const getProcessFlow = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    await requireRole(ctx, "viewer");
    return await ctx.db
      .query("processFlows")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Internal action: the actual LLM call
// ---------------------------------------------------------------------------

export const generateFlowInternal = internalAction({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      console.error("OPENROUTER_API_KEY is not configured — skipping flow generation");
      await ctx.runMutation(internal.processFlows.saveProcessFlow, {
        processId: args.processId,
        status: "failed",
        conversationCount: 0,
        errorMessage: "Flow generation is not configured (missing API key).",
      });
      return;
    }

    // Fetch all data needed for generation
    const data: {
      rollingSummary: string | null;
      conversations: Array<{
        contributorName: string;
        analysis: Record<string, unknown> | null;
        creationTime: number;
      }>;
    } = await ctx.runQuery(internal.processFlows.getFlowGenerationData, {
      processId: args.processId,
    });

    if (data.conversations.length === 0) {
      await ctx.runMutation(internal.processFlows.saveProcessFlow, {
        processId: args.processId,
        status: "failed",
        conversationCount: 0,
        errorMessage: "No completed conversations available. Record conversations first.",
      });
      return;
    }

    // Assemble the user prompt
    const conversationBlocks = data.conversations
      .map((c, i) => formatConversationData(c, i + 1))
      .join("\n\n---\n\n");

    let userContent = "";
    if (data.rollingSummary) {
      userContent += `Process Summary:\n${data.rollingSummary}\n\n---\n\nConversation Data:\n\n${conversationBlocks}`;
    } else {
      userContent += `Conversation Data:\n\n${conversationBlocks}`;
    }

    // Call LLM
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4.5",
          messages: [
            { role: "system", content: FLOW_EXTRACTION_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          max_tokens: 8192,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter API error:", response.status, errorText);
      await ctx.runMutation(internal.processFlows.saveProcessFlow, {
        processId: args.processId,
        status: "failed",
        conversationCount: data.conversations.length,
        errorMessage: "Failed to generate process flow. Please try again.",
      });
      return;
    }

    const result = await response.json();
    const content: string | null = result.choices?.[0]?.message?.content?.trim() ?? null;

    if (!content) {
      await ctx.runMutation(internal.processFlows.saveProcessFlow, {
        processId: args.processId,
        status: "failed",
        conversationCount: data.conversations.length,
        errorMessage: "Empty response from AI. Please try again.",
      });
      return;
    }

    // Strip markdown fences if present
    const jsonStr = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

    let parsed: {
      nodes?: unknown[];
      edges?: unknown[];
      insights?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error("Failed to parse flow JSON:", e, "\nRaw content:", content);
      await ctx.runMutation(internal.processFlows.saveProcessFlow, {
        processId: args.processId,
        status: "failed",
        conversationCount: data.conversations.length,
        errorMessage: "Failed to parse AI response. Please try again.",
      });
      return;
    }

    // Validate and normalize nodes
    const validCategories = new Set(["start", "end", "action", "decision", "handoff", "wait"]);
    const validAutomation = new Set(["none", "low", "medium", "high"]);
    const validConfidence = new Set(["high", "medium", "low"]);
    const validEdgeTypes = new Set(["sequential", "conditional", "parallel", "fallback"]);

    const nodes = (parsed.nodes ?? []).map((n: unknown) => {
      const node = n as Record<string, unknown>;
      return {
        id: String(node.id ?? ""),
        label: String(node.label ?? ""),
        description: String(node.description ?? ""),
        category: validCategories.has(String(node.category))
          ? (String(node.category) as "start" | "end" | "action" | "decision" | "handoff" | "wait")
          : ("action" as const),
        actors: Array.isArray(node.actors) ? node.actors.map(String) : [],
        tools: Array.isArray(node.tools) ? node.tools.map(String) : [],
        estimatedDuration: node.estimatedDuration ? String(node.estimatedDuration) : undefined,
        painPoints: Array.isArray(node.painPoints) ? node.painPoints.map(String) : [],
        automationPotential: validAutomation.has(String(node.automationPotential))
          ? (String(node.automationPotential) as "none" | "low" | "medium" | "high")
          : ("none" as const),
        confidence: validConfidence.has(String(node.confidence))
          ? (String(node.confidence) as "high" | "medium" | "low")
          : ("medium" as const),
        isBottleneck: node.isBottleneck === true,
        isTribalKnowledge: node.isTribalKnowledge === true,
        riskIndicators: Array.isArray(node.riskIndicators) ? node.riskIndicators.map(String) : [],
        sources: Array.isArray(node.sources) ? node.sources.map(String) : [],
      };
    }).filter((n) => n.id && n.label);

    const nodeIds = new Set(nodes.map((n) => n.id));

    const edges = (parsed.edges ?? [])
      .map((e: unknown) => {
        const edge = e as Record<string, unknown>;
        return {
          id: String(edge.id ?? `${edge.source}-${edge.target}`),
          source: String(edge.source ?? ""),
          target: String(edge.target ?? ""),
          type: validEdgeTypes.has(String(edge.type))
            ? (String(edge.type) as "sequential" | "conditional" | "parallel" | "fallback")
            : ("sequential" as const),
          label: edge.label ? String(edge.label) : undefined,
          isHappyPath: edge.isHappyPath !== false,
        };
      })
      .filter((e) => e.source && e.target && nodeIds.has(e.source) && nodeIds.has(e.target));

    const rawInsights = (parsed.insights ?? {}) as Record<string, unknown>;
    const insights = {
      totalEstimatedDuration: rawInsights.totalEstimatedDuration
        ? String(rawInsights.totalEstimatedDuration)
        : undefined,
      criticalPath: Array.isArray(rawInsights.criticalPath)
        ? rawInsights.criticalPath.map(String).filter((id) => nodeIds.has(id))
        : [],
      handoffCount: typeof rawInsights.handoffCount === "number"
        ? rawInsights.handoffCount
        : nodes.filter((n) => n.category === "handoff").length,
      toolCount: typeof rawInsights.toolCount === "number"
        ? rawInsights.toolCount
        : new Set(nodes.flatMap((n) => n.tools)).size,
      automationOpportunities: Array.isArray(rawInsights.automationOpportunities)
        ? rawInsights.automationOpportunities.map(String)
        : [],
      topBottlenecks: Array.isArray(rawInsights.topBottlenecks)
        ? rawInsights.topBottlenecks.map(String)
        : nodes.filter((n) => n.isBottleneck).map((n) => n.label),
    };

    await ctx.runMutation(internal.processFlows.saveProcessFlow, {
      processId: args.processId,
      status: "ready",
      nodes,
      edges,
      insights,
      conversationCount: data.conversations.length,
    });
  },
});

// ---------------------------------------------------------------------------
// Public action: trigger flow generation (called from frontend)
// ---------------------------------------------------------------------------

export const generateProcessFlow = action({
  args: { processId: v.id("processes") },
  handler: async (ctx, args): Promise<{ message: string | null }> => {
    const identity = await requireAuth(ctx);
    const user = await ctx.runQuery(
      internal.postCall.getUserByToken,
      { tokenIdentifier: identity.tokenIdentifier },
    );
    checkRoleFromUser(user, "contributor");

    // Set status to "generating" immediately so the UI can show loading state
    await ctx.runMutation(internal.processFlows.saveProcessFlow, {
      processId: args.processId,
      status: "generating",
      conversationCount: 0,
    });

    // Schedule the actual generation as a separate action
    await ctx.scheduler.runAfter(0, internal.processFlows.generateFlowInternal, {
      processId: args.processId,
    });

    return { message: null as string | null };
  },
});
