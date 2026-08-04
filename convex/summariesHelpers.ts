import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  AITruncationError,
  assertCompletionNotTruncated,
  isAIConfigured,
} from "./lib/aiProvider";
import { meteredCompletion } from "./lib/aiUsageMeter";

// ---------------------------------------------------------------------------
// Staleness propagation — internal mutations, always called from an org-scoped
// public entrypoint that already verified the parent belongs to the caller.
// Each internal still asserts org ownership defensively before mutating.
// ---------------------------------------------------------------------------

export const markFunctionSummaryStale = internalMutation({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const fn = await ctx.db.get(args.functionId);
    if (!fn) return;
    await ctx.db.patch(args.functionId, { summaryStale: true });
  },
});

export const markDepartmentSummaryStale = internalMutation({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const dept = await ctx.db.get(args.departmentId);
    if (!dept) return;
    await ctx.db.patch(args.departmentId, { summaryStale: true });
    await ctx.runMutation(
      internal.summariesHelpers.markFunctionSummaryStale,
      { functionId: dept.functionId },
    );
  },
});

// ---------------------------------------------------------------------------
// Save mutations
// ---------------------------------------------------------------------------

export const saveDepartmentSummary = internalMutation({
  args: {
    departmentId: v.id("departments"),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.departmentId, {
      summary: args.summary,
      summaryUpdatedAt: Date.now(),
      summaryStale: false,
    });
  },
});

export const saveFunctionSummary = internalMutation({
  args: {
    functionId: v.id("functions"),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.functionId, {
      summary: args.summary,
      summaryUpdatedAt: Date.now(),
      summaryStale: false,
    });
  },
});

// ---------------------------------------------------------------------------
// Internal queries — all accept clerkOrgId so the action-side callers can
// thread org context through without re-reading ctx.auth inside internals.
// ---------------------------------------------------------------------------

export const getProcessSummariesByDepartment = internalQuery({
  args: {
    departmentId: v.id("departments"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const dept = await ctx.db.get(args.departmentId);
    if (!dept || dept.clerkOrgId !== args.clerkOrgId) return [];
    const processes = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("departmentId", args.departmentId),
      )
      .collect();

    return processes
      .filter((p) => p.rollingSummary)
      .map((p) => ({
        processName: p.name,
        summary: p.rollingSummary!,
      }));
  },
});

export const getDepartmentSummariesByFunction = internalQuery({
  args: {
    functionId: v.id("functions"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const fn = await ctx.db.get(args.functionId);
    if (!fn || fn.clerkOrgId !== args.clerkOrgId) return [];
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("functionId", args.functionId),
      )
      .collect();

    return departments.map((dept) => ({
      departmentId: dept._id,
      departmentName: dept.name,
      summary: dept.summary ?? null,
    }));
  },
});

export const getDepartment = internalQuery({
  args: {
    departmentId: v.id("departments"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.departmentId);
    if (!doc || doc.clerkOrgId !== args.clerkOrgId) return null;
    return doc;
  },
});

export const getFunction = internalQuery({
  args: {
    functionId: v.id("functions"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.functionId);
    if (!doc || doc.clerkOrgId !== args.clerkOrgId) return null;
    return doc;
  },
});

// ---------------------------------------------------------------------------
// LLM prompts + internal action
// ---------------------------------------------------------------------------

// Mirrors ROLLUP_SUMMARY_MAX_TOKENS in summaries.ts — same prompt, same shape
// of output, reached through the cascade rather than a direct request.
const CASCADE_SUMMARY_MAX_TOKENS = 8192;

const DEPARTMENT_SUMMARY_SYSTEM_PROMPT = `You are an analyst synthesizing process-level summaries for an organizational department into a structured brief. Your output must use the following markdown format exactly:

## Overview
Executive summary of how this department operates (2-3 sentences).

## Cross-Process Handoffs
How processes feed into each other — inputs, outputs, and dependencies. Cite the source process using [Process name] format — e.g., "Output from [Compensation] feeds into [Bank Transfers] for payment execution."

## Shared Themes
Patterns that appear across multiple processes — common tools, shared bottlenecks, recurring pain points. Cite which processes share each theme.

## Tensions & Gaps
Contradictions between processes or uncovered gaps in the handoff chain. Be specific about which processes conflict and how.

## Notable Details
Unique findings from individual processes worth surfacing at the department level. Cite the source process.

Rules:
- Always cite processes using [Process name] format.
- Write in clear, concise prose within each section.
- If there is only one process, note that a fuller picture will emerge as more processes are documented.
- Output ONLY the markdown sections above, nothing else.`;

export const generateDepartmentSummaryInternal = internalAction({
  args: {
    departmentId: v.id("departments"),
    clerkOrgId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ summary: string | null; message: string | null }> => {
    const dept: Doc<"departments"> | null = await ctx.runQuery(
      internal.summariesHelpers.getDepartment,
      { departmentId: args.departmentId, clerkOrgId: args.clerkOrgId },
    );
    if (!dept) {
      return { summary: null, message: "Department not found." };
    }

    if (dept.summary && dept.summaryStale === false) {
      return { summary: dept.summary, message: null };
    }

    const processSummaries: Array<{
      processName: string;
      summary: string;
    }> = await ctx.runQuery(
      internal.summariesHelpers.getProcessSummariesByDepartment,
      { departmentId: args.departmentId, clerkOrgId: args.clerkOrgId },
    );

    if (processSummaries.length === 0) {
      return { summary: null, message: "No process summaries available." };
    }

    if (!isAIConfigured("synthesis")) {
      return { summary: null, message: "Missing API key." };
    }

    const summaryBlock = processSummaries
      .map((s) => `[Process: ${s.processName}]\n${s.summary}`)
      .join("\n\n");

    let generated: string | null;
    try {
      const completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: args.clerkOrgId,
          entityType: "department",
          entityId: args.departmentId,
          entityLabel: dept.name,
          // No actor: this is the cascade triggered by a conversation
          // completing, not a person pressing a button. Attributing it to
          // whoever happened to record last would be a lie.
        },
        {
          capability: "synthesis",
          operation: "department-summary-cascade",
          system: DEPARTMENT_SUMMARY_SYSTEM_PROMPT,
          user: `Here are the process summaries for this department:\n\n${summaryBlock}`,
          maxTokens: CASCADE_SUMMARY_MAX_TOKENS,
        },
      );
      assertCompletionNotTruncated(
        completion,
        "department-summary-cascade",
        CASCADE_SUMMARY_MAX_TOKENS,
      );
      generated = completion.text;
    } catch (error) {
      if (error instanceof AITruncationError) {
        console.error(error.message);
        return {
          summary: null,
          message: "Too much content to summarize in one pass.",
        };
      }
      return { summary: null, message: "Failed to generate summary." };
    }
    if (!generated) {
      return { summary: null, message: "Failed to generate summary." };
    }

    await ctx.runMutation(
      internal.summariesHelpers.saveDepartmentSummary,
      { departmentId: args.departmentId, summary: generated },
    );

    return { summary: generated, message: null };
  },
});
