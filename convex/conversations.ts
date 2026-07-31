import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  assertOrgOwns,
  requireOrgAdmin,
  requireOrgMember,
  resolveOrgForAction,
} from "./lib/orgAuth";
import { conversationTitle } from "./lib/conversationTitle";

const DEFAULT_COMPACT_CONVERSATION_LIMIT = 50;
const MAX_COMPACT_CONVERSATION_LIMIT = 100;

export const listByProcess = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.processId);
    if (!parent || parent.clerkOrgId !== caller.orgId) return [];
    return await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
      )
      .order("desc")
      .take(200);
  },
});

export const listCompactByProcess = query({
  args: {
    processId: v.id("processes"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.processId);
    if (!parent || parent.clerkOrgId !== caller.orgId) return [];

    const requestedLimit =
      args.limit === undefined
        ? DEFAULT_COMPACT_CONVERSATION_LIMIT
        : Math.floor(args.limit);
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      MAX_COMPACT_CONVERSATION_LIMIT,
    );

    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
      )
      .order("desc")
      .take(limit);

    return rows.map((conversation) => ({
      _id: conversation._id,
      _creationTime: conversation._creationTime,
      processId: conversation.processId,
      contributorName: conversation.contributorName,
      userId: conversation.userId ?? null,
      subjectUserId: conversation.subjectUserId ?? null,
      submittedByName: conversation.submittedByName ?? null,
      inputMode: conversation.inputMode ?? "agent",
      status: conversation.status,
      // Falls back to the analysis blob so rows written before the `title`
      // column existed are still titled by what was discussed.
      title: conversationTitle(conversation) ?? null,
      durationSeconds: conversation.durationSeconds ?? null,
      hasAudio: Boolean(
        conversation.elevenlabsConversationId || conversation.audioStorageId,
      ),
      hasTranscript: Boolean(conversation.transcript?.length),
      hasSummary: Boolean(conversation.summary?.trim()),
      needsSpeakerLabels: conversation.status === "needs_speaker_labels",
    }));
  },
});

// Process ids in the caller's org that have at least one conversation awaiting
// speaker labels — the actionable state a contributor can resolve inline. Reads
// the `by_clerkOrgId_and_status` index, so it returns only the (typically few)
// pending rows rather than scanning every conversation. Used to flag rows with
// an "attention" dot in the navigator.
export const processIdsNeedingAttention = query({
  args: {},
  handler: async (ctx): Promise<Id<"processes">[]> => {
    const caller = await requireOrgMember(ctx);
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_status", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("status", "needs_speaker_labels"),
      )
      .take(500);
    const ids = new Set<Id<"processes">>();
    for (const row of rows) ids.add(row.processId);
    return [...ids];
  },
});

// ---------------------------------------------------------------------------
// Admin surface — org-wide listing, delete, retry. Every query/mutation/action
// is gated by `requireOrgAdmin` (or equivalent) and filters strictly by
// `caller.orgId` derived from the JWT.
// ---------------------------------------------------------------------------

type ConversationRow = Doc<"conversations"> & {
  processName: string | null;
  departmentName: string | null;
  functionName: string | null;
};

/**
 * Admin-only. Paginated listing of every conversation in the caller's org,
 * joined with process/department/function names. Optional `status` filter uses
 * the existing `by_clerkOrgId_and_status` index. Optional `processId` filter
 * uses `by_clerkOrgId_and_processId` and assert-owns the process before
 * applying.
 */
