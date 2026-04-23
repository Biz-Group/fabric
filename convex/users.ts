import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  getActiveOrgClaims,
  requireAuth,
  requireOrgAdmin,
  requireOrgMember,
} from "./lib/orgAuth";

export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireAuth(ctx);

    const existing = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();

    let userId: Id<"users">;
    let userPlatformRole: "superAdmin" | undefined;

    if (existing) {
      // Sync email/name from Clerk if they were missing or changed
      const updates: Record<string, string> = {};
      if (identity.email && existing.email !== identity.email) {
        updates.email = identity.email;
      }
      if (identity.name && existing.name !== identity.name) {
        updates.name = identity.name;
      }
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(existing._id, updates);
      }
      userId = existing._id;
      userPlatformRole = existing.platformRole;
    } else {
      userId = await ctx.db.insert("users", {
        tokenIdentifier: identity.tokenIdentifier,
        name: identity.name ?? "Anonymous",
        email: identity.email ?? "",
        profileComplete: false,
      });
      userPlatformRole = undefined;
    }

    // Auto-provision a Fabric `memberships` row for the caller's active org
    // if one doesn't exist yet. This is how invited users get their initial
    // role without requiring an explicit admin action in Fabric.
    //
    // Default role:
    //   - platform super-admin → "admin"  (they operate across every org)
    //   - everyone else         → "contributor" (safe default for invitees)
    const { orgId } = getActiveOrgClaims(identity);
    if (orgId) {
      const existingMembership = await ctx.db
        .query("memberships")
        .withIndex("by_tokenIdentifier_and_clerkOrgId", (q) =>
          q
            .eq("tokenIdentifier", identity.tokenIdentifier)
            .eq("clerkOrgId", orgId),
        )
        .unique();
      if (!existingMembership) {
        await ctx.db.insert("memberships", {
          tokenIdentifier: identity.tokenIdentifier,
          userId,
          clerkOrgId: orgId,
          role: userPlatformRole === "superAdmin" ? "admin" : "contributor",
          createdAt: Date.now(),
        });
      }
    }

    return userId;
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
