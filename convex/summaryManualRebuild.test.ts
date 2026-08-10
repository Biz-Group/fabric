/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ORG = "org_manual_rebuild";
const ISSUER = "https://manual-rebuild.test";
const originalSummaryV2 = process.env.SUMMARY_V2;

function identity(name: string) {
  return {
    tokenIdentifier: `${ISSUER}|${name}`,
    subject: name,
    issuer: ISSUER,
    name,
    email: `${name}@example.test`,
    orgId: ORG,
    orgSlug: ORG,
  };
}

async function seed(
  ctx: MutationCtx,
  role: "viewer" | "contributor" | "admin" = "contributor",
) {
  const userId = await ctx.db.insert("users", {
    tokenIdentifier: `${ISSUER}|${role}`,
    name: role,
    email: `${role}@example.test`,
    profileComplete: true,
  });
  await ctx.db.insert("memberships", {
    tokenIdentifier: `${ISSUER}|${role}`,
    userId,
    clerkOrgId: ORG,
    role,
    createdAt: Date.now(),
  });
  const functionId = await ctx.db.insert("functions", {
    name: "Operations",
    sortOrder: 1,
    clerkOrgId: ORG,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Service",
    sortOrder: 1,
    clerkOrgId: ORG,
  });
  const processId = await ctx.db.insert("processes", {
    departmentId,
    name: "Request handling",
    sortOrder: 1,
    // The production shape: a legacy Markdown summary and no V2 artifact.
    rollingSummary: "## Existing overview\n\nGenerated before the test calls.",
    summaryUpdatedAt: 1_780_000_000_000,
    clerkOrgId: ORG,
  });
  return { functionId, departmentId, processId };
}

async function scheduledCount(t: ReturnType<typeof convexTest>) {
  return await t.run(
    async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).length,
  );
}

describe("summary generation is a human action", () => {
  beforeEach(() => {
    process.env.SUMMARY_V2 = "true";
  });
  afterEach(() => {
    if (originalSummaryV2 === undefined) delete process.env.SUMMARY_V2;
    else process.env.SUMMARY_V2 = originalSummaryV2;
  });

  test("new evidence marks the process stale and schedules nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx));

    await t.mutation(internal.summaryEvidence.markProcessSummaryStale, {
      processId: ids.processId,
      clerkOrgId: ORG,
    });

    const process = await t.run(async (ctx) => ctx.db.get(ids.processId));
    expect(process?.summaryStale).toBe(true);
    expect(process?.summaryEvidenceRevision).toBe(1);
    // The expensive fields stay untouched: nothing is in flight, so no
    // extraction, no reduce, and no scheduled action.
    expect(process?.summaryEvidenceRefreshGenerationId).toBeUndefined();
    expect(process?.summaryEvidenceRefreshScheduledAt).toBeUndefined();
    expect(process?.rollingSummary).toContain("Existing overview");
    expect(await scheduledCount(t)).toBe(0);
  });

  test("repeated test recordings cost nothing beyond the revision", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx));

    for (let index = 0; index < 5; index += 1) {
      await t.mutation(internal.summaryEvidence.markProcessSummaryStale, {
        processId: ids.processId,
        clerkOrgId: ORG,
      });
    }

    const process = await t.run(async (ctx) => ctx.db.get(ids.processId));
    expect(process?.summaryEvidenceRevision).toBe(5);
    expect(await scheduledCount(t)).toBe(0);
  });

  test("a stale legacy-only process says so and keeps its previous content", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx));
    await t.mutation(internal.summaryEvidence.markProcessSummaryStale, {
      processId: ids.processId,
      clerkOrgId: ORG,
    });

    const overview = await t
      .withIdentity(identity("contributor"))
      .query(api.summaries.getOverview, {
        entity: { kind: "process", processId: ids.processId },
      });

    // Before the stale flag existed this read as "current", because a row with
    // no V2 artifact had no revision pair to compare.
    expect(overview.state).toBe("stale");
    expect(overview.content.markdown).toContain("Existing overview");
    expect(overview.progress).toBeNull();
  });

  test("cross-tenant marking is refused", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx));

    await t.mutation(internal.summaryEvidence.markProcessSummaryStale, {
      processId: ids.processId,
      clerkOrgId: "org_someone_else",
    });

    const process = await t.run(async (ctx) => ctx.db.get(ids.processId));
    expect(process?.summaryStale).toBeUndefined();
    expect(process?.summaryEvidenceRevision).toBeUndefined();
  });

  test("an explicit rebuild is the only thing that schedules generation", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx));
    await t.mutation(internal.summaryEvidence.markProcessSummaryStale, {
      processId: ids.processId,
      clerkOrgId: ORG,
    });
    expect(await scheduledCount(t)).toBe(0);

    const result = await t
      .withIdentity(identity("contributor"))
      .mutation(api.summaries.forceRefresh, {
        entity: { kind: "process", processId: ids.processId },
      });

    expect(result).toEqual({ status: "scheduled", scheduled: true });
    const process = await t.run(async (ctx) => ctx.db.get(ids.processId));
    expect(process?.summaryEvidenceRefreshGenerationId).toBeTruthy();
    expect(await scheduledCount(t)).toBeGreaterThan(0);
  });

  test("viewing a stale overview never schedules generation", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx, "viewer"));
    await t.mutation(internal.summaryEvidence.markProcessSummaryStale, {
      processId: ids.processId,
      clerkOrgId: ORG,
    });
    const viewer = t.withIdentity(identity("viewer"));

    for (let index = 0; index < 3; index += 1) {
      const overview = await viewer.query(api.summaries.getOverview, {
        entity: { kind: "process", processId: ids.processId },
      });
      expect(overview.state).toBe("stale");
    }

    expect(await scheduledCount(t)).toBe(0);
    const process = await t.run(async (ctx) => ctx.db.get(ids.processId));
    expect(process?.summaryEvidenceRevision).toBe(1);
  });
});
