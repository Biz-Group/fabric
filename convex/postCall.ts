import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  requireOrgContributor,
  requireOrgMember,
  resolveOrgForAction,
} from "./lib/orgAuth";
import {
  generateAICompletion,
  isAIConfigured,
} from "./lib/aiProvider";
import {
  isSamePersonName,
  sanitizeContributorName,
} from "./lib/contributorAttribution";

// Normalize ElevenLabs transcript to the shape our UI expects:
// ElevenLabs returns { role: "agent"|"user", message: string, time_in_call_secs: number }
// Our UI expects { role: "ai"|"user", content: string, time_in_call_secs: number }
function normalizeTranscript(
  raw: Array<{ role: string; message?: string; time_in_call_secs?: number }> | null,
): Array<{
  role: string;
  content: string;
  time_in_call_secs: number;
  speakerId?: string;
  speakerName?: string;
}> | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  return raw.map((msg) => ({
    role: msg.role === "agent" ? "ai" : msg.role,
    content: msg.message ?? "",
    time_in_call_secs: msg.time_in_call_secs ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Internal auth-gating helpers for actions
// ---------------------------------------------------------------------------

/**
 * Gate an action on the caller being a contributor (or admin) in their active
 * org. Actions call this via `ctx.runQuery(internal.postCall.requireOrgContributorInternal, {})`.
 * Throws if not authenticated, no active org, no membership, or role < contributor.
 */
export const requireOrgContributorInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgContributor(ctx);
    return { orgId: caller.orgId, userId: caller.userId };
  },
});

// ---------------------------------------------------------------------------
// Contributor attribution
// ---------------------------------------------------------------------------

export type ResolvedAttribution = {
  /** Display name of the person the recording is about. */
  contributorName: string;
  /** The submitting account. Always the authenticated caller. */
  userId: Id<"users">;
  /** The subject's account, when they are a verified org member. */
  subjectUserId?: Id<"users">;
  /** Set only when subject ≠ submitter; its presence marks an on-behalf row. */
  submittedByName?: string;
};

/**
 * Separates who a recording is *about* from who submitted it, so third-party
 * consultants can file interviews for an employee without the record claiming
 * the employee submitted it.
 *
 * Called by every public entry point that inserts a conversation. Passing no
 * `contributorName`/`subjectUserId` (or naming yourself) yields the pre-existing
 * behaviour: attribution derived from the caller's account.
 *
 * On-behalf-of submissions are gated on two things, because the modal's
 * recording notice is consent from whoever is typing — not from the person named:
 *   1. admin role, so an ordinary contributor cannot put words under a
 *      colleague's byline;
 *   2. an explicit consent attestation, recorded on the row by the caller.
 * `subjectUserId` is verified against org membership the same way
 * `submitSpeakerLabels` verifies speaker links.
 */
