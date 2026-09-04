/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { SUMMARY_V2_PROMPT_VERSIONS } from "./summaryV2";

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

  test("processes.listAll only returns caller's org rows (enriched)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    const aResults = await t
      .withIdentity(identityForOrgA())
      .query(api.processes.listAll);
    expect(aResults).toHaveLength(1);
    expect(aResults[0].name).toBe("Lead-Qualification-A");
    expect(aResults[0].clerkOrgId).toBe(ORG_A);
    expect(aResults[0].departmentName).toBe("Inside-Sales-A");
    expect(aResults[0].functionName).toBe("Sales-A");

    const bResults = await t
      .withIdentity(identityForOrgB())
      .query(api.processes.listAll);
    expect(bResults).toHaveLength(1);
    expect(bResults[0].name).toBe("Lead-Qualification-B");
  });

  test("conversations.processIdsNeedingAttention is org-scoped", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);

    // One needs_speaker_labels conversation in each org.
    await t.run(async (ctx) => {
      await ctx.db.insert("conversations", {
        processId: ids.procA,
        contributorName: "Alice",
        status: "needs_speaker_labels",
        clerkOrgId: ORG_A,
      });
      await ctx.db.insert("conversations", {
        processId: ids.procB,
        contributorName: "Bob",
        status: "needs_speaker_labels",
        clerkOrgId: ORG_B,
      });
      // A done conversation in org A must NOT be flagged.
      await ctx.db.insert("conversations", {
        processId: ids.procA,
        contributorName: "Alice",
        status: "done",
        clerkOrgId: ORG_A,
      });
    });

    const aResult = await t
      .withIdentity(identityForOrgA())
      .query(api.conversations.processIdsNeedingAttention);
    expect(aResult).toEqual([ids.procA]);

    const bResult = await t
      .withIdentity(identityForOrgB())
      .query(api.conversations.processIdsNeedingAttention);
    expect(bResult).toEqual([ids.procB]);
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
      t.withIdentity(identityForOrgA()).action(api.processes.create, {
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

  test("function rename does not rewrite global profiles in either tenant", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.userAId, { function: "Sales-A" });
      await ctx.db.patch(ids.userBId, { function: "Sales-A" });
    });

    await t.withIdentity(identityForOrgA()).mutation(api.functions.update, {
      functionId: ids.fnA,
      name: "Revenue-A",
    });

    const result = await t.run(async (ctx) => ({
      renamedFunction: await ctx.db.get(ids.fnA),
      userA: await ctx.db.get(ids.userAId),
      userB: await ctx.db.get(ids.userBId),
    }));
    expect(result.renamedFunction?.name).toBe("Revenue-A");
    expect(result.userA?.function).toBe("Sales-A");
    expect(result.userB?.function).toBe("Sales-A");
  });

  test("department rename does not rewrite global profiles in either tenant", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.userAId, { department: "Inside-Sales-A" });
      await ctx.db.patch(ids.userBId, { department: "Inside-Sales-A" });
    });

    await t.withIdentity(identityForOrgA()).action(api.departments.update, {
      departmentId: ids.deptA,
      name: "Field-Sales-A",
    });

    const result = await t.run(async (ctx) => ({
      renamedDepartment: await ctx.db.get(ids.deptA),
      userA: await ctx.db.get(ids.userAId),
      userB: await ctx.db.get(ids.userBId),
    }));
    expect(result.renamedDepartment?.name).toBe("Field-Sales-A");
    expect(result.userA?.department).toBe("Inside-Sales-A");
    expect(result.userB?.department).toBe("Inside-Sales-A");
  });

  test("audio URL is revoked immediately when its signed membership is removed", async () => {
    process.env.AUDIO_SIGNING_SECRET =
      "test-audio-signing-secret-with-sufficient-entropy";
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const conversationId = await t.run(async (ctx) => {
      const audioStorageId = await ctx.storage.store(
        new Blob(["private audio"], { type: "audio/webm" }),
      );
      return await ctx.db.insert("conversations", {
        processId: ids.procA,
        clerkOrgId: ORG_A,
        contributorName: "Alice",
        inputMode: "voiceRecord",
        audioStorageId,
        audioMimeType: "audio/webm",
        status: "done",
      });
    });

    const mintedAt = Date.now();
    const token = await t
      .withIdentity(identityForOrgA())
      .action(api.postCall.getAudioPlaybackToken, { conversationId });
    expect(token).not.toBeNull();
    expect(token!.clerkOrgId).toBe(ORG_A);
    expect(token!.exp).toBeGreaterThan(mintedAt);
    expect(token!.exp).toBeLessThanOrEqual(mintedAt + 5 * 60 * 1000 + 1_000);

    const params = new URLSearchParams({
      exp: String(token!.exp),
      mid: token!.membershipId,
      sig: token!.sig,
    });
    const audioPath = `/audio/${ORG_A}/${conversationId}?${params.toString()}`;
    const beforeRemoval = await t.fetch(audioPath);
    expect(beforeRemoval.status).toBe(200);
    expect(beforeRemoval.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(beforeRemoval.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await beforeRemoval.text()).toBe("private audio");

    const expiredParams = new URLSearchParams(params);
    expiredParams.set("exp", String(Date.now() - 1));
    const expired = await t.fetch(
      `/audio/${ORG_A}/${conversationId}?${expiredParams.toString()}`,
    );
    expect(expired.status).toBe(404);

    await t.run(async (ctx) => {
      await ctx.db.delete(token!.membershipId);
    });

    const afterRemoval = await t.fetch(audioPath);
    expect(afterRemoval.status).toBe(404);
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

function stubClerkFetchStatus(status: number, body: unknown = {}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function stubClerkFetchSequence(
  responses: Array<{ status: number; body?: unknown }>,
) {
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
      const response = responses[callIndex] ?? { status: 200, body: {} };
      callIndex += 1;
      return new Response(JSON.stringify(response.body ?? {}), {
        status: response.status,
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
    process.env.CLERK_JWT_ISSUER_DOMAIN = ISSUER;
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
    expect(stored.membership?.source).toBe("selfSignup");
    expect(stored.membership?.emailLower).toBe("new.member@a.test");
    expect(stored.membership?.searchText).toContain("new member");
    expect(stored.membership?.clerkOrgId).toBe(ORG_A);
  });

  test("pending invite intent controls accepted member role", async () => {
    const t = convexTest(schema, modules);
    stubClerkFetch([
      {
        id: "user_invited",
        first_name: "Invited",
        last_name: "Admin",
        primary_email_address_id: "email_1",
        email_addresses: [
          {
            id: "email_1",
            email_address: "invited.admin@a.test",
          },
        ],
      },
    ]);

    await t.run(async (ctx) => {
      await ctx.db.insert("membershipIntents", {
        clerkOrgId: ORG_A,
        email: "invited.admin@a.test",
        emailLower: "invited.admin@a.test",
        requestedRole: "admin",
        source: "adminInvite",
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const identity = {
      tokenIdentifier: `${ISSUER}|user_invited`,
      subject: "user_invited",
      issuer: ISSUER,
      name: "JWT Name",
      orgId: ORG_A,
      orgSlug: "org-a",
    };

    const userId = await t
      .withIdentity(identity)
      .action(api.users.syncCurrentUserFromClerk, {});

    const stored = await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
          q
            .eq("tokenIdentifier", identity.tokenIdentifier)
            .eq("clerkOrgId", ORG_A),
        )
        .unique();
      const intent = await ctx.db
        .query("membershipIntents")
        .withIndex("by_clerkOrgId_and_emailLower", (q) =>
          q.eq("clerkOrgId", ORG_A).eq("emailLower", "invited.admin@a.test"),
        )
        .unique();
      return { membership, intent };
    });

    expect(stored.membership?.userId).toBe(userId);
    expect(stored.membership?.role).toBe("admin");
    expect(stored.membership?.source).toBe("adminInvite");
    expect(stored.intent?.status).toBe("accepted");
    expect(stored.intent?.acceptedUserId).toBe(userId);
    expect(stored.intent?.acceptedTokenIdentifier).toBe(identity.tokenIdentifier);
  });

  test("super admins auto-provision as admins in each active org", async () => {
    const t = convexTest(schema, modules);
    const tokenIdentifier = `${ISSUER}|user_super`;
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        tokenIdentifier,
        clerkUserId: "user_super",
        name: "Super Admin",
        email: "super@fabric.test",
        emailLower: "super@fabric.test",
        profileComplete: true,
        platformRole: "superAdmin",
      });
    });

    const identity = {
      tokenIdentifier,
      subject: "user_super",
      issuer: ISSUER,
      name: "Super Admin",
      email: "super@fabric.test",
      orgSlug: "org-a",
    };

    await t
      .withIdentity({ ...identity, orgId: ORG_A })
      .mutation(api.users.store, {});
    await t
      .withIdentity({ ...identity, orgId: ORG_B, orgSlug: "org-b" })
      .mutation(api.users.store, {});

    const memberships = await t.run(async (ctx) => {
      return await ctx.db.query("memberships").collect();
    });

    expect(memberships).toHaveLength(2);
    expect(
      memberships.map((m) => ({
        clerkOrgId: m.clerkOrgId,
        role: m.role,
        source: m.source,
      })),
    ).toEqual(
      expect.arrayContaining([
        { clerkOrgId: ORG_A, role: "admin", source: "superAdminFanOut" },
        { clerkOrgId: ORG_B, role: "admin", source: "superAdminFanOut" },
      ]),
    );
  });
});

