import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  MutationCtx,
  mutation,
  QueryCtx,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  getActiveOrgClaims,
  requireAuth,
  requireOrgAdmin,
  requireOrgContributor,
  requireOrgMember,
  resolveOrgForAction,
} from "./lib/orgAuth";
import {
  clerkFetch,
  clerkUserIdFromTokenIdentifier,
} from "./lib/clerkApi";
import {
  allowedDomainsFromMetadata,
  markTenantDeleted,
  upsertTenantFromClerkOrg,
} from "./tenants";

const roleValidator = v.union(
  v.literal("admin"),
  v.literal("contributor"),
  v.literal("viewer"),
);

const membershipSourceValidator = v.union(
  v.literal("selfSignup"),
  v.literal("adminInvite"),
  v.literal("superAdminFanOut"),
  v.literal("reconcile"),
  v.literal("webhook"),
  v.literal("legacy"),
);

type Role = "admin" | "contributor" | "viewer";
type MembershipSource =
  | "selfSignup"
  | "adminInvite"
  | "superAdminFanOut"
  | "reconcile"
  | "webhook"
  | "legacy";

type UpsertUserAndMembershipArgs = {
  tokenIdentifier: string;
  clerkUserId?: string | null;
  name?: string | null;
  email?: string | null;
  orgId?: string | null;
  source?: MembershipSource | null;
  requestedRole?: Role | null;
  invitedBy?: Id<"users"> | null;
};

type ClerkUserResponse = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: Array<{
    id: string;
    email_address: string;
    verification?: { status?: string | null } | null;
  }>;
  primary_email_address_id?: string | null;
  banned?: boolean | null;
  locked?: boolean | null;
};

type ClerkMembershipResponse = {
  public_user_data?: {
    user_id?: string;
    first_name?: string | null;
    last_name?: string | null;
    identifier?: string | null;
  };
};

type ClerkMembershipListResponse = {
  data: ClerkMembershipResponse[];
  total_count?: number;
};

type MemberDisplay = {
  name: string;
  email: string;
  emailLower: string;
  jobTitle?: string;
  profileComplete: boolean;
  platformRole?: "superAdmin";
  clerkUserId?: string;
  searchText: string;
};

function displayNameFromParts(
  firstName?: string | null,
  lastName?: string | null,
  fallback?: string | null,
): string | null {
  const fullName = `${firstName ?? ""} ${lastName ?? ""}`.trim();
  return fullName || fallback?.trim() || null;
}

function normalizeEmail(email?: string | null): string {
  return (email ?? "").trim().toLowerCase();
}

function cleanEmail(email?: string | null): string | null {
  const trimmed = email?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed;
}

