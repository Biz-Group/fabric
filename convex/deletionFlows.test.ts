/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ORG_A = "org_delete_a";
const ISSUER = "https://test.clerk";

type SeededOrg = {
  adminId: Id<"users">;
  contributorId: Id<"users">;
  viewerId: Id<"users">;
  functionId: Id<"functions">;
  departmentId: Id<"departments">;
  processId: Id<"processes">;
};

function identityFor(user: "admin" | "contributor" | "viewer") {
  return {
    tokenIdentifier: `${ISSUER}|${user}`,
    subject: user,
    issuer: ISSUER,
    name: user,
    email: `${user}@example.test`,
    orgId: ORG_A,
    orgSlug: "delete-a",
  };
}

async function seedOrg(t: ReturnType<typeof convexTest>): Promise<SeededOrg> {
  return await t.run(async (ctx) => {
    const adminId = await ctx.db.insert("users", {
      tokenIdentifier: `${ISSUER}|admin`,
      name: "Admin",
      email: "admin@example.test",
      profileComplete: true,
    });
    const contributorId = await ctx.db.insert("users", {
      tokenIdentifier: `${ISSUER}|contributor`,
      name: "Contributor",
      email: "contributor@example.test",
      profileComplete: true,
    });
    const viewerId = await ctx.db.insert("users", {
      tokenIdentifier: `${ISSUER}|viewer`,
      name: "Viewer",
      email: "viewer@example.test",
      profileComplete: true,
    });

    await ctx.db.insert("memberships", {
      tokenIdentifier: `${ISSUER}|admin`,
      userId: adminId,
      clerkOrgId: ORG_A,
      role: "admin",
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      tokenIdentifier: `${ISSUER}|contributor`,
      userId: contributorId,
      clerkOrgId: ORG_A,
      role: "contributor",
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      tokenIdentifier: `${ISSUER}|viewer`,
      userId: viewerId,
      clerkOrgId: ORG_A,
      role: "viewer",
      createdAt: Date.now(),
    });

    const functionId = await ctx.db.insert("functions", {
      name: "Operations",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });
    const departmentId = await ctx.db.insert("departments", {
      functionId,
      name: "Payroll",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });
    const processId = await ctx.db.insert("processes", {
      departmentId,
      name: "Monthly payroll",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });

    return {
      adminId,
      contributorId,
      viewerId,
      functionId,
      departmentId,
      processId,
    };
  });
}

async function insertConversation(
  t: ReturnType<typeof convexTest>,
  processId: Id<"processes">,
): Promise<Id<"conversations">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("conversations", {
      processId,
      clerkOrgId: ORG_A,
      contributorName: "Contributor",
      status: "done",
      summary: "Done conversation summary.",
    });
  });
}

async function insertProcessFlow(
  t: ReturnType<typeof convexTest>,
  processId: Id<"processes">,
): Promise<Id<"processFlows">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("processFlows", {
      processId,
      clerkOrgId: ORG_A,
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
    });
  });
}

