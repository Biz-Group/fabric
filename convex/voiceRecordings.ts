import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  assertOrgOwns,
  requireOrgContributor,
  resolveOrgForAction,
} from "./lib/orgAuth";

type TranscriptMessage = {
  role: string;
  content: string;
  time_in_call_secs: number;
};

type ScribeWord = {
  text?: string;
  start?: number;
  end?: number;
  type?: string;
  speaker_id?: string;
};

type ScribeResponse = {
  text?: string;
  words?: ScribeWord[];
};

type AnalysisPayload = {
  transcript_summary: string;
  data_collection: {
    process_steps: string;
    step_connections: string;
    step_issues: string;
    dependencies: string;
    frequency: string;
    edge_cases: string;
    total_process_duration: string;
    compliance_or_approvals: string;
  };
  success_evaluation: {
    described_specific_steps: boolean;
    mentioned_tools_or_systems: boolean;
    identified_dependencies: boolean;
  };
};

const VOICE_RECORDING_ANALYSIS_PROMPT = `You are analyzing a single employee voice recording about one business process.

Return ONLY a valid JSON object with this exact shape:
{
  "transcript_summary": "Concise 4-6 sentence summary of what the contributor explained.",
  "data_collection": {
    "process_steps": "JSON array string of steps: [{\\"id\\":\\"kebab-case\\",\\"name\\":\\"Step name\\",\\"type\\":\\"action|decision|handoff|wait\\",\\"actor\\":\\"person/team\\",\\"tools\\":[\\"tool\\"],\\"duration\\":\\"duration or null\\"}]",
    "step_connections": "JSON array string of connections: [{\\"from\\":\\"step-id\\",\\"to\\":\\"step-id\\",\\"condition\\":\\"condition or null\\"}]",
    "step_issues": "JSON array string of issues: [{\\"step_id\\":\\"step-id\\",\\"pain_point\\":\\"issue or null\\",\\"is_bottleneck\\":false,\\"bottleneck_reason\\":\\"reason or null\\",\\"automation_potential\\":\\"none|low|medium|high|null\\",\\"workaround\\":\\"workaround or null\\"}]",
    "dependencies": "People, teams, or systems depended on. Empty string if not mentioned.",
    "frequency": "How often this process happens. Empty string if not mentioned.",
    "edge_cases": "Exceptions or failure modes. Empty string if not mentioned.",
    "total_process_duration": "End-to-end duration. Empty string if not mentioned.",
    "compliance_or_approvals": "Approval or compliance gates. Empty string if none mentioned."
  },
  "success_evaluation": {
    "described_specific_steps": true,
    "mentioned_tools_or_systems": true,
    "identified_dependencies": true
  }
}

Rules:
- Base the JSON only on the transcript. Do not invent tools, dependencies, or durations.
- process_steps, step_connections, and step_issues must be strings containing valid JSON arrays.
- Use stable kebab-case ids for steps so downstream process-flow generation can merge them.
- If the transcript is vague, keep fields sparse and mark booleans false where appropriate.`;

