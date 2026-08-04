/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ORG = "org_flow_actions";
const OTHER_ORG = "org_flow_actions_other";
const ISSUER = "https://test.clerk";

const AI_ENV = [
  "AI_PROVIDER",
  "FOUNDRY_ENDPOINT",
  "FOUNDRY_API_KEY",
  "FOUNDRY_CLAUDE_DEPLOYMENT",
] as const;

function configureFoundry() {
  process.env.AI_PROVIDER = "foundry";
  process.env.FOUNDRY_ENDPOINT = "https://fabric-test.services.ai.azure.com";
  process.env.FOUNDRY_API_KEY = "foundry-test-key";
  process.env.FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude-haiku-4-5";
}

function identity(orgId = ORG) {
  return {
    tokenIdentifier: `${ISSUER}|member_${orgId}`,
    subject: `member_${orgId}`,
    issuer: ISSUER,
    name: "Member",
    email: "member@test.dev",
    orgId,
    orgSlug: orgId,
  };
}

/** A Foundry Claude Messages-API response carrying a forced tool call. */
function toolUseResponse(name: string, input: unknown) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "fabric-claude-haiku-4-5",
    content: [{ type: "tool_use", id: "toolu_1", name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}

/** The provider ran out of output tokens mid-answer. */
function truncatedResponse() {
  return {
    id: "msg_truncated",
    type: "message",
    role: "assistant",
    model: "fabric-claude-haiku-4-5",
    content: [],
    stop_reason: "max_tokens",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 4096 },
  };
}

const GRAPH_PAYLOAD = {
  nodes: [
    { id: "intake", label: "Intake", category: "start" },
    { id: "triage", label: "Triage", category: "handoff" },
    { id: "resolve", label: "Resolve", category: "end" },
  ],
  edges: [
    {
      id: "intake-triage",
      source: "intake",
      target: "triage",
      type: "sequential",
      isHappyPath: true,
    },
  ],
  insights: { criticalPath: ["intake", "triage", "resolve"] },
};

function detailFor(nodeId: string) {
  return {
    nodeId,
    description: `What happens at ${nodeId}`,
    actors: ["Team lead"],
    tools: ["Jira"],
    painPoints: ["Checked by hand"],
    automationPotential: "high",
    confidence: "high",
    isBottleneck: true,
    isTribalKnowledge: false,
    riskIndicators: [],
    sources: ["Alice, Conv. 1"],
  };
}

const OPPORTUNITY = {
  title: "Ticket triage assistant",
  kind: "agent",
  nodeIds: ["intake", "triage"],
  rationale: "Every ticket is read and routed by hand today.",
  prerequisites: ["Jira API access"],
  confidence: "high",
};

type StubOptions = {
  /** Force every stage to report a token-limit stop reason. */
  truncateAll?: boolean;
  /** Force only the named tool's stage to truncate. */
  truncateTool?: string;
};

/**
 * Stubs the provider at the fetch layer, dispatching on which tool the request
 * forces so a single stub can serve all three stages of one run.
 */
function stubClaude(options: StubOptions = {}) {
  const seenTools: string[] = [];
  /** The user-facing prompt each stage sent, keyed by the tool it forced. */
  const sentPrompts: Record<string, string> = {};

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const body = (await request.clone().json()) as {
        tools?: Array<{ name: string }>;
        messages?: Array<{ content: string }>;
      };
      const toolName = body.tools?.[0]?.name ?? "";
      seenTools.push(toolName);
      sentPrompts[toolName] = body.messages?.[0]?.content ?? "";

      const shouldTruncate =
        options.truncateAll === true || options.truncateTool === toolName;

      const payload = shouldTruncate
        ? truncatedResponse()
        : toolName === "return_process_graph"
          ? toolUseResponse(toolName, GRAPH_PAYLOAD)
          : toolName === "return_node_details"
            ? toolUseResponse(toolName, {
                details: GRAPH_PAYLOAD.nodes.map((n) => detailFor(n.id)),
              })
            : toolUseResponse(toolName, { opportunities: [OPPORTUNITY] });

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, seenTools, sentPrompts };
}

