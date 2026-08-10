/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import {
  parseSummaryV2Rollout,
  isSummaryV2EnabledForOrg,
  isSummaryV2EnabledAnywhere,
} from "./lib/summaryV2Feature";
import {
  SUMMARY_V2_PROMPT_VERSIONS,
  type ProcessOverviewArtifactV2,
} from "./summaryV2";

const modules = import.meta.glob("./**/*.ts");
const INTERNAL_ORG = "org_internal_pilot";
const EXTERNAL_ORG = "org_external_not_yet";
const ISSUER = "https://summary-rollout.test";
const originalSummaryV2 = process.env.SUMMARY_V2;

function identity(name: string, orgId: string) {
  return {
    tokenIdentifier: `${ISSUER}|${name}`,
    subject: name,
    issuer: ISSUER,
    name,
    email: `${name}@example.test`,
    orgId,
    orgSlug: orgId,
  };
}

function processArtifact(headline: string): ProcessOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline,
    executiveBrief: "A bounded process overview used for rollout gating.",
    scope: [],
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
    coverage: {
      includedSources: 1,
      totalEligibleSources: 1,
      uniqueContributors: 1,
      complete: true,
    },
    provenance: {
      sourceSnapshotHash: "rollout-snapshot",
      generatedAt: 1_780_000_000_000,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
      provider: "fabric-foundry",
      model: "test-model",
    },
  };
}

async function seedOrg(ctx: MutationCtx, orgId: string, member: string) {
  const userId = await ctx.db.insert("users", {
    tokenIdentifier: `${ISSUER}|${member}`,
    name: member,
    email: `${member}@example.test`,
    profileComplete: true,
  });
  await ctx.db.insert("memberships", {
    tokenIdentifier: `${ISSUER}|${member}`,
    userId,
    clerkOrgId: orgId,
    role: "viewer",
    createdAt: Date.now(),
  });
  const functionId = await ctx.db.insert("functions", {
    name: "Operations",
    sortOrder: 1,
    clerkOrgId: orgId,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Service",
    sortOrder: 1,
    clerkOrgId: orgId,
  });
  const processId = await ctx.db.insert("processes", {
    departmentId,
    name: "Request handling",
    sortOrder: 1,
    clerkOrgId: orgId,
    summaryV2: processArtifact(`Structured overview for ${orgId}`),
    rollingSummary: `# Legacy Markdown for ${orgId}`,
    summaryUpdatedAt: 1_779_000_000_000,
  });
  return { functionId, departmentId, processId };
}

describe("SUMMARY_V2 rollout parsing", () => {
  test("unset, empty, and false all mean off", () => {
    for (const raw of [undefined, "", "   ", "false", "FALSE"]) {
      expect(parseSummaryV2Rollout(raw)).toEqual({ mode: "off" });
    }
  });

  test("true means every tenant on the deployment", () => {
    expect(parseSummaryV2Rollout("true")).toEqual({ mode: "all" });
    expect(parseSummaryV2Rollout("  TRUE  ")).toEqual({ mode: "all" });
  });

  test("a comma-separated list is an organization allowlist", () => {
    const rollout = parseSummaryV2Rollout(" org_a , org_b ,, org_c ");
    expect(rollout.mode).toBe("allowlist");
    if (rollout.mode !== "allowlist") throw new Error("unreachable");
    expect([...rollout.orgIds].sort()).toEqual(["org_a", "org_b", "org_c"]);
  });

  test("a list that parses to nothing fails closed", () => {
    expect(parseSummaryV2Rollout(" , , ")).toEqual({ mode: "off" });
  });
});

describe("SUMMARY_V2 per-organization gating", () => {
  beforeEach(() => {
    process.env.SUMMARY_V2 = `${INTERNAL_ORG},org_second_pilot`;
  });

  afterEach(() => {
    if (originalSummaryV2 === undefined) delete process.env.SUMMARY_V2;
    else process.env.SUMMARY_V2 = originalSummaryV2;
  });

  test("only allowlisted organizations are enabled", () => {
    expect(isSummaryV2EnabledForOrg(INTERNAL_ORG)).toBe(true);
    expect(isSummaryV2EnabledForOrg("org_second_pilot")).toBe(true);
    expect(isSummaryV2EnabledForOrg(EXTERNAL_ORG)).toBe(false);
    expect(isSummaryV2EnabledAnywhere()).toBe(true);
  });

  test("a typo in the allowlist enables nobody by accident", () => {
    process.env.SUMMARY_V2 = "org_internl_pilot";
    expect(isSummaryV2EnabledForOrg(INTERNAL_ORG)).toBe(false);
  });

  test("full rollback disables every organization at once", () => {
    process.env.SUMMARY_V2 = "false";
    expect(isSummaryV2EnabledForOrg(INTERNAL_ORG)).toBe(false);
    expect(isSummaryV2EnabledForOrg(EXTERNAL_ORG)).toBe(false);
    expect(isSummaryV2EnabledAnywhere()).toBe(false);
  });

  test("an allowlisted tenant reads V2 while another tenant on the same deployment reads legacy", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => ({
      internal: await seedOrg(ctx, INTERNAL_ORG, "pilot-viewer"),
      external: await seedOrg(ctx, EXTERNAL_ORG, "other-viewer"),
    }));

    const pilot = await t
      .withIdentity(identity("pilot-viewer", INTERNAL_ORG))
      .query(api.summaries.getOverview, {
        entity: { kind: "process", processId: ids.internal.processId },
      });
    expect(pilot.content.format).toBe("v2");
    expect(pilot.coverage).not.toBeNull();

    const other = await t
      .withIdentity(identity("other-viewer", EXTERNAL_ORG))
      .query(api.summaries.getOverview, {
        entity: { kind: "process", processId: ids.external.processId },
      });
    // The artifact is still stored; the read gate simply does not serve it.
    expect(other.content.format).toBe("legacy");
    expect(other.content.markdown).toBe(`# Legacy Markdown for ${EXTERNAL_ORG}`);
    expect(other.coverage).toBeNull();
    await t.run(async (ctx) => {
      const stored = await ctx.db.get(ids.external.processId);
      expect(stored?.summaryV2).toBeDefined();
    });
  });

  test("a non-allowlisted tenant cannot start a V2 refresh", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) =>
      seedOrg(ctx, EXTERNAL_ORG, "other-viewer"),
    );
    const result = await t
      .withIdentity(identity("other-viewer", EXTERNAL_ORG))
      .mutation(api.summaries.ensureCurrent, {
        entity: { kind: "process", processId: ids.processId },
      });
    expect(result.status).toBe("disabled");
    expect(result.scheduled).toBe(false);
  });

  test("hierarchy list metadata is gated per tenant too", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedOrg(ctx, INTERNAL_ORG, "pilot-viewer");
      await seedOrg(ctx, EXTERNAL_ORG, "other-viewer");
    });

    const pilotTree = await t
      .withIdentity(identity("pilot-viewer", INTERNAL_ORG))
      .query(api.hierarchy.getTree, {});
    expect(
      pilotTree.functions[0].departments[0].processes[0].summaryOverview
        .format,
    ).toBe("v2");

    const otherTree = await t
      .withIdentity(identity("other-viewer", EXTERNAL_ORG))
      .query(api.hierarchy.getTree, {});
    expect(
      otherTree.functions[0].departments[0].processes[0].summaryOverview
        .format,
    ).toBe("legacy");
    expect(
      otherTree.functions[0].departments[0].processes[0].summaryOverview
        .coverage,
    ).toBeNull();
  });
});
