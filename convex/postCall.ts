import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAuth, checkRoleFromUser } from "./lib/auth";

// Normalize ElevenLabs transcript to the shape our UI expects:
// ElevenLabs returns { role: "agent"|"user", message: string, time_in_call_secs: number }
// Our UI expects { role: "ai"|"user", content: string, time_in_call_secs: number }
function normalizeTranscript(
  raw: Array<{ role: string; message?: string; time_in_call_secs?: number }> | null,
): Array<{ role: string; content: string; time_in_call_secs: number }> | null {
  if (!raw || !Array.isArray(raw)) return null;
  return raw.map((msg) => ({
    role: msg.role === "agent" ? "ai" : msg.role,
    content: msg.message ?? "",
    time_in_call_secs: msg.time_in_call_secs ?? 0,
  }));
}

// --- Internal helpers (not public) ---

export const insertConversation = internalMutation({
  args: {
    processId: v.id("processes"),
    elevenlabsConversationId: v.string(),
    contributorName: v.string(),
    userId: v.optional(v.id("users")),
    transcript: v.optional(v.any()),
    summary: v.optional(v.string()),
    analysis: v.optional(v.any()),
    durationSeconds: v.optional(v.number()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("conversations", {
      processId: args.processId,
      elevenlabsConversationId: args.elevenlabsConversationId,
      contributorName: args.contributorName,
      userId: args.userId,
      transcript: args.transcript,
      summary: args.summary,
      analysis: args.analysis,
      durationSeconds: args.durationSeconds,
      status: args.status,
    });
  },
});

export const getConversationSummaries = internalQuery({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .order("asc")
      .collect();
    return conversations
      .filter((c) => c.status === "done" && c.summary)
      .map((c) => ({
        contributorName: c.contributorName,
        summary: c.summary!,
        transcript: c.transcript ?? null,
        creationTime: c._creationTime,
      }));
  },
});

// Fetch only the latest done conversation for a process (used by incremental summary path)
export const getLatestConversation = internalQuery({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .order("desc")
      .filter((q) => q.eq(q.field("status"), "done"))
      .first();
    if (!conversation) return null;
    return {
      contributorName: conversation.contributorName,
      summary: conversation.summary ?? null,
      transcript: conversation.transcript ?? null,
      creationTime: conversation._creationTime,
    };
  },
});

// Fetch the current rolling summary for a process
export const getProcessRollingSummary = internalQuery({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    return process?.rollingSummary ?? null;
  },
});

export const updateRollingSummary = internalMutation({
  args: {
    processId: v.id("processes"),
    rollingSummary: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.processId, {
      rollingSummary: args.rollingSummary,
    });
  },
});

// Lookup a process's departmentId for staleness cascading
export const getProcessDepartmentId = internalQuery({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    return process?.departmentId ?? null;
  },
});

// --- Public action: fetchConversation ---
// Called by the frontend after onDisconnect fires.
// Polls ElevenLabs API until the conversation is processed, then inserts data.

