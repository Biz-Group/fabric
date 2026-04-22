/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ORG_A = "org_A_testorg";
const ORG_B = "org_B_testorg";
const ISSUER = "https://test.clerk";

type SeededIds = {
  userAId: string;
  userBId: string;
  fnA: string;
  deptA: string;
  procA: string;
  fnB: string;
  deptB: string;
  procB: string;
};

async function seedTwoOrgs(t: ReturnType<typeof convexTest>): Promise<SeededIds> {
  return await t.run(async (ctx) => {
    const userAId = await ctx.db.insert("users", {
      tokenIdentifier: `${ISSUER}|user_a`,
      name: "Alice",
      email: "alice@a.test",
      profileComplete: true,
    });
    const userBId = await ctx.db.insert("users", {
      tokenIdentifier: `${ISSUER}|user_b`,
      name: "Bob",
      email: "bob@b.test",
      profileComplete: true,
    });

    await ctx.db.insert("memberships", {
      tokenIdentifier: `${ISSUER}|user_a`,
      userId: userAId,
      clerkOrgId: ORG_A,
      role: "admin",
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      tokenIdentifier: `${ISSUER}|user_b`,
      userId: userBId,
      clerkOrgId: ORG_B,
      role: "admin",
      createdAt: Date.now(),
    });

    const fnA = await ctx.db.insert("functions", {
      name: "Sales-A",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });
    const deptA = await ctx.db.insert("departments", {
      functionId: fnA,
      name: "Inside-Sales-A",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });
    const procA = await ctx.db.insert("processes", {
      departmentId: deptA,
      name: "Lead-Qualification-A",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });

    const fnB = await ctx.db.insert("functions", {
      name: "Sales-B",
      sortOrder: 0,
      clerkOrgId: ORG_B,
    });
    const deptB = await ctx.db.insert("departments", {
      functionId: fnB,
      name: "Inside-Sales-B",
      sortOrder: 0,
      clerkOrgId: ORG_B,
    });
    const procB = await ctx.db.insert("processes", {
      departmentId: deptB,
      name: "Lead-Qualification-B",
      sortOrder: 0,
      clerkOrgId: ORG_B,
    });

    return {
      userAId,
      userBId,
      fnA,
      deptA,
      procA,
      fnB,
      deptB,
      procB,
    };
  });
}

function identityForOrgA() {
  return {
    tokenIdentifier: `${ISSUER}|user_a`,
    subject: "user_a",
    issuer: ISSUER,
    name: "Alice",
    email: "alice@a.test",
    orgId: ORG_A,
    orgSlug: "org-a",
  };
}

function identityForOrgB() {
  return {
    tokenIdentifier: `${ISSUER}|user_b`,
    subject: "user_b",
    issuer: ISSUER,
    name: "Bob",
    email: "bob@b.test",
    orgId: ORG_B,
    orgSlug: "org-b",
  };
}

describe("cross-tenant isolation", () => {
  test("functions.list only returns caller's org rows", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    const aResults = await t.withIdentity(identityForOrgA()).query(api.functions.list);
    expect(aResults).toHaveLength(1);
    expect(aResults[0].name).toBe("Sales-A");
    expect(aResults[0].clerkOrgId).toBe(ORG_A);

    const bResults = await t.withIdentity(identityForOrgB()).query(api.functions.list);
    expect(bResults).toHaveLength(1);
    expect(bResults[0].name).toBe("Sales-B");
  });

  // For list-by-parent queries, the contract is "treat cross-org access as empty"
  // rather than throwing — documented in [convex/departments.ts:14] etc. The
  // security property (no cross-tenant data leakage) still holds: the list is
  // empty and `withIndex` is pinned to `caller.orgId`.

  test("departments.listByFunction returns empty for cross-tenant parent", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);

    const result = await t
      .withIdentity(identityForOrgA())
      .query(api.departments.listByFunction, { functionId: ids.fnB });
    expect(result).toEqual([]);
  });

  test("processes.listByDepartment returns empty for cross-tenant parent", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);

    const result = await t
      .withIdentity(identityForOrgA())
      .query(api.processes.listByDepartment, { departmentId: ids.deptB });
    expect(result).toEqual([]);
  });

  test("conversations.listByProcess returns empty for cross-tenant parent", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);

    const result = await t
      .withIdentity(identityForOrgA())
      .query(api.conversations.listByProcess, { processId: ids.procB });
    expect(result).toEqual([]);
  });

  test("processes.create with cross-tenant departmentId throws", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);

    await expect(
      t.withIdentity(identityForOrgA()).mutation(api.processes.create, {
        departmentId: ids.deptB,
        name: "Malicious process",
      }),
    ).rejects.toThrow(/Not found/);
  });

  test("functions.create stamps caller's clerkOrgId", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    await t.withIdentity(identityForOrgA()).mutation(api.functions.create, {
      name: "NewFnA",
    });

    const rows = await t.withIdentity(identityForOrgA()).query(api.functions.list);
    const created = rows.find((r) => r.name === "NewFnA");
    expect(created).toBeDefined();
    expect(created!.clerkOrgId).toBe(ORG_A);
  });

  test("identity with orgId but no membership throws", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    // Alice exists and has a membership in ORG_A. Put her JWT into a DIFFERENT
    // org (ORG_B) where she has no memberships row → requireOrgMember throws.
    const strangerIdentity = {
      ...identityForOrgA(),
      orgId: ORG_B,
      orgSlug: "org-b",
    };

    await expect(
      t.withIdentity(strangerIdentity).query(api.functions.list),
    ).rejects.toThrow(/Not a member of this organization/);
  });

  test("setMembershipRole across orgs throws", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    // Find Bob's membership id (in ORG_B) and try to edit it as Alice (admin of ORG_A).
    const bobMembership = await t.run(async (ctx) => {
      return await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", ORG_B))
        .first();
    });
    expect(bobMembership).not.toBeNull();

    await expect(
      t.withIdentity(identityForOrgA()).mutation(api.users.setMembershipRole, {
        membershipId: bobMembership!._id,
        role: "viewer",
      }),
    ).rejects.toThrow(/Membership not found/);
  });
});