function validateProfileText(
  value: string,
  field: string,
  maxLength = 120,
): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function optionalProfileText(
  value: string | undefined,
  field: string,
  maxLength = 120,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function emailFromClerkUser(user: ClerkUserResponse): string | null {
  const primary = user.email_addresses?.find(
    (email) => email.id === user.primary_email_address_id,
  );
  return (
    primary?.email_address ??
    user.email_addresses?.[0]?.email_address ??
    null
  );
}

function profileFromClerkUser(user: ClerkUserResponse): {
  name: string | null;
  email: string | null;
} {
  return {
    name: displayNameFromParts(user.first_name, user.last_name, user.username),
    email: emailFromClerkUser(user),
  };
}

function tokenIdentifierFromClerkUserId(clerkUserId: string): string {
  const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
  if (!issuerDomain) {
    throw new Error("CLERK_JWT_ISSUER_DOMAIN is not set in Convex env");
  }
  return `${issuerDomain}|${clerkUserId}`;
}

async function getClerkUserProfile(clerkUserId: string): Promise<{
  name: string | null;
  email: string | null;
}> {
  const user = (await clerkFetch(`/users/${clerkUserId}`)) as ClerkUserResponse;
  if (user.id !== clerkUserId) {
    throw new Error("Clerk user response mismatch");
  }
  return profileFromClerkUser(user);
}

function memberDisplayFromUser(user: Doc<"users">): MemberDisplay {
  const email = user.email ?? "";
  const emailLower = user.emailLower ?? normalizeEmail(email);
  const clerkUserId =
    user.clerkUserId ?? clerkUserIdFromTokenIdentifier(user.tokenIdentifier);
  const name = user.name || email || "Anonymous";
  const jobTitle = user.jobTitle?.trim() || undefined;
  const searchText = [name, email, jobTitle ?? ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    name,
    email,
    emailLower,
    jobTitle,
    profileComplete: user.profileComplete,
    platformRole: user.platformRole,
    clerkUserId,
    searchText,
  };
}

async function writeAudit(
  ctx: MutationCtx,
  event: {
    clerkOrgId?: string;
    actorUserId?: Id<"users">;
    targetUserId?: Id<"users">;
    targetEmailLower?: string;
    membershipId?: Id<"memberships">;
    action:
      | "selfSignup"
      | "inviteCreated"
      | "inviteRevoked"
      | "membershipAccepted"
      | "roleChanged"
      | "memberRemoved"
      | "webhookProcessed"
      | "webhookFailed"
      | "blockedJoin"
      | "superAdminFanOut"
      | "reconcile";
    detail?: string;
  },
) {
  await ctx.db.insert("authAuditEvents", {
    ...event,
    createdAt: Date.now(),
  });
}

async function patchStatsIfPresent(
  ctx: MutationCtx,
  clerkOrgId: string,
  delta: {
    active?: number;
    admin?: number;
    contributor?: number;
    viewer?: number;
    pendingInvite?: number;
  },
) {
  const stats = await ctx.db
    .query("orgMembershipStats")
    .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  if (!stats) return;

  await ctx.db.patch(stats._id, {
    activeCount: Math.max(0, stats.activeCount + (delta.active ?? 0)),
    adminCount: Math.max(0, stats.adminCount + (delta.admin ?? 0)),
    contributorCount: Math.max(
      0,
      stats.contributorCount + (delta.contributor ?? 0),
    ),
    viewerCount: Math.max(0, stats.viewerCount + (delta.viewer ?? 0)),
    pendingInviteCount: Math.max(
      0,
      stats.pendingInviteCount + (delta.pendingInvite ?? 0),
    ),
    updatedAt: Date.now(),
  });
}

function roleDelta(role: Role, amount: number) {
  return {
    active: amount,
    admin: role === "admin" ? amount : 0,
    contributor: role === "contributor" ? amount : 0,
    viewer: role === "viewer" ? amount : 0,
  };
}

async function findInviteIntentForMembership(
  ctx: MutationCtx,
  clerkOrgId: string,
  emailLower: string,
) {
  if (!emailLower) return null;
  const intents = await ctx.db
    .query("membershipIntents")
    .withIndex("by_clerkOrgId_and_emailLower", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("emailLower", emailLower),
    )
    .take(20);
  return (
    intents
      .filter(
        (intent) =>
          intent.source === "adminInvite" &&
          (intent.status === "pending" || intent.status === "accepted"),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  );
}

async function syncMembershipProfilesForUser(
  ctx: MutationCtx,
  user: Doc<"users">,
) {
  const display = memberDisplayFromUser(user);
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .take(1000);
  await Promise.all(
    memberships.map((membership) =>
      ctx.db.patch(membership._id, {
        clerkUserId: display.clerkUserId,
        name: display.name,
        email: display.email,
        emailLower: display.emailLower,
        jobTitle: display.jobTitle,
        profileComplete: display.profileComplete,
        platformRole: display.platformRole,
        searchText: display.searchText,
        updatedAt: Date.now(),
      }),
    ),
  );
}

async function upsertUserAndMembership(
  ctx: MutationCtx,
  args: UpsertUserAndMembershipArgs,
): Promise<Id<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", args.tokenIdentifier),
    )
    .unique();

  const name = args.name?.trim();
  const email = cleanEmail(args.email);
  const emailLower = normalizeEmail(email);
  const clerkUserId =
    args.clerkUserId ?? clerkUserIdFromTokenIdentifier(args.tokenIdentifier);
  let user: Doc<"users">;

  if (existing) {
    const updates: Partial<Doc<"users">> = {};
    if (email && existing.email !== email) updates.email = email;
    if (emailLower && existing.emailLower !== emailLower) {
      updates.emailLower = emailLower;
    }
    if (name && existing.name !== name) updates.name = name;
    if (clerkUserId && existing.clerkUserId !== clerkUserId) {
      updates.clerkUserId = clerkUserId;
    }
    if (existing.deletedAt !== undefined) updates.deletedAt = undefined;
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(existing._id, updates);
      user = { ...existing, ...updates };
    } else {
      user = existing;
    }
  } else {
    const userId = await ctx.db.insert("users", {
      tokenIdentifier: args.tokenIdentifier,
      clerkUserId,
      name: name || "Anonymous",
      email: email || "",
      emailLower,
      profileComplete: false,
      lastSyncedFromClerkAt: Date.now(),
    });
    const created = await ctx.db.get(userId);
    if (!created) throw new Error("Failed to create user");
    user = created;
  }

  const orgId = args.orgId;
  if (!orgId) {
    await syncMembershipProfilesForUser(ctx, user);
    return user._id;
  }

  const existingMembership = await ctx.db
    .query("memberships")
    .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
      q.eq("tokenIdentifier", args.tokenIdentifier).eq("clerkOrgId", orgId),
    )
    .unique();

  const display = memberDisplayFromUser(user);
  if (existingMembership) {
    await ctx.db.patch(existingMembership._id, {
      clerkUserId: display.clerkUserId,
      name: display.name,
      email: display.email,
      emailLower: display.emailLower,
      jobTitle: display.jobTitle,
      profileComplete: display.profileComplete,
      platformRole: display.platformRole,
      searchText: display.searchText,
      status: "active",
      removedAt: undefined,
      updatedAt: Date.now(),
    });
    return user._id;
  }

  // Default Fabric role for members with no invite intent (e.g. walk-up
  // domain-matched sign-ups): contributor, so new joiners can capture work
  // without an admin having to upgrade them first.
  let role: Role = "contributor";
  let source: MembershipSource = args.source ?? "selfSignup";
  let invitedBy = args.invitedBy ?? undefined;
  let matchedIntent: Doc<"membershipIntents"> | null = null;

  if (user.platformRole === "superAdmin") {
    role = "admin";
    source = "superAdminFanOut";
  } else if (args.requestedRole) {
    role = args.requestedRole;
  } else {
    matchedIntent = await findInviteIntentForMembership(
      ctx,
      orgId,
      display.emailLower,
    );
    if (matchedIntent) {
      role = matchedIntent.requestedRole;
      source = "adminInvite";
      invitedBy = matchedIntent.invitedBy;
    }
  }

  const membershipId = await ctx.db.insert("memberships", {
    tokenIdentifier: args.tokenIdentifier,
    userId: user._id,
    clerkOrgId: orgId,
    role,
    invitedBy,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "active",
    source,
    clerkUserId: display.clerkUserId,
    name: display.name,
    email: display.email,
    emailLower: display.emailLower,
    jobTitle: display.jobTitle,
    profileComplete: display.profileComplete,
    platformRole: display.platformRole,
    searchText: display.searchText,
  });

  if (matchedIntent) {
    await ctx.db.patch(matchedIntent._id, {
      status: "accepted",
      acceptedUserId: user._id,
      acceptedTokenIdentifier: args.tokenIdentifier,
      clerkUserId: display.clerkUserId,
      updatedAt: Date.now(),
    });
    await patchStatsIfPresent(ctx, orgId, { pendingInvite: -1 });
  }

  await patchStatsIfPresent(ctx, orgId, roleDelta(role, 1));
  await writeAudit(ctx, {
    clerkOrgId: orgId,
    targetUserId: user._id,
    targetEmailLower: display.emailLower,
    membershipId,
    action:
      source === "adminInvite"
        ? "membershipAccepted"
        : source === "superAdminFanOut"
          ? "superAdminFanOut"
          : source === "reconcile"
            ? "reconcile"
            : "selfSignup",
    detail: `Created ${source} membership as ${role}`,
  });

  return user._id;
}

