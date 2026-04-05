import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";

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
        creationTime: c._creationTime,
      }));
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
// Fetches all conversation summaries for a process and synthesizes via Claude Haiku.

export const regenerateProcessSummary = internalAction({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const summaries = await ctx.runQuery(
      internal.postCall.getConversationSummaries,
      { processId: args.processId },
    );

    if (summaries.length === 0) {
      return;
    }

    // If only one summary, use it directly without calling the LLM
    if (summaries.length === 1) {
      await ctx.runMutation(internal.postCall.updateRollingSummary, {
        processId: args.processId,
        rollingSummary: summaries[0].summary,
      });
      return;
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      console.error("OPENROUTER_API_KEY is not configured — skipping summary regeneration");
      return;
    }

    // Build the prompt with all conversation summaries
    const summaryBlock = summaries
      .map(
        (s: { contributorName: string; summary: string; creationTime: number }, i: number) =>
          `[Conversation ${i + 1} — ${s.contributorName}]\n${s.summary}`,
      )
      .join("\n\n");

    const systemPrompt = `You are synthesizing multiple employee accounts of a single business process. Combine these into a coherent narrative that describes the full process end-to-end, noting which contributors handle which parts, and highlighting any overlaps or gaps. Write in clear, concise prose — no bullet points or headers. Output only the synthesized summary, nothing else.`;

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
              content: `Here are the individual conversation summaries to synthesize:\n\n${summaryBlock}`,
            },
          ],
          max_tokens: 1024,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter API error:", response.status, errorText);
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const result = await response.json();
    const rollingSummary =
      result.choices?.[0]?.message?.content?.trim() ?? null;

    if (rollingSummary) {
      await ctx.runMutation(internal.postCall.updateRollingSummary, {
        processId: args.processId,
        rollingSummary,
      });
    }
  },
});
