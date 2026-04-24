/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ORG_A = "org_A_testorg";
const ORG_B = "org_B_testorg";
const ISSUER = "https://test.clerk";

type SeededIds = {
  userAId: Id<"users">;
  userBId: Id<"users">;
  fnA: Id<"functions">;
  deptA: Id<"departments">;
  procA: Id<"processes">;
  fnB: Id<"functions">;
  deptB: Id<"departments">;
  procB: Id<"processes">;
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

// ---------------------------------------------------------------------------
// Invitations — every action must route through `requireOrgAdmin` (Fabric side)
// before calling Clerk, and must build the Clerk URL using the JWT-derived
// `orgId`, never a client-supplied value. fetch is stubbed so these tests never
// hit the real Clerk API.
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit | undefined };

function stubClerkFetch(responses: Array<unknown>) {
  const calls: FetchCall[] = [];
  let callIndex = 0;
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      const body = responses[callIndex] ?? {};
      callIndex += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

describe("user provisioning sync", () => {
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_abc";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("syncCurrentUserFromClerk upserts user and membership from trusted Clerk profile", async () => {
    const t = convexTest(schema, modules);
    const { calls } = stubClerkFetch([
      {
        id: "user_new",
        first_name: "New",
        last_name: "Member",
        primary_email_address_id: "email_1",
        email_addresses: [
          {
            id: "email_1",
            email_address: "new.member@a.test",
          },
        ],
      },
    ]);

    const identity = {
      tokenIdentifier: `${ISSUER}|user_new`,
      subject: "user_new",
      issuer: ISSUER,
      name: "JWT Name",
      orgId: ORG_A,
      orgSlug: "org-a",
    };

    const userId = await t
      .withIdentity(identity)
      .action(api.users.syncCurrentUserFromClerk, {});

    const stored = await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
          q
            .eq("tokenIdentifier", identity.tokenIdentifier)
            .eq("clerkOrgId", ORG_A),
        )
        .unique();
      return { user, membership };
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/users/user_new");
    expect(stored.user?.email).toBe("new.member@a.test");
    expect(stored.user?.name).toBe("New Member");
    expect(stored.membership?.role).toBe("contributor");
    expect(stored.membership?.clerkOrgId).toBe(ORG_A);
  });
});

describe("invitations — admin gating and org scoping", () => {
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_abc";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("invite: non-admin caller throws before touching Clerk", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    // Demote Alice to contributor.
    await t.run(async (ctx) => {
      const aliceMembership = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", ORG_A))
        .first();
      if (aliceMembership) {
        await ctx.db.patch(aliceMembership._id, { role: "contributor" });
      }
    });

    const { calls } = stubClerkFetch([]);

    await expect(
      t
        .withIdentity(identityForOrgA())
        .action(api.invitations.invite, { email: "new@a.test" }),
    ).rejects.toThrow(/Insufficient permissions/);

    // Belt-and-braces: fetch must not have been called at all.
    expect(calls).toHaveLength(0);
  });

  test("invite: admin → Clerk URL uses JWT-derived orgId", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    const { calls } = stubClerkFetch([
      {
        id: "inv_1",
        email_address: "new@a.test",
        role: "org:member",
        status: "pending",
        organization_id: ORG_A,
        created_at: Date.now(),
      },
    ]);

    const result = await t
      .withIdentity(identityForOrgA())
      .action(api.invitations.invite, { email: "new@a.test" });

    expect(result.id).toBe("inv_1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/organizations/${ORG_A}/invitations`);
    // The other org's id must never appear in the URL or body.
    expect(calls[0].url).not.toContain(ORG_B);
    expect(calls[0].init?.body).not.toContain(ORG_B);
  });

  test("invite: rejects Clerk responses whose organization_id doesn't match", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    // Stub Clerk returning an invitation allegedly for ORG_B even though we
    // hit ORG_A's URL — the action must refuse to trust this.
    stubClerkFetch([
      {
        id: "inv_bad",
        email_address: "x@x.test",
        role: "org:member",
        status: "pending",
        organization_id: ORG_B,
        created_at: Date.now(),
      },
    ]);

    await expect(
      t
        .withIdentity(identityForOrgA())
        .action(api.invitations.invite, { email: "x@x.test" }),
    ).rejects.toThrow(/Invitation org mismatch/);
  });

  test("list: admin → Clerk URL scoped to caller's org; filters out mismatched rows", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    // Clerk response contains rows from ORG_A and a poisoned row for ORG_B;
    // the action must strip the cross-tenant row.
    const { calls } = stubClerkFetch([
      {
        data: [
          {
            id: "inv_good",
            email_address: "good@a.test",
            role: "org:member",
            status: "pending",
            organization_id: ORG_A,
            created_at: 1,
          },
          {
            id: "inv_leak",
            email_address: "leak@b.test",
            role: "org:member",
            status: "pending",
            organization_id: ORG_B,
            created_at: 2,
          },
        ],
      },
    ]);

    const rows = await t
      .withIdentity(identityForOrgA())
      .action(api.invitations.list, {});

    expect(calls[0].url).toContain(`/organizations/${ORG_A}/invitations`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("inv_good");
  });

  test("list: non-admin caller throws", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", ORG_A))
        .first();
      if (m) await ctx.db.patch(m._id, { role: "viewer" });
    });

    const { calls } = stubClerkFetch([]);

    await expect(
      t
        .withIdentity(identityForOrgA())
        .action(api.invitations.list, {}),
    ).rejects.toThrow(/Insufficient permissions/);
    expect(calls).toHaveLength(0);
  });

  test("revoke: URL uses JWT orgId, not any client-supplied id", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    const { calls } = stubClerkFetch([
      {
        id: "inv_1",
        email_address: "x@a.test",
        role: "org:member",
        status: "revoked",
        organization_id: ORG_A,
        created_at: 1,
      },
    ]);

    await t
      .withIdentity(identityForOrgA())
      .action(api.invitations.revoke, { invitationId: "inv_1" });

    expect(calls[0].url).toContain(
      `/organizations/${ORG_A}/invitations/inv_1/revoke`,
    );
    expect(calls[0].url).not.toContain(ORG_B);
  });

  test("revoke: rejects cross-tenant Clerk response", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    stubClerkFetch([
      {
        id: "inv_1",
        email_address: "x@a.test",
        role: "org:member",
        status: "revoked",
        organization_id: ORG_B,
        created_at: 1,
      },
    ]);

    await expect(
      t
        .withIdentity(identityForOrgA())
        .action(api.invitations.revoke, { invitationId: "inv_1" }),
    ).rejects.toThrow(/different organization/);
  });
});

