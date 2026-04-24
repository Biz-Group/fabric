import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  getActiveOrgClaims,
  requireAuth,
  requireOrgAdmin,
  requireOrgMember,
  resolveOrgForAction,
} from "./lib/orgAuth";
import {
  clerkFetch,
  clerkUserIdFromTokenIdentifier,
} from "./lib/clerkApi";

type UpsertUserAndMembershipArgs = {
  tokenIdentifier: string;
  name?: string | null;
  email?: string | null;
  orgId?: string | null;
};

type ClerkUserResponse = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: Array<{
    id: string;
    email_address: string;
  }>;
  primary_email_address_id?: string | null;
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

function displayNameFromParts(
  firstName?: string | null,
  lastName?: string | null,
  fallback?: string | null,
): string | null {
  const fullName = `${firstName ?? ""} ${lastName ?? ""}`.trim();
  return fullName || fallback?.trim() || null;
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
  const email = args.email?.trim();
  let userId: Id<"users">;
  let userPlatformRole: "superAdmin" | undefined;

  if (existing) {
    const updates: { name?: string; email?: string } = {};
    if (email && existing.email !== email) {
      updates.email = email;
    }
    if (name && existing.name !== name) {
      updates.name = name;
    }
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(existing._id, updates);
    }
    userId = existing._id;
    userPlatformRole = existing.platformRole;
  } else {
    userId = await ctx.db.insert("users", {
      tokenIdentifier: args.tokenIdentifier,
      name: name || "Anonymous",
      email: email || "",
      profileComplete: false,
    });
    userPlatformRole = undefined;
  }

  // Auto-provision a Fabric `memberships` row for the caller's active org
  // if one doesn't exist yet. This is how invited users get their initial
  // role without requiring an explicit admin action in Fabric.
  //
  // Default role:
  //   - platform super-admin -> "admin"  (they operate across every org)
  //   - everyone else        -> "contributor" (safe default for invitees)
  const orgId = args.orgId;
  if (orgId) {
    const existingMembership = await ctx.db
      .query("memberships")
      .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
        q
          .eq("tokenIdentifier", args.tokenIdentifier)
          .eq("clerkOrgId", orgId),
      )
      .unique();
    if (!existingMembership) {
      await ctx.db.insert("memberships", {
        tokenIdentifier: args.tokenIdentifier,
        userId,
        clerkOrgId: orgId,
        role: userPlatformRole === "superAdmin" ? "admin" : "contributor",
        createdAt: Date.now(),
      });
    }
  }

  return userId;
}

export const upsertCurrentUserInternal = internalMutation({
  args: {
    tokenIdentifier: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    orgId: v.optional(v.string()),
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
    });
  },
});

/**
 * Authenticated, trusted profile sync. Unlike `store`, this fetches the
 * caller's real Clerk profile via the Clerk backend API, so server-side flows
 * can create accurate Convex rows even when the Convex JWT omits email.
 */
export const syncCurrentUserFromClerk = action({
  args: {},
  handler: async (ctx): Promise<Id<"users">> => {
    const identity = await requireAuth(ctx);
    const clerkUserId = clerkUserIdFromTokenIdentifier(
      identity.tokenIdentifier,
    );
    const profile = await getClerkUserProfile(clerkUserId);
    const { orgId } = getActiveOrgClaims(identity);

    const args: {
      tokenIdentifier: string;
      name?: string;
      email?: string;
      orgId?: string;
    } = {
      tokenIdentifier: identity.tokenIdentifier,
    };
    if (profile.name ?? identity.name) args.name = profile.name ?? identity.name;
    if (profile.email ?? identity.email) {
      args.email = profile.email ?? identity.email;
    }
    if (orgId) args.orgId = orgId;

    const userId: Id<"users"> = await ctx.runMutation(
      internal.users.upsertCurrentUserInternal,
      args,
    );
    return userId;
  },
});

/**
 * CLI repair path for Clerk/Fabric drift. It reads every Clerk member in an
 * org and idempotently ensures the matching Convex user + membership exists.
 *
 * Run:
 *   npx convex run --prod users:reconcileOrgMembersFromClerk '{"clerkOrgId":"org_..."}'
 */
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
    // Validate early so a missing issuer doesn't produce partial reconciliation.
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
          name?: string;
          email?: string;
          orgId: string;
        } = {
          tokenIdentifier: tokenIdentifierFromClerkUserId(clerkUserId),
          orgId: args.clerkOrgId,
        };
        if (name) upsertArgs.name = name;
        if (email) upsertArgs.email = email;

        await ctx.runMutation(
          internal.users.upsertCurrentUserInternal,
          upsertArgs,
        );
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
    if (!identity) {
      return null;
    }

    return await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
  },
});

/** Safe org-context probe for the client bootstrap path.
 * Returns the active Clerk org carried by the Convex JWT, or null if the
 * session is authenticated without an active org yet. */