export const listAllForOrg = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(
      v.union(
        v.literal("processing"),
        v.literal("needs_speaker_labels"),
        v.literal("done"),
        v.literal("failed"),
      ),
    ),
    processId: v.optional(v.id("processes")),
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgAdmin(ctx);

    // If a processId is supplied, assert it belongs to the caller's org first.
    // This prevents a malicious caller from confirming a cross-tenant id exists
    // via an empty result vs. a thrown error — instead we normalize to empty.
    if (args.processId) {
      const process = await ctx.db.get(args.processId);
      if (!process || process.clerkOrgId !== caller.orgId) {
        return { page: [], isDone: true, continueCursor: "" };
      }
    }

    // Pick the narrowest index available given the provided filters.
    const base =
      args.processId !== undefined
        ? ctx.db
            .query("conversations")
            .withIndex("by_clerkOrgId_and_processId", (q) =>
              q
                .eq("clerkOrgId", caller.orgId)
                .eq("processId", args.processId!),
            )
        : args.status !== undefined
          ? ctx.db
              .query("conversations")
              .withIndex("by_clerkOrgId_and_status", (q) =>
                q.eq("clerkOrgId", caller.orgId).eq("status", args.status!),
              )
          : ctx.db
              .query("conversations")
              .withIndex("by_clerkOrgId", (q) =>
                q.eq("clerkOrgId", caller.orgId),
              );

    // If both processId and status are provided, drop to a post-filter for the
    // remaining dimension.
    const filtered =
      args.processId !== undefined && args.status !== undefined
        ? base.filter((q) => q.eq(q.field("status"), args.status))
        : base;

    const result = await filtered.order("desc").paginate(args.paginationOpts);

    // Join each conversation with its process/department/function names.
    const processCache = new Map<Id<"processes">, Doc<"processes"> | null>();
    const departmentCache = new Map<Id<"departments">, Doc<"departments"> | null>();
    const functionCache = new Map<Id<"functions">, Doc<"functions"> | null>();

    const joined: ConversationRow[] = await Promise.all(
      result.page.map(async (conv) => {
        let processName: string | null = null;
        let departmentName: string | null = null;
        let functionName: string | null = null;

        let process = processCache.get(conv.processId);
        if (process === undefined) {
          process = await ctx.db.get(conv.processId);
          processCache.set(conv.processId, process);
        }

        // Defense-in-depth: if the join somehow crosses org boundaries, leave
        // the name blank rather than leaking another tenant's label.
        if (process && process.clerkOrgId === caller.orgId) {
          processName = process.name;

          let department = departmentCache.get(process.departmentId);
          if (department === undefined) {
            department = await ctx.db.get(process.departmentId);
            departmentCache.set(process.departmentId, department);
          }
          if (department && department.clerkOrgId === caller.orgId) {
            departmentName = department.name;

            let fn = functionCache.get(department.functionId);
            if (fn === undefined) {
              fn = await ctx.db.get(department.functionId);
              functionCache.set(department.functionId, fn);
            }
            if (fn && fn.clerkOrgId === caller.orgId) {
              functionName = fn.name;
            }
          }
        }

        return { ...conv, processName, departmentName, functionName };
      }),
    );

    return { ...result, page: joined };
  },
});

/**
 * Admin-only. Single-conversation fetch for the transcript viewer. Ownership
 * is enforced via `assertOrgOwns`, which throws "Not found" (never leaks
 * existence) when the conversation belongs to a different org.
 */
export const getForAdmin = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const caller = await requireOrgAdmin(ctx);
    const conv = await ctx.db.get(args.conversationId);
    assertOrgOwns(caller, conv);
    return conv;
  },
});

/**
 * Admin-only. Count conversations for the caller's org — optionally filtered
 * by status and/or a `since` creation timestamp. Used by the overview
 * dashboard's stat cards.
 */
export const countForOrg = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("processing"),
        v.literal("needs_speaker_labels"),
        v.literal("done"),
        v.literal("failed"),
      ),
    ),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgAdmin(ctx);
    const rows =
      args.status !== undefined
        ? await ctx.db
            .query("conversations")
            .withIndex("by_clerkOrgId_and_status", (q) =>
              q.eq("clerkOrgId", caller.orgId).eq("status", args.status!),
            )
            .collect()
        : await ctx.db
            .query("conversations")
            .withIndex("by_clerkOrgId_and_processId", (q) =>
              q.eq("clerkOrgId", caller.orgId),
            )
            .collect();

    const since = args.since;
    if (since === undefined) return rows.length;
    return rows.filter((r) => r._creationTime >= since).length;
  },
});

/**
 * Admin-only. Deletes a conversation. Re-asserts org ownership even though the
 * caller's admin role is already verified — `assertOrgOwns` is the
 * defense-in-depth layer that prevents a caller from targeting a different
 * org's row by id. After deletion we schedule a full summary rebuild for the
 * parent process so the rolling summary stays consistent.
 */