export const fetchConversation = action({
  args: {
    elevenlabsConversationId: v.string(),
    processId: v.id("processes"),
    contributorName: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: derive userId server-side
    const identity = await requireAuth(ctx);
    const user = await ctx.runQuery(
      internal.postCall.getUserByToken,
      { tokenIdentifier: identity.tokenIdentifier },
    );
    // Role check: recording requires contributor
    checkRoleFromUser(user, "contributor");
    const userId = user?._id ?? undefined;

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not configured");
    }

    const maxRetries = 30;
    const pollIntervalMs = 2000;
    const maxNetworkErrors = 5; // tolerate up to 5 consecutive network failures
    let consecutiveNetworkErrors = 0;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversations/${args.elevenlabsConversationId}`,
          {
            headers: { "xi-api-key": apiKey },
          },
        );
      } catch (networkError) {
        // Network-level failure (DNS, timeout, connection refused, etc.)
        consecutiveNetworkErrors++;
        console.error(
          `ElevenLabs network error (attempt ${attempt + 1}, consecutive: ${consecutiveNetworkErrors}):`,
          networkError,
        );

        if (consecutiveNetworkErrors >= maxNetworkErrors) {
          // Too many consecutive network errors — give up and record as failed
          await ctx.runMutation(internal.postCall.insertConversation, {
            processId: args.processId,
            elevenlabsConversationId: args.elevenlabsConversationId,
            contributorName: args.contributorName,
            userId,
            status: "failed",
          });
          return { status: "failed" as const };
        }

        // Back off slightly longer on network errors (3 seconds)
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      // Reset consecutive error counter on successful connection
      consecutiveNetworkErrors = 0;

      if (!response.ok) {
        // Transient server errors (5xx) — retry; client errors (4xx) — fail
        if (response.status >= 500) {
          console.error(
            `ElevenLabs server error ${response.status} on attempt ${attempt + 1} — retrying`,
          );
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        // 4xx errors are not transient — fail immediately
        await ctx.runMutation(internal.postCall.insertConversation, {
          processId: args.processId,
          elevenlabsConversationId: args.elevenlabsConversationId,
          contributorName: args.contributorName,
          userId,
          status: "failed",
        });
        return { status: "failed" as const };
      }

      const data = await response.json();

      if (data.status === "done") {
        // Extract fields from the ElevenLabs response
        const transcript = normalizeTranscript(data.transcript);
        const summary = data.analysis?.transcript_summary ?? null;
        const analysis = data.analysis ?? null;
        const durationSeconds = data.metadata?.call_duration_secs ?? null;

        // Insert the conversation record
        await ctx.runMutation(internal.postCall.insertConversation, {
          processId: args.processId,
          elevenlabsConversationId: args.elevenlabsConversationId,
          contributorName: args.contributorName,
          userId,
          transcript,
          summary,
          analysis,
          durationSeconds,
          status: "done",
        });

        // Trigger rolling summary regeneration
        await ctx.scheduler.runAfter(
          0,
          internal.postCall.regenerateProcessSummary,
          { processId: args.processId },
        );

        return { status: "done" as const };
      }

      if (data.status === "failed") {
        await ctx.runMutation(internal.postCall.insertConversation, {
          processId: args.processId,
          elevenlabsConversationId: args.elevenlabsConversationId,
          contributorName: args.contributorName,
          userId,
          status: "failed",
        });
        return { status: "failed" as const };
      }

      // Still processing — wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Max retries exceeded — insert as processing so frontend can detect via reactivity
    await ctx.runMutation(internal.postCall.insertConversation, {
      processId: args.processId,
      elevenlabsConversationId: args.elevenlabsConversationId,
      contributorName: args.contributorName,
      userId,
      status: "processing",
    });

    return { status: "timeout" as const };
  },
});

// Helper query for looking up user by tokenIdentifier (internal only)
export const getUserByToken = internalQuery({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();
  },
});

// --- Internal helper: get all imported ElevenLabs conversation IDs ---

export const getImportedConversationIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const conversations = await ctx.db.query("conversations").collect();
    return conversations.map((c) => c.elevenlabsConversationId);
  },
});

// --- Backfill: list conversations on ElevenLabs not yet in our DB ---

export const listUnimported = internalAction({
  args: {},
  handler: async (ctx) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

    const agentId = process.env.ELEVENLABS_AGENT_ID;

    // Fetch conversations from ElevenLabs (up to 100)
    const url = new URL("https://api.elevenlabs.io/v1/convai/conversations");
    if (agentId) url.searchParams.set("agent_id", agentId);

    const response = await fetch(url.toString(), {
      headers: { "xi-api-key": apiKey },
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    const data = await response.json();
    const allConversations: Array<{
      conversation_id: string;
      status: string;
      start_time_unix_secs?: number;
      call_duration_secs?: number;
    }> = data.conversations ?? [];

    // Get IDs already in our DB
    const importedIds: string[] = await ctx.runQuery(
      internal.postCall.getImportedConversationIds,
      {},
    );
    const importedSet: Set<string> = new Set(importedIds);

    // Filter to unimported, done conversations
    const unimported: Array<{
      conversationId: string;
      startTime: string | null;
      durationSeconds: number | null;
    }> = allConversations
      .filter(
        (c) =>
          !importedSet.has(c.conversation_id) && c.status === "done",
      )
      .map((c) => ({
        conversationId: c.conversation_id,
        startTime: c.start_time_unix_secs
          ? new Date(c.start_time_unix_secs * 1000).toISOString()
          : null,
        durationSeconds: c.call_duration_secs ?? null,
      }));

    return unimported;
  },
});

// --- Backfill: import a specific ElevenLabs conversation into a process ---

export const importConversation = internalAction({
  args: {
    elevenlabsConversationId: v.string(),
    processId: v.id("processes"),
    contributorName: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${args.elevenlabsConversationId}`,
      { headers: { "xi-api-key": apiKey } },
    );

    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "done") {
      throw new Error(
        `Conversation status is "${data.status}" — only "done" conversations can be imported`,
      );
    }

    const transcript = normalizeTranscript(data.transcript);
    const summary = data.analysis?.transcript_summary ?? null;
    const analysis = data.analysis ?? null;
    const durationSeconds = data.metadata?.call_duration_secs ?? null;

    await ctx.runMutation(internal.postCall.insertConversation, {
      processId: args.processId,
      elevenlabsConversationId: args.elevenlabsConversationId,
      contributorName: args.contributorName,
      transcript,
      summary,
      analysis,
      durationSeconds,
      status: "done",
    });

    // Regenerate rolling summary for the process
    await ctx.scheduler.runAfter(
      0,
      internal.postCall.regenerateProcessSummary,
      { processId: args.processId },
    );

    return { status: "done" as const, summary };
  },
});