export const upsertCurrentUserInternal = internalMutation({
  args: {
    tokenIdentifier: v.string(),
    clerkUserId: v.optional(v.string()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    orgId: v.optional(v.string()),
    source: v.optional(membershipSourceValidator),
    requestedRole: v.optional(roleValidator),
    invitedBy: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    return await upsertUserAndMembership(ctx, args);
  },
});

export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAuth(ctx);
    const { orgId } = getActiveOrgClaims(identity);
    return await upsertUserAndMembership(ctx, {
      tokenIdentifier: identity.tokenIdentifier,
      name: identity.name ?? null,
      email: identity.email ?? null,
      orgId,
      source: "selfSignup",
    });
  },
});

export const syncCurrentUserFromClerk = action({
  args: {},
  handler: async (ctx): Promise<Id<"users">> => {
    const identity = await requireAuth(ctx);
    const clerkUserId = clerkUserIdFromTokenIdentifier(
      identity.tokenIdentifier,
    );
    const profile = await getClerkUserProfile(clerkUserId);
    const { orgId } = getActiveOrgClaims(identity);

    const upsertArgs: {
      tokenIdentifier: string;
      clerkUserId: string;
      name?: string;
      email?: string;
      orgId?: string;
      source: MembershipSource;
    } = {
      tokenIdentifier: identity.tokenIdentifier,
      clerkUserId,
      source: "selfSignup",
    };
    if (profile.name ?? identity.name) upsertArgs.name = profile.name ?? identity.name;
    if (profile.email ?? identity.email) {
      upsertArgs.email = profile.email ?? identity.email;
    }
    if (orgId) upsertArgs.orgId = orgId;

    return await ctx.runMutation(internal.users.upsertCurrentUserInternal, upsertArgs);
  },
});