describe("Clerk webhook processing", () => {
  beforeEach(() => {
    process.env.CLERK_JWT_ISSUER_DOMAIN = ISSUER;
  });

  test("organization membership webhook creates default contributor membership and is idempotent", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.users.handleClerkWebhook, {
      eventId: "evt_membership_created",
      eventType: "organizationMembership.created",
      data: {
        organization: { id: ORG_A },
        public_user_data: {
          user_id: "user_webhook",
          first_name: "Webhook",
          last_name: "Member",
          identifier: "webhook.member@a.test",
        },
        role: "org:admin",
      },
    });
    const second = await t.mutation(internal.users.handleClerkWebhook, {
      eventId: "evt_membership_created",
      eventType: "organizationMembership.created",
      data: {
        organization: { id: ORG_A },
        public_user_data: {
          user_id: "user_webhook",
          first_name: "Changed",
          last_name: "Name",
          identifier: "changed@a.test",
        },
        role: "org:admin",
      },
    });

    const stored = await t.run(async (ctx) => {
      const events = await ctx.db.query("processedWebhookEvents").collect();
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
          q
            .eq("tokenIdentifier", `${ISSUER}|user_webhook`)
            .eq("clerkOrgId", ORG_A),
        )
        .unique();
      return { events, membership };
    });

    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect(stored.events).toHaveLength(1);
    expect(stored.membership?.role).toBe("contributor");
    expect(stored.membership?.source).toBe("webhook");
    expect(stored.membership?.emailLower).toBe("webhook.member@a.test");
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
      { data: [], total_count: 0 },
      { data: [], total_count: 0 },
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
      .action(api.invitations.invite, {
        email: "new@a.test",
        role: "viewer",
      });

    expect(result.outcome).toBe("invited");
    if (result.outcome !== "invited") {
      throw new Error(`Expected invited outcome, got ${result.outcome}`);
    }
    expect(result.id).toBe("inv_1");
    expect(result.role).toBe("viewer");
    expect(calls).toHaveLength(3);
    const createCall = calls.find((call) => call.init?.method === "POST");
    expect(createCall?.url).toContain(`/organizations/${ORG_A}/invitations`);
    expect(createCall?.init?.body).toContain('"role":"org:member"');
    expect(calls[0].url).toContain("email_address=new%40a.test");
    // The other org's id must never appear in the URL or body.
    expect(calls.every((call) => !call.url.includes(ORG_B))).toBe(true);
    expect(createCall?.init?.body).not.toContain(ORG_B);

    const intent = await t.run(async (ctx) => {
      return await ctx.db
        .query("membershipIntents")
        .withIndex("by_clerkInvitationId", (q) => q.eq("clerkInvitationId", "inv_1"))
        .unique();
    });
    expect(intent?.requestedRole).toBe("viewer");
    expect(intent?.source).toBe("adminInvite");
    expect(intent?.status).toBe("pending");
  });

  test("invite: finds an existing member through a legacy membership without emailLower", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_tokenIdentifier", (q) =>
          q.eq("tokenIdentifier", `${ISSUER}|user_a`),
        )
        .unique();
      if (!user) throw new Error("Missing seeded user");
      await ctx.db.patch(user._id, { emailLower: "alice@a.test" });
    });
    const { calls } = stubClerkFetch([]);

    const result = await t
      .withIdentity(identityForOrgA())
      .action(api.invitations.invite, { email: "ALICE@A.TEST" });

    expect(result).toEqual({
      outcome: "alreadyMember",
      email: "ALICE@A.TEST",
    });
    expect(calls).toHaveLength(0);
  });

  test("invite: a sequential duplicate is rejected before another Clerk request", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    const { calls } = stubClerkFetch([
      { data: [], total_count: 0 },
      { data: [], total_count: 0 },
      {
        id: "inv_once",
        email_address: "repeat@a.test",
        role: "org:member",
        status: "pending",
        organization_id: ORG_A,
        created_at: Date.now(),
      },
    ]);

    const first = await t
      .withIdentity(identityForOrgA())
      .action(api.invitations.invite, { email: "repeat@a.test" });
    const second = await t
      .withIdentity(identityForOrgA())
      .action(api.invitations.invite, { email: "REPEAT@A.TEST" });

    expect(first.outcome).toBe("invited");
    expect(second).toEqual({
      outcome: "alreadyInvited",
      email: "REPEAT@A.TEST",
    });
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  test("invite: concurrent duplicates create only one Clerk invitation", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url, init });
        const isCreate = init?.method === "POST";
        return new Response(
          JSON.stringify(
            isCreate
              ? {
                  id: "inv_concurrent",
                  email_address: "concurrent@a.test",
                  role: "org:member",
                  status: "pending",
                  organization_id: ORG_A,
                  created_at: Date.now(),
                }
              : { data: [], total_count: 0 },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const results = await Promise.all([
      t
        .withIdentity(identityForOrgA())
        .action(api.invitations.invite, { email: "concurrent@a.test" }),
      t
        .withIdentity(identityForOrgA())
        .action(api.invitations.invite, { email: "CONCURRENT@A.TEST" }),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      "alreadyInvited",
      "invited",
    ]);
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
  });

  test("invite: a failed Clerk create releases its pending claim", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    stubClerkFetchSequence([
      { status: 200, body: { data: [], total_count: 0 } },
      { status: 200, body: { data: [], total_count: 0 } },
      { status: 500, body: { error: "upstream unavailable" } },
    ]);

    const first = await t
      .withIdentity(identityForOrgA())
      .action(api.invitations.invite, { email: "retry@a.test" });
    expect(first.outcome).toBe("failed");

    const pendingAfterFailure = await t.run(async (ctx) => {
      return await ctx.db
        .query("membershipIntents")
        .withIndex("by_clerkOrgId_and_emailLower", (q) =>
          q
            .eq("clerkOrgId", ORG_A)
            .eq("emailLower", "retry@a.test"),
        )
        .take(20);
    });
    expect(
      pendingAfterFailure.some((intent) => intent.status === "pending"),
    ).toBe(false);
  });

  test.each([
    [
      "alreadyMember",
      { data: [{ public_user_data: { identifier: "external@a.test" } }] },
      { data: [], total_count: 0 },
    ],
    [
      "alreadyInvited",
      { data: [], total_count: 0 },
      {
        data: [
          {
            id: "inv_external",
            email_address: "external@a.test",
            role: "org:member",
            status: "pending",
            organization_id: ORG_A,
            created_at: Date.now(),
          },
        ],
        total_count: 1,
      },
    ],
  ] as const)(
    "invite: Clerk preflight returns %s for externally managed state",
    async (outcome, membershipResponse, invitationResponse) => {
      const t = convexTest(schema, modules);
      await seedTwoOrgs(t);
      const { calls } = stubClerkFetch([
        membershipResponse,
        invitationResponse,
      ]);

      const result = await t
        .withIdentity(identityForOrgA())
        .action(api.invitations.invite, { email: "external@a.test" });

      expect(result).toEqual({ outcome, email: "external@a.test" });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.init?.method !== "POST")).toBe(true);
    },
  );

  test.each([
    ["already_a_member_in_organization", "alreadyMember"],
    ["duplicate_record", "alreadyInvited"],
  ] as const)(
    "invite: Clerk %s conflict returns the %s outcome",
    async (code, outcome) => {
      const t = convexTest(schema, modules);
      await seedTwoOrgs(t);
      stubClerkFetchSequence([
        { status: 200, body: { data: [], total_count: 0 } },
        { status: 200, body: { data: [], total_count: 0 } },
        { status: 422, body: { errors: [{ code }] } },
      ]);

      const result = await t
        .withIdentity(identityForOrgA())
        .action(api.invitations.invite, { email: "existing@a.test" });

      expect(result).toEqual({ outcome, email: "existing@a.test" });
    },
  );

  test("invite: rejects Clerk responses whose organization_id doesn't match", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);

    // Stub Clerk returning an invitation allegedly for ORG_B even though we
    // hit ORG_A's URL — the action must refuse to trust this.
    stubClerkFetch([
      { data: [], total_count: 0 },
      { data: [], total_count: 0 },
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

  async function addOrgAMember(
    t: ReturnType<typeof convexTest>,
    suffix: string,
    role: "admin" | "contributor" | "viewer",
  ): Promise<Id<"memberships">> {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        tokenIdentifier: `${ISSUER}|${suffix}`,
        name: suffix,
        email: `${suffix}@a.test`,
        profileComplete: true,
      });
      return await ctx.db.insert("memberships", {
        tokenIdentifier: `${ISSUER}|${suffix}`,
        userId,
        clerkOrgId: ORG_A,
        role,
        createdAt: Date.now(),
      });
    });
  }

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

  test("successful removal deletes from Clerk before Fabric row", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    const targetId = await addOrgAMember(t, "user_c", "contributor");
    const { calls } = stubClerkFetchStatus(200, {});

    await t.withIdentity(identityForOrgA()).action(api.users.removeMemberFromOrg, {
      membershipId: targetId,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/organizations/${ORG_A}/memberships/user_c`);
    const row = await t.run(async (ctx) => ctx.db.get(targetId));
    expect(row).toBeNull();
  });

  test("Clerk failure preserves Fabric membership", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    const targetId = await addOrgAMember(t, "user_c", "contributor");
    stubClerkFetchStatus(500, { error: "upstream unavailable" });

    await expect(
      t.withIdentity(identityForOrgA()).action(api.users.removeMemberFromOrg, {
        membershipId: targetId,
      }),
    ).rejects.toThrow(/500/);

    const row = await t.run(async (ctx) => ctx.db.get(targetId));
    expect(row).not.toBeNull();
  });

  test("Clerk 404 still removes stale Fabric membership", async () => {
    const t = convexTest(schema, modules);
    await seedTwoOrgs(t);
    const targetId = await addOrgAMember(t, "user_c", "contributor");
    stubClerkFetchStatus(404, { error: "not found" });

    await t.withIdentity(identityForOrgA()).action(api.users.removeMemberFromOrg, {
      membershipId: targetId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(targetId));
    expect(row).toBeNull();
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
    status: "processing" | "needs_speaker_labels" | "done" | "failed";
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

  test("hierarchy lists expose V2 state without returning full artifacts", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      const common = {
        schemaVersion: "v2" as const,
        sourceMode: "interview_evidence" as const,
        headline: "Synthetic overview",
        executiveBrief: "A compact synthetic brief.",
        coverage: {
          includedSources: 0,
          totalEligibleSources: 0,
          complete: true,
        },
        provenance: {
          sourceSnapshotHash: "sha256:empty",
          generatedAt: 1_786_000_000_000,
          provider: "fabric-foundry",
          model: "test-model",
        },
      };
      await ctx.db.patch(ids.fnA, {
        summaryV2: {
          ...common,
          provenance: {
            ...common.provenance,
            promptVersion: SUMMARY_V2_PROMPT_VERSIONS.functionOverview,
          },
          crossDepartmentDependencies: [],
          strategicPatterns: [],
          variationsAndTensions: [],
          gaps: [],
          notable: [],
        },
      });
      await ctx.db.patch(ids.deptA, {
        summaryV2: {
          ...common,
          provenance: {
            ...common.provenance,
            promptVersion: SUMMARY_V2_PROMPT_VERSIONS.departmentOverview,
          },
          crossProcessDependencies: [],
          sharedPatterns: [],
          variationsAndTensions: [],
          gaps: [],
          notable: [],
        },
      });
      await ctx.db.patch(ids.procA, {
        summaryV2: {
          ...common,
          provenance: {
            ...common.provenance,
            promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
          },
          scope: [],
          consensus: [],
          variations: [],
          gaps: [],
          notable: [],
        },
      });
    });

    const scoped = t.withIdentity(identityForOrgA());
    const [functions, departments, processes, tree, selectedProcess] =
      await Promise.all([
        scoped.query(api.functions.list),
        scoped.query(api.departments.listByFunction, {
          functionId: ids.fnA,
        }),
        scoped.query(api.processes.listByDepartment, {
          departmentId: ids.deptA,
        }),
        scoped.query(api.hierarchy.getTree),
        scoped.query(api.processes.get, { processId: ids.procA }),
      ]);

    expect(functions[0]).not.toHaveProperty("summaryV2");
    expect(departments[0]).not.toHaveProperty("summaryV2");
    expect(processes[0]).not.toHaveProperty("summaryV2");
    expect(functions[0].summaryOverview).toMatchObject({
      format: "v2",
      state: "current",
      coverage: { includedSources: 0, totalEligibleSources: 0, complete: true },
    });
    expect(
      tree.functions[0].departments[0].processes[0].summaryOverview.format,
    ).toBe("v2");
    // Selected-entity reads retain the full artifact for the future Overview
    // query/UI, while navigation reads stay compact.
    expect(selectedProcess?.summaryV2?.headline).toBe("Synthetic overview");
  });
}

function waitForNextTimestamp() {
  return new Promise((resolve) => setTimeout(resolve, 2));
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

  test("listAllForOrg orders unfiltered rows by latest creation time first", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTwoOrgs(t);
    const procA2 = await t.run(async (ctx) => {
      return await ctx.db.insert("processes", {
        departmentId: ids.deptA,
        name: "Contracting-A",
        sortOrder: 1,
        clerkOrgId: ORG_A,
      });
    });

    await seedConversation(t, ids.procA, ORG_A, {
      contributorName: "older-conversation",
    });
    await waitForNextTimestamp();
    await seedConversation(t, procA2, ORG_A, {
      contributorName: "middle-conversation",
    });
    await waitForNextTimestamp();
    await seedConversation(t, ids.procA, ORG_A, {
      contributorName: "newer-conversation",
    });

    const result = await t
      .withIdentity(identityForOrgA())
      .query(api.conversations.listAllForOrg, {
        paginationOpts: { numItems: 50, cursor: null },
      });

    expect(result.page.map((row) => row.contributorName)).toEqual([
      "newer-conversation",
      "middle-conversation",
      "older-conversation",
    ]);
    expect(result.page[0]._creationTime).toBeGreaterThanOrEqual(
      result.page[1]._creationTime,
    );
    expect(result.page[1]._creationTime).toBeGreaterThanOrEqual(
      result.page[2]._creationTime,
    );
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