export const resolveContributorAttribution = internalQuery({
  args: {
    clerkOrgId: v.string(),
    contributorName: v.optional(v.string()),
    subjectUserId: v.optional(v.id("users")),
    consentAttested: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ResolvedAttribution> => {
    const caller = await requireOrgContributor(ctx);
    if (caller.orgId !== args.clerkOrgId) {
      throw new Error("Organization mismatch");
    }
    const submitter = await ctx.db.get(caller.userId);
    const submitterName =
      sanitizeContributorName(submitter?.name ?? "") || "Anonymous";

    let subjectUserId: Id<"users"> | undefined;
    let subjectName: string | undefined;
    if (args.subjectUserId) {
      const subject = await ctx.db.get(args.subjectUserId);
      if (!subject) throw new Error("Selected member was not found");
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_userId", (q) => q.eq("userId", args.subjectUserId!))
        .take(100);
      if (!memberships.some((m) => m.clerkOrgId === caller.orgId)) {
        throw new Error("Selected member is not in this organization");
      }
      subjectUserId = subject._id;
      subjectName = sanitizeContributorName(subject.name) || "Anonymous";
    }

    const typedName = sanitizeContributorName(args.contributorName ?? "");
    const resolvedName = subjectName ?? typedName;

    const isSelfRecording =
      subjectUserId !== undefined
        ? subjectUserId === caller.userId
        : resolvedName === "" || isSamePersonName(resolvedName, submitterName);
    if (isSelfRecording) {
      return {
        contributorName: submitterName,
        userId: caller.userId,
        subjectUserId: caller.userId,
      };
    }

    if (caller.role !== "admin") {
      throw new Error(
        "Only organization admins can record on another person's behalf",
      );
    }
    if (!args.consentAttested) {
      throw new Error(
        "Confirm the person was informed and consented before recording on their behalf",
      );
    }

    return {
      contributorName: resolvedName,
      userId: caller.userId,
      subjectUserId,
      submittedByName: submitterName,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal helpers — all tenant-scoped via explicit clerkOrgId arg
// ---------------------------------------------------------------------------

export const insertConversation = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    elevenlabsConversationId: v.optional(v.string()),
    contributorName: v.string(),
    userId: v.optional(v.id("users")),
    subjectUserId: v.optional(v.id("users")),
    submittedByName: v.optional(v.string()),
    consentAttestedAt: v.optional(v.number()),
    inputMode: v.optional(
      v.union(
        v.literal("agent"),
        v.literal("voiceRecord"),
        v.literal("audioUpload"),
      ),
    ),
    audioStorageId: v.optional(v.id("_storage")),
    audioMimeType: v.optional(v.string()),
    transcriptionProvider: v.optional(
      v.union(
        v.literal("elevenlabs-convai"),
        v.literal("elevenlabs-scribe"),
      ),
    ),
    analysisProvider: v.optional(
      v.union(
        v.literal("elevenlabs-convai"),
        v.literal("fabric-openrouter"),
        v.literal("fabric-foundry"),
      ),
    ),
    transcript: v.optional(
      v.array(
        v.object({
          role: v.string(),
          content: v.string(),
          time_in_call_secs: v.number(),
          speakerId: v.optional(v.string()),
          speakerName: v.optional(v.string()),
        }),
      ),
    ),
    speakerLabels: v.optional(
      v.array(
        v.object({
          speakerId: v.string(),
          displayName: v.string(),
          userId: v.optional(v.id("users")),
        }),
      ),
    ),
    summary: v.optional(v.string()),
    analysis: v.optional(v.any()),
    durationSeconds: v.optional(v.number()),
    status: v.union(
      v.literal("processing"),
      v.literal("needs_speaker_labels"),
      v.literal("done"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, args) => {
    // Defensive: ensure the parent process belongs to the stamping org.
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Process not found in this organization");
    }
    return await ctx.db.insert("conversations", {
      processId: args.processId,
      clerkOrgId: args.clerkOrgId,
      elevenlabsConversationId: args.elevenlabsConversationId,
      contributorName: args.contributorName,
      userId: args.userId,
      subjectUserId: args.subjectUserId,
      submittedByName: args.submittedByName,
      consentAttestedAt: args.consentAttestedAt,
      inputMode: args.inputMode ?? "agent",
      audioStorageId: args.audioStorageId,
      audioMimeType: args.audioMimeType,
      transcriptionProvider:
        args.transcriptionProvider ?? "elevenlabs-convai",
      analysisProvider: args.analysisProvider ?? "elevenlabs-convai",
      transcript: args.transcript,
      speakerLabels: args.speakerLabels,
      summary: args.summary,
      analysis: args.analysis,
      durationSeconds: args.durationSeconds,
      status: args.status,
    });
  },
});

export const getConversationSummaries = internalQuery({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("processId", args.processId),
      )
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

export const getLatestConversation = internalQuery({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId_and_status", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("processId", args.processId)
          .eq("status", "done"),
      )
      .order("desc")
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

export const getProcessRollingSummary = internalQuery({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== args.clerkOrgId) return null;
    return process.rollingSummary ?? null;
  },
});

export const updateRollingSummary = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    rollingSummary: v.string(),
  },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== args.clerkOrgId) return;
    await ctx.db.patch(args.processId, {
      rollingSummary: args.rollingSummary,
    });
  },
});

export const getProcessDepartmentId = internalQuery({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== args.clerkOrgId) return null;
    return process.departmentId ?? null;
  },
});