export const reconcileOrgMembersFromClerk = internalAction({
  args: { clerkOrgId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    clerkOrgId: string;
    processed: number;
    skipped: number;
  }> => {
    tokenIdentifierFromClerkUserId("user_probe");

    let offset = 0;
    let processed = 0;
    let skipped = 0;

    while (true) {
      const response = (await clerkFetch(
        `/organizations/${args.clerkOrgId}/memberships`,
        { query: { limit: "100", offset: String(offset) } },
      )) as ClerkMembershipListResponse;
      const memberships = response.data ?? [];
      if (memberships.length === 0) break;

      for (const membership of memberships) {
        const publicUser = membership.public_user_data;
        if (!publicUser?.user_id) {
          skipped++;
          continue;
        }
        const clerkUserId = publicUser.user_id;

        let name = displayNameFromParts(
          publicUser.first_name,
          publicUser.last_name,
          publicUser.identifier,
        );
        let email =
          publicUser.identifier && publicUser.identifier.includes("@")
            ? publicUser.identifier
            : null;

        if (!name || !email) {
          const profile = await getClerkUserProfile(clerkUserId);
          name ??= profile.name;
          email ??= profile.email;
        }

        const upsertArgs: {
          tokenIdentifier: string;
          clerkUserId: string;
          name?: string;
          email?: string;
          orgId: string;
          source: MembershipSource;
        } = {
          tokenIdentifier: tokenIdentifierFromClerkUserId(clerkUserId),
          clerkUserId,
          orgId: args.clerkOrgId,
          source: "reconcile",
        };
        if (name) upsertArgs.name = name;
        if (email) upsertArgs.email = email;

        await ctx.runMutation(internal.users.upsertCurrentUserInternal, upsertArgs);
        processed++;
      }

      offset += memberships.length;
      if (
        response.total_count !== undefined &&
        offset >= response.total_count
      ) {
        break;
      }
    }

    return { clerkOrgId: args.clerkOrgId, processed, skipped };
  },
});

export const getMe = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
  },
});

export const getActiveOrg = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const { orgId, orgSlug } = getActiveOrgClaims(identity);
    if (!orgId) return null;

    return {
      orgId,
      orgSlug: orgSlug ?? "",
    };
  },
});

export const completeProfile = mutation({
  args: {
    name: v.string(),
    jobTitle: v.string(),
    function: v.string(),
    department: v.string(),
    hireDate: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireAuth(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    if (!user) throw new Error("User not found");

    await ctx.db.patch(user._id, {
      name: validateProfileText(args.name, "Name"),
      jobTitle: validateProfileText(args.jobTitle, "Job title"),
      function: validateProfileText(args.function, "Function"),
      department: validateProfileText(args.department, "Department"),
      hireDate: validateProfileText(args.hireDate, "Hire date", 40),
      profileComplete: true,
    });
    const updated = await ctx.db.get(user._id);
    if (updated) await syncMembershipProfilesForUser(ctx, updated);
  },
});

export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
    function: v.optional(v.string()),
    department: v.optional(v.string()),
    hireDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireAuth(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    if (!user) throw new Error("User not found");

    const updates: Record<string, string> = {};
    const name = optionalProfileText(args.name, "Name");
    const jobTitle = optionalProfileText(args.jobTitle, "Job title");
    const fn = optionalProfileText(args.function, "Function");
    const department = optionalProfileText(args.department, "Department");
    const hireDate = optionalProfileText(args.hireDate, "Hire date", 40);
    if (name !== undefined) updates.name = name;
    if (jobTitle !== undefined) updates.jobTitle = jobTitle;
    if (fn !== undefined) updates.function = fn;
    if (department !== undefined) updates.department = department;
    if (hireDate !== undefined) updates.hireDate = hireDate;

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(user._id, updates);
      const updated = await ctx.db.get(user._id);
      if (updated) await syncMembershipProfilesForUser(ctx, updated);
    }
  },
});

async function memberRow(ctx: QueryCtx, m: Doc<"memberships">) {
  const user =
    m.name && m.email !== undefined && m.profileComplete !== undefined
      ? null
      : await ctx.db.get(m.userId);
  return {
    membershipId: m._id,
    userId: m.userId,
    clerkOrgId: m.clerkOrgId,
    role: m.role,
    createdAt: m.createdAt,
    invitedBy: m.invitedBy ?? null,
    name: m.name ?? user?.name ?? "Unknown",
    email: m.email ?? user?.email ?? "",
    jobTitle: m.jobTitle ?? user?.jobTitle ?? null,
    profileComplete: m.profileComplete ?? user?.profileComplete ?? false,
    platformRole: m.platformRole ?? user?.platformRole ?? null,
    source: m.source ?? "legacy",
  };
}

export const listOrgMembersPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    role: v.optional(roleValidator),
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgAdmin(ctx);
    const search = args.search?.trim();
    const result =
      search && search.length > 0
        ? await ctx.db
            .query("memberships")
            .withSearchIndex("search_member", (q) =>
              q.search("searchText", search).eq("clerkOrgId", caller.orgId),
            )
            .paginate(args.paginationOpts)
        : args.role
          ? await ctx.db
              .query("memberships")
              .withIndex("by_clerkOrgId_and_role", (q) =>
                q.eq("clerkOrgId", caller.orgId).eq("role", args.role!),
              )
              .paginate(args.paginationOpts)
          : await ctx.db
              .query("memberships")
              .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
              .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(result.page.map((m) => memberRow(ctx, m))),
    };
  },
});