export const getActiveOrg = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const { orgId, orgSlug } = getActiveOrgClaims(identity);
    if (!orgId) {
      return null;
    }

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

    if (!user) {
      throw new Error("User not found");
    }

    await ctx.db.patch(user._id, {
      name: args.name,
      jobTitle: args.jobTitle,
      function: args.function,
      department: args.department,
      hireDate: args.hireDate,
      profileComplete: true,
    });
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

    if (!user) {
      throw new Error("User not found");
    }

    const updates: Record<string, string> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.jobTitle !== undefined) updates.jobTitle = args.jobTitle;
    if (args.function !== undefined) updates.function = args.function;
    if (args.department !== undefined) updates.department = args.department;
    if (args.hireDate !== undefined) updates.hireDate = args.hireDate;

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(user._id, updates);
    }
  },
});

// ---------------------------------------------------------------------------
// Org-scoped member management — all admin-only, all restricted to the
// caller's active org.
// ---------------------------------------------------------------------------

/** Admin-only. Lists every membership in the caller's active org joined with
 * the user profile. Safe on small orgs — capped at 1000 rows. */
export const listOrgMembers = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgAdmin(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .take(1000);
    const members = await Promise.all(
      memberships.map(async (m) => {
        const user = await ctx.db.get(m.userId);
        return {
          membershipId: m._id,
          userId: m.userId,
          clerkOrgId: m.clerkOrgId,
          role: m.role,
          createdAt: m.createdAt,
          invitedBy: m.invitedBy ?? null,
          name: user?.name ?? "Unknown",
          email: user?.email ?? "",
          jobTitle: user?.jobTitle ?? null,
          profileComplete: user?.profileComplete ?? false,
          // Surface platformRole so UI can show a "Platform Admin" badge.
          platformRole: user?.platformRole ?? null,
        };
      }),
    );
    return members;
  },
});

/** Admin-only. Change a member's role. Validates target belongs to caller's org
 * and enforces "cannot demote the last admin" within that org. */
export const setMembershipRole = mutation({
  args: {
    membershipId: v.id("memberships"),
    role: v.union(
      v.literal("admin"),
      v.literal("contributor"),
      v.literal("viewer"),
    ),
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgAdmin(ctx);
    const target = await ctx.db.get(args.membershipId);
    if (!target || target.clerkOrgId !== caller.orgId) {
      throw new Error("Membership not found");
    }

    // Cannot self-demote if it would remove the last org admin.
    if (target.userId === caller.userId && args.role !== "admin") {
      const admins = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
        .collect();
      const otherAdmins = admins.filter(
        (m) => m._id !== target._id && m.role === "admin",
      );
      if (otherAdmins.length === 0) {
        throw new Error("Cannot demote yourself — you are the last admin.");
      }
    }

    // Cannot demote the last admin in the org (even if it's not the caller).
    if (target.role === "admin" && args.role !== "admin") {
      const admins = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
        .collect();
      const remainingAdmins = admins.filter(
        (m) => m.role === "admin" && m._id !== target._id,
      );
      if (remainingAdmins.length === 0) {
        throw new Error("Cannot demote the last admin in this org.");
      }
    }

    await ctx.db.patch(args.membershipId, { role: args.role });
  },
});

/** Admin-only. Remove a membership (Fabric side only — does not touch Clerk).
 * To also remove the user from the Clerk org, use the Clerk Dashboard. */
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
      const admins = await ctx.db
        .query("memberships")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
        .collect();
      const remainingAdmins = admins.filter(
        (m) => m.role === "admin" && m._id !== target._id,
      );
      if (remainingAdmins.length === 0) {
        throw new Error("Cannot remove the last admin from this org.");
      }
    }
    await ctx.db.delete(args.membershipId);
  },
});

// ---------------------------------------------------------------------------
// Internal helpers for Clerk-coordinated admin actions.
// Per the orgAuth convention, these accept orgId explicitly and do NOT re-read
// ctx.auth — the public action entrypoint resolves auth once and passes the
// fields downstream.
// ---------------------------------------------------------------------------

/**
 * Internal. Verifies the caller (identified by tokenIdentifier) is an admin in
 * `orgId`, that the target membership belongs to the same org, and returns the
 * target's tokenIdentifier so the action can tell Clerk which user to remove.
 */
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

    return {
      targetTokenIdentifier: target.tokenIdentifier,
      targetUserId: target.userId,
    };
  },
});

/**
 * Public action. Removes a member from the org on BOTH sides — Fabric
 * `memberships` row (via the existing `removeMembership` mutation with all its
 * last-admin guards) and Clerk's organization membership (so the user's JWT
 * stops carrying this orgId on its next refresh).
 *
 * Ordering rationale: remove the Fabric row first so the user loses Fabric
 * access immediately on their next query. Clerk removal is second; if it
 * fails, the Fabric side is already consistent and the Clerk org can be
 * reconciled by retry or the Clerk dashboard.
 */
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

    // Fabric-side removal first (source of truth for access). This mutation
    // enforces "cannot remove self" and "cannot remove last admin".
    await ctx.runMutation(api.users.removeMembership, {
      membershipId: args.membershipId,
    });

    // Clerk-side removal. 404 is treated as already-consistent.
    const clerkUserId = clerkUserIdFromTokenIdentifier(targetTokenIdentifier);
    try {
      await clerkFetch(
        `/organizations/${orgId}/memberships/${clerkUserId}`,
        { method: "DELETE" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) return;
      throw err;
    }
  },
});

/** Returns the caller's own membership (role) in their active org. Used by the
 * frontend to gate UI elements without needing admin privileges to look up. */
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