// ---------------------------------------------------------------------------
// Public action: fetchConversation
// Called by the frontend after onDisconnect fires. Polls ElevenLabs API
// until the conversation is processed, then inserts data.
// ---------------------------------------------------------------------------

export const fetchConversation = action({
  args: {
    elevenlabsConversationId: v.string(),
    processId: v.id("processes"),
    // Optional on-behalf-of attribution; omitted for ordinary self-recordings.
    contributorName: v.optional(v.string()),
    subjectUserId: v.optional(v.id("users")),
    consentAttested: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { orgId } = await resolveOrgForAction(ctx);
    // Also gates the caller on contributor role — the resolver runs
    // requireOrgContributor, and escalates to admin for on-behalf submissions.
    const attribution: ResolvedAttribution = await ctx.runQuery(
      internal.postCall.resolveContributorAttribution,
      {
        clerkOrgId: orgId,
        contributorName: args.contributorName,
        subjectUserId: args.subjectUserId,
        consentAttested: args.consentAttested,
      },
    );
    // Spread into every insert below rather than repeating the fields, so a
    // future attribution field can't be added to one exit path and missed in
    // the other four.
    const attributionFields = {
      contributorName: attribution.contributorName,
      userId: attribution.userId,
      subjectUserId: attribution.subjectUserId,
      submittedByName: attribution.submittedByName,
      consentAttestedAt: attribution.submittedByName ? Date.now() : undefined,
    };

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not configured");
    }

    const maxRetries = 30;
    const pollIntervalMs = 2000;
    const maxNetworkErrors = 5;
    let consecutiveNetworkErrors = 0;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversations/${args.elevenlabsConversationId}`,
          { headers: { "xi-api-key": apiKey } },
        );
      } catch (networkError) {
        consecutiveNetworkErrors++;
        console.error(
          `ElevenLabs network error (attempt ${attempt + 1}, consecutive: ${consecutiveNetworkErrors}):`,
          networkError,
        );

        if (consecutiveNetworkErrors >= maxNetworkErrors) {
          await ctx.runMutation(internal.postCall.insertConversation, {
            processId: args.processId,
            clerkOrgId: orgId,
            elevenlabsConversationId: args.elevenlabsConversationId,
            ...attributionFields,
            inputMode: "agent",
            transcriptionProvider: "elevenlabs-convai",
            analysisProvider: "elevenlabs-convai",
            status: "failed",
          });
          return { status: "failed" as const };
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      consecutiveNetworkErrors = 0;

      if (!response.ok) {
        if (response.status >= 500) {
          console.error(
            `ElevenLabs server error ${response.status} on attempt ${attempt + 1} — retrying`,
          );
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        await ctx.runMutation(internal.postCall.insertConversation, {
          processId: args.processId,
          clerkOrgId: orgId,
          elevenlabsConversationId: args.elevenlabsConversationId,
          ...attributionFields,
          inputMode: "agent",
          transcriptionProvider: "elevenlabs-convai",
          analysisProvider: "elevenlabs-convai",
          status: "failed",
        });
        return { status: "failed" as const };
      }

      const data = await response.json();

      if (data.status === "done") {
        const transcript = normalizeTranscript(data.transcript);
        const summary = data.analysis?.transcript_summary ?? undefined;
        const analysis = data.analysis ?? null;
        const durationSeconds = data.metadata?.call_duration_secs ?? undefined;

        await ctx.runMutation(internal.postCall.insertConversation, {
          processId: args.processId,
          clerkOrgId: orgId,
          elevenlabsConversationId: args.elevenlabsConversationId,
          ...attributionFields,
          transcript,
          summary,
          analysis,
          durationSeconds,
          inputMode: "agent",
          transcriptionProvider: "elevenlabs-convai",
          analysisProvider: "elevenlabs-convai",
          status: "done",
        });

        await ctx.scheduler.runAfter(
          0,
          internal.postCall.regenerateProcessSummary,
          { processId: args.processId, clerkOrgId: orgId },
        );

        return { status: "done" as const };
      }

      if (data.status === "failed") {
        await ctx.runMutation(internal.postCall.insertConversation, {
          processId: args.processId,
          clerkOrgId: orgId,
          elevenlabsConversationId: args.elevenlabsConversationId,
          ...attributionFields,
          inputMode: "agent",
          transcriptionProvider: "elevenlabs-convai",
          analysisProvider: "elevenlabs-convai",
          status: "failed",
        });
        return { status: "failed" as const };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Max retries exceeded — insert as processing so frontend can detect via reactivity
    await ctx.runMutation(internal.postCall.insertConversation, {
      processId: args.processId,
      clerkOrgId: orgId,
      elevenlabsConversationId: args.elevenlabsConversationId,
      ...attributionFields,
      inputMode: "agent",
      transcriptionProvider: "elevenlabs-convai",
      analysisProvider: "elevenlabs-convai",
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

// Helper query: verify an ElevenLabs conversation exists in our DB for the
// given org. Used by the audio proxy (Phase 13.7) to authorize playback.
export const conversationExistsByElevenLabsId = internalQuery({
  args: {
    elevenlabsConversationId: v.string(),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_elevenlabsConversationId", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("elevenlabsConversationId", args.elevenlabsConversationId),
      )
      .first();
    return conv !== null;
  },
});

// Signed audio URLs stay valid this long. The HTTP audio endpoint can't run
// `requireOrgMember` itself (cross-origin <audio> fetches are unauthenticated
// — the browser uses crossOrigin="anonymous" so no Clerk JWT is sent), so
// authorization is enforced once at token-mint time and re-verified by HMAC
// on every byte fetch within the TTL.
const AUDIO_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function signAudioPath(
  secret: string,
  clerkOrgId: string,
  conversationId: string,
  expiresAt: number,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${clerkOrgId}.${conversationId}.${expiresAt}`),
  );
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Returns an HMAC-signed `{ exp, sig }` pair the client can append to an
 * /audio/{orgId}/{convId} URL. Authorization is enforced here: the caller
 * must have a membership in the conversation's org. Returns null if the
 * conversation doesn't exist or belongs to a different org (404-equivalent).
 */