export const listOrgMembers = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgAdmin(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .take(1000);
    return await Promise.all(memberships.map((m) => memberRow(ctx, m)));
  },
});

export const searchOrgMembers = query({
  args: {
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const search = args.search?.trim();
    const rows =
      search && search.length > 0
        ? await ctx.db
            .query("memberships")
            .withSearchIndex("search_member", (q) =>
              q.search("searchText", search).eq("clerkOrgId", caller.orgId),
            )
            .take(limit)
        : await ctx.db
            .query("memberships")
            .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
            .take(limit);
    const members = await Promise.all(rows.map((m) => memberRow(ctx, m)));
    return members
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        email: m.email,
        jobTitle: m.jobTitle,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const listOrgMemberOptions = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgContributor(ctx);
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .take(100);
    const members = await Promise.all(rows.map((m) => memberRow(ctx, m)));
    return members
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        email: m.email,
        jobTitle: m.jobTitle,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const getOrgMembershipStats = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgAdmin(ctx);
    const stats = await ctx.db
      .query("orgMembershipStats")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .unique();
    if (stats) {
      return {
        activeCount: stats.activeCount,
        adminCount: stats.adminCount,
        contributorCount: stats.contributorCount,
        viewerCount: stats.viewerCount,
        pendingInviteCount: stats.pendingInviteCount,
      };
    }

    const counts = {
      activeCount: 0,
      adminCount: 0,
      contributorCount: 0,
      viewerCount: 0,
      pendingInviteCount: 0,
    };
    for await (const m of ctx.db
      .query("memberships")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))) {
      counts.activeCount++;
      if (m.role === "admin") counts.adminCount++;
      if (m.role === "contributor") counts.contributorCount++;
      if (m.role === "viewer") counts.viewerCount++;
    }
    const pending = await ctx.db
      .query("membershipIntents")
      .withIndex("by_clerkOrgId_and_status", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("status", "pending"),
      )
      .take(1000);
    counts.pendingInviteCount = pending.length;
    return counts;
  },
});

async function hasOtherAdmin(
  ctx: QueryCtx | MutationCtx,
  clerkOrgId: string,
  excludedMembershipId: Id<"memberships">,
) {
  const admins = await ctx.db
    .query("memberships")
    .withIndex("by_clerkOrgId_and_role", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("role", "admin"),
    )
    .take(2);
  return admins.some((m) => m._id !== excludedMembershipId);
}

export const setMembershipRole = mutation({
  args: {
    membershipId: v.id("memberships"),
    role: roleValidator,
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgAdmin(ctx);
    const target = await ctx.db.get(args.membershipId);
    if (!target || target.clerkOrgId !== caller.orgId) {
      throw new Error("Membership not found");
    }
    if (target.role === args.role) return;

    if (target.role === "admin" && args.role !== "admin") {
      const otherAdmin = await hasOtherAdmin(ctx, caller.orgId, target._id);
      if (!otherAdmin) {
        throw new Error("Cannot demote the last admin in this org.");
      }
    }

    await ctx.db.patch(args.membershipId, {
      role: args.role,
      updatedAt: Date.now(),
    });
    await patchStatsIfPresent(ctx, caller.orgId, {
      ...roleDelta(target.role, -1),
      admin: (target.role === "admin" ? -1 : 0) + (args.role === "admin" ? 1 : 0),
      contributor:
        (target.role === "contributor" ? -1 : 0) +
        (args.role === "contributor" ? 1 : 0),
      viewer:
        (target.role === "viewer" ? -1 : 0) + (args.role === "viewer" ? 1 : 0),
      active: 0,
    });
    await writeAudit(ctx, {
      clerkOrgId: caller.orgId,
      actorUserId: caller.userId,
      targetUserId: target.userId,
      membershipId: target._id,
      action: "roleChanged",
      detail: `${target.role} -> ${args.role}`,
    });
  },
});

export const removeMembership = mutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, args) => {
    const caller = await requireOrgAdmin(ctx);
    const target = await ctx.db.get(args.membershipId);
    if (!target || target.clerkOrgId !== caller.orgId) {
      throw new Error("Membership not found");
    }
    if (target.userId === caller.userId) {
      throw new Error("Cannot remove your own membership.");
    }
    if (target.role === "admin") {
      const otherAdmin = await hasOtherAdmin(ctx, caller.orgId, target._id);
      if (!otherAdmin) {
        throw new Error("Cannot remove the last admin from this org.");
      }
    }
    await ctx.db.delete(args.membershipId);
    await patchStatsIfPresent(ctx, caller.orgId, roleDelta(target.role, -1));
    await writeAudit(ctx, {
      clerkOrgId: caller.orgId,
      actorUserId: caller.userId,
      targetUserId: target.userId,
      membershipId: target._id,
      action: "memberRemoved",
    });
  },
});

