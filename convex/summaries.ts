import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth } from "./lib/auth";

// --- Summary Generation Actions ---

// On-demand department summary with token guard and persistence
export const generateDepartmentSummary = action({
  args: {
    departmentId: v.id("departments"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ summary: string | null; message: string | null }> => {
    await requireAuth(ctx);

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

    let summary: string;

    if (processSummaries.length === 1) {
      summary = `Based on the "${processSummaries[0].processName}" process: ${processSummaries[0].summary}`;
    } else {
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
      const generated: string | null = result.choices?.[0]?.message?.content?.trim() ?? null;

      if (!generated) {
        return {
          summary: null as string | null,
          message: "Failed to generate summary. Please try again." as string | null,
        };
      }

      summary = generated;
    }

    // Persist the summary
    await ctx.runMutation(internal.summariesHelpers.saveDepartmentSummary, {
      departmentId: args.departmentId,
      summary,
    });

    return { summary: summary as string | null, message: null as string | null };
  },
});

// On-demand function summary with token guard, cascade generation, and persistence
export const generateFunctionSummary = action({
  args: {
    functionId: v.id("functions"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ summary: string | null; message: string | null }> => {
    await requireAuth(ctx);

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

    if (deptResults.length === 1) {
      const summary = `Based on the "${deptResults[0].departmentName}" department: ${deptResults[0].summary}`;
      await ctx.runMutation(internal.summariesHelpers.saveFunctionSummary, {
        functionId: args.functionId,
        summary,
      });
      return { summary: summary as string | null, message: null as string | null };
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

    const systemPrompt = `You are synthesizing department-level summaries for an organizational function. Combine these into a cohesive function-level overview that describes how the departments work together, noting cross-departmental themes, handoffs, and dependencies. Write in clear, concise prose — no bullet points or headers. Output only the synthesized summary, nothing else.`;

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
              content: `Here are the department summaries for this function:\n\n${summaryBlock}`,
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
