/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import {
  SUMMARY_V2_PROMPT_VERSIONS,
  type DepartmentOverviewArtifactV2,
  type ProcessOverviewArtifactV2,
} from "./summaryV2";

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

/**
 * A rollup left incomplete by a child with no overview of its own — the shape a
 * department lands on when one of its processes has never been recorded.
 */
function departmentArtifact(): DepartmentOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: "Service",
    executiveBrief: "A rollup over the processes that had overviews to read.",
    crossProcessDependencies: [],
    sharedPatterns: [],
    variationsAndTensions: [],
    gaps: [],
    notable: [],
    coverage: {
      includedSources: 1,
      totalEligibleSources: 2,
      complete: false,
    },
    provenance: {
      sourceSnapshotHash: "one-child-unbuilt",
      generatedAt: 1_780_000_000_000,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.departmentOverview,
      provider: "fabric-foundry",
      model: "test-model",
    },
  };
}

/** A complete artifact: every eligible source read, nothing left to add. */
function processArtifact(): ProcessOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: "Request handling",
    executiveBrief: "A bounded process overview built from current evidence.",
    scope: [],
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
    coverage: {
      includedSources: 2,
      totalEligibleSources: 2,
      uniqueContributors: 2,
      complete: true,
    },
    provenance: {
      sourceSnapshotHash: "settled-source",
      generatedAt: 1_780_000_000_000,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
      provider: "fabric-foundry",
      model: "test-model",
    },
  };
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

  test("an up-to-date overview refuses to rebuild itself", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx));
    // The shape left behind by a successful run: a structured artifact built
    // from the current evidence revision, with nothing recorded since.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.processId, {
        summaryEvidenceRevision: 3,
        summaryV2SourceRevision: 3,
        summaryStale: false,
        summaryV2: processArtifact(),
      });
    });
    const contributor = t.withIdentity(identity("contributor"));
    const entity = { kind: "process" as const, processId: ids.processId };

    const overview = await contributor.query(api.summaries.getOverview, {
      entity,
    });
    expect(overview.state).toBe("current");
    expect(overview.refreshAvailable).toBe(false);

    // Pressing it anyway — a stale tab, a scripted client — still spends
    // nothing. Repeated presses were the whole cost being guarded against.
    for (let index = 0; index < 3; index += 1) {
      expect(
        await contributor.mutation(api.summaries.forceRefresh, { entity }),
      ).toEqual({ status: "current", scheduled: false });
    }
    expect(await scheduledCount(t)).toBe(0);
    const process = await t.run(async (ctx) => ctx.db.get(ids.processId));
    // No generation id, and above all no revision bump: a refused rebuild must
    // not be the thing that makes the overview look stale.
    expect(process?.summaryEvidenceRefreshGenerationId).toBeUndefined();
    expect(process?.summaryEvidenceRevision).toBe(3);
  });

  test("a process with no conversation is undocumented, not partial", async () => {
    const t = convexTest(schema, modules);
    const contributor = t.withIdentity(identity("contributor"));
    const ids = await t.run(async (ctx) => {
      const seeded = await seed(ctx);
      const emptyProcessId = await ctx.db.insert("processes", {
        departmentId: seeded.departmentId,
        name: "Newly created, never recorded",
        sortOrder: 2,
        clerkOrgId: ORG,
      });
      return { ...seeded, emptyProcessId };
    });

    const overview = await contributor.query(api.summaries.getOverview, {
      entity: { kind: "process", processId: ids.emptyProcessId },
    });

    // Nothing has been written about it, so it is undocumented — never a
    // partial reading of evidence that does not exist.
    expect(overview.state).toBe("missing");
    expect(overview.content.format).toBe("none");
    // Building the first overview is still the point of the control.
    expect(overview.refreshAvailable).toBe(true);
  });

  test("that empty process cannot make its department a rebuild faucet", async () => {
    const t = convexTest(schema, modules);
    const contributor = t.withIdentity(identity("contributor"));
    const ids = await t.run(async (ctx) => {
      const seeded = await seed(ctx);
      await ctx.db.insert("processes", {
        departmentId: seeded.departmentId,
        name: "Newly created, never recorded",
        sortOrder: 2,
        clerkOrgId: ORG,
      });
      // The rollup a department lands on with one unbuilt child: every source
      // it could read is in, so `complete` is false and stays false until that
      // process is built — which would bump `summarySourceRevision` here.
      await ctx.db.patch(seeded.departmentId, {
        summarySourceRevision: 2,
        summaryV2SourceRevision: 2,
        summaryStale: false,
        summaryV2: departmentArtifact(),
      });
      return seeded;
    });
    const entity = { kind: "department" as const, departmentId: ids.departmentId };

    const overview = await contributor.query(api.summaries.getOverview, {
      entity,
    });
    expect(overview.state).toBe("partial");
    // Rebuilding the parent cannot reach the unbuilt child, so pressing it
    // would buy the same rollup at full cost, every time, forever.
    expect(overview.refreshAvailable).toBe(false);
    expect(
      await contributor.mutation(api.summaries.forceRefresh, { entity }),
    ).toEqual({ status: "current", scheduled: false });
    expect(await scheduledCount(t)).toBe(0);
  });

  test("building the missing child re-opens the department rebuild", async () => {
    const t = convexTest(schema, modules);
    const contributor = t.withIdentity(identity("contributor"));
    const ids = await t.run(async (ctx) => {
      const seeded = await seed(ctx);
      await ctx.db.patch(seeded.departmentId, {
        summarySourceRevision: 2,
        summaryV2SourceRevision: 2,
        summaryStale: false,
        summaryV2: departmentArtifact(),
      });
      return seeded;
    });
    const entity = { kind: "department" as const, departmentId: ids.departmentId };

    // What publishing a child overview does to its parent — the one route out
    // of a permanently partial rollup.
    await t.mutation(internal.summariesHelpers.markDepartmentSummaryStale, {
      departmentId: ids.departmentId,
    });

    const overview = await contributor.query(api.summaries.getOverview, {
      entity,
    });
    expect(overview.state).toBe("stale");
    expect(overview.refreshAvailable).toBe(true);
    expect(
      await contributor.mutation(api.summaries.forceRefresh, { entity }),
    ).toEqual({ status: "scheduled", scheduled: true });
  });

  test("evidence recorded after a build re-opens the rebuild", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx));
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.processId, {
        summaryEvidenceRevision: 3,
        summaryV2SourceRevision: 3,
        summaryStale: false,
        summaryV2: processArtifact(),
      });
    });
    const contributor = t.withIdentity(identity("contributor"));
    const entity = { kind: "process" as const, processId: ids.processId };

    await t.mutation(internal.summaryEvidence.markProcessSummaryStale, {
      processId: ids.processId,
      clerkOrgId: ORG,
    });

    const overview = await contributor.query(api.summaries.getOverview, {
      entity,
    });
    expect(overview.state).toBe("stale");
    // The gate re-opens; that a stale row then schedules is covered above.
    expect(overview.refreshAvailable).toBe(true);
  });

  test("a legacy row can still be migrated to the structured format", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => await seed(ctx));
    const contributor = t.withIdentity(identity("contributor"));
    const entity = { kind: "process" as const, processId: ids.processId };

    // Nothing has changed under it, so it reads as current — but it holds only
    // Markdown, and the rebuild is the only way it gains an artifact. Gating on
    // the state alone would stall the migration here.
    const overview = await contributor.query(api.summaries.getOverview, {
      entity,
    });
    expect(overview.state).toBe("current");
    expect(overview.content.format).toBe("legacy");
    expect(overview.refreshAvailable).toBe(true);
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