describe("removeMemberFromOrg — admin gating + Clerk coordination", () => {
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_abc";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("cross-tenant membershipId → Not found (existence does not leak)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    const bobMembership = await t.run(async (ctx) => {
      return await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", ORG_B))
        .first();
    });
    expect(bobMembership).not.toBeNull();

    const { calls } = stubClerkFetch([]);

    await expect(
      t.withIdentity(identityForOrgA()).action(api.users.removeMemberFromOrg, {
        membershipId: bobMembership!._id,
      }),
    ).rejects.toThrow(/Membership not found/);

    // Must not have reached Clerk, and must not have deleted anything.
    expect(calls).toHaveLength(0);
    const stillThere = await t.run(async (ctx) => ctx.db.get(bobMembership!._id));
    expect(stillThere).not.toBeNull();
  });

  test("non-admin caller → Insufficient permissions, no Clerk call", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", ORG_A))
        .first();
      if (m) await ctx.db.patch(m._id, { role: "viewer" });
    });

    // Add a second member in ORG_A so there's something to target.
    const targetId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        tokenIdentifier: `${ISSUER}|user_c`,
        name: "Carol",
        email: "carol@a.test",
        profileComplete: true,
      });
      return await ctx.db.insert("memberships", {
        tokenIdentifier: `${ISSUER}|user_c`,
        userId,
        clerkOrgId: ORG_A,
        role: "contributor",
        createdAt: Date.now(),
      });
    });

    const { calls } = stubClerkFetch([]);

    await expect(
      t.withIdentity(identityForOrgA()).action(api.users.removeMemberFromOrg, {
        membershipId: targetId,
      }),
    ).rejects.toThrow(/Insufficient permissions/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conversations admin surface — list / get / count / delete / retry must all
// scope to the caller's JWT-derived orgId and reject cross-tenant access.
// ---------------------------------------------------------------------------

async function seedConversation(
  t: ReturnType<typeof convexTest>,
  processId: Id<"processes">,
  clerkOrgId: string,
  overrides: Partial<{
    contributorName: string;
    elevenlabsConversationId: string;
    status: "processing" | "done" | "failed";
    summary: string;
    durationSeconds: number;
  }> = {},
): Promise<Id<"conversations">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("conversations", {
      processId,
      clerkOrgId,
      elevenlabsConversationId:
        overrides.elevenlabsConversationId ?? `el_${Math.random()}`,
      contributorName: overrides.contributorName ?? "Alice",
      status: overrides.status ?? "done",
      summary: overrides.summary,
      durationSeconds: overrides.durationSeconds,
    });
  });
}

