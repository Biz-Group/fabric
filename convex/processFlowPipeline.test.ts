/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import schema from "./schema";
import { placeholderNodeDetail } from "./lib/flowStages";

const modules = import.meta.glob("./**/*.ts");

const ORG = "org_flow_pipeline";
const ISSUER = "https://test.clerk";

function identity() {
  return {
    tokenIdentifier: `${ISSUER}|member`,
    subject: "member",
    issuer: ISSUER,
    name: "Member",
    email: "member@test.dev",
    orgId: ORG,
    orgSlug: "pipeline",
  };
}

const GRAPH_NODES = [
  { id: "intake", label: "Intake", category: "start" as const },
  { id: "triage", label: "Triage", category: "handoff" as const },
  { id: "resolve", label: "Resolve", category: "end" as const },
];

const GRAPH_EDGES = [
  {
    id: "intake-triage",
    source: "intake",
    target: "triage",
    type: "sequential" as const,
    isHappyPath: true,
  },
];

const DETAIL = {
  ...placeholderNodeDetail(),
  description: "Triaged by the team lead",
  tools: ["Jira"],
  isBottleneck: true,
  automationPotential: "high" as const,
  painPoints: ["Queue is checked by hand"],
};

async function seedOrg(ctx: MutationCtx): Promise<Id<"processes">> {
  const userId = await ctx.db.insert("users", {
    tokenIdentifier: `${ISSUER}|member`,
    name: "Member",
    email: "member@test.dev",
    profileComplete: true,
  });
  await ctx.db.insert("memberships", {
    tokenIdentifier: `${ISSUER}|member`,
    userId,
    clerkOrgId: ORG,
    role: "contributor",
    createdAt: Date.now(),
  });
  const functionId = await ctx.db.insert("functions", {
    name: "Operations",
    sortOrder: 0,
    clerkOrgId: ORG,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Support",
    sortOrder: 0,
    clerkOrgId: ORG,
  });
  return await ctx.db.insert("processes", {
    departmentId,
    name: "Ticket triage",
    sortOrder: 0,
    clerkOrgId: ORG,
  });
}

// The single place that builds a harness. Deriving `Harness` from it keeps the
// schema in the type — bare `ReturnType<typeof convexTest>` erases it and
// leaves `ctx.db` typed against the system tables only.
function harness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof harness>;

/** Runs the graph stage's writes without the LLM call. */
async function startAndSaveGraph(t: Harness, processId: Id<"processes">) {
  const started = await t.mutation(internal.processFlows.startFlowGeneration, {
    processId,
    clerkOrgId: ORG,
  });
  const processFlowId = await t.mutation(internal.processFlows.saveFlowGraph, {
    processId,
    clerkOrgId: ORG,
    generationId: started.generationId,
    conversationCount: 2,
    nodes: GRAPH_NODES,
    edges: GRAPH_EDGES,
    criticalPath: ["intake", "triage"],
  });
  return { ...started, processFlowId: processFlowId! };
}

function readFlow(t: Harness, processId: Id<"processes">) {
  return t.run(async (ctx) => {
    return await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", ORG).eq("processId", processId),
      )
      .first();
  });
}

function readDetailRows(
  t: Harness,
  processFlowId: Id<"processFlows">,
): Promise<Doc<"processFlowNodeDetails">[]> {
  return t.run(async (ctx) => {
    return await ctx.db
      .query("processFlowNodeDetails")
      .withIndex(
        "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
        (q) => q.eq("clerkOrgId", ORG).eq("processFlowId", processFlowId),
      )
      .collect();
  });
}