export const getMembershipForRemoval = internalQuery({
  args: {
    membershipId: v.id("memberships"),
    orgId: v.string(),
    callerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const callerMembership = await ctx.db
      .query("memberships")
      .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
        q
          .eq("tokenIdentifier", args.callerTokenIdentifier)
          .eq("clerkOrgId", args.orgId),
      )
      .unique();
    if (!callerMembership || callerMembership.role !== "admin") {
      throw new Error("Insufficient permissions");
    }

    const target = await ctx.db.get(args.membershipId);
    if (!target || target.clerkOrgId !== args.orgId) {
      throw new Error("Membership not found");
    }
    if (target.userId === callerMembership.userId) {
      throw new Error("Cannot remove your own membership.");
    }
    if (target.role === "admin") {
      const otherAdmin = await hasOtherAdmin(ctx, args.orgId, target._id);
      if (!otherAdmin) {
        throw new Error("Cannot remove the last admin from this org.");
      }
    }

    return {
      targetTokenIdentifier: target.tokenIdentifier,
      targetUserId: target.userId,
    };
  },
});

export const removeMemberFromOrg = action({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, args): Promise<void> => {
    const { orgId, tokenIdentifier } = await resolveOrgForAction(ctx);
    const { targetTokenIdentifier } = await ctx.runQuery(
      internal.users.getMembershipForRemoval,
      {
        membershipId: args.membershipId,
        orgId,
        callerTokenIdentifier: tokenIdentifier,
      },
    );

    const clerkUserId = clerkUserIdFromTokenIdentifier(targetTokenIdentifier);
    try {
      await clerkFetch(`/organizations/${orgId}/memberships/${clerkUserId}`, {
        method: "DELETE",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404")) throw err;
    }

    await ctx.runMutation(api.users.removeMembership, {
      membershipId: args.membershipId,
    });
  },
});

export const getMyMembership = query({
  args: {},
  handler: async (ctx) => {
    try {
      const caller = await requireOrgMember(ctx);
      return {
        orgId: caller.orgId,
        orgSlug: caller.orgSlug,
        role: caller.role,
        userId: caller.userId,
      };
    } catch {
      return null;
    }
  },
});

export const createMembershipIntent = internalMutation({
  args: {
    clerkOrgId: v.string(),
    email: v.string(),
    requestedRole: roleValidator,
    source: membershipSourceValidator,
    invitedBy: v.optional(v.id("users")),
    clerkInvitationId: v.optional(v.string()),
    failIfPending: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const email = validateProfileText(args.email, "Email", 320);
    const emailLower = normalizeEmail(email);
    const existing = await ctx.db
      .query("membershipIntents")
      .withIndex("by_clerkOrgId_and_emailLower", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("emailLower", emailLower),
      )
      .take(20);
    const reusable = existing.find(
      (intent) =>
        intent.source === args.source &&
        (intent.status === "pending" || intent.status === "accepted"),
    );
    if (reusable) {
      if (args.failIfPending && reusable.status === "pending") {
        return { outcome: "alreadyPending" as const, intentId: reusable._id };
      }
      await ctx.db.patch(reusable._id, {
        requestedRole: args.requestedRole,
        clerkInvitationId: args.clerkInvitationId ?? reusable.clerkInvitationId,
        invitedBy: args.invitedBy ?? reusable.invitedBy,
        status: "pending",
        updatedAt: Date.now(),
      });
      return { outcome: "ready" as const, intentId: reusable._id };
    }
    const intentId = await ctx.db.insert("membershipIntents", {
      clerkOrgId: args.clerkOrgId,
      email,
      emailLower,
      requestedRole: args.requestedRole,
      source: args.source,
      status: "pending",
      invitedBy: args.invitedBy,
      clerkInvitationId: args.clerkInvitationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await patchStatsIfPresent(ctx, args.clerkOrgId, { pendingInvite: 1 });
    await writeAudit(ctx, {
      clerkOrgId: args.clerkOrgId,
      actorUserId: args.invitedBy,
      targetEmailLower: emailLower,
      action: "inviteCreated",
      detail: `Requested ${args.requestedRole}`,
    });
    return { outcome: "ready" as const, intentId };
  },
});

export const releaseMembershipIntentClaim = internalMutation({
  args: { intentId: v.id("membershipIntents") },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (
      !intent ||
      intent.source !== "adminInvite" ||
      intent.status !== "pending" ||
      intent.clerkInvitationId !== undefined
    ) {
      return null;
    }

    await ctx.db.patch(intent._id, {
      status: "revoked",
      updatedAt: Date.now(),
    });
    await patchStatsIfPresent(ctx, intent.clerkOrgId, { pendingInvite: -1 });
    await writeAudit(ctx, {
      clerkOrgId: intent.clerkOrgId,
      actorUserId: intent.invitedBy,
      targetEmailLower: intent.emailLower,
      action: "inviteRevoked",
      detail: "Invite creation did not complete in Clerk",
    });
    return null;
  },
});

export const markInvitationRevoked = internalMutation({
  args: {
    clerkOrgId: v.string(),
    clerkInvitationId: v.string(),
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db
      .query("membershipIntents")
      .withIndex("by_clerkInvitationId", (q) =>
        q.eq("clerkInvitationId", args.clerkInvitationId),
      )
      .unique();
    if (!intent || intent.clerkOrgId !== args.clerkOrgId) return;
    if (intent.status === "pending") {
      await patchStatsIfPresent(ctx, args.clerkOrgId, { pendingInvite: -1 });
    }
    await ctx.db.patch(intent._id, {
      status: "revoked",
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      clerkOrgId: args.clerkOrgId,
      targetEmailLower: intent.emailLower,
      action: "inviteRevoked",
    });
  },
});

export const getInvitationIntentRoles = internalQuery({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const intents = await ctx.db
      .query("membershipIntents")
      .withIndex("by_clerkOrgId_and_status", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("status", "pending"),
      )
      .take(1000);
    return intents.map((intent) => ({
      clerkInvitationId: intent.clerkInvitationId ?? null,
      emailLower: intent.emailLower,
      requestedRole: intent.requestedRole,
    }));
  },
});

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function webhookEmail(data: Record<string, unknown>): string | null {
  const emailAddresses = data.email_addresses;
  const primaryId = getString(data.primary_email_address_id);
  if (!Array.isArray(emailAddresses)) return null;
  const primary = emailAddresses.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      getString((entry as Record<string, unknown>).id) === primaryId,
  ) as Record<string, unknown> | undefined;
  return (
    getString(primary?.email_address) ??
    getString((emailAddresses[0] as Record<string, unknown> | undefined)?.email_address)
  );
}