async function seedOrg(
  ctx: MutationCtx,
  orgId = ORG,
): Promise<Id<"processes">> {
  const userId = await ctx.db.insert("users", {
    tokenIdentifier: `${ISSUER}|member_${orgId}`,
    name: "Member",
    email: "member@test.dev",
    profileComplete: true,
  });
  await ctx.db.insert("memberships", {
    tokenIdentifier: `${ISSUER}|member_${orgId}`,
    userId,
    clerkOrgId: orgId,
    role: "contributor",
    createdAt: Date.now(),
  });
  const functionId = await ctx.db.insert("functions", {
    name: "Operations",
    sortOrder: 0,
    clerkOrgId: orgId,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Support",
    sortOrder: 0,
    clerkOrgId: orgId,
  });
  const processId = await ctx.db.insert("processes", {
    departmentId,
    name: "Ticket triage",
    sortOrder: 0,
    clerkOrgId: orgId,
    rollingSummary: "Tickets arrive, are triaged, then resolved.",
  });
  // The graph pass refuses to run without completed conversations.
  await ctx.db.insert("conversations", {
    processId,
    contributorName: "Alice",
    status: "done",
    clerkOrgId: orgId,
    summary: "Alice described triage",
    analysis: {
      data_collection: {
        process_steps: JSON.stringify([
          { id: "intake", name: "Intake", type: "action" },
        ]),
      },
    },
  });
  return processId;
}

function harness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof harness>;

function readFlow(
  t: Harness,
  processId: Id<"processes">,
): Promise<Doc<"processFlows"> | null> {
  return t.run(async (ctx) => {
    return await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", ORG).eq("processId", processId),
      )
      .first();
  });
}

function readDetailRows(t: Harness): Promise<Doc<"processFlowNodeDetails">[]> {
  return t.run(async (ctx) => {
    return await ctx.db.query("processFlowNodeDetails").collect();
  });
}

/**
 * The jobs a stage put on the scheduler, newest last.
 *
 * The chain is driven explicitly in these tests rather than by letting the
 * harness run the queue: these stages make HTTP calls through the provider SDK,
 * and the harness's scheduled-function draining does not execute them here. So
 * the hand-off is asserted from the queue, and the next stage is invoked
 * directly — which also keeps each assertion about one stage.
 */
function scheduledJobs(t: Harness) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.map((job) => ({
      name: job.name,
      args: job.args[0] as Record<string, unknown>,
    }));
  });
}

async function scheduledJobFor(t: Harness, fnName: string) {
  const jobs = await scheduledJobs(t);
  return jobs.filter((job) => job.name.includes(fnName)).at(-1) ?? null;
}

/** Runs detail batches until none are left, the way the chain would. */
async function runDetailBatches(
  t: Harness,
  args: {
    processId: Id<"processes">;
    processFlowId: Id<"processFlows">;
    generationId: string;
  },
  maxBatches = 10,
): Promise<void> {
  for (let i = 0; i < maxBatches; i++) {
    const rows = await readDetailRows(t);
    if (!rows.some((row) => row.status === "pending")) return;
    await t.action(internal.processFlows.generateNodeDetailsBatchInternal, {
      processId: args.processId,
      clerkOrgId: ORG,
      processFlowId: args.processFlowId,
      generationId: args.generationId,
    });
  }
}

