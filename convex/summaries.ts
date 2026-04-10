import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth, checkRoleFromUser } from "./lib/auth";

// --- Shared Prompt Constants ---

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

// On-demand department summary with token guard and persistence
export const generateDepartmentSummary = action({
  args: {
    departmentId: v.id("departments"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ summary: string | null; message: string | null }> => {
    const identity = await requireAuth(ctx);
    const user = await ctx.runQuery(
      internal.postCall.getUserByToken,
      { tokenIdentifier: identity.tokenIdentifier },
    );
    checkRoleFromUser(user, "contributor");

    // Token guard: skip LLM call if summary is fresh
    const dept: Doc<"departments"> | null = await ctx.runQuery(
      internal.summariesHelpers.getDepartment,
      { departmentId: args.departmentId },
    );
    if (!dept) {
      return {
        summary: null as string | null,
        message: "Department not found." as string | null,
      };
    }

    if (
      !args.forceRefresh &&
      dept.summary &&
      dept.summaryStale === false
    ) {
      return { summary: dept.summary as string | null, message: null as string | null };
    }

    const processSummaries: Array<{ processName: string; summary: string }> =
      await ctx.runQuery(
        internal.summariesHelpers.getProcessSummariesByDepartment,
        { departmentId: args.departmentId },
      );

    if (processSummaries.length === 0) {
      return {
        summary: null as string | null,
        message: "No process summaries available yet. Record conversations for the processes in this department first." as string | null,
      };
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      return {
        summary: null as string | null,
        message: "Summary generation is not configured (missing API key)." as string | null,
      };
    }

    const summaryBlock = processSummaries
      .map(
        (s: { processName: string; summary: string }) =>
          `[Process: ${s.processName}]\n${s.summary}`,
      )
      .join("\n\n");

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4.5",
          messages: [
            { role: "system", content: DEPARTMENT_SUMMARY_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Here are the process summaries for this department:\n\n${summaryBlock}`,
            },
          ],
          max_tokens: 8192,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter API error:", response.status, errorText);
      return {
        summary: null as string | null,
        message: "Failed to generate summary. Please try again." as string | null,
      };
    }

    const result = await response.json();
    const generated: string | null = result.choices?.[0]?.message?.content?.trim() ?? null;

    if (!generated) {
      return {
        summary: null as string | null,
        message: "Failed to generate summary. Please try again." as string | null,
      };
    }

    // Persist the summary
    await ctx.runMutation(internal.summariesHelpers.saveDepartmentSummary, {
      departmentId: args.departmentId,
      summary: generated,
    });

    return { summary: generated as string | null, message: null as string | null };
  },
});

// On-demand function summary with token guard, cascade generation, and persistence
export const generateFunctionSummary = action({
  args: {
    functionId: v.id("functions"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ summary: string | null; message: string | null }> => {
    const identity = await requireAuth(ctx);
    const user = await ctx.runQuery(
      internal.postCall.getUserByToken,
      { tokenIdentifier: identity.tokenIdentifier },
    );
    checkRoleFromUser(user, "contributor");

    // Token guard: skip LLM call if summary is fresh
    const func: Doc<"functions"> | null = await ctx.runQuery(
      internal.summariesHelpers.getFunction,
      { functionId: args.functionId },
    );
    if (!func) {
      return {
        summary: null as string | null,
        message: "Function not found." as string | null,
      };
    }

    if (
      !args.forceRefresh &&
      func.summary &&
      func.summaryStale === false
    ) {
      return { summary: func.summary as string | null, message: null as string | null };
    }

    // Fetch department-level summaries
    const deptSummaries: Array<{
      departmentId: Id<"departments">;
      departmentName: string;
      summary: string | null;
    }> = await ctx.runQuery(
      internal.summariesHelpers.getDepartmentSummariesByFunction,
      { functionId: args.functionId },
    );

    if (deptSummaries.length === 0) {
      return {
        summary: null as string | null,
        message: "No departments exist under this function yet." as string | null,
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
        // Auto-generate this department's summary
        const genResult: { summary: string | null; message: string | null } =
          await ctx.runAction(internal.summariesHelpers.generateDepartmentSummaryInternal, {
            departmentId: dept.departmentId,
          });
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
        summary: null as string | null,
        message: "No department summaries available yet. Record conversations for the processes first." as string | null,
      };
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      return {
        summary: null as string | null,
        message: "Summary generation is not configured (missing API key)." as string | null,
      };
    }

    const summaryBlock = deptResults
      .map(
        (s: { departmentName: string; summary: string }) =>
          `[Department: ${s.departmentName}]\n${s.summary}`,
      )
      .join("\n\n");

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4.5",
          messages: [
            { role: "system", content: FUNCTION_SUMMARY_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Here are the department summaries for this function:\n\n${summaryBlock}`,
            },
          ],
          max_tokens: 8192,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter API error:", response.status, errorText);
      return {
        summary: null as string | null,
        message: "Failed to generate summary. Please try again." as string | null,
      };
    }

    const result = await response.json();
    const summary: string | null = result.choices?.[0]?.message?.content?.trim() ?? null;

    if (!summary) {
      return {
        summary: null as string | null,
        message: "Failed to generate summary. Please try again." as string | null,
      };
    }

    // Persist the summary
    await ctx.runMutation(internal.summariesHelpers.saveFunctionSummary, {
      functionId: args.functionId,
      summary,
    });

    return { summary, message: null as string | null };
  },
});

// Public action: force-refresh a process rolling summary (rebuilds from all transcripts)
export const forceRefreshProcessSummary = action({
  args: {
    processId: v.id("processes"),
  },
  handler: async (ctx, args): Promise<{ message: string | null }> => {
    const identity = await requireAuth(ctx);
    const user = await ctx.runQuery(
      internal.postCall.getUserByToken,
      { tokenIdentifier: identity.tokenIdentifier },
    );
    checkRoleFromUser(user, "contributor");
    await ctx.scheduler.runAfter(0, internal.postCall.regenerateProcessSummary, {
      processId: args.processId,
      forceRefresh: true,
    });
    return { message: null as string | null };
  },
});
