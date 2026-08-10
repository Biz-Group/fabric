import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireOrgMember } from "./lib/orgAuth";
import {
  derivePendingWorkStatus,
  emptyConversationCounts,
  getConversationCounts,
  groupConversationsByProcess,
  PENDING_WORK_LABELS,
  summarizeFlow,
} from "./readModelHelpers";
import { getSummaryListMetadata } from "./summaryV2";
import { readableSummaryV2 } from "./lib/summaryV2Feature";

const MAX_FUNCTIONS = 200;
const MAX_DEPARTMENTS = 1000;
const MAX_PROCESSES = 2000;
const MAX_CONVERSATIONS = 5000;
const MAX_PROCESS_FLOWS = 2000;

function sortBySortOrder<T extends { sortOrder: number; _creationTime: number }>(
  rows: T[],
) {
  return rows.sort(
    (a, b) => a.sortOrder - b.sortOrder || a._creationTime - b._creationTime,
  );
}

export const getTree = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgMember(ctx);

    const functions = sortBySortOrder(
      await ctx.db
        .query("functions")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
        .take(MAX_FUNCTIONS),
    );
    const departments = sortBySortOrder(
      await ctx.db
        .query("departments")
        .withIndex("by_clerkOrgId_and_functionId", (q) =>
          q.eq("clerkOrgId", caller.orgId),
        )
        .take(MAX_DEPARTMENTS),
    );
    const processes = sortBySortOrder(
      await ctx.db
        .query("processes")
        .withIndex("by_clerkOrgId_and_departmentId", (q) =>
          q.eq("clerkOrgId", caller.orgId),
        )
        .take(MAX_PROCESSES),
    );
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId),
      )
      .take(MAX_CONVERSATIONS);
    const flows = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId),
      )
      .take(MAX_PROCESS_FLOWS);

    const departmentsByFunction = new Map<
      Id<"functions">,
      Doc<"departments">[]
    >();
    for (const department of departments) {
      const current = departmentsByFunction.get(department.functionId) ?? [];
      current.push(department);
      departmentsByFunction.set(department.functionId, current);
    }

    const processesByDepartment = new Map<
      Id<"departments">,
      Doc<"processes">[]
    >();
    for (const process of processes) {
      const current = processesByDepartment.get(process.departmentId) ?? [];
      current.push(process);
      processesByDepartment.set(process.departmentId, current);
    }

    const conversationsByProcess = groupConversationsByProcess(conversations);
    const flowByProcess = new Map<Id<"processes">, Doc<"processFlows">>();
    for (const flow of flows) {
      flowByProcess.set(flow.processId, flow);
    }

    return {
      limits: {
        functions: MAX_FUNCTIONS,
        departments: MAX_DEPARTMENTS,
        processes: MAX_PROCESSES,
        conversations: MAX_CONVERSATIONS,
        processFlows: MAX_PROCESS_FLOWS,
      },
      truncated: {
        functions: functions.length === MAX_FUNCTIONS,
        departments: departments.length === MAX_DEPARTMENTS,
        processes: processes.length === MAX_PROCESSES,
        conversations: conversations.length === MAX_CONVERSATIONS,
        processFlows: flows.length === MAX_PROCESS_FLOWS,
      },
      functions: functions.map((fn) => {
        const childDepartments = departmentsByFunction.get(fn._id) ?? [];
        return {
          _id: fn._id,
          _creationTime: fn._creationTime,
          name: fn.name,
          sortOrder: fn.sortOrder,
          summary: fn.summary ?? null,
          summaryUpdatedAt: fn.summaryUpdatedAt ?? null,
          summaryStale: fn.summaryStale ?? false,
          summaryOverview: getSummaryListMetadata({
            summaryV2: readableSummaryV2(fn.clerkOrgId, fn.summaryV2),
            legacyMarkdown: fn.summary,
            legacyGeneratedAt: fn.summaryUpdatedAt,
            stale: fn.summaryStale,
            refreshScheduledAt: fn.summaryRegenScheduledAt,
            lastRunState: fn.summaryV2LastRunState,
            lastRunCompletedAt: fn.summaryV2LastCompletedAt,
          }),
          departmentCount: childDepartments.length,
          departments: childDepartments.map((department) => {
            const childProcesses =
              processesByDepartment.get(department._id) ?? [];
            return {
              _id: department._id,
              _creationTime: department._creationTime,
              functionId: department.functionId,
              name: department.name,
              description: department.description ?? null,
              sortOrder: department.sortOrder,
              summary: department.summary ?? null,
              summaryUpdatedAt: department.summaryUpdatedAt ?? null,
              summaryStale: department.summaryStale ?? false,
              summaryOverview: getSummaryListMetadata({
                summaryV2: readableSummaryV2(department.clerkOrgId, department.summaryV2),
                legacyMarkdown: department.summary,
                legacyGeneratedAt: department.summaryUpdatedAt,
                stale: department.summaryStale,
                refreshScheduledAt: department.summaryRegenScheduledAt,
                lastRunState: department.summaryV2LastRunState,
                lastRunCompletedAt: department.summaryV2LastCompletedAt,
              }),
              processCount: childProcesses.length,
              processes: childProcesses.map((process) => {
                const processConversations =
                  conversationsByProcess.get(process._id) ?? [];
                const counts =
                  processConversations.length > 0
                    ? getConversationCounts(processConversations)
                    : emptyConversationCounts();
                const pendingWorkStatus = derivePendingWorkStatus(counts);
                const flowSummary = summarizeFlow(
                  flowByProcess.get(process._id) ?? null,
                  counts.done,
                );

                return {
                  _id: process._id,
                  _creationTime: process._creationTime,
                  departmentId: process.departmentId,
                  name: process.name,
                  description: process.description ?? null,
                  sortOrder: process.sortOrder,
                  hasSummary: Boolean(process.rollingSummary?.trim()),
                  summaryOverview: getSummaryListMetadata({
                    summaryV2: readableSummaryV2(process.clerkOrgId, process.summaryV2),
                    legacyMarkdown: process.rollingSummary,
                    legacyGeneratedAt: process.summaryUpdatedAt,
                    stale:
                      process.summaryStale === true ||
                      Boolean(
                        process.summaryV2 &&
                          process.summaryV2SourceRevision !==
                            (process.summaryEvidenceRevision ?? 0),
                      ),
                    refreshScheduledAt: process.summaryRegenScheduledAt,
                    lastRunState: process.summaryV2LastRunState,
                    lastRunCompletedAt: process.summaryV2LastCompletedAt,
                  }),
                  conversationCounts: counts,
                  conversationCount: counts.total,
                  pendingWorkStatus,
                  pendingWorkLabel: PENDING_WORK_LABELS[pendingWorkStatus],
                  needsAttention: counts.needsSpeakerLabels > 0,
                  stale: flowSummary?.stale ?? false,
                  flow: flowSummary,
                };
              }),
            };
          }),
        };
      }),
    };
  },
});