describe("deletion flow integrity", () => {
  test("process delete eligibility is role-aware and blocks conversations", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedOrg(t);
    await insertConversation(t, ids.processId);

    const adminEligibility = await t
      .withIdentity(identityFor("admin"))
      .query(api.processes.deleteEligibility, { processId: ids.processId });
    expect(adminEligibility).toMatchObject({
      canDelete: false,
      blocker: "children",
      childKind: "conversations",
      canCleanUpChildren: true,
    });

    const contributorEligibility = await t
      .withIdentity(identityFor("contributor"))
      .query(api.processes.deleteEligibility, { processId: ids.processId });
    expect(contributorEligibility).toMatchObject({
      canDelete: false,
      blocker: "children",
      childKind: "conversations",
      canCleanUpChildren: false,
    });

    const viewerEligibility = await t
      .withIdentity(identityFor("viewer"))
      .query(api.functions.deleteEligibility, { functionId: ids.functionId });
    expect(viewerEligibility).toMatchObject({
      canDelete: false,
      blocker: "role",
    });
  });

  test("deleting an empty process removes its process flow", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedOrg(t);
    const flowId = await insertProcessFlow(t, ids.processId);

    await t
      .withIdentity(identityFor("contributor"))
      .mutation(api.processes.remove, { processId: ids.processId });

    const rows = await t.run(async (ctx) => ({
      process: await ctx.db.get(ids.processId),
      flow: await ctx.db.get(flowId),
      department: await ctx.db.get(ids.departmentId),
      fn: await ctx.db.get(ids.functionId),
    }));
    expect(rows.process).toBeNull();
    expect(rows.flow).toBeNull();
    expect(rows.department?.summarySourceRevision).toBe(1);
    expect(rows.fn?.summarySourceRevision).toBe(1);
    expect(rows.fn?.summaryStale).toBe(true);
  });

  test("deleting the last done conversation clears summary and flow", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedOrg(t);
    const conversationId = await insertConversation(t, ids.processId);
    const flowId = await insertProcessFlow(t, ids.processId);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.processId, { rollingSummary: "Old process summary" });
      await ctx.db.patch(ids.departmentId, {
        summary: "Old department summary",
        summaryStale: false,
      });
      await ctx.db.patch(ids.functionId, {
        summary: "Old function summary",
        summaryStale: false,
      });
    });

    await t
      .withIdentity(identityFor("admin"))
      .mutation(api.conversations.deleteForAdmin, { conversationId });

    const rows = await t.run(async (ctx) => ({
      process: await ctx.db.get(ids.processId),
      department: await ctx.db.get(ids.departmentId),
      fn: await ctx.db.get(ids.functionId),
      flow: await ctx.db.get(flowId),
    }));
    expect(rows.process?.rollingSummary).toBeUndefined();
    expect(rows.department?.summary).toBeUndefined();
    expect(rows.department?.summaryStale).toBeUndefined();
    expect(rows.fn?.summaryStale).toBe(true);
    expect(rows.flow).toBeNull();
  });

  test("deleting one of multiple done conversations marks flow stale", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedOrg(t);
    const firstConversationId = await insertConversation(t, ids.processId);
    await insertConversation(t, ids.processId);
    const flowId = await insertProcessFlow(t, ids.processId);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.processId, { rollingSummary: "Old process summary" });
      await ctx.db.patch(ids.departmentId, { summaryStale: false });
    });

    await t
      .withIdentity(identityFor("admin"))
      .mutation(api.conversations.deleteForAdmin, {
        conversationId: firstConversationId,
      });

    const rows = await t.run(async (ctx) => ({
      process: await ctx.db.get(ids.processId),
      department: await ctx.db.get(ids.departmentId),
      flow: await ctx.db.get(flowId),
    }));
    expect(rows.process?.rollingSummary).toBe("Old process summary");
    expect(rows.department?.summaryStale).toBe(true);
    expect(rows.flow?.stale).toBe(true);
  });

  test("deleting a conversation marks the summary stale without rebuilding it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedOrg(t);
    const conversationId = await insertConversation(t, ids.processId);
    await insertConversation(t, ids.processId);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.processId, {
        rollingSummary: "Old process summary",
      });
    });

    await t
      .withIdentity(identityFor("admin"))
      .mutation(api.conversations.deleteForAdmin, { conversationId });

    const after = await t.run(async (ctx) => ({
      process: await ctx.db.get(ids.processId),
      scheduled: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).length,
    }));
    // Bulk-deleting test recordings is exactly where a rebuild per deletion
    // would cost the most for the least value, so deletion only invalidates.
    expect(after.process?.summaryStale).toBe(true);
    expect(after.process?.summaryEvidenceRefreshGenerationId).toBeUndefined();
    expect(after.process?.rollingSummary).toBe("Old process summary");
    expect(after.scheduled).toBe(0);
  });
});
