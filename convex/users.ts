import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { requireAuth, requireAdmin } from "./lib/auth";

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
      return existing._id;
    }

    const userId = await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      name: identity.name ?? "Anonymous",
      email: identity.email ?? "",
      profileComplete: false,
      role: "viewer",
    });

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

// --- Role management (admin only) ---

export const setUserRole = mutation({
  args: {
    targetUserId: v.id("users"),
    role: v.union(v.literal("admin"), v.literal("contributor"), v.literal("viewer")),
  },
  handler: async (ctx, args) => {
    const caller = await requireAdmin(ctx);

    // Prevent self-demotion
    if (caller._id === args.targetUserId) {
      throw new Error("Cannot change your own role");
    }

    const target = await ctx.db.get(args.targetUserId);
    if (!target) throw new Error("Target user not found");

    // Prevent removing the last admin
    if (target.role === "admin" && args.role !== "admin") {
      const admins = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("role"), "admin"))
        .collect();
      if (admins.length <= 1) {
        throw new Error("Cannot demote the last admin");
      }
    }

    await ctx.db.patch(args.targetUserId, { role: args.role });
  },
});

export const listAllUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("users").take(1000);
  },
});

// --- Internal mutations for bootstrapping (run via `npx convex run`) ---

export const backfillRoles = internalMutation({
  args: {
    defaultRole: v.union(v.literal("admin"), v.literal("contributor"), v.literal("viewer")),
  },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    let updated = 0;
    for (const user of users) {
      if (!user.role) {
        await ctx.db.patch(user._id, { role: args.defaultRole });
        updated++;
      }
    }
    return { updated, total: users.length };
  },
});

export const bootstrapAdmin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (!user) throw new Error(`No user found with email: ${args.email}`);
    await ctx.db.patch(user._id, { role: "admin" });
    return { userId: user._id, email: args.email, role: "admin" };
  },
});
