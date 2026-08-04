/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ORG = "org_flow_schema";

type FlowFixture = Omit<Doc<"processFlows">, "_id" | "_creationTime">;
type DetailFixture = Omit<
  Doc<"processFlowNodeDetails">,
  "_id" | "_creationTime"
>;

const NODE_DETAIL: NonNullable<DetailFixture["detail"]> = {
  description: "Ticket is triaged by the team lead",
  actors: ["Team lead"],
  tools: ["Jira"],
  painPoints: ["Queue is checked manually"],
  automationPotential: "medium",
  confidence: "high",
  isBottleneck: false,
  isTribalKnowledge: false,
  riskIndicators: [],
  sources: ["Alice, Conv. 1"],
};

async function seedProcess(ctx: MutationCtx): Promise<Id<"processes">> {
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

function flow(
  processId: Id<"processes">,
  overrides: Partial<FlowFixture> = {},
): FlowFixture {
  return {
    processId,
    status: "ready",
    stale: false,
    generatedAt: 1_700_000_000_000,
    conversationCount: 2,
    nodes: [
      { id: "intake", label: "Intake", category: "start", ...NODE_DETAIL },
      { id: "triage", label: "Triage", category: "action", ...NODE_DETAIL },
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
    insights: {
      criticalPath: ["intake", "triage"],
      handoffCount: 0,
      toolCount: 1,
      automationOpportunities: [],
      topBottlenecks: [],
    },
    clerkOrgId: ORG,
    ...overrides,
  };
}

function detailRow(
  processId: Id<"processes">,
  processFlowId: Id<"processFlows">,
  overrides: Partial<DetailFixture> = {},
): DetailFixture {
  return {
    clerkOrgId: ORG,
    processId,
    processFlowId,
    generationId: "gen_current",
    nodeId: "triage",
    status: "pending",
    ...overrides,
  };
}

describe("staged flow generation schema", () => {
  test("a legacy row carrying none of the staged metadata is still valid", async () => {
    const t = convexTest(schema, modules);

    const stored = await t.run(async (ctx) => {
      const processId = await seedProcess(ctx);
      const flowId = await ctx.db.insert("processFlows", flow(processId));
      return await ctx.db.get(flowId);
    });

    // Absent `generationVersion` is the discriminator reads use to treat the
    // inline nodes as already fully detailed.
    expect(stored?.generationVersion).toBeUndefined();
    expect(stored?.detailsStatus).toBeUndefined();
    expect(stored?.nodes[0].description).toBe(NODE_DETAIL.description);
  });

  test("a staged row carries its generation metadata", async () => {
    const t = convexTest(schema, modules);

    const stored = await t.run(async (ctx) => {
      const processId = await seedProcess(ctx);
      const flowId = await ctx.db.insert(
        "processFlows",
        flow(processId, {
          generationVersion: "v3",
          generationId: "gen_current",
          detailsStatus: "generating",
          detailNodeCount: 2,
          detailCompletedCount: 1,
          detailFailedCount: 0,
          lastProgressAt: 1_700_000_000_000,
          resumeAttempts: 0,
        }),
      );
      return await ctx.db.get(flowId);
    });

    expect(stored?.generationVersion).toBe("v3");
    expect(stored?.detailsStatus).toBe("generating");
    expect(stored?.detailCompletedCount).toBe(1);
  });

  test("detail rows of a superseded generation are excluded by the index", async () => {
    const t = convexTest(schema, modules);

    const rows = await t.run(async (ctx) => {
      const processId = await seedProcess(ctx);
      const flowId = await ctx.db.insert(
        "processFlows",
        flow(processId, {
          generationVersion: "v3",
          generationId: "gen_current",
        }),
      );
      await ctx.db.insert(
        "processFlowNodeDetails",
        detailRow(processId, flowId, { nodeId: "intake", status: "ready" }),
      );
      await ctx.db.insert(
        "processFlowNodeDetails",
        detailRow(processId, flowId, { nodeId: "triage", status: "ready" }),
      );
      // Left over from a run the user superseded by regenerating.
      await ctx.db.insert(
        "processFlowNodeDetails",
        detailRow(processId, flowId, {
          generationId: "gen_previous",
          nodeId: "triage",
          status: "ready",
        }),
      );

      return await ctx.db
        .query("processFlowNodeDetails")
        .withIndex(
          "by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId",
          (q) =>
            q
              .eq("clerkOrgId", ORG)
              .eq("processFlowId", flowId)
              .eq("generationId", "gen_current"),
        )
        .collect();
    });

    // The stale-write guard the whole design rests on: a prior generation's
    // rows cannot bleed into a read of the current one.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.nodeId).sort()).toEqual(["intake", "triage"]);
  });

  test("pending nodes of a generation are findable for the next batch", async () => {
    const t = convexTest(schema, modules);

    const pending = await t.run(async (ctx) => {
      const processId = await seedProcess(ctx);
      const flowId = await ctx.db.insert(
        "processFlows",
        flow(processId, {
          generationVersion: "v3",
          generationId: "gen_current",
        }),
      );
      await ctx.db.insert(
        "processFlowNodeDetails",
        detailRow(processId, flowId, {
          nodeId: "intake",
          status: "ready",
          detail: NODE_DETAIL,
          generatedAt: 1_700_000_000_000,
        }),
      );
      await ctx.db.insert(
        "processFlowNodeDetails",
        detailRow(processId, flowId, { nodeId: "triage" }),
      );
      await ctx.db.insert(
        "processFlowNodeDetails",
        detailRow(processId, flowId, { nodeId: "resolve" }),
      );

      return await ctx.db
        .query("processFlowNodeDetails")
        .withIndex(
          "by_clerkOrgId_and_processFlowId_and_generationId_and_status",
          (q) =>
            q
              .eq("clerkOrgId", ORG)
              .eq("processFlowId", flowId)
              .eq("generationId", "gen_current")
              .eq("status", "pending"),
        )
        .take(6);
    });

    expect(pending.map((r) => r.nodeId).sort()).toEqual(["resolve", "triage"]);
    expect(pending.every((r) => r.detail === undefined)).toBe(true);
  });

  test("the reaper index finds runs stuck in either stage, across orgs", async () => {
    const t = convexTest(schema, modules);
    const cutoff = 1_700_000_000_000;

    const { stuckGraph, stuckDetails } = await t.run(async (ctx) => {
      const processId = await seedProcess(ctx);
      await ctx.db.insert(
        "processFlows",
        flow(processId, {
          status: "generating",
          lastProgressAt: cutoff - 60_000,
          generationVersion: "v3",
        }),
      );
      // Healthy: heartbeat is fresher than the cutoff.
      await ctx.db.insert(
        "processFlows",
        flow(processId, {
          status: "generating",
          lastProgressAt: cutoff + 60_000,
          generationVersion: "v3",
        }),
      );
      // Graph landed, details wedged — the case a status-only sweep misses.
      await ctx.db.insert(
        "processFlows",
        flow(processId, {
          status: "ready",
          detailsStatus: "generating",
          lastProgressAt: cutoff - 60_000,
          generationVersion: "v3",
          // Another tenant entirely: the sweep is not org-scoped.
          clerkOrgId: "org_other_tenant",
        }),
      );

      return {
        stuckGraph: await ctx.db
          .query("processFlows")
          .withIndex("by_status_and_lastProgressAt", (q) =>
            q.eq("status", "generating").lt("lastProgressAt", cutoff),
          )
          .take(20),
        stuckDetails: await ctx.db
          .query("processFlows")
          .withIndex("by_detailsStatus_and_lastProgressAt", (q) =>
            q.eq("detailsStatus", "generating").lt("lastProgressAt", cutoff),
          )
          .take(20),
      };
    });

    expect(stuckGraph).toHaveLength(1);
    expect(stuckGraph[0].lastProgressAt).toBe(cutoff - 60_000);
    expect(stuckDetails).toHaveLength(1);
    expect(stuckDetails[0].clerkOrgId).toBe("org_other_tenant");
  });
});
