import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { resolveOrgForAction } from "./lib/orgAuth";
import {
  AITruncationError,
  assertCompletionNotTruncated,
  generateAICompletion,
  isAIConfigured,
} from "./lib/aiProvider";

// --- Shared Prompt Constants ---

// Rollup summaries are bounded markdown briefs, but their input grows with the
// org, so the output can too. Truncated output is never saved — see the
// AITruncationError branches below.
const ROLLUP_SUMMARY_MAX_TOKENS = 8192;

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

const FUNCTION_SUMMARY_SYSTEM_PROMPT = `You are an analyst synthesizing department-level summaries for an organizational function into a structured brief. Your output must use the following markdown format exactly:

## Overview
High-level summary of how this function operates as a whole (2-3 sentences).

## Cross-Department Patterns
How departments relate — shared dependencies, organizational handoffs. Cite the source department using [Dept name] format — e.g., "Both [Payroll] and [Treasury] depend on the same HRIS data feed."

## Strategic Themes
Recurring patterns across departments — common tooling, shared constraints, workforce themes. Cite which departments share each theme.

## Tensions & Gaps
Cross-departmental contradictions or organizational blind spots. Be specific about which departments are affected.

## Notable Details
Department-specific findings worth escalating to the function level. Cite the source department.

Rules:
- Always cite departments using [Dept name] format.
- Write in clear, concise prose within each section.
- If there is only one department, note that a fuller picture will emerge as more departments are documented.
- Output ONLY the markdown sections above, nothing else.`;

// --- Summary Generation Actions ---

