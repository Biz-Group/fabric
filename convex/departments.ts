import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  assertOrgOwns,
  requireOrgContributor,
  requireOrgMember,
} from "./lib/orgAuth";

export const listByFunction = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    // Defense-in-depth: confirm the parent function belongs to this org before
    // returning its children. If it doesn't, return [] rather than throwing —
    // matches the "treat cross-org access as empty" UX.
    const parent = await ctx.db.get(args.functionId);
    if (!parent || parent.clerkOrgId !== caller.orgId) return [];
    return await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("functionId", args.functionId),
      )
      .order("asc")
      .collect();
  },
});

export const get = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const doc = await ctx.db.get(args.departmentId);
    if (!doc || doc.clerkOrgId !== caller.orgId) return null;
    return doc;
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgMember(ctx);
    // Uses `by_clerkOrgId_and_functionId` with only the first (clerkOrgId)
    // prefix eq — valid because Convex indexes support prefix queries.
    const depts = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId),
      )
      .order("asc")
      .collect();
    const functions = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .collect();
    const fnMap = new Map(functions.map((f) => [f._id, f.name]));
    return depts.map((d) => ({
      ...d,
      functionName: fnMap.get(d.functionId) ?? "Unknown",
    }));
  },
});

export const create = mutation({
  args: { functionId: v.id("functions"), name: v.string() },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const parentFunction = await ctx.db.get(args.functionId);
    assertOrgOwns(caller, parentFunction);

    const existing = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("functionId", args.functionId),
      )
      .order("desc")
      .take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    const id = await ctx.db.insert("departments", {
      functionId: args.functionId,
      name: args.name,
      sortOrder: maxSortOrder + 1,
      clerkOrgId: caller.orgId,
    });
    // Mark function summary as stale
    await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
      functionId: args.functionId,
    });
    return id;
  },
});

export const update = mutation({
  args: {
    departmentId: v.id("departments"),
    name: v.string(),
    functionId: v.optional(v.id("functions")),
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const dept = await ctx.db.get(args.departmentId);
    assertOrgOwns(caller, dept);

    const oldName = dept.name;
    const patch: Record<string, unknown> = { name: args.name };
    const isMoving =
      args.functionId !== undefined && args.functionId !== dept.functionId;

    if (isMoving) {
      const targetFunction = await ctx.db.get(args.functionId!);
      assertOrgOwns(caller, targetFunction);
      const existing = await ctx.db
        .query("departments")
        .withIndex("by_clerkOrgId_and_functionId", (q) =>
          q
            .eq("clerkOrgId", caller.orgId)
            .eq("functionId", args.functionId!),
        )
        .order("desc")
        .take(1);
      patch.functionId = args.functionId;
      patch.sortOrder = (existing.length > 0 ? existing[0].sortOrder : 0) + 1;
    }

    await ctx.db.patch(args.departmentId, patch);

    // Cascade name change to users referencing the old department name.
    // See note on the equivalent cascade in functions.ts::update.
    if (oldName !== args.name) {
      const usersWithOldName = await ctx.db
        .query("users")
        .withIndex("by_department", (q) => q.eq("department", oldName))
        .collect();
      for (const user of usersWithOldName) {
        await ctx.db.patch(user._id, { department: args.name });
      }
    }

    if (isMoving) {
      await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
        functionId: dept.functionId,
      });
      await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
        functionId: args.functionId!,
      });
    }
  },
});

export const childCount = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.departmentId);
    assertOrgOwns(caller, parent);
    const children = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("departmentId", args.departmentId),
      )
      .collect();
    return children.length;
  },
});

export const remove = mutation({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const dept = await ctx.db.get(args.departmentId);
    assertOrgOwns(caller, dept);
    const children = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("departmentId", args.departmentId),
      )
      .take(1);
    if (children.length > 0) {
      throw new Error(
        "Cannot delete this department because it still has processes. Remove all processes first.",
      );
    }
    const functionId = dept.functionId;
    await ctx.db.delete(args.departmentId);
    // Mark function summary as stale
    await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
      functionId,
    });
  },
});
