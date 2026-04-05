import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";

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

// Gather all process rolling summaries under a function (across all departments)
export const getProcessSummariesByFunction = internalQuery({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId))
      .collect();

    const results: Array<{
      departmentName: string;
      processName: string;
      summary: string;
    }> = [];

    for (const dept of departments) {
      const processes = await ctx.db
        .query("processes")
        .withIndex("by_departmentId", (q) =>
          q.eq("departmentId", dept._id),
        )
        .collect();

      for (const proc of processes) {
        if (proc.rollingSummary) {
          results.push({
            departmentName: dept.name,
            processName: proc.name,
            summary: proc.rollingSummary,
          });
        }
      }
    }

    return results;
  },
});

// On-demand department summary: concatenates child process summaries and synthesizes
export const generateDepartmentSummary = action({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);

    const processSummaries: Array<{ processName: string; summary: string }> =
      await ctx.runQuery(
        internal.summaries.getProcessSummariesByDepartment,
        { departmentId: args.departmentId },
      );

    if (processSummaries.length === 0) {
      return {
        summary: null as string | null,
        message: "No process summaries available yet. Record conversations for the processes in this department first." as string | null,
      };
    }

    if (processSummaries.length === 1) {
      return {
        summary: `Based on the "${processSummaries[0].processName}" process: ${processSummaries[0].summary}` as string | null,
        message: null as string | null,
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

    const systemPrompt = `You are synthesizing process-level summaries for an organizational department. Combine these into a cohesive department-level overview that describes how the processes relate to each other, noting handoffs and dependencies between them. Write in clear, concise prose — no bullet points or headers. Output only the synthesized summary, nothing else.`;

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Here are the process summaries for this department:\n\n${summaryBlock}`,
            },
          ],
          max_tokens: 1024,
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

    return { summary, message: null as string | null };
  },
});

// On-demand function summary: concatenates all process summaries across departments
export const generateFunctionSummary = action({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);

    const processSummaries: Array<{
      departmentName: string;
      processName: string;
      summary: string;
    }> = await ctx.runQuery(
      internal.summaries.getProcessSummariesByFunction,
      { functionId: args.functionId },
    );

    if (processSummaries.length === 0) {
      return {
        summary: null as string | null,
        message: "No process summaries available yet. Record conversations for the processes in this function first." as string | null,
      };
    }

    if (processSummaries.length === 1) {
      return {
        summary: `Based on the "${processSummaries[0].processName}" process (${processSummaries[0].departmentName}): ${processSummaries[0].summary}` as string | null,
        message: null as string | null,
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
        (s: { departmentName: string; processName: string; summary: string }) =>
          `[${s.departmentName} > ${s.processName}]\n${s.summary}`,
      )
      .join("\n\n");

    const systemPrompt = `You are synthesizing process-level summaries for an organizational function. Combine these into a cohesive function-level overview that describes how the departments and processes work together, noting cross-departmental handoffs and dependencies. Write in clear, concise prose — no bullet points or headers. Output only the synthesized summary, nothing else.`;

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Here are the process summaries across departments for this function:\n\n${summaryBlock}`,
            },
          ],
          max_tokens: 1024,
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

    return { summary, message: null as string | null };
  },
});