export const generateDepartmentSummary = action({
  args: {
    departmentId: v.id("departments"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ summary: string | null; message: string | null }> => {
    const { orgId } = await resolveOrgForAction(ctx);
    await ctx.runQuery(internal.postCall.requireOrgContributorInternal, {});

    const dept: Doc<"departments"> | null = await ctx.runQuery(
      internal.summariesHelpers.getDepartment,
      { departmentId: args.departmentId, clerkOrgId: orgId },
    );
    if (!dept) {
      return { summary: null, message: "Department not found." };
    }

    if (!args.forceRefresh && dept.summary && dept.summaryStale === false) {
      return { summary: dept.summary, message: null };
    }

    const processSummaries: Array<{
      processName: string;
      summary: string;
    }> = await ctx.runQuery(
      internal.summariesHelpers.getProcessSummariesByDepartment,
      { departmentId: args.departmentId, clerkOrgId: orgId },
    );

    if (processSummaries.length === 0) {
      return {
        summary: null,
        message:
          "No process summaries available yet. Record conversations for the processes in this department first.",
      };
    }

    if (!isAIConfigured("synthesis")) {
      return {
        summary: null,
        message: "Summary generation is not configured (missing API key).",
      };
    }

    const summaryBlock = processSummaries
      .map((s) => `[Process: ${s.processName}]\n${s.summary}`)
      .join("\n\n");

    let generated: string | null;
    try {
      const completion = await generateAICompletion({
        capability: "synthesis",
        operation: "department-summary",
        system: DEPARTMENT_SUMMARY_SYSTEM_PROMPT,
        user: `Here are the process summaries for this department:\n\n${summaryBlock}`,
        maxTokens: ROLLUP_SUMMARY_MAX_TOKENS,
      });
      assertCompletionNotTruncated(
        completion,
        "department-summary",
        ROLLUP_SUMMARY_MAX_TOKENS,
      );
      generated = completion.text;
    } catch (error) {
      if (error instanceof AITruncationError) {
        console.error(error.message);
        return {
          summary: null,
          message:
            "This department has too much content to summarize in one pass. Try again, or summarize fewer processes.",
        };
      }
      return {
        summary: null,
        message: "Failed to generate summary. Please try again.",
      };
    }

    if (!generated) {
      return {
        summary: null,
        message: "Failed to generate summary. Please try again.",
      };
    }

    await ctx.runMutation(internal.summariesHelpers.saveDepartmentSummary, {
      departmentId: args.departmentId,
      summary: generated,
    });

    return { summary: generated, message: null };
  },
});

export const generateFunctionSummary = action({
  args: {
    functionId: v.id("functions"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ summary: string | null; message: string | null }> => {
    const { orgId } = await resolveOrgForAction(ctx);
    await ctx.runQuery(internal.postCall.requireOrgContributorInternal, {});

    const func: Doc<"functions"> | null = await ctx.runQuery(
      internal.summariesHelpers.getFunction,
      { functionId: args.functionId, clerkOrgId: orgId },
    );
    if (!func) {
      return { summary: null, message: "Function not found." };
    }

    if (!args.forceRefresh && func.summary && func.summaryStale === false) {
      return { summary: func.summary, message: null };
    }

    const deptSummaries: Array<{
      departmentId: Id<"departments">;
      departmentName: string;
      summary: string | null;
    }> = await ctx.runQuery(
      internal.summariesHelpers.getDepartmentSummariesByFunction,
      { functionId: args.functionId, clerkOrgId: orgId },
    );

    if (deptSummaries.length === 0) {
      return {
        summary: null,
        message: "No departments exist under this function yet.",
      };
    }

    // Cascade generation: generate missing department summaries first
    const deptResults: Array<{ departmentName: string; summary: string }> = [];
    for (const dept of deptSummaries) {
      if (dept.summary) {
        deptResults.push({
          departmentName: dept.departmentName,
          summary: dept.summary,
        });
      } else {
        const genResult: {
          summary: string | null;
          message: string | null;
        } = await ctx.runAction(
          internal.summariesHelpers.generateDepartmentSummaryInternal,
          { departmentId: dept.departmentId, clerkOrgId: orgId },
        );
        if (genResult.summary) {
          deptResults.push({
            departmentName: dept.departmentName,
            summary: genResult.summary,
          });
        }
      }
    }

    if (deptResults.length === 0) {
      return {
        summary: null,
        message:
          "No department summaries available yet. Record conversations for the processes first.",
      };
    }

    if (!isAIConfigured("synthesis")) {
      return {
        summary: null,
        message: "Summary generation is not configured (missing API key).",
      };
    }

    const summaryBlock = deptResults
      .map((s) => `[Department: ${s.departmentName}]\n${s.summary}`)
      .join("\n\n");

    let summary: string | null;
    try {
      const completion = await generateAICompletion({
        capability: "synthesis",
        operation: "function-summary",
        system: FUNCTION_SUMMARY_SYSTEM_PROMPT,
        user: `Here are the department summaries for this function:\n\n${summaryBlock}`,
        maxTokens: ROLLUP_SUMMARY_MAX_TOKENS,
      });
      assertCompletionNotTruncated(
        completion,
        "function-summary",
        ROLLUP_SUMMARY_MAX_TOKENS,
      );
      summary = completion.text;
    } catch (error) {
      if (error instanceof AITruncationError) {
        console.error(error.message);
        return {
          summary: null,
          message:
            "This function has too much content to summarize in one pass. Try again, or summarize fewer departments.",
        };
      }
      return {
        summary: null,
        message: "Failed to generate summary. Please try again.",
      };
    }

    if (!summary) {
      return {
        summary: null,
        message: "Failed to generate summary. Please try again.",
      };
    }

    await ctx.runMutation(internal.summariesHelpers.saveFunctionSummary, {
      functionId: args.functionId,
      summary,
    });

    return { summary, message: null };
  },
});

export const forceRefreshProcessSummary = action({
  args: {
    processId: v.id("processes"),
  },
  handler: async (ctx, args): Promise<{ message: string | null }> => {
    const { orgId } = await resolveOrgForAction(ctx);
    await ctx.runQuery(internal.postCall.requireOrgContributorInternal, {});
    // Through the gate, not straight to the action: a manual rebuild pressed
    // while conversations are still landing should join the in-flight run
    // rather than start a competing one.
    await ctx.runMutation(internal.postCall.requestProcessSummaryRegen, {
      processId: args.processId,
      clerkOrgId: orgId,
      forceRefresh: true,
    });
    return { message: null };
  },
});