describe("staged flow generation pipeline", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("a second trigger joins the run in flight instead of starting another", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);

    const first = await t.mutation(internal.processFlows.startFlowGeneration, {
      processId,
      clerkOrgId: ORG,
    });
    const second = await t.mutation(internal.processFlows.startFlowGeneration, {
      processId,
      clerkOrgId: ORG,
    });

    // Two clicks must not buy two pipelines' worth of tokens.
    expect(first.joined).toBe(false);
    expect(second.joined).toBe(true);
    expect(second.generationId).toBe(first.generationId);
  });

  test("a run whose heartbeat went stale can be superseded", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);

    const first = await t.mutation(internal.processFlows.startFlowGeneration, {
      processId,
      clerkOrgId: ORG,
    });
    // Simulate a wedged run: no heartbeat for well past the window.
    await t.run(async (ctx) => {
      const flow = (await ctx.db
        .query("processFlows")
        .withIndex("by_clerkOrgId_and_processId", (q) =>
          q.eq("clerkOrgId", ORG).eq("processId", processId),
        )
        .first())!;
      await ctx.db.patch(flow._id, { lastProgressAt: Date.now() - 600_000 });
    });

    const second = await t.mutation(internal.processFlows.startFlowGeneration, {
      processId,
      clerkOrgId: ORG,
    });

    expect(second.joined).toBe(false);
    expect(second.generationId).not.toBe(first.generationId);
  });

  test("saving the graph seeds one pending row per node and keeps its metadata", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );

    const flow = await readFlow(t, processId);
    const rows = await readDetailRows(t, processFlowId);

    expect(flow?.status).toBe("ready");
    expect(flow?.detailsStatus).toBe("generating");
    expect(flow?.detailNodeCount).toBe(3);
    // The patch-not-replace guarantee: a `replace` that forgot these fields
    // would leave the pipeline running with no bookkeeping. This is the single
    // most likely silent regression in the whole migration.
    expect(flow?.generationId).toBe(generationId);
    expect(flow?.generationVersion).toBe("v3");
    expect(rows.map((r) => r.nodeId).sort()).toEqual([
      "intake",
      "resolve",
      "triage",
    ]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  test("a superseded run cannot write its graph over the current one", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId } = await startAndSaveGraph(t, processId);

    const result = await t.mutation(internal.processFlows.saveFlowGraph, {
      processId,
      clerkOrgId: ORG,
      generationId: "gen_from_an_abandoned_run",
      conversationCount: 99,
      nodes: [{ id: "ghost", label: "Ghost", category: "action" }],
      edges: [],
      criticalPath: [],
    });

    const flow = await readFlow(t, processId);
    expect(result).toBeNull();
    expect(flow?.generationId).toBe(generationId);
    expect(flow?.nodes.map((n) => n.id)).toEqual([
      "intake",
      "triage",
      "resolve",
    ]);
    expect(flow?.conversationCount).toBe(2);
  });

  test("a batch marks its nodes and recomputes the counters", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );

    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: [
        { nodeId: "intake", detail: DETAIL },
        { nodeId: "triage", errorMessage: "No detail returned." },
      ],
    });

    const flow = await readFlow(t, processId);
    const rows = await readDetailRows(t, processFlowId);
    const byId = new Map(rows.map((r) => [r.nodeId, r]));

    expect(byId.get("intake")?.status).toBe("ready");
    expect(byId.get("intake")?.detail?.description).toBe(DETAIL.description);
    expect(byId.get("triage")?.status).toBe("failed");
    expect(byId.get("resolve")?.status).toBe("pending");
    expect(flow?.detailCompletedCount).toBe(1);
    expect(flow?.detailFailedCount).toBe(1);
  });

  test("counters are recomputed, so a replayed batch cannot double-count", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );

    const batch = {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: [{ nodeId: "intake", detail: DETAIL }],
    };
    await t.mutation(internal.processFlows.saveNodeDetailBatch, batch);
    await t.mutation(internal.processFlows.saveNodeDetailBatch, batch);

    const flow = await readFlow(t, processId);
    expect(flow?.detailCompletedCount).toBe(1);
  });

  test("finalize reports ready when every node landed, and rolls up insights", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );

    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: GRAPH_NODES.map((n) => ({ nodeId: n.id, detail: DETAIL })),
    });
    await t.mutation(internal.processFlows.finalizeNodeDetails, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    const flow = await readFlow(t, processId);
    expect(flow?.detailsStatus).toBe("ready");
    expect(flow?.detailErrorMessage).toBeUndefined();
    // Rolled up from the detail rows, without another LLM call.
    expect(flow?.insights.toolCount).toBe(1);
    expect(flow?.insights.topBottlenecks).toEqual([
      "Intake",
      "Triage",
      "Resolve",
    ]);
    expect(flow?.insights.handoffCount).toBe(1);
  });

  test("finalize stores the analysed automation opportunities it is handed", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: GRAPH_NODES.map((n) => ({ nodeId: n.id, detail: DETAIL })),
    });

    await t.mutation(internal.processFlows.finalizeNodeDetails, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      automationOpportunityDetails: [
        {
          title: "Ticket triage assistant",
          kind: "agent",
          nodeIds: ["intake", "triage"],
          rationale: "Every ticket is read and routed by hand today.",
          expectedBenefit: "Removes the morning queue sweep",
          prerequisites: ["Jira API access"],
          confidence: "high",
        },
      ],
    });

    const flow = await readFlow(t, processId);
    // Structured and spanning both steps, so a future Agents Library can build
    // from it rather than re-deriving intent from a sentence.
    expect(flow?.insights.automationOpportunitiesSource).toBe("ai");
    expect(flow?.insights.automationOpportunityDetails).toHaveLength(1);
    expect(flow?.insights.automationOpportunityDetails?.[0].nodeIds).toEqual([
      "intake",
      "triage",
    ]);
    expect(flow?.insights.automationOpportunities[0]).toContain(
      "Ticket triage assistant",
    );
  });

  test("finalize without an analysis falls back and records that it did", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: GRAPH_NODES.map((n) => ({ nodeId: n.id, detail: DETAIL })),
    });

    // The watchdog finalizes this way, and so does the insights stage when its
    // call fails: the run still lands, flagged as not analysed.
    await t.mutation(internal.processFlows.finalizeNodeDetails, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    const flow = await readFlow(t, processId);
    expect(flow?.insights.automationOpportunitiesSource).toBe("derived");
    expect(flow?.insights.automationOpportunityDetails).toBeUndefined();
    expect(flow?.detailsStatus).toBe("ready");
  });

  test("finalize reports partial when some nodes never landed", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );

    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: [
        { nodeId: "intake", detail: DETAIL },
        { nodeId: "triage", errorMessage: "nope" },
      ],
    });
    await t.mutation(internal.processFlows.finalizeNodeDetails, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    const flow = await readFlow(t, processId);
    // The graph is still usable, so this is explicitly not "failed".
    expect(flow?.status).toBe("ready");
    expect(flow?.detailsStatus).toBe("partial");
    expect(flow?.detailFailedCount).toBe(2);
    expect(flow?.detailErrorMessage).toContain("2 of 3");
  });

  test("finalize reports failed when nothing could be described", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );

    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: GRAPH_NODES.map((n) => ({
        nodeId: n.id,
        errorMessage: "nope",
      })),
    });
    await t.mutation(internal.processFlows.finalizeNodeDetails, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    const flow = await readFlow(t, processId);
    expect(flow?.detailsStatus).toBe("failed");
    expect(flow?.status).toBe("ready");
  });

  test("a graph-stage failure leaves the flow failed, not half-generated", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const started = await t.mutation(
      internal.processFlows.startFlowGeneration,
      { processId, clerkOrgId: ORG },
    );

    await t.mutation(internal.processFlows.failFlowGeneration, {
      processId,
      clerkOrgId: ORG,
      generationId: started.generationId,
      stage: "graph",
      errorMessage: "Failed to generate process flow. Please try again.",
    });

    const flow = await readFlow(t, processId);
    expect(flow?.status).toBe("failed");
    expect(flow?.detailsStatus).toBeUndefined();
    expect(flow?.errorMessage).toContain("Please try again");
  });

  test("a failed refresh keeps the previous flow intact underneath", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);

    // A generation that succeeded: this is what the user already has.
    const first = await startAndSaveGraph(t, processId);
    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId: first.processFlowId,
      generationId: first.generationId,
      results: GRAPH_NODES.map((n) => ({ nodeId: n.id, detail: DETAIL })),
    });
    await t.mutation(internal.processFlows.finalizeNodeDetails, {
      clerkOrgId: ORG,
      processFlowId: first.processFlowId,
      generationId: first.generationId,
    });
    const before = await readFlow(t, processId);

    // A later refresh dies in the graph stage.
    const second = await t.mutation(internal.processFlows.startFlowGeneration, {
      processId,
      clerkOrgId: ORG,
    });
    await t.mutation(internal.processFlows.failFlowGeneration, {
      processId,
      clerkOrgId: ORG,
      generationId: second.generationId,
      stage: "graph",
      errorMessage: "Failed to generate process flow. Please try again.",
    });

    const after = await readFlow(t, processId);
    // Everything the user could read is still there and still describes the
    // generation it actually came from — the UI renders this rather than an
    // error page. The old `replace`-based save destroyed it instead.
    expect(after?.status).toBe("failed");
    expect(after?.nodes).toEqual(before?.nodes);
    expect(after?.edges).toEqual(before?.edges);
    expect(after?.insights).toEqual(before?.insights);
    expect(after?.conversationCount).toBe(before?.conversationCount);
    expect(after?.generatedAt).toBe(before?.generatedAt);
  });

  test("cleanup removes a superseded generation's rows and keeps the current ones", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("processFlowNodeDetails", {
        clerkOrgId: ORG,
        processId,
        processFlowId,
        generationId: "gen_previous",
        nodeId: "old-node",
        status: "ready",
      });
    });

    await t.mutation(internal.processFlows.cleanupSupersededDetailRows, {
      clerkOrgId: ORG,
      processFlowId,
      keepGenerationId: generationId,
    });

    const rows = await readDetailRows(t, processFlowId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.generationId === generationId)).toBe(true);
  });

  test("a failed step can be requeued without regenerating the flow", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: [
        { nodeId: "intake", detail: DETAIL },
        { nodeId: "triage", errorMessage: "The AI returned no detail." },
        { nodeId: "resolve", detail: DETAIL },
      ],
    });
    await t.mutation(internal.processFlows.finalizeNodeDetails, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
    });

    const result = await t.mutation(internal.processFlows.requeueNodeDetail, {
      processId,
      clerkOrgId: ORG,
      nodeId: "triage",
    });

    const rows = await readDetailRows(t, processFlowId);
    const byId = new Map(rows.map((r) => [r.nodeId, r]));
    const flow = await readFlow(t, processId);

    expect(result.requeued).toBe(true);
    expect(byId.get("triage")?.status).toBe("pending");
    expect(byId.get("triage")?.errorMessage).toBeUndefined();
    // The steps that succeeded are untouched — that is the point of retrying
    // one node rather than the run.
    expect(byId.get("intake")?.status).toBe("ready");
    expect(byId.get("resolve")?.status).toBe("ready");
    // Back in flight, so the UI shows work and the watchdog covers the retry.
    expect(flow?.detailsStatus).toBe("generating");
    expect(flow?.detailErrorMessage).toBeUndefined();
  });

  test("requeueing a step that already succeeded does nothing", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: [{ nodeId: "intake", detail: DETAIL }],
    });

    const result = await t.mutation(internal.processFlows.requeueNodeDetail, {
      processId,
      clerkOrgId: ORG,
      nodeId: "intake",
    });

    expect(result.requeued).toBe(false);
    const rows = await readDetailRows(t, processFlowId);
    expect(rows.find((r) => r.nodeId === "intake")?.detail?.description).toBe(
      DETAIL.description,
    );
  });

  test("another org cannot requeue a step", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: [{ nodeId: "triage", errorMessage: "nope" }],
    });

    const result = await t.mutation(internal.processFlows.requeueNodeDetail, {
      processId,
      clerkOrgId: "org_someone_else",
      nodeId: "triage",
    });

    expect(result.requeued).toBe(false);
    const rows = await readDetailRows(t, processFlowId);
    expect(rows.find((r) => r.nodeId === "triage")?.status).toBe("failed");
  });

  test("a summary rebuild over the same conversations does not flag the flow", async () => {
    const t = harness();
    const processId = await t.run(async (ctx) => {
      const id = await seedOrg(ctx);
      // Two completed conversations, matching what the flow will record.
      for (const name of ["Alice", "Bob"]) {
        await ctx.db.insert("conversations", {
          processId: id,
          contributorName: name,
          status: "done",
          clerkOrgId: ORG,
        });
      }
      return id;
    });
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    // startAndSaveGraph records 2, matching the conversations above.
    await t.run(async (ctx) => {
      await ctx.db.patch(processFlowId, { conversationCount: 2 });
    });
    void generationId;

    // The rolling summary finishes rebuilding minutes after the flow generated —
    // exactly the sequence that produced a "2 conversations vs 2 conversations"
    // stale notice in the app.
    await t.mutation(internal.processFlows.markFlowStale, {
      processId,
      clerkOrgId: ORG,
      trigger: "summaryRebuilt",
    });

    const flow = await readFlow(t, processId);
    expect(flow?.stale).toBe(false);
  });

  test("a new conversation does flag the flow as stale", async () => {
    const t = harness();
    const processId = await t.run(async (ctx) => {
      const id = await seedOrg(ctx);
      await ctx.db.insert("conversations", {
        processId: id,
        contributorName: "Alice",
        status: "done",
        clerkOrgId: ORG,
      });
      return id;
    });
    const { processFlowId } = await startAndSaveGraph(t, processId);
    await t.run(async (ctx) => {
      await ctx.db.patch(processFlowId, { conversationCount: 1 });
      // A third contributor lands after the flow was built.
      await ctx.db.insert("conversations", {
        processId,
        contributorName: "Bob",
        status: "done",
        clerkOrgId: ORG,
      });
    });

    await t.mutation(internal.processFlows.markFlowStale, {
      processId,
      clerkOrgId: ORG,
      trigger: "summaryRebuilt",
    });

    expect((await readFlow(t, processId))?.stale).toBe(true);
  });

  test("removed evidence flags the flow even when the count is unchanged", async () => {
    const t = harness();
    const processId = await t.run(async (ctx) => {
      const id = await seedOrg(ctx);
      // Two conversations, matching what the flow records below.
      for (const name of ["Alice", "Bob"]) {
        await ctx.db.insert("conversations", {
          processId: id,
          contributorName: name,
          status: "done",
          clerkOrgId: ORG,
        });
      }
      return id;
    });
    const { processFlowId } = await startAndSaveGraph(t, processId);
    await t.run(async (ctx) => {
      await ctx.db.patch(processFlowId, { conversationCount: 2 });
    });

    // A third lands and one of the originals is deleted: the count is 2 again,
    // but the flow still describes an interview that no longer exists. This is
    // why deletion cannot rely on counting.
    await t.run(async (ctx) => {
      await ctx.db.insert("conversations", {
        processId,
        contributorName: "Carol",
        status: "done",
        clerkOrgId: ORG,
      });
      const alice = await ctx.db
        .query("conversations")
        .withIndex("by_clerkOrgId_and_processId", (q) =>
          q.eq("clerkOrgId", ORG).eq("processId", processId),
        )
        .collect();
      await ctx.db.delete(alice[0]._id);
    });

    await t.mutation(internal.processFlows.markFlowStale, {
      processId,
      clerkOrgId: ORG,
      trigger: "evidenceChanged",
    });

    expect((await readFlow(t, processId))?.stale).toBe(true);
  });

  test("a flow still generating is never marked stale", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    await t.mutation(internal.processFlows.startFlowGeneration, {
      processId,
      clerkOrgId: ORG,
    });

    await t.mutation(internal.processFlows.markFlowStale, {
      processId,
      clerkOrgId: ORG,
      trigger: "summaryRebuilt",
    });

    const flow = await readFlow(t, processId);
    expect(flow?.status).toBe("generating");
    expect(flow?.stale).toBe(false);
  });

  test("deleting a process takes its detail rows with it", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { processFlowId } = await startAndSaveGraph(t, processId);

    await t.mutation(internal.processFlows.deleteForProcess, {
      processId,
      clerkOrgId: ORG,
    });

    expect(await readFlow(t, processId)).toBeNull();
    // Deleting the parent first would orphan these beyond reach.
    expect(await readDetailRows(t, processFlowId)).toHaveLength(0);
  });
});