describe("staged flow generation, driven end to end", () => {
  beforeEach(() => {
    configureFoundry();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const name of AI_ENV) delete process.env[name];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("the graph pass lands a ready flow with every node pending", async () => {
    const t = harness();
    // Wrapped rather than passed by reference: `run` supplies a second
    // argument, which would land in `orgId`.
    const processId = await t.run((ctx) => seedOrg(ctx));
    stubClaude();

    const { generationId } = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );
    await t.action(internal.processFlows.generateGraphInternal, {
      processId,
      clerkOrgId: ORG,
      generationId,
    });

    const flow = await readFlow(t, processId);
    const rows = await readDetailRows(t);

    expect(flow?.status).toBe("ready");
    expect(flow?.detailsStatus).toBe("generating");
    expect(flow?.nodes.map((n) => n.id)).toEqual([
      "intake",
      "triage",
      "resolve",
    ]);
    // Details do not exist yet, so the nodes carry placeholders.
    expect(flow?.nodes[0].description).toBe("");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "pending")).toBe(true);

    // And it handed off to the detail stage rather than stopping here.
    const next = await scheduledJobFor(t, "generateNodeDetailsBatchInternal");
    expect(next?.args.generationId).toBe(generationId);
  });

  test("a truncated graph fails the run cleanly instead of half-saving", async () => {
    const t = harness();
    // Wrapped rather than passed by reference: `run` supplies a second
    // argument, which would land in `orgId`.
    const processId = await t.run((ctx) => seedOrg(ctx));
    stubClaude({ truncateTool: "return_process_graph" });

    const { generationId } = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );
    await t.action(internal.processFlows.generateGraphInternal, {
      processId,
      clerkOrgId: ORG,
      generationId,
    });

    const flow = await readFlow(t, processId);
    expect(flow?.status).toBe("failed");
    expect(flow?.errorMessage).toContain("too large");
    // No half-built generation left behind for the detail stage to pick up.
    expect(flow?.detailsStatus).toBeUndefined();
    expect(await readDetailRows(t)).toHaveLength(0);
  });

  test("a whole run reaches ready with analysed automation opportunities", async () => {
    const t = harness();
    // Wrapped rather than passed by reference: `run` supplies a second
    // argument, which would land in `orgId`.
    const processId = await t.run((ctx) => seedOrg(ctx));
    const { seenTools } = stubClaude();

    const { generationId } = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );
    await t.action(internal.processFlows.generateGraphInternal, {
      processId,
      clerkOrgId: ORG,
      generationId,
    });
    const processFlowId = (await readFlow(t, processId))!._id;
    await runDetailBatches(t, { processId, processFlowId, generationId });
    await t.action(internal.processFlows.generateFlowInsightsInternal, {
      processId,
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    const flow = await readFlow(t, processId);
    const rows = await readDetailRows(t);

    expect(rows.every((r) => r.status === "ready")).toBe(true);
    expect(flow?.detailsStatus).toBe("ready");
    expect(flow?.detailCompletedCount).toBe(3);
    // All three stages ran, in order.
    expect(seenTools).toEqual([
      "return_process_graph",
      "return_node_details",
      "return_automation_opportunities",
    ]);
    // The analysed opportunity, not the mechanical fallback.
    expect(flow?.insights.automationOpportunitiesSource).toBe("ai");
    expect(flow?.insights.automationOpportunityDetails?.[0].title).toBe(
      "Ticket triage assistant",
    );
    // Rolled up from the details that landed.
    expect(flow?.insights.toolCount).toBe(1);
    expect(flow?.insights.topBottlenecks).toHaveLength(3);
  });

  test("each stage is sent the context it needs and nothing it shouldn't change", async () => {
    const t = harness();
    // Wrapped rather than passed by reference: `run` supplies a second
    // argument, which would land in `orgId`.
    const processId = await t.run((ctx) => seedOrg(ctx));
    const { sentPrompts } = stubClaude();

    const { generationId } = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );
    await t.action(internal.processFlows.generateGraphInternal, {
      processId,
      clerkOrgId: ORG,
      generationId,
    });
    const processFlowId = (await readFlow(t, processId))!._id;
    await runDetailBatches(t, { processId, processFlowId, generationId });
    await t.action(internal.processFlows.generateFlowInsightsInternal, {
      processId,
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    // The graph pass gets the evidence.
    expect(sentPrompts.return_process_graph).toContain(
      "Tickets arrive, are triaged, then resolved.",
    );

    // The detail pass gets the settled graph AND the evidence, plus an explicit
    // list of which nodes are its responsibility. Without the graph it cannot
    // tell what a step sits between; without the restriction it would wander
    // into other batches' nodes.
    const detailPrompt = sentPrompts.return_node_details;
    expect(detailPrompt).toContain("settled");
    expect(detailPrompt).toContain("intake");
    expect(detailPrompt).toContain("triage");
    expect(detailPrompt).toContain("intake -> triage");
    expect(detailPrompt).toContain("Describe ONLY these");
    expect(detailPrompt).toContain(
      "Tickets arrive, are triaged, then resolved.",
    );

    // The automation pass gets the enriched process — descriptions and pain
    // points, not just the skeleton — because that is what it reasons over.
    const insightsPrompt = sentPrompts.return_automation_opportunities;
    expect(insightsPrompt).toContain("What happens at triage");
    expect(insightsPrompt).toContain("Checked by hand");
    expect(insightsPrompt).toContain("Automation potential: high");
  });

  test("a truncated detail batch is halved, not failed wholesale", async () => {
    const t = harness();
    // Wrapped rather than passed by reference: `run` supplies a second
    // argument, which would land in `orgId`.
    const processId = await t.run((ctx) => seedOrg(ctx));
    stubClaude({ truncateTool: "return_node_details" });

    const { generationId } = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );
    await t.action(internal.processFlows.generateGraphInternal, {
      processId,
      clerkOrgId: ORG,
      generationId,
    });
    const processFlowId = (await readFlow(t, processId))!._id;

    // One batch attempt, which truncates.
    await t.action(internal.processFlows.generateNodeDetailsBatchInternal, {
      processId,
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    // The batch is retried smaller rather than written off — nothing has been
    // marked failed yet. Failing the whole batch here is the regression this
    // guards against.
    const afterFirstAttempt = await readDetailRows(t);
    expect(afterFirstAttempt.every((r) => r.status === "pending")).toBe(true);

    // Halved exactly once, and flagged so it cannot halve again.
    const retry = await scheduledJobFor(t, "generateNodeDetailsBatchInternal");
    expect(retry?.args.batchSize).toBe(3);
    expect(retry?.args.halved).toBe(true);
  });

  test("an already-halved batch that truncates again gives up on those nodes", async () => {
    const t = harness();
    // Wrapped rather than passed by reference: `run` supplies a second
    // argument, which would land in `orgId`.
    const processId = await t.run((ctx) => seedOrg(ctx));
    stubClaude({ truncateTool: "return_node_details" });

    const { generationId } = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );
    await t.action(internal.processFlows.generateGraphInternal, {
      processId,
      clerkOrgId: ORG,
      generationId,
    });
    const processFlowId = (await readFlow(t, processId))!._id;

    await t.action(internal.processFlows.generateNodeDetailsBatchInternal, {
      processId,
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      batchSize: 1,
      halved: true,
    });

    const rows = await readDetailRows(t);
    // Bisection is bounded: the node is written off rather than split forever,
    // which is what keeps the chain terminating.
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
    // And it moves on to the rest rather than stopping on the failure.
    const next = await scheduledJobFor(t, "generateNodeDetailsBatchInternal");
    expect(next?.args.batchSize).toBeUndefined();
  });

  test("persistent truncation lands a partial flow with the graph intact", async () => {
    const t = harness();
    // Wrapped rather than passed by reference: `run` supplies a second
    // argument, which would land in `orgId`.
    const processId = await t.run((ctx) => seedOrg(ctx));
    stubClaude({ truncateTool: "return_node_details" });

    const { generationId } = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );
    await t.action(internal.processFlows.generateGraphInternal, {
      processId,
      clerkOrgId: ORG,
      generationId,
    });
    const processFlowId = (await readFlow(t, processId))!._id;

    // Every batch truncates at every size, so each node is eventually failed.
    for (let i = 0; i < 6; i++) {
      const rows = await readDetailRows(t);
      if (!rows.some((row) => row.status === "pending")) break;
      await t.action(internal.processFlows.generateNodeDetailsBatchInternal, {
        processId,
        clerkOrgId: ORG,
        processFlowId,
        generationId,
        batchSize: 1,
        halved: true,
      });
    }
    await t.action(internal.processFlows.generateFlowInsightsInternal, {
      processId,
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    const flow = await readFlow(t, processId);
    const rows = await readDetailRows(t);

    expect(rows.every((r) => r.status === "failed")).toBe(true);
    expect(flow?.detailsStatus).toBe("failed");
    // The graph survives, because it is independently useful.
    expect(flow?.status).toBe("ready");
    expect(flow?.nodes).toHaveLength(3);
  });

  test("a provider error on details leaves the graph usable and partial", async () => {
    const t = harness();
    // Wrapped rather than passed by reference: `run` supplies a second
    // argument, which would land in `orgId`.
    const processId = await t.run((ctx) => seedOrg(ctx));

    const { generationId } = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );
    stubClaude();
    await t.action(internal.processFlows.generateGraphInternal, {
      processId,
      clerkOrgId: ORG,
      generationId,
    });
    const processFlowId = (await readFlow(t, processId))!._id;

    // Details now fail at the transport layer on every attempt.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );
    await runDetailBatches(t, { processId, processFlowId, generationId });
    await t.action(internal.processFlows.generateFlowInsightsInternal, {
      processId,
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    const flow = await readFlow(t, processId);
    // A transport failure costs the descriptions, not the diagram.
    expect(flow?.status).toBe("ready");
    expect(flow?.detailsStatus).toBe("failed");
    expect(flow?.detailErrorMessage).toBeDefined();
  });
});

describe("tenant isolation for staged flows", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("another org cannot read a process flow or its details", async () => {
    const t = harness();
    const { processId } = await t.run(async (ctx) => {
      const id = await seedOrg(ctx);
      await seedOrg(ctx, OTHER_ORG);
      const flowId = await ctx.db.insert("processFlows", {
        processId: id,
        clerkOrgId: ORG,
        status: "ready",
        stale: false,
        generatedAt: Date.now(),
        conversationCount: 1,
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
        generationId: "gen_current",
        detailsStatus: "ready",
      });
      await ctx.db.insert("processFlowNodeDetails", {
        clerkOrgId: ORG,
        processId: id,
        processFlowId: flowId,
        generationId: "gen_current",
        nodeId: "intake",
        status: "ready",
      });
      return { processId: id, flowId };
    });

    const asOtherOrg = await t
      .withIdentity(identity(OTHER_ORG))
      .query(api.processFlows.getProcessFlow, { processId });

    // The process is not theirs, so it does not exist as far as they are told.
    expect(asOtherOrg).toBeNull();
  });

  test("detail rows cannot be reached with a mismatched org id", async () => {
    const t = harness();
    const { flowId } = await t.run(async (ctx) => {
      const id = await seedOrg(ctx);
      const createdFlowId = await ctx.db.insert("processFlows", {
        processId: id,
        clerkOrgId: ORG,
        status: "ready",
        stale: false,
        generatedAt: Date.now(),
        conversationCount: 1,
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
        generationId: "gen_current",
        detailsStatus: "generating",
      });
      await ctx.db.insert("processFlowNodeDetails", {
        clerkOrgId: ORG,
        processId: id,
        processFlowId: createdFlowId,
        generationId: "gen_current",
        nodeId: "intake",
        status: "pending",
      });
      return { flowId: createdFlowId };
    });

    // Every internal query and mutation is scoped by clerkOrgId as well as by
    // id, so a leaked id is not enough to read another tenant's rows.
    const batch = await t.query(internal.processFlows.getNodeDetailBatch, {
      clerkOrgId: OTHER_ORG,
      processFlowId: flowId,
      generationId: "gen_current",
      limit: 6,
    });
    expect(batch).toBeNull();

    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: OTHER_ORG,
      processFlowId: flowId,
      generationId: "gen_current",
      results: [{ nodeId: "intake", errorMessage: "should not apply" }],
    });

    const rows = await readDetailRows(t);
    expect(rows[0].status).toBe("pending");
  });
});