// --- Internal action: regenerateProcessSummary ---
// Incrementally builds a structured process summary using Claude Haiku 4.5.
// First conversation: full transcript → initial structured summary.
// Subsequent: existing rolling summary + new transcript → updated summary.
// forceRefresh: rebuilds from ALL transcripts (higher token cost).

const PROCESS_SUMMARY_SYSTEM_PROMPT = `You are an analyst synthesizing employee accounts of a single business process into a structured brief. Your output must use the following markdown format exactly:

## Overview
2-3 sentence executive summary of the process.

## Key Stages
Thematic breakdown of the process phases. Cite which contributors described each stage using the format [Name, Conv. N] — e.g., "The request is triaged by the team lead [Alice, Conv. 2]." Group related steps into coherent stages rather than listing every micro-step.

## Consensus
What multiple contributors agree on — the shared understanding of how the process works. Only include points confirmed by more than one source.

## Tensions & Gaps
Where accounts contradict each other or where no contributor covers a step. Be specific: name the contributors who disagree and what they disagree about. If there are no contradictions, note any gaps in coverage instead.

## Notable Details
Unique insights mentioned by only one contributor that seem important enough to preserve. Cite the source.

Rules:
- Always cite contributors using [Name, Conv. N] format.
- Write in clear, concise prose within each section.
- If this is the first conversation, the Consensus and Tensions & Gaps sections can note that only one perspective exists so far.
- When integrating new information into an existing summary, preserve existing citations and add new ones. Update sections as needed — move items from Notable Details to Consensus if a new contributor confirms them, or add new tensions if accounts conflict.
- Output ONLY the markdown sections above, nothing else.`;

const PROCESS_SUMMARY_SYSTEM_PROMPT_FULL_REBUILD = `You are an analyst synthesizing multiple employee accounts of a single business process into a structured brief. You are given the full transcripts of all conversations. Your output must use the following markdown format exactly:

## Overview
2-3 sentence executive summary of the process.

## Key Stages
Thematic breakdown of the process phases. Cite which contributors described each stage using the format [Name, Conv. N] — e.g., "The request is triaged by the team lead [Alice, Conv. 2]." Group related steps into coherent stages rather than listing every micro-step.

## Consensus
What multiple contributors agree on — the shared understanding of how the process works. Only include points confirmed by more than one source.

## Tensions & Gaps
Where accounts contradict each other or where no contributor covers a step. Be specific: name the contributors who disagree and what they disagree about. If there are no contradictions, note any gaps in coverage instead.

## Notable Details
Unique insights mentioned by only one contributor that seem important enough to preserve. Cite the source.

Rules:
- Always cite contributors using [Name, Conv. N] format.
- Write in clear, concise prose within each section.
- Output ONLY the markdown sections above, nothing else.`;

function formatTranscript(
  transcript: Array<{ role: string; content: string }> | null,
  contributorName: string,
  conversationNumber: number,
): string {
  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
    return `[Conversation ${conversationNumber} — ${contributorName}]\n(No transcript available)`;
  }
  const lines = transcript.map(
    (msg: { role: string; content: string }) =>
      `${msg.role === "user" ? contributorName : "Agent"}: ${msg.content}`,
  );
  return `[Conversation ${conversationNumber} — ${contributorName}]\n${lines.join("\n")}`;
}