describe("reading a staged flow", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("overlays the current generation's details onto the graph", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: [{ nodeId: "triage", detail: DETAIL }],
    });

    const flow = await t
      .withIdentity(identity())
      .query(api.processFlows.getProcessFlow, { processId });

    const byId = new Map(flow!.nodes.map((n) => [n.id, n]));
    expect(byId.get("triage")?.description).toBe(DETAIL.description);
    expect(byId.get("triage")?.detailStatus).toBe("ready");
    // Not yet enriched — reported as pending rather than as an empty step.
    expect(byId.get("intake")?.detailStatus).toBe("pending");
    expect(byId.get("intake")?.description).toBe("");
  });

  test("a superseded generation's details never leak into the read", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { processFlowId } = await startAndSaveGraph(t, processId);
    await t.run(async (ctx) => {
      await ctx.db.insert("processFlowNodeDetails", {
        clerkOrgId: ORG,
        processId,
        processFlowId,
        generationId: "gen_previous",
        nodeId: "triage",
        status: "ready",
        detail: { ...DETAIL, description: "Stale description" },
      });
    });

    const flow = await t
      .withIdentity(identity())
      .query(api.processFlows.getProcessFlow, { processId });

    const triage = flow!.nodes.find((n) => n.id === "triage");
    expect(triage?.description).not.toBe("Stale description");
    expect(triage?.detailStatus).toBe("pending");
  });

  test("a legacy single-call flow reads as fully detailed", async () => {
    const t = harness();
    const processId = await t.run(async (ctx) => {
      const id = await seedOrg(ctx);
      await ctx.db.insert("processFlows", {
        processId: id,
        clerkOrgId: ORG,
        status: "ready",
        stale: false,
        generatedAt: Date.now(),
        conversationCount: 1,
        nodes: [
          {
            id: "legacy",
            label: "Legacy Step",
            category: "action",
            ...placeholderNodeDetail(),
            description: "Written inline by the old single call",
          },
        ],
        edges: [],
        insights: {
          criticalPath: [],
          handoffCount: 0,
          toolCount: 0,
          automationOpportunities: [],
          topBottlenecks: [],
        },
      });
      return id;
    });

    const flow = await t
      .withIdentity(identity())
      .query(api.processFlows.getProcessFlow, { processId });

    // No migration required: absent generationVersion means already detailed.
    expect(flow?.detailsStatus).toBe("ready");
    expect(flow?.nodes[0].detailStatus).toBe("ready");
    expect(flow?.nodes[0].description).toBe(
      "Written inline by the old single call",
    );
  });
});