export const getAudioPlaybackToken = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || conv.clerkOrgId !== caller.orgId) return null;

    const secret = process.env.AUDIO_SIGNING_SECRET;
    if (!secret) {
      throw new Error(
        "AUDIO_SIGNING_SECRET is not configured on the Convex deployment",
      );
    }

    const exp = Date.now() + AUDIO_URL_TTL_MS;
    const sig = await signAudioPath(
      secret,
      caller.orgId,
      args.conversationId,
      exp,
    );
    return { exp, sig };
  },
});

export const getConversationAudioSource = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || conv.clerkOrgId !== args.clerkOrgId) return null;

    const inputMode = conv.inputMode ?? "agent";
    if (inputMode === "voiceRecord" || inputMode === "audioUpload") {
      if (!conv.audioStorageId) return null;
      return {
        inputMode,
        audioStorageId: conv.audioStorageId,
        audioMimeType: conv.audioMimeType ?? "audio/webm",
      };
    }

    if (!conv.elevenlabsConversationId) return null;
    return {
      inputMode: "agent" as const,
      elevenlabsConversationId: conv.elevenlabsConversationId,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal backfill helpers — always scoped by explicit clerkOrgId arg
// ---------------------------------------------------------------------------

export const getImportedConversationIds = internalQuery({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .take(10000);
    return conversations.flatMap((c) =>
      c.elevenlabsConversationId ? [c.elevenlabsConversationId] : [],
    );
  },
});

