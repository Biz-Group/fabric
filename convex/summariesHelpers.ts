import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";

// --- Staleness Propagation ---

export const markFunctionSummaryStale = internalMutation({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.functionId, { summaryStale: true });
  },
});

export const markDepartmentSummaryStale = internalMutation({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const dept = await ctx.db.get(args.departmentId);
    if (!dept) return;
    await ctx.db.patch(args.departmentId, { summaryStale: true });
    // Cascade to the parent function
    const _cascade: null = await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
      functionId: dept.functionId,
    });
  },
});

// --- Save Mutations ---

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

// --- Internal Queries ---

// Gather all process rolling summaries under a department
export const getProcessSummariesByDepartment = internalQuery({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const processes = await ctx.db
      .query("processes")
      .withIndex("by_departmentId", (q) =>
        q.eq("departmentId", args.departmentId),
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

// Gather department-level summaries for a function (used by function summary generation)
export const getDepartmentSummariesByFunction = internalQuery({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId))
      .collect();

    return departments.map((dept) => ({
      departmentId: dept._id,
      departmentName: dept.name,
      summary: dept.summary ?? null,
    }));
  },
});

// Get department doc for token guard check
export const getDepartment = internalQuery({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.departmentId);
  },
});

// Get function doc for token guard check
export const getFunction = internalQuery({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.functionId);
  },
});

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

// Internal version of generateDepartmentSummary for cascade calls (no auth needed)
export const generateDepartmentSummaryInternal = internalAction({
  args: {
    departmentId: v.id("departments"),
  },
  handler: async (ctx, args): Promise<{ summary: string | null; message: string | null }> => {
    const dept: Doc<"departments"> | null = await ctx.runQuery(
      internal.summariesHelpers.getDepartment,
      { departmentId: args.departmentId },
    );
    if (!dept) {
      return { summary: null as string | null, message: "Department not found." as string | null };
    }

    // If a fresh summary already exists, return it
    if (dept.summary && dept.summaryStale === false) {
      return { summary: dept.summary as string | null, message: null as string | null };
    }

    const processSummaries: Array<{ processName: string; summary: string }> =
      await ctx.runQuery(
        internal.summariesHelpers.getProcessSummariesByDepartment,
        { departmentId: args.departmentId },
      );

    if (processSummaries.length === 0) {
      return { summary: null as string | null, message: "No process summaries available." as string | null };
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      return { summary: null as string | null, message: "Missing API key." as string | null };
    }

    const summaryBlock = processSummaries
      .map((s) => `[Process: ${s.processName}]\n${s.summary}`)
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
            { role: "user", content: `Here are the process summaries for this department:\n\n${summaryBlock}` },
          ],
          max_tokens: 8192,
        }),
      },
    );

    if (!response.ok) {
      return { summary: null as string | null, message: "Failed to generate summary." as string | null };
    }

    const result = await response.json();
    const generated = result.choices?.[0]?.message?.content?.trim() ?? null;
    if (!generated) {
      return { summary: null as string | null, message: "Failed to generate summary." as string | null };
    }

    const _save: null = await ctx.runMutation(internal.summariesHelpers.saveDepartmentSummary, {
      departmentId: args.departmentId,
      summary: generated,
    });

    return { summary: generated as string | null, message: null as string | null };
  },
});
