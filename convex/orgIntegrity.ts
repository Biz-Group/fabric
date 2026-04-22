import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  MutationCtx,
} from "./_generated/server";

const AUDIT_LIMIT = 5000;
const RECOVERED_FUNCTION_NAME = "Recovered / Missing Parents";
const RECOVERED_DEPARTMENT_NAME = "Recovered / Missing Department";

async function getOrCreateRecoveredFunction(
  ctx: MutationCtx,
  clerkOrgId: string,
) {
  const functions = await ctx.db
    .query("functions")
    .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
    .take(AUDIT_LIMIT);
  const existing = functions.find((fn) => fn.name === RECOVERED_FUNCTION_NAME);
  if (existing) {
    return existing._id;
  }

  const maxSortOrder = functions.reduce(
    (max, fn) => Math.max(max, fn.sortOrder),
    0,
  );

  return await ctx.db.insert("functions", {
    name: RECOVERED_FUNCTION_NAME,
    sortOrder: maxSortOrder + 1,
    summaryStale: true,
    clerkOrgId,
  });
}

async function getOrCreateRecoveredDepartment(
  ctx: MutationCtx,
  clerkOrgId: string,
  functionId: Id<"functions">,
) {
  const departments = await ctx.db
    .query("departments")
    .withIndex("by_clerkOrgId_and_functionId", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("functionId", functionId),
    )
    .take(AUDIT_LIMIT);

  const existing = departments.find(
    (dept) => dept.name === RECOVERED_DEPARTMENT_NAME,
  );
  if (existing) {
    return existing._id;
  }

  const maxSortOrder = departments.reduce(
    (max, dept) => Math.max(max, dept.sortOrder),
    0,
  );

  return await ctx.db.insert("departments", {
    functionId,
    name: RECOVERED_DEPARTMENT_NAME,
    sortOrder: maxSortOrder + 1,
    summaryStale: true,
    clerkOrgId,
  });
}

/**
 * Scope-by-org audit: find orphaned parent references inside a single tenant.
 */
export const auditHierarchyIntegrity = internalQuery({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const functions = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(AUDIT_LIMIT);
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .take(AUDIT_LIMIT);
    const processes = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .take(AUDIT_LIMIT);
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .take(AUDIT_LIMIT);
    const processFlows = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .take(AUDIT_LIMIT);
    const users = await ctx.db.query("users").take(AUDIT_LIMIT);

    const functionIds = new Set(functions.map((fn) => fn._id));
    const departmentIds = new Set(departments.map((dept) => dept._id));
    const processIds = new Set(processes.map((process) => process._id));
    const userIds = new Set(users.map((user) => user._id));

    return {
      clerkOrgId: args.clerkOrgId,
      scanned: {
        functions: functions.length,
        departments: departments.length,
        processes: processes.length,
        conversations: conversations.length,
        processFlows: processFlows.length,
        users: users.length,
      },
      orphanDepartments: departments
        .filter((dept) => !functionIds.has(dept.functionId))
        .map((dept) => ({
          _id: dept._id,
          name: dept.name,
          functionId: dept.functionId,
        })),
      orphanProcesses: processes
        .filter((process) => !departmentIds.has(process.departmentId))
        .map((process) => ({
          _id: process._id,
          name: process.name,
          departmentId: process.departmentId,
        })),
      orphanConversationsByProcess: conversations
        .filter((conversation) => !processIds.has(conversation.processId))
        .map((conversation) => ({
          _id: conversation._id,
          processId: conversation.processId,
          elevenlabsConversationId: conversation.elevenlabsConversationId,
        })),
      orphanConversationsByUser: conversations
        .filter(
          (conversation) =>
            conversation.userId && !userIds.has(conversation.userId),
        )
        .map((conversation) => ({
          _id: conversation._id,
          userId: conversation.userId,
          elevenlabsConversationId: conversation.elevenlabsConversationId,
        })),
      orphanProcessFlows: processFlows
        .filter((flow) => !processIds.has(flow.processId))
        .map((flow) => ({
          _id: flow._id,
          processId: flow.processId,
          status: flow.status,
        })),
    };
  },
});

/**
 * Non-destructive repair for orphaned org-tree records. Scoped to a single
 * tenant — caller passes `clerkOrgId`. Existing processes keep their ids, so
 * conversations and flows stay attached.
 */