export const listUnimported = internalAction({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

    const agentId = process.env.ELEVENLABS_AGENT_ID;

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

    const importedIds: string[] = await ctx.runQuery(
      internal.postCall.getImportedConversationIds,
      { clerkOrgId: args.clerkOrgId },
    );
    const importedSet: Set<string> = new Set(importedIds);

    const unimported: Array<{
      conversationId: string;
      startTime: string | null;
      durationSeconds: number | null;
    }> = allConversations
      .filter(
        (c) => !importedSet.has(c.conversation_id) && c.status === "done",
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

export const importConversation = internalAction({
  args: {
    elevenlabsConversationId: v.string(),
    processId: v.id("processes"),
    contributorName: v.string(),
    clerkOrgId: v.string(),
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
    const summary = data.analysis?.transcript_summary ?? undefined;
    const analysis = data.analysis ?? null;
    const durationSeconds = data.metadata?.call_duration_secs ?? undefined;

    await ctx.runMutation(internal.postCall.insertConversation, {
      processId: args.processId,
      clerkOrgId: args.clerkOrgId,
      elevenlabsConversationId: args.elevenlabsConversationId,
      contributorName: args.contributorName,
      transcript,
      summary,
      analysis,
      durationSeconds,
      inputMode: "agent",
      transcriptionProvider: "elevenlabs-convai",
      analysisProvider: "elevenlabs-convai",
      status: "done",
    });

    await ctx.scheduler.runAfter(
      0,
      internal.postCall.regenerateProcessSummary,
      { processId: args.processId, clerkOrgId: args.clerkOrgId },
    );

    return { status: "done" as const, summary };
  },
});

export const refreshConversationAnalysis = internalAction({
  args: {
    elevenlabsConversationId: v.string(),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

    const existing = await ctx.runQuery(
      internal.postCall.getConversationByElevenLabsId,
      {
        elevenlabsConversationId: args.elevenlabsConversationId,
        clerkOrgId: args.clerkOrgId,
      },
    );
    if (!existing) {
      throw new Error(
        `Conversation ${args.elevenlabsConversationId} not found in org ${args.clerkOrgId}`,
      );
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${args.elevenlabsConversationId}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    const data = await response.json();
    const transcript = normalizeTranscript(data.transcript) ?? existing.transcript;
    const summary = data.analysis?.transcript_summary ?? existing.summary;
    const analysis = data.analysis ?? existing.analysis;
    const durationSeconds = data.metadata?.call_duration_secs ?? existing.durationSeconds;

    await ctx.runMutation(internal.postCall.updateConversationAnalysis, {
      conversationId: existing._id,
      clerkOrgId: args.clerkOrgId,
      transcript,
      summary,
      analysis,
      durationSeconds,
    });

    console.log(`Refreshed analysis for ${args.elevenlabsConversationId}`);
    return { status: "updated" as const };
  },
});

export const getConversationByElevenLabsId = internalQuery({
  args: {
    elevenlabsConversationId: v.string(),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_elevenlabsConversationId", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("elevenlabsConversationId", args.elevenlabsConversationId),
      )
      .first();
  },
});

export const updateConversationAnalysis = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    clerkOrgId: v.string(),
    transcript: v.optional(
      v.array(
        v.object({
          role: v.string(),
          content: v.string(),
          time_in_call_secs: v.number(),
          speakerId: v.optional(v.string()),
          speakerName: v.optional(v.string()),
        }),
      ),
    ),
    summary: v.optional(v.string()),
    analysis: v.optional(v.any()),
    durationSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || conv.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Conversation not found in this organization");
    }
    await ctx.db.patch(args.conversationId, {
      transcript: args.transcript,
      summary: args.summary,
      analysis: args.analysis,
      durationSeconds: args.durationSeconds,
    });
  },
});

// ---------------------------------------------------------------------------
// Internal action: regenerateProcessSummary
// Incrementally builds a structured process summary using Claude Haiku 4.5.
// First conversation: full transcript → initial structured summary.
// Subsequent: existing rolling summary + new transcript → updated summary.
// forceRefresh: rebuilds from ALL transcripts (higher token cost).
// ---------------------------------------------------------------------------

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
  transcript: Array<{
    role: string;
    content: string;
    speakerName?: string;
  }> | null,
  contributorName: string,
  conversationNumber: number,
): string {
  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
    return `[Conversation ${conversationNumber} — ${contributorName}]\n(No transcript available)`;
  }
  const lines = transcript.map(
    (msg: { role: string; content: string; speakerName?: string }) =>
      `${msg.speakerName ?? (msg.role === "user" ? contributorName : "Agent")}: ${msg.content}`,
  );
  return `[Conversation ${conversationNumber} — ${contributorName}]\n${lines.join("\n")}`;
}