function webhookMembershipData(data: Record<string, unknown>) {
  const organization = data.organization as Record<string, unknown> | undefined;
  const publicUser = data.public_user_data as Record<string, unknown> | undefined;
  const clerkOrgId = getString(organization?.id) ?? getString(data.organization_id);
  const clerkUserId = getString(publicUser?.user_id) ?? getString(data.user_id);
  const email = getString(publicUser?.identifier);
  const name = displayNameFromParts(
    getString(publicUser?.first_name),
    getString(publicUser?.last_name),
    email ?? clerkUserId,
  );
  const clerkRole = getString(data.role);
  return { clerkOrgId, clerkUserId, email, name, clerkRole };
}

export const handleClerkWebhook = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("processedWebhookEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .first();
    if (existing?.status === "processed") {
      return { status: "duplicate" };
    }

    const data =
      typeof args.data === "object" && args.data !== null
        ? (args.data as Record<string, unknown>)
        : {};
    try {
      if (args.eventType === "user.created" || args.eventType === "user.updated") {
        const clerkUserId = getString(data.id);
        if (clerkUserId) {
          await upsertUserAndMembership(ctx, {
            tokenIdentifier: tokenIdentifierFromClerkUserId(clerkUserId),
            clerkUserId,
            name: displayNameFromParts(
              getString(data.first_name),
              getString(data.last_name),
              getString(data.username) ?? clerkUserId,
            ),
            email: webhookEmail(data),
          });
        }
      }

      if (args.eventType === "user.deleted") {
        const clerkUserId = getString(data.id);
        if (clerkUserId) {
          const tokenIdentifier = tokenIdentifierFromClerkUserId(clerkUserId);
          const user = await ctx.db
            .query("users")
            .withIndex("by_tokenIdentifier", (q) =>
              q.eq("tokenIdentifier", tokenIdentifier),
            )
            .unique();
          if (user) {
            await ctx.db.patch(user._id, { deletedAt: Date.now() });
            const memberships = await ctx.db
              .query("memberships")
              .withIndex("by_userId", (q) => q.eq("userId", user._id))
              .take(1000);
            for (const membership of memberships) {
              await ctx.db.delete(membership._id);
              await patchStatsIfPresent(
                ctx,
                membership.clerkOrgId,
                roleDelta(membership.role, -1),
              );
              await writeAudit(ctx, {
                clerkOrgId: membership.clerkOrgId,
                targetUserId: user._id,
                membershipId: membership._id,
                action: "memberRemoved",
                detail: "Clerk user.deleted",
              });
            }
          }
        }
      }

      if (args.eventType === "organizationMembership.created") {
        const membership = webhookMembershipData(data);
        if (membership.clerkOrgId && membership.clerkUserId) {
          await upsertUserAndMembership(ctx, {
            tokenIdentifier: tokenIdentifierFromClerkUserId(membership.clerkUserId),
            clerkUserId: membership.clerkUserId,
            name: membership.name,
            email: membership.email,
            orgId: membership.clerkOrgId,
            source: "webhook",
          });
        }
      }

      if (args.eventType === "organizationMembership.deleted") {
        const membership = webhookMembershipData(data);
        if (membership.clerkOrgId && membership.clerkUserId) {
          const tokenIdentifier = tokenIdentifierFromClerkUserId(membership.clerkUserId);
          const existingMembership = await ctx.db
            .query("memberships")
            .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
              q
                .eq("tokenIdentifier", tokenIdentifier)
                .eq("clerkOrgId", membership.clerkOrgId!),
            )
            .unique();
          if (existingMembership) {
            await ctx.db.delete(existingMembership._id);
            await patchStatsIfPresent(
              ctx,
              membership.clerkOrgId,
              roleDelta(existingMembership.role, -1),
            );
            await writeAudit(ctx, {
              clerkOrgId: membership.clerkOrgId,
              targetUserId: existingMembership.userId,
              membershipId: existingMembership._id,
              action: "memberRemoved",
              detail: "Clerk organizationMembership.deleted",
            });
          }
        }
      }

      // Keep the platform tenant registry in sync with orgs created/edited
      // outside the console (e.g. directly in the Clerk dashboard).
      if (
        args.eventType === "organization.created" ||
        args.eventType === "organization.updated"
      ) {
        const clerkOrgId = getString(data.id);
        const name = getString(data.name);
        const slug = getString(data.slug);
        if (clerkOrgId && name && slug) {
          await upsertTenantFromClerkOrg(
            ctx,
            {
              clerkOrgId,
              name,
              slug,
              logoUrl: getString(data.image_url),
              allowedEmailDomains: allowedDomainsFromMetadata(
                (data.public_metadata ?? null) as Record<
                  string,
                  unknown
                > | null,
              ),
            },
            "clerkSync",
          );
        }
      }

      if (args.eventType === "organization.deleted") {
        const clerkOrgId = getString(data.id);
        if (clerkOrgId) {
          await markTenantDeleted(ctx, clerkOrgId);
        }
      }

      if (args.eventType === "organizationInvitation.revoked") {
        const invitationId = getString(data.id);
        const organization = data.organization as Record<string, unknown> | undefined;
        const clerkOrgId =
          getString(data.organization_id) ?? getString(organization?.id);
        if (invitationId && clerkOrgId) {
          const intent = await ctx.db
            .query("membershipIntents")
            .withIndex("by_clerkInvitationId", (q) =>
              q.eq("clerkInvitationId", invitationId),
            )
            .unique();
          if (intent && intent.status === "pending") {
            await ctx.db.patch(intent._id, {
              status: "revoked",
              updatedAt: Date.now(),
            });
            await patchStatsIfPresent(ctx, clerkOrgId, { pendingInvite: -1 });
          }
        }
      }

      if (existing) {
        await ctx.db.patch(existing._id, {
          eventType: args.eventType,
          status: "processed",
          processedAt: Date.now(),
          error: undefined,
        });
      } else {
        await ctx.db.insert("processedWebhookEvents", {
          eventId: args.eventId,
          eventType: args.eventType,
          status: "processed",
          processedAt: Date.now(),
        });
      }
      await writeAudit(ctx, {
        action: "webhookProcessed",
        detail: args.eventType,
      });
      return { status: "processed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (existing) {
        await ctx.db.patch(existing._id, {
          eventType: args.eventType,
          status: "failed",
          processedAt: Date.now(),
          error: message,
        });
      } else {
        await ctx.db.insert("processedWebhookEvents", {
          eventId: args.eventId,
          eventType: args.eventType,
          status: "failed",
          processedAt: Date.now(),
          error: message,
        });
      }
      await writeAudit(ctx, {
        action: "webhookFailed",
        detail: `${args.eventType}: ${message}`,
      });
      return { status: "failed", error: message };
    }
  },
});

export const rebuildOrgMembershipStats = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const counts = {
      activeCount: 0,
      adminCount: 0,
      contributorCount: 0,
      viewerCount: 0,
      pendingInviteCount: 0,
    };
    for await (const membership of ctx.db
      .query("memberships")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))) {
      counts.activeCount++;
      if (membership.role === "admin") counts.adminCount++;
      if (membership.role === "contributor") counts.contributorCount++;
      if (membership.role === "viewer") counts.viewerCount++;
    }
    for await (const intent of ctx.db
      .query("membershipIntents")
      .withIndex("by_clerkOrgId_and_status", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("status", "pending"),
      )) {
      if (intent._id) counts.pendingInviteCount++;
    }
    const existing = await ctx.db
      .query("orgMembershipStats")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    const payload = { ...counts, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("orgMembershipStats", {
      clerkOrgId: args.clerkOrgId,
      ...payload,
    });
  },
});