export const deleteForAdmin = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const caller = await requireOrgAdmin(ctx);
    const conv = await ctx.db.get(args.conversationId);
    assertOrgOwns(caller, conv);

    const processId = conv.processId;
    const deletedDoneConversation = conv.status === "done";
    if (conv.audioStorageId) {
      try {
        await ctx.storage.delete(conv.audioStorageId);
      } catch {
        // Storage may already have been removed by an abandonment/retry path.
        // The conversation row is the access-control source of truth.
      }
    }
    await ctx.db.delete(args.conversationId);

    if (!deletedDoneConversation) return;

    const remainingDone = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId_and_status", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("processId", processId)
          .eq("status", "done"),
      )
      .take(1);

    if (remainingDone.length > 0) {
      await ctx.runMutation(internal.processFlows.markFlowStale, {
        processId,
        clerkOrgId: caller.orgId,
      });
      const process = await ctx.db.get(processId);
      if (process && process.clerkOrgId === caller.orgId) {
        await ctx.runMutation(
          internal.summariesHelpers.markDepartmentSummaryStale,
          { departmentId: process.departmentId },
        );
      }
      // Rebuild the parent process summary from scratch — the deleted
      // conversation may have contributed citations/content to the incremental
      // summary, so a full rebuild is the safe option.
      await ctx.scheduler.runAfter(
        0,
        internal.postCall.regenerateProcessSummary,
        {
          processId,
          clerkOrgId: caller.orgId,
          forceRefresh: true,
        },
      );
      return;
    }

    const process = await ctx.db.get(processId);
    if (!process || process.clerkOrgId !== caller.orgId) return;

    await ctx.db.patch(processId, { rollingSummary: undefined });
    await ctx.runMutation(internal.processFlows.deleteForProcess, {
      processId,
      clerkOrgId: caller.orgId,
    });

    const department = await ctx.db.get(process.departmentId);
    if (!department || department.clerkOrgId !== caller.orgId) return;

    const siblingProcesses = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("departmentId", process.departmentId),
      )
      .take(1000);
    const hasSummaries = siblingProcesses.some((p) => p.rollingSummary);
    if (hasSummaries) {
      await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
        departmentId: process.departmentId,
      });
    } else {
      await ctx.db.patch(process.departmentId, {
        summary: undefined,
        summaryUpdatedAt: undefined,
        summaryStale: undefined,
      });
      await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
        functionId: department.functionId,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Retry flow for failed conversations.
// ---------------------------------------------------------------------------

/** Internal. Loads a failed conversation for retry — verifies admin and
 * ownership, returns the fields needed to re-trigger the fetch. */
export const getFailedForRetry = internalQuery({
  args: {
    conversationId: v.id("conversations"),
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

    const conv = await ctx.db.get(args.conversationId);
    if (!conv || conv.clerkOrgId !== args.orgId) {
      throw new Error("Not found");
    }
    if (conv.status !== "failed") {
      throw new Error("Only failed conversations can be retried");
    }
    if ((conv.inputMode ?? "agent") !== "agent" || !conv.elevenlabsConversationId) {
      throw new Error("Only failed AI interview conversations can be retried");
    }

    return {
      conversationId: conv._id,
      processId: conv.processId,
      elevenlabsConversationId: conv.elevenlabsConversationId,
      // Carry the original on-behalf-of attribution across the retry. The retry
      // deletes and re-inserts the row, so without this the contributor would
      // be re-derived from the retrying admin's account and the interview would
      // be silently reattributed to them.
      wasOnBehalf: Boolean(conv.submittedByName),
      contributorName: conv.submittedByName ? conv.contributorName : undefined,
      subjectUserId: conv.submittedByName ? conv.subjectUserId : undefined,
    };
  },
});

/** Internal. Deletes the failed row so the retry can insert a fresh one. */
export const deleteFailedRow = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || conv.clerkOrgId !== args.orgId) {
      throw new Error("Not found");
    }
    if (conv.status !== "failed") {
      throw new Error("Only failed conversations can be retried");
    }
    await ctx.db.delete(args.conversationId);
  },
});

/**
 * Admin-only. Retries fetching a failed conversation from ElevenLabs.
 * Implementation: verify admin + ownership → delete the stale failed row →
 * call the existing `fetchConversation` action, which handles the polling,
 * insert, and summary rebuild end-to-end.
 */
type FetchResult = { status: "done" | "failed" | "processing" | "timeout" };

export const retryFetch = action({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<FetchResult> => {
    const { orgId, tokenIdentifier } = await resolveOrgForAction(ctx);
    const target = await ctx.runQuery(
      internal.conversations.getFailedForRetry,
      {
        conversationId: args.conversationId,
        orgId,
        callerTokenIdentifier: tokenIdentifier,
      },
    );

    // Delete the failed placeholder so fetchConversation can insert a fresh
    // row. The internal cleanup inherits the admin + ownership checks from
    // `getFailedForRetry` and re-validates org ownership before deleting.
    await ctx.runMutation(internal.conversations.deleteFailedRow, {
      conversationId: target.conversationId,
      orgId,
    });

    // Re-trigger the normal fetch pipeline. fetchConversation re-reads auth and
    // validates the caller is at least a contributor in the active org — which
    // admins already are.
    return (await ctx.runAction(api.postCall.fetchConversation, {
      elevenlabsConversationId: target.elevenlabsConversationId,
      processId: target.processId,
      contributorName: target.contributorName,
      subjectUserId: target.subjectUserId,
      // The original submitter already attested; a retry re-files an existing
      // record rather than making a fresh consent decision. The new row's
      // `submittedByName` becomes the retrying admin, which is accurate — theirs
      // is the account that re-filed it.
      consentAttested: target.wasOnBehalf ? true : undefined,
    })) as FetchResult;
  },
});