describe("conversations admin — cross-tenant scoping", () => {
  test("listAllForOrg returns only caller's org rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    await seedConversation(t, ids.procA, ORG_A, { contributorName: "A-conv" });
    await seedConversation(t, ids.procB, ORG_B, { contributorName: "B-conv" });

    const result = await t
      .withIdentity(identityForOrgA())
      .query(api.conversations.listAllForOrg, {
        paginationOpts: { numItems: 50, cursor: null },
      });

    expect(result.page).toHaveLength(1);
    expect(result.page[0].contributorName).toBe("A-conv");
    expect(result.page[0].clerkOrgId).toBe(ORG_A);
    // Process-name join must only surface Org A's process name.
    expect(result.page[0].processName).toBe("Lead-Qualification-A");
  });

  test("listAllForOrg with cross-tenant processId returns empty page", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    await seedConversation(t, ids.procB, ORG_B);

    const result = await t
      .withIdentity(identityForOrgA())
      .query(api.conversations.listAllForOrg, {
        paginationOpts: { numItems: 50, cursor: null },
        processId: ids.procB,
      });

    expect(result.page).toEqual([]);
    expect(result.isDone).toBe(true);
  });

  test("listAllForOrg requires admin role", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", ORG_A))
        .first();
      if (m) await ctx.db.patch(m._id, { role: "contributor" });
    });

    await expect(
      t
        .withIdentity(identityForOrgA())
        .query(api.conversations.listAllForOrg, {
          paginationOpts: { numItems: 50, cursor: null },
        }),
    ).rejects.toThrow(/Insufficient permissions/);
  });

  test("getForAdmin throws Not found for cross-tenant conversation", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const bConvId = await seedConversation(t, ids.procB, ORG_B);

    await expect(
      t
        .withIdentity(identityForOrgA())
        .query(api.conversations.getForAdmin, { conversationId: bConvId }),
    ).rejects.toThrow(/Not found/);
  });

  test("countForOrg counts only caller's org", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    await seedConversation(t, ids.procA, ORG_A, { status: "done" });
    await seedConversation(t, ids.procA, ORG_A, { status: "failed" });
    await seedConversation(t, ids.procB, ORG_B, { status: "done" });
    await seedConversation(t, ids.procB, ORG_B, { status: "failed" });

    const total = await t
      .withIdentity(identityForOrgA())
      .query(api.conversations.countForOrg, {});
    expect(total).toBe(2);

    const failed = await t
      .withIdentity(identityForOrgA())
      .query(api.conversations.countForOrg, { status: "failed" });
    expect(failed).toBe(1);
  });

  test("deleteForAdmin throws Not found for cross-tenant conversation", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const bConvId = await seedConversation(t, ids.procB, ORG_B);

    await expect(
      t
        .withIdentity(identityForOrgA())
        .mutation(api.conversations.deleteForAdmin, {
          conversationId: bConvId,
        }),
    ).rejects.toThrow(/Not found/);

    // Row must still exist.
    const stillThere = await t.run(async (ctx) => ctx.db.get(bConvId));
    expect(stillThere).not.toBeNull();
  });

  test("deleteForAdmin removes own-org row and schedules summary rebuild", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const convId = await seedConversation(t, ids.procA, ORG_A);

    await t
      .withIdentity(identityForOrgA())
      .mutation(api.conversations.deleteForAdmin, {
        conversationId: convId,
      });

    const gone = await t.run(async (ctx) => ctx.db.get(convId));
    expect(gone).toBeNull();
  });

  test("deleteForAdmin requires admin role", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const convId = await seedConversation(t, ids.procA, ORG_A);
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", ORG_A))
        .first();
      if (m) await ctx.db.patch(m._id, { role: "contributor" });
    });

    await expect(
      t
        .withIdentity(identityForOrgA())
        .mutation(api.conversations.deleteForAdmin, {
          conversationId: convId,
        }),
    ).rejects.toThrow(/Insufficient permissions/);
  });

  test("retryFetch rejects cross-tenant conversation id (Not found)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const bFailed = await seedConversation(t, ids.procB, ORG_B, {
      status: "failed",
    });

    await expect(
      t
        .withIdentity(identityForOrgA())
        .action(api.conversations.retryFetch, { conversationId: bFailed }),
    ).rejects.toThrow(/Not found/);
  });

  test("retryFetch rejects non-failed conversations", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const doneConv = await seedConversation(t, ids.procA, ORG_A, {
      status: "done",
    });

    await expect(
      t
        .withIdentity(identityForOrgA())
        .action(api.conversations.retryFetch, { conversationId: doneConv }),
    ).rejects.toThrow(/Only failed conversations/);
  });

  test("retryFetch requires admin role", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const failed = await seedConversation(t, ids.procA, ORG_A, {
      status: "failed",
    });
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", ORG_A))
        .first();
      if (m) await ctx.db.patch(m._id, { role: "contributor" });
    });

    await expect(
      t
        .withIdentity(identityForOrgA())
        .action(api.conversations.retryFetch, { conversationId: failed }),
    ).rejects.toThrow(/Insufficient permissions/);
  });
});