export const repairHierarchyOrphans = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const functions = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(AUDIT_LIMIT);
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .take(AUDIT_LIMIT);
    const processes = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .take(AUDIT_LIMIT);

    const functionIds = new Set(functions.map((fn) => fn._id));
    const departmentIds = new Set(departments.map((dept) => dept._id));

    const orphanDepartments = departments.filter(
      (dept) => !functionIds.has(dept.functionId),
    );
    const orphanProcesses = processes.filter(
      (process) => !departmentIds.has(process.departmentId),
    );

    if (orphanDepartments.length === 0 && orphanProcesses.length === 0) {
      return {
        repairedDepartments: 0,
        repairedProcesses: 0,
        recoveredFunctionId: null,
        recoveredDepartmentId: null,
      };
    }

    const recoveredFunctionId = await getOrCreateRecoveredFunction(
      ctx,
      args.clerkOrgId,
    );

    for (const dept of orphanDepartments) {
      await ctx.db.patch(dept._id, { functionId: recoveredFunctionId });
    }

    let recoveredDepartmentId: Id<"departments"> | null = null;
    if (orphanProcesses.length > 0) {
      recoveredDepartmentId = await getOrCreateRecoveredDepartment(
        ctx,
        args.clerkOrgId,
        recoveredFunctionId,
      );

      for (const process of orphanProcesses) {
        await ctx.db.patch(process._id, {
          departmentId: recoveredDepartmentId,
        });
      }
    }

    return {
      repairedDepartments: orphanDepartments.length,
      repairedProcesses: orphanProcesses.length,
      recoveredFunctionId,
      recoveredDepartmentId,
      orphanDepartmentIds: orphanDepartments.map((dept) => dept._id),
      orphanProcessIds: orphanProcesses.map((process) => process._id),
    };
  },
});

/**
 * Cross-org audit: scans every tenant table for rows missing `clerkOrgId`, or
 * rows whose `clerkOrgId` doesn't match their parent's. Used to verify the
 * widen-migrate-narrow pipeline before tightening the schema in Phase 13.8.
 */
export const auditAllOrgs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const functions = await ctx.db.query("functions").take(AUDIT_LIMIT);
    const departments = await ctx.db.query("departments").take(AUDIT_LIMIT);
    const processes = await ctx.db.query("processes").take(AUDIT_LIMIT);
    const conversations = await ctx.db.query("conversations").take(AUDIT_LIMIT);
    const processFlows = await ctx.db.query("processFlows").take(AUDIT_LIMIT);

    const functionOrgMap = new Map(
      functions.map((f) => [f._id, f.clerkOrgId ?? null]),
    );
    const departmentOrgMap = new Map(
      departments.map((d) => [d._id, d.clerkOrgId ?? null]),
    );
    const processOrgMap = new Map(
      processes.map((p) => [p._id, p.clerkOrgId ?? null]),
    );

    return {
      missingClerkOrgId: {
        functions: functions.filter((f) => !f.clerkOrgId).length,
        departments: departments.filter((d) => !d.clerkOrgId).length,
        processes: processes.filter((p) => !p.clerkOrgId).length,
        conversations: conversations.filter((c) => !c.clerkOrgId).length,
        processFlows: processFlows.filter((f) => !f.clerkOrgId).length,
      },
      // Child rows whose clerkOrgId doesn't match their parent's —
      // indicates a data integrity bug, not a backfill issue.
      orgMismatches: {
        departments: departments
          .filter(
            (d) =>
              d.clerkOrgId &&
              functionOrgMap.get(d.functionId) &&
              functionOrgMap.get(d.functionId) !== d.clerkOrgId,
          )
          .map((d) => ({
            _id: d._id,
            ownOrg: d.clerkOrgId,
            parentOrg: functionOrgMap.get(d.functionId),
          })),
        processes: processes
          .filter(
            (p) =>
              p.clerkOrgId &&
              departmentOrgMap.get(p.departmentId) &&
              departmentOrgMap.get(p.departmentId) !== p.clerkOrgId,
          )
          .map((p) => ({
            _id: p._id,
            ownOrg: p.clerkOrgId,
            parentOrg: departmentOrgMap.get(p.departmentId),
          })),
        conversations: conversations
          .filter(
            (c) =>
              c.clerkOrgId &&
              processOrgMap.get(c.processId) &&
              processOrgMap.get(c.processId) !== c.clerkOrgId,
          )
          .map((c) => ({
            _id: c._id,
            ownOrg: c.clerkOrgId,
            parentOrg: processOrgMap.get(c.processId),
          })),
        processFlows: processFlows
          .filter(
            (f) =>
              f.clerkOrgId &&
              processOrgMap.get(f.processId) &&
              processOrgMap.get(f.processId) !== f.clerkOrgId,
          )
          .map((f) => ({
            _id: f._id,
            ownOrg: f.clerkOrgId,
            parentOrg: processOrgMap.get(f.processId),
          })),
      },
    };
  },
});