function appendToken(current: string, token: string): string {
  if (!current) return token;
  if (/^[,.;:!?)]/.test(token)) return `${current}${token}`;
  if (/^['"]$/.test(token)) return `${current}${token}`;
  return `${current} ${token}`;
}

export function normalizeScribeTranscript(
  data: ScribeResponse,
): TranscriptMessage[] {
  const words = Array.isArray(data.words) ? data.words : [];
  const speechWords = words.filter((word) => {
    const token = (word.text ?? "").trim();
    return token && word.type !== "audio_event";
  });

  if (speechWords.length === 0) {
    const text = (data.text ?? "").trim();
    return text
      ? [{ role: "user", content: text, time_in_call_secs: 0 }]
      : [];
  }

  const chunks: TranscriptMessage[] = [];
  let content = "";
  let chunkStart = speechWords[0]?.start ?? 0;
  let lastEnd = chunkStart;

  for (const word of speechWords) {
    const token = (word.text ?? "").trim();
    if (!token) continue;

    const start = typeof word.start === "number" ? word.start : lastEnd;
    const end = typeof word.end === "number" ? word.end : start;
    const shouldSplit =
      content.length > 260 ||
      (content.length > 120 && /[.!?]$/.test(content)) ||
      start - chunkStart > 25;

    if (content && shouldSplit) {
      chunks.push({
        role: "user",
        content,
        time_in_call_secs: chunkStart,
      });
      content = token;
      chunkStart = start;
    } else {
      content = appendToken(content, token);
    }
    lastEnd = end;
  }

  if (content) {
    chunks.push({ role: "user", content, time_in_call_secs: chunkStart });
  }

  return chunks;
}

function transcriptText(transcript: TranscriptMessage[]): string {
  return transcript.map((msg) => msg.content).join("\n");
}

function stripJsonFences(content: string): string {
  const trimmed = content.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const first = withoutFences.indexOf("{");
  const last = withoutFences.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return withoutFences.slice(first, last + 1);
  }
  return withoutFences;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonArrayString(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? JSON.stringify(parsed) : "[]";
    } catch {
      return "[]";
    }
  }
  return Array.isArray(value) ? JSON.stringify(value) : "[]";
}

export function coerceAnalysisPayload(
  value: unknown,
  fallbackSummary: string,
): AnalysisPayload {
  const root = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
  const dc = root.data_collection && typeof root.data_collection === "object"
    ? (root.data_collection as Record<string, unknown>)
    : {};
  const success =
    root.success_evaluation && typeof root.success_evaluation === "object"
      ? (root.success_evaluation as Record<string, unknown>)
      : {};

  return {
    transcript_summary:
      stringValue(root.transcript_summary) || fallbackSummary,
    data_collection: {
      process_steps: jsonArrayString(dc.process_steps),
      step_connections: jsonArrayString(dc.step_connections),
      step_issues: jsonArrayString(dc.step_issues),
      dependencies: stringValue(dc.dependencies),
      frequency: stringValue(dc.frequency),
      edge_cases: stringValue(dc.edge_cases),
      total_process_duration: stringValue(dc.total_process_duration),
      compliance_or_approvals: stringValue(dc.compliance_or_approvals),
    },
    success_evaluation: {
      described_specific_steps: success.described_specific_steps === true,
      mentioned_tools_or_systems: success.mentioned_tools_or_systems === true,
      identified_dependencies: success.identified_dependencies === true,
    },
  };
}

function fallbackSummaryFromTranscript(transcript: TranscriptMessage[]): string {
  const text = transcriptText(transcript).trim();
  if (!text) return "No transcript content was available for this recording.";
  return text.length > 800 ? `${text.slice(0, 797)}...` : text;
}