export const regenerateProcessSummary = internalAction({
  args: {
    processId: v.id("processes"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      console.error("OPENROUTER_API_KEY is not configured — skipping summary regeneration");
      return;
    }

    // Full rebuild: fetch all conversations and regenerate from scratch
    if (args.forceRefresh) {
      const allConversations: Array<{
        contributorName: string;
        summary: string;
        transcript: unknown;
        creationTime: number;
      }> = await ctx.runQuery(
        internal.postCall.getConversationSummaries,
        { processId: args.processId },
      );

      if (allConversations.length === 0) return;

      const transcriptBlock = allConversations
        .map(
          (c: { contributorName: string; transcript: unknown }, i: number) =>
            formatTranscript(
              c.transcript as Array<{ role: string; content: string }> | null,
              c.contributorName,
              i + 1,
            ),
        )
        .join("\n\n---\n\n");

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
              { role: "system", content: PROCESS_SUMMARY_SYSTEM_PROMPT_FULL_REBUILD },
              {
                role: "user",
                content: `Here are the full transcripts of all ${allConversations.length} conversations for this process:\n\n${transcriptBlock}`,
              },
            ],
            max_tokens: 8192,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error("OpenRouter API error:", response.status, errorText);
        throw new Error(`OpenRouter API error: ${response.status}`);
      }

      const result = await response.json();
      const rollingSummary = result.choices?.[0]?.message?.content?.trim() ?? null;
      if (rollingSummary) {
        await ctx.runMutation(internal.postCall.updateRollingSummary, {
          processId: args.processId,
          rollingSummary,
        });
        const departmentId: string | null = await ctx.runQuery(
          internal.postCall.getProcessDepartmentId,
          { processId: args.processId },
        );
        if (departmentId) {
          await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
            departmentId: departmentId as Id<"departments">,
          });
        }
      }
      return;
    }

    // Incremental path: existing summary + latest conversation transcript
    const existingSummary: string | null = await ctx.runQuery(
      internal.postCall.getProcessRollingSummary,
      { processId: args.processId },
    );

    const latestConversation: {
      contributorName: string;
      summary: string | null;
      transcript: unknown;
      creationTime: number;
    } | null = await ctx.runQuery(
      internal.postCall.getLatestConversation,
      { processId: args.processId },
    );

    if (!latestConversation) return;

    // Count total conversations for numbering
    const allConversations: Array<{
      contributorName: string;
      summary: string;
      transcript: unknown;
      creationTime: number;
    }> = await ctx.runQuery(
      internal.postCall.getConversationSummaries,
      { processId: args.processId },
    );

    const conversationCount = allConversations.length;
    if (conversationCount === 0) return;

    const latestTranscript = formatTranscript(
      latestConversation.transcript as Array<{ role: string; content: string }> | null,
      latestConversation.contributorName,
      conversationCount,
    );

    let userContent: string;

    if (!existingSummary || conversationCount === 1) {
      // First conversation: generate initial structured summary from transcript
      userContent = `This is the first conversation recorded for this process. Generate the initial structured summary from this transcript:\n\n${latestTranscript}`;
    } else {
      // Subsequent conversation: integrate into existing summary
      userContent = `Here is the existing process summary:\n\n${existingSummary}\n\n---\n\nA new conversation has been recorded. Integrate the information from this transcript into the existing summary, updating all sections as needed:\n\n${latestTranscript}`;
    }

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
            { role: "system", content: PROCESS_SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          max_tokens: 8192,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter API error:", response.status, errorText);
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const result = await response.json();
    const rollingSummary = result.choices?.[0]?.message?.content?.trim() ?? null;

    if (rollingSummary) {
      await ctx.runMutation(internal.postCall.updateRollingSummary, {
        processId: args.processId,
        rollingSummary,
      });
      // Mark department (and cascading function) summary as stale
      const departmentId: string | null = await ctx.runQuery(
        internal.postCall.getProcessDepartmentId,
        { processId: args.processId },
      );
      if (departmentId) {
        await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
          departmentId: departmentId as Id<"departments">,
        });
      }
    }
  },
});
