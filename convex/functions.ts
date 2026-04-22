import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import {
  assertOrgOwns,
  requireOrgContributor,
  requireOrgMember,
} from "./lib/orgAuth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgMember(ctx);
    return await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .order("asc")
      .collect();
  },
});

export const get = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const doc = await ctx.db.get(args.functionId);
    // Do not throw on cross-org — return null so the frontend treats it as
    // a "not found" (e.g., stale selection) without leaking existence.
    if (!doc || doc.clerkOrgId !== caller.orgId) return null;
    return doc;
  },
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const existing = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .order("desc")
      .take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    return await ctx.db.insert("functions", {
      name: args.name,
      sortOrder: maxSortOrder + 1,
      clerkOrgId: caller.orgId,
    });
  },
});

export const update = mutation({
  args: { functionId: v.id("functions"), name: v.string() },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const existing = await ctx.db.get(args.functionId);
    assertOrgOwns(caller, existing);
    const oldName = existing.name;
    await ctx.db.patch(args.functionId, { name: args.name });

    // Cascade name change to users whose profile references the old function
    // name. Note: users.function is a global profile string (not org-scoped),
    // so a user in a different org with the same function label would also
    // be updated. Acceptable for Biz-Group-only rollout; revisit when a
    // second tenant joins (see PRD §3.7 Open Items).
    if (oldName !== args.name) {
      const usersWithOldName = await ctx.db
        .query("users")
        .withIndex("by_function", (q) => q.eq("function", oldName))
        .collect();
      for (const user of usersWithOldName) {
        await ctx.db.patch(user._id, { function: args.name });
      }
    }
  },
});

export const childCount = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.functionId);
    assertOrgOwns(caller, parent);
    const children = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("functionId", args.functionId),
      )
      .collect();
    return children.length;
  },
});

export const remove = mutation({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const target = await ctx.db.get(args.functionId);
    assertOrgOwns(caller, target);
    const children = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("functionId", args.functionId),
      )
      .take(1);
    if (children.length > 0) {
      throw new Error(
        "Cannot delete this function because it still has departments. Remove all departments first.",
      );
    }
    await ctx.db.delete(args.functionId);
  },
});