export const regenerateProcessSummary = internalAction({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!isAIConfigured("synthesis")) {
      console.error("AI synthesis is not configured — skipping summary regeneration");
      return;
    }

    if (args.forceRefresh) {
      const allConversations: Array<{
        contributorName: string;
        summary: string;
        transcript: unknown;
        creationTime: number;
      }> = await ctx.runQuery(internal.postCall.getConversationSummaries, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
      });

      if (allConversations.length === 0) return;

      const transcriptBlock = allConversations
        .map((c, i) =>
          formatTranscript(
            c.transcript as Array<{
              role: string;
              content: string;
              speakerName?: string;
            }> | null,
            c.contributorName,
            i + 1,
          ),
        )
        .join("\n\n---\n\n");

      const completion = await generateAICompletion({
        capability: "synthesis",
        operation: "process-summary-full-rebuild",
        system: PROCESS_SUMMARY_SYSTEM_PROMPT_FULL_REBUILD,
        user: `Here are the full transcripts of all ${allConversations.length} conversations for this process:\n\n${transcriptBlock}`,
        maxTokens: 8192,
      });
      const rollingSummary = completion.text;
      if (rollingSummary) {
        await ctx.runMutation(internal.postCall.updateRollingSummary, {
          processId: args.processId,
          clerkOrgId: args.clerkOrgId,
          rollingSummary,
        });
        await ctx.runMutation(internal.processFlows.markFlowStale, {
          processId: args.processId,
          clerkOrgId: args.clerkOrgId,
        });
        const departmentId: Id<"departments"> | null = await ctx.runQuery(
          internal.postCall.getProcessDepartmentId,
          { processId: args.processId, clerkOrgId: args.clerkOrgId },
        );
        if (departmentId) {
          await ctx.runMutation(
            internal.summariesHelpers.markDepartmentSummaryStale,
            { departmentId },
          );
        }
      }
      return;
    }

    // Incremental path: existing summary + latest conversation transcript
    const existingSummary: string | null = await ctx.runQuery(
      internal.postCall.getProcessRollingSummary,
      { processId: args.processId, clerkOrgId: args.clerkOrgId },
    );

    const latestConversation: {
      contributorName: string;
      summary: string | null;
      transcript: unknown;
      creationTime: number;
    } | null = await ctx.runQuery(internal.postCall.getLatestConversation, {
      processId: args.processId,
      clerkOrgId: args.clerkOrgId,
    });

    if (!latestConversation) return;

    const allConversations: Array<{
      contributorName: string;
      summary: string;
      transcript: unknown;
      creationTime: number;
    }> = await ctx.runQuery(internal.postCall.getConversationSummaries, {
      processId: args.processId,
      clerkOrgId: args.clerkOrgId,
    });

    const conversationCount = allConversations.length;
    if (conversationCount === 0) return;

    const latestTranscript = formatTranscript(
      latestConversation.transcript as Array<{
        role: string;
        content: string;
        speakerName?: string;
      }> | null,
      latestConversation.contributorName,
      conversationCount,
    );

    let userContent: string;

    if (!existingSummary || conversationCount === 1) {
      userContent = `This is the first conversation recorded for this process. Generate the initial structured summary from this transcript:\n\n${latestTranscript}`;
    } else {
      userContent = `Here is the existing process summary:\n\n${existingSummary}\n\n---\n\nA new conversation has been recorded. Integrate the information from this transcript into the existing summary, updating all sections as needed:\n\n${latestTranscript}`;
    }

    const completion = await generateAICompletion({
      capability: "synthesis",
      operation: "process-summary-incremental",
      system: PROCESS_SUMMARY_SYSTEM_PROMPT,
      user: userContent,
      maxTokens: 8192,
    });
    const rollingSummary = completion.text;

    if (rollingSummary) {
      await ctx.runMutation(internal.postCall.updateRollingSummary, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        rollingSummary,
      });
      await ctx.runMutation(internal.processFlows.markFlowStale, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
      });
      const departmentId: Id<"departments"> | null = await ctx.runQuery(
        internal.postCall.getProcessDepartmentId,
        { processId: args.processId, clerkOrgId: args.clerkOrgId },
      );
      if (departmentId) {
        await ctx.runMutation(
          internal.summariesHelpers.markDepartmentSummaryStale,
          { departmentId },
        );
      }
    }
  },
});