async function transcribeWithScribe(
  audio: Blob,
  apiKey: string,
  mimeType: string,
): Promise<ScribeResponse> {
  const form = new FormData();
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  form.append("file", audio, `voice-recording.${extension}`);
  form.append("model_id", "scribe_v2");
  form.append("language_code", "en");
  form.append("tag_audio_events", "true");
  form.append("timestamps_granularity", "word");
  form.append("diarize", "false");

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs Scribe error ${response.status}: ${body}`);
  }

  return (await response.json()) as ScribeResponse;
}

async function analyzeTranscript(
  transcript: TranscriptMessage[],
  openrouterKey: string,
): Promise<AnalysisPayload> {
  const fallbackSummary = fallbackSummaryFromTranscript(transcript);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4.5",
      messages: [
        { role: "system", content: VOICE_RECORDING_ANALYSIS_PROMPT },
        {
          role: "user",
          content: `Transcript:\n\n${transcriptText(transcript)}`,
        },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${body}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter returned an empty analysis response");
  }

  return coerceAnalysisPayload(
    JSON.parse(stripJsonFences(content)),
    fallbackSummary,
  );
}

export const generateUploadUrl = mutation({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const process = await ctx.db.get(args.processId);
    assertOrgOwns(caller, process);
    return await ctx.storage.generateUploadUrl();
  },
});

export const processVoiceRecording = action({
  args: {
    processId: v.id("processes"),
    storageId: v.id("_storage"),
    durationSeconds: v.optional(v.number()),
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    const { orgId, tokenIdentifier } = await resolveOrgForAction(ctx);
    const caller: { orgId: string; userId: Id<"users"> } =
      await ctx.runQuery(internal.postCall.requireOrgContributorInternal, {});
    await ctx.runQuery(internal.processFlows.assertProcessInOrg, {
      processId: args.processId,
      clerkOrgId: orgId,
    });

    const user = await ctx.runQuery(internal.postCall.getUserByToken, {
      tokenIdentifier,
    });
    const conversationId: Id<"conversations"> = await ctx.runMutation(
      internal.postCall.insertConversation,
      {
        processId: args.processId,
        clerkOrgId: orgId,
        contributorName: user?.name ?? "Anonymous",
        userId: caller.userId,
        inputMode: "voiceRecord",
        audioStorageId: args.storageId,
        audioMimeType: args.mimeType,
        transcriptionProvider: "elevenlabs-scribe",
        analysisProvider: "fabric-openrouter",
        durationSeconds: args.durationSeconds,
        status: "processing",
      },
    );

    await ctx.scheduler.runAfter(
      0,
      internal.voiceRecordings.processVoiceRecordingInternal,
      {
        conversationId,
        processId: args.processId,
        clerkOrgId: orgId,
        storageId: args.storageId,
        durationSeconds: args.durationSeconds,
        mimeType: args.mimeType,
      },
    );

    return { status: "processing" as const, conversationId };
  },
});

export const finishVoiceRecording = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    clerkOrgId: v.string(),
    transcript: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        time_in_call_secs: v.number(),
      }),
    ),
    summary: v.string(),
    analysis: v.any(),
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
      inputMode: "voiceRecord",
      transcriptionProvider: "elevenlabs-scribe",
      analysisProvider: "fabric-openrouter",
      status: "done",
    });
  },
});

export const markVoiceRecordingFailed = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || conv.clerkOrgId !== args.clerkOrgId) return;
    await ctx.db.patch(args.conversationId, { status: "failed" });
  },
});

export const processVoiceRecordingInternal = internalAction({
  args: {
    conversationId: v.id("conversations"),
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    storageId: v.id("_storage"),
    durationSeconds: v.optional(v.number()),
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
      if (!elevenLabsKey) {
        throw new Error("ELEVENLABS_API_KEY is not configured");
      }
      const openrouterKey = process.env.OPENROUTER_API_KEY;
      if (!openrouterKey) {
        throw new Error("OPENROUTER_API_KEY is not configured");
      }

      const audio = await ctx.storage.get(args.storageId);
      if (!audio) {
        throw new Error(`Storage object ${args.storageId} not found`);
      }

      const scribeResult = await transcribeWithScribe(
        audio,
        elevenLabsKey,
        args.mimeType,
      );
      const transcript = normalizeScribeTranscript(scribeResult);
      if (transcript.length === 0) {
        throw new Error("Scribe returned an empty transcript");
      }

      const analysis = await analyzeTranscript(transcript, openrouterKey);
      const inferredDuration =
        args.durationSeconds ??
        transcript[transcript.length - 1]?.time_in_call_secs;

      await ctx.runMutation(internal.voiceRecordings.finishVoiceRecording, {
        conversationId: args.conversationId,
        clerkOrgId: args.clerkOrgId,
        transcript,
        summary: analysis.transcript_summary,
        analysis,
        durationSeconds: inferredDuration,
      });

      await ctx.scheduler.runAfter(
        0,
        internal.postCall.regenerateProcessSummary,
        { processId: args.processId, clerkOrgId: args.clerkOrgId },
      );

      return { status: "done" as const };
    } catch (error) {
      console.error("Voice recording processing failed:", error);
      await ctx.runMutation(internal.voiceRecordings.markVoiceRecordingFailed, {
        conversationId: args.conversationId,
        clerkOrgId: args.clerkOrgId,
      });
      return { status: "failed" as const };
    }
  },
});