describe("watchdog", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("fails a run wedged in the graph stage", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    await t.mutation(internal.processFlows.startFlowGeneration, {
      processId,
      clerkOrgId: ORG,
    });
    await t.run(async (ctx) => {
      const flow = (await ctx.db
        .query("processFlows")
        .withIndex("by_clerkOrgId_and_processId", (q) =>
          q.eq("clerkOrgId", ORG).eq("processId", processId),
        )
        .first())!;
      await ctx.db.patch(flow._id, { lastProgressAt: Date.now() - 700_000 });
    });

    await t.mutation(internal.processFlows.reapStuckFlowGenerations, {});

    const flow = await readFlow(t, processId);
    // Terminal, so the UI's retry becomes reachable. Deliberately not re-run
    // from the reaper: that would spend tokens on an abandoned run.
    expect(flow?.status).toBe("failed");
    expect(flow?.errorMessage).toContain("stopped unexpectedly");
  });

  test("resumes a detail stage that died with work still pending", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { processFlowId } = await startAndSaveGraph(t, processId);
    await t.run(async (ctx) => {
      await ctx.db.patch(processFlowId, {
        lastProgressAt: Date.now() - 700_000,
      });
    });

    await t.mutation(internal.processFlows.reapStuckFlowGenerations, {});

    const flow = await readFlow(t, processId);
    // This is the gap try/catch cannot close: an action killed between writing
    // a batch and scheduling the next one leaves pending rows and no error.
    expect(flow?.resumeAttempts).toBe(1);
    expect(flow?.detailsStatus).toBe("generating");
  });

  test("stops resuming after the attempt cap and finalizes to partial", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    const { generationId, processFlowId } = await startAndSaveGraph(
      t,
      processId,
    );
    await t.mutation(internal.processFlows.saveNodeDetailBatch, {
      clerkOrgId: ORG,
      processFlowId,
      generationId,
      results: [{ nodeId: "intake", detail: DETAIL }],
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(processFlowId, {
        lastProgressAt: Date.now() - 700_000,
        resumeAttempts: 2,
      });
    });

    // The reaper hands off to finalize through the scheduler rather than
    // calling it inline — sweeping up to 25 flows, each reading every one of
    // its detail rows, would not fit in one transaction. So the test has to let
    // that scheduled work run.
    vi.useFakeTimers();
    try {
      await t.mutation(internal.processFlows.reapStuckFlowGenerations, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const flow = await readFlow(t, processId);
    // Lands on a terminal state with the graph intact rather than retrying
    // forever or sitting in "generating".
    expect(flow?.detailsStatus).toBe("partial");
    expect(flow?.detailCompletedCount).toBe(1);
  });

  test("leaves a healthy run alone", async () => {
    const t = harness();
    const processId = await t.run(seedOrg);
    await startAndSaveGraph(t, processId);

    await t.mutation(internal.processFlows.reapStuckFlowGenerations, {});

    const flow = await readFlow(t, processId);
    expect(flow?.detailsStatus).toBe("generating");
    expect(flow?.resumeAttempts).toBe(0);
  });
});
