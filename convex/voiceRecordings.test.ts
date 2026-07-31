/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  coerceAnalysisPayload,
  normalizeScribeTranscript,
  parseAnalysisResponse,
} from "./voiceRecordings";

const modules = import.meta.glob("./**/*.ts");

const ORG_A = "org_voice_a";
const ORG_B = "org_voice_b";
const ISSUER = "https://test.clerk";

function identityForOrgA() {
  return {
    tokenIdentifier: `${ISSUER}|user_a`,
    subject: "user_a",
    issuer: ISSUER,
    name: "Alice",
    email: "alice@example.test",
    orgId: ORG_A,
    orgSlug: "voice-a",
  };
}

function identityForOrgB() {
  return {
    tokenIdentifier: `${ISSUER}|user_b`,
    subject: "user_b",
    issuer: ISSUER,
    name: "Bob",
    email: "bob@example.test",
    orgId: ORG_B,
    orgSlug: "voice-b",
  };
}

function identityForOrgAUser(
  userId: "user_c" | "user_admin",
  name: string,
) {
  return {
    tokenIdentifier: `${ISSUER}|${userId}`,
    subject: userId,
    issuer: ISSUER,
    name,
    email: `${userId}@example.test`,
    orgId: ORG_A,
    orgSlug: "voice-a",
  };
}

async function seedSpeakerLabelFixture(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userAId = await ctx.db.insert("users", {
      tokenIdentifier: `${ISSUER}|user_a`,
      name: "Alice",
      email: "alice@example.test",
      profileComplete: true,
    });
    const userBId = await ctx.db.insert("users", {
      tokenIdentifier: `${ISSUER}|user_b`,
      name: "Bob",
      email: "bob@example.test",
      profileComplete: true,
    });
    await ctx.db.insert("memberships", {
      tokenIdentifier: `${ISSUER}|user_a`,
      userId: userAId,
      clerkOrgId: ORG_A,
      role: "contributor",
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      tokenIdentifier: `${ISSUER}|user_b`,
      userId: userBId,
      clerkOrgId: ORG_B,
      role: "contributor",
      createdAt: Date.now(),
    });
    const fnA = await ctx.db.insert("functions", {
      name: "Ops",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });
    const deptA = await ctx.db.insert("departments", {
      functionId: fnA,
      name: "Payroll",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });
    const processA = await ctx.db.insert("processes", {
      departmentId: deptA,
      name: "Monthly payroll",
      sortOrder: 0,
      clerkOrgId: ORG_A,
    });
    const conversationId = await ctx.db.insert("conversations", {
      processId: processA,
      clerkOrgId: ORG_A,
      contributorName: "Recorder",
      userId: userAId,
      inputMode: "voiceRecord",
      transcriptionProvider: "elevenlabs-scribe",
      analysisProvider: "fabric-openrouter",
      status: "needs_speaker_labels",
      transcript: [
        {
          role: "user",
          content: "I pull the payroll report.",
          time_in_call_secs: 0,
          speakerId: "speaker_0",
        },
        {
          role: "user",
          content: "Then I approve the final totals.",
          time_in_call_secs: 4,
          speakerId: "speaker_1",
        },
      ],
      speakerLabels: [
        { speakerId: "speaker_0", displayName: "Speaker 1" },
        { speakerId: "speaker_1", displayName: "Speaker 2" },
      ],
    });
    return { conversationId, userAId, userBId };
  });
}

async function seedOrgAMember(
  t: ReturnType<typeof convexTest>,
  userId: "user_c" | "user_admin",
  role: "admin" | "contributor",
) {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", {
      tokenIdentifier: `${ISSUER}|${userId}`,
      name: userId,
      email: `${userId}@example.test`,
      profileComplete: true,
    });
    await ctx.db.insert("memberships", {
      tokenIdentifier: `${ISSUER}|${userId}`,
      userId: id,
      clerkOrgId: ORG_A,
      role,
      createdAt: Date.now(),
    });
    return id;
  });
}

async function seedFailedAudioConversation(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    clerkOrgId: string;
    inputMode: "agent" | "voiceRecord" | "audioUpload";
    withAudioStorage: boolean;
    transcript: Array<{
      role: string;
      content: string;
      time_in_call_secs: number;
      speakerId?: string;
      speakerName?: string;
    }>;
    summary: string;
    title: string;
    analysis: Record<string, unknown>;
  }> = {},
) {
  return await t.run(async (ctx) => {
    const clerkOrgId = overrides.clerkOrgId ?? ORG_A;
    const fn = await ctx.db.insert("functions", {
      name: "Ops",
      sortOrder: 0,
      clerkOrgId,
    });
    const dept = await ctx.db.insert("departments", {
      functionId: fn,
      name: "Payroll",
      sortOrder: 0,
      clerkOrgId,
    });
    const processId = await ctx.db.insert("processes", {
      departmentId: dept,
      name: "Monthly payroll",
      sortOrder: 0,
      clerkOrgId,
    });
    const audioStorageId = overrides.withAudioStorage
      ? await ctx.storage.store(new Blob(["audio"], { type: "audio/webm" }))
      : undefined;
    const conversationId = await ctx.db.insert("conversations", {
      processId,
      clerkOrgId,
      contributorName: "Uploader",
      inputMode: overrides.inputMode ?? "audioUpload",
      audioStorageId,
      audioMimeType: audioStorageId ? "audio/webm" : undefined,
      transcriptionProvider: "elevenlabs-scribe",
      analysisProvider: "fabric-openrouter",
      transcript: overrides.transcript,
      summary: overrides.summary,
      title: overrides.title,
      analysis: overrides.analysis,
      durationSeconds: 42,
      status: "failed",
    });
    return { conversationId, processId };
  });
}

describe("voice recording helpers", () => {
  test("normalizes Scribe word timestamps into transcript chunks", () => {
    const transcript = normalizeScribeTranscript({
      text: "Pull the report. Validate totals.",
      words: [
        { text: "Pull", start: 0, end: 0.2, type: "word" },
        { text: "the", start: 0.25, end: 0.4, type: "word" },
        { text: "report", start: 0.45, end: 0.8, type: "word" },
        { text: ".", start: 0.8, end: 0.85, type: "spacing" },
        { text: "[noise]", start: 0.9, end: 1.1, type: "audio_event" },
        { text: "Validate", start: 2, end: 2.3, type: "word" },
        { text: "totals", start: 2.35, end: 2.8, type: "word" },
        { text: ".", start: 2.8, end: 2.85, type: "spacing" },
      ],
    });

    expect(transcript).toEqual([
      {
        role: "user",
        content: "Pull the report. Validate totals.",
        time_in_call_secs: 0,
        speakerId: "speaker_0",
      },
    ]);
  });

  test("splits normalized transcript when diarized speaker changes", () => {
    const transcript = normalizeScribeTranscript({
      words: [
        { text: "Pull", start: 0, end: 0.2, type: "word", speaker_id: "speaker_0" },
        { text: "report", start: 0.25, end: 0.5, type: "word", speaker_id: "speaker_0" },
        { text: "Approve", start: 1, end: 1.4, type: "word", speaker_id: "speaker_1" },
        { text: "totals", start: 1.45, end: 1.8, type: "word", speaker_id: "speaker_1" },
      ],
    });

    expect(transcript).toEqual([
      {
        role: "user",
        content: "Pull report",
        time_in_call_secs: 0,
        speakerId: "speaker_0",
      },
      {
        role: "user",
        content: "Approve totals",
        time_in_call_secs: 1,
        speakerId: "speaker_1",
      },
    ]);
  });

  test("coerces analysis fields into the process-flow compatible shape", () => {
    const analysis = coerceAnalysisPayload(
      {
        call_summary_title: "  Monthly payroll checks  ",
        transcript_summary: "Contributor described monthly payroll checks.",
        data_collection: {
          process_steps: [{ id: "pull-report", name: "Pull report" }],
          step_connections: "[]",
          step_issues: [{ step_id: "pull-report", is_bottleneck: false }],
          dependencies: "HRIS export",
          frequency: "Monthly",
        },
        success_evaluation: {
          described_specific_steps: true,
          mentioned_tools_or_systems: true,
          identified_dependencies: true,
        },
      },
      "Fallback",
    );

    expect(analysis.call_summary_title).toBe("Monthly payroll checks");
    expect(analysis.transcript_summary).toBe(
      "Contributor described monthly payroll checks.",
    );
    expect(JSON.parse(analysis.data_collection.process_steps)).toHaveLength(1);
    expect(JSON.parse(analysis.data_collection.step_connections)).toEqual([]);
    expect(JSON.parse(analysis.data_collection.step_issues)).toHaveLength(1);
    expect(analysis.data_collection.dependencies).toBe("HRIS export");
    expect(analysis.success_evaluation.identified_dependencies).toBe(true);
  });

  test("parses a well-formed analysis response into a payload", () => {
    const payload = {
      call_summary_title: "Payroll close walkthrough",
      transcript_summary: "Contributor walked through the payroll close.",
      data_collection: {
        process_steps: "[]",
        step_connections: "[]",
        step_issues: "[]",
      },
    };
    const analysis = parseAnalysisResponse(
      { text: JSON.stringify(payload), finishReason: "stop" },
      "Fallback",
    );

    expect(analysis.call_summary_title).toBe("Payroll close walkthrough");
    expect(analysis.transcript_summary).toBe(
      "Contributor walked through the payroll close.",
    );
  });

  test("detects token-limit truncation instead of throwing a parse error", () => {
    // A truncated payload — JSON.parse would normally throw an opaque error.
    expect(() =>
      parseAnalysisResponse(
        {
          finishReason: "length",
          text: '{"transcript_summary":"Contributor expl',
        },
        "Fallback",
      ),
    ).toThrow(/token limit/i);
  });

  test("reports unparseable (non-truncated) JSON distinctly", () => {
    expect(() =>
      parseAnalysisResponse(
        {
          finishReason: "stop",
          text: "not json at all",
        },
        "Fallback",
      ),
    ).toThrow(/unparseable JSON/i);
  });
});

describe("speaker label submission", () => {
  test("applies labels, optional org member links, and queues analysis", async () => {
    const t = convexTest(schema, modules);
    const { conversationId, userAId } = await seedSpeakerLabelFixture(t);

    await t.withIdentity(identityForOrgA()).mutation(
      api.voiceRecordings.submitSpeakerLabels,
      {
        conversationId,
        labels: [
          { speakerId: "speaker_0", displayName: "Alice", userId: userAId },
          { speakerId: "speaker_1", displayName: "Finance Lead" },
        ],
      },
    );

    const updated = await t.run(async (ctx) => {
      return await ctx.db.get(conversationId);
    });
    expect(updated?.status).toBe("processing");
    expect(updated?.speakerLabels).toEqual([
      { speakerId: "speaker_0", displayName: "Alice", userId: userAId },
      { speakerId: "speaker_1", displayName: "Finance Lead" },
    ]);
    expect(updated?.transcript?.map((msg) => msg.speakerName)).toEqual([
      "Alice",
      "Finance Lead",
    ]);
  });

  test("rejects missing labels", async () => {
    const t = convexTest(schema, modules);
    const { conversationId } = await seedSpeakerLabelFixture(t);

    await expect(
      t.withIdentity(identityForOrgA()).mutation(
        api.voiceRecordings.submitSpeakerLabels,
        {
          conversationId,
          labels: [{ speakerId: "speaker_0", displayName: "Alice" }],
        },
      ),
    ).rejects.toThrow(/Every speaker needs a label/);
  });

  test("rejects cross-org submitters and cross-org member links", async () => {
    const t = convexTest(schema, modules);
    const { conversationId, userBId } = await seedSpeakerLabelFixture(t);

    await expect(
      t.withIdentity(identityForOrgB()).mutation(
        api.voiceRecordings.submitSpeakerLabels,
        {
          conversationId,
          labels: [
            { speakerId: "speaker_0", displayName: "Alice" },
            { speakerId: "speaker_1", displayName: "Bob" },
          ],
        },
      ),
    ).rejects.toThrow(/Not found/);

    await expect(
      t.withIdentity(identityForOrgA()).mutation(
        api.voiceRecordings.submitSpeakerLabels,
        {
          conversationId,
          labels: [
            { speakerId: "speaker_0", displayName: "Alice" },
            { speakerId: "speaker_1", displayName: "Bob", userId: userBId },
          ],
        },
      ),
    ).rejects.toThrow(/not in this organization/);
  });
});

describe("voice recording abandonment", () => {
  test("allows the owner to abandon an unfinished recording", async () => {
    const t = convexTest(schema, modules);
    const { conversationId } = await seedSpeakerLabelFixture(t);

    await t
      .withIdentity(identityForOrgA())
      .mutation(api.voiceRecordings.abandonVoiceRecording, { conversationId });

    const row = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(row).toBeNull();
  });

  test("blocks same-org contributors who do not own the recording", async () => {
    const t = convexTest(schema, modules);
    const { conversationId } = await seedSpeakerLabelFixture(t);
    await seedOrgAMember(t, "user_c", "contributor");

    await expect(
      t
        .withIdentity(identityForOrgAUser("user_c", "Carol"))
        .mutation(api.voiceRecordings.abandonVoiceRecording, { conversationId }),
    ).rejects.toThrow(/Insufficient permissions/);

    const row = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(row).not.toBeNull();
  });

  test("allows admins to abandon another member's unfinished recording", async () => {
    const t = convexTest(schema, modules);
    const { conversationId } = await seedSpeakerLabelFixture(t);
    await seedOrgAMember(t, "user_admin", "admin");

    await t
      .withIdentity(identityForOrgAUser("user_admin", "Admin"))
      .mutation(api.voiceRecordings.abandonVoiceRecording, { conversationId });

    const row = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(row).toBeNull();
  });

  test("preserves finalized recordings even for the owner", async () => {
    const t = convexTest(schema, modules);
    const { conversationId } = await seedSpeakerLabelFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(conversationId, { status: "done" });
    });

    await t
      .withIdentity(identityForOrgA())
      .mutation(api.voiceRecordings.abandonVoiceRecording, { conversationId });

    const row = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(row?.status).toBe("done");
  });
});

describe("audio retry", () => {
  test("queues transcription retry for a failed audio upload without a transcript", async () => {
    const t = convexTest(schema, modules);
    await seedOrgAMember(t, "user_admin", "admin");
    const { conversationId } = await seedFailedAudioConversation(t, {
      withAudioStorage: true,
    });

    const result = await t
      .withIdentity(identityForOrgAUser("user_admin", "Admin"))
      .mutation(api.voiceRecordings.retryAudioProcessing, { conversationId });

    expect(result).toEqual({
      status: "processing",
      retryStage: "transcription",
    });
    const row = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(row?.status).toBe("processing");
    expect(row?.summary).toBeUndefined();
    expect(row?.analysis).toBeUndefined();
  });

  test("queues summary retry for a failed audio upload with a transcript", async () => {
    const t = convexTest(schema, modules);
    await seedOrgAMember(t, "user_admin", "admin");
    const transcript = [
      {
        role: "user",
        content: "I pull the payroll report.",
        time_in_call_secs: 0,
        speakerId: "speaker_0",
        speakerName: "Alice",
      },
    ];
    const { conversationId } = await seedFailedAudioConversation(t, {
      transcript,
      summary: "Stale summary",
      title: "Stale title",
      analysis: { stale: true },
    });

    const result = await t
      .withIdentity(identityForOrgAUser("user_admin", "Admin"))
      .mutation(api.voiceRecordings.retryAudioProcessing, { conversationId });

    expect(result).toEqual({
      status: "processing",
      retryStage: "analysis",
    });
    const row = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(row?.status).toBe("processing");
    expect(row?.transcript).toEqual(transcript);
    expect(row?.summary).toBeUndefined();
    expect(row?.title).toBeUndefined();
    expect(row?.analysis).toBeUndefined();
  });

  test("rejects cross-org audio retry attempts", async () => {
    const t = convexTest(schema, modules);
    await seedOrgAMember(t, "user_admin", "admin");
    const { conversationId } = await seedFailedAudioConversation(t, {
      clerkOrgId: ORG_B,
      withAudioStorage: true,
    });

    await expect(
      t
        .withIdentity(identityForOrgAUser("user_admin", "Admin"))
        .mutation(api.voiceRecordings.retryAudioProcessing, { conversationId }),
    ).rejects.toThrow(/Not found/);
  });

  test("requires admin role for audio retry", async () => {
    const t = convexTest(schema, modules);
    await seedOrgAMember(t, "user_c", "contributor");
    const { conversationId } = await seedFailedAudioConversation(t, {
      withAudioStorage: true,
    });

    await expect(
      t
        .withIdentity(identityForOrgAUser("user_c", "Carol"))
        .mutation(api.voiceRecordings.retryAudioProcessing, { conversationId }),
    ).rejects.toThrow(/Insufficient permissions/);
  });

  test("rejects non-audio failed conversations", async () => {
    const t = convexTest(schema, modules);
    await seedOrgAMember(t, "user_admin", "admin");
    const { conversationId } = await seedFailedAudioConversation(t, {
      inputMode: "agent",
      withAudioStorage: true,
    });

    await expect(
      t
        .withIdentity(identityForOrgAUser("user_admin", "Admin"))
        .mutation(api.voiceRecordings.retryAudioProcessing, { conversationId }),
    ).rejects.toThrow(/Only failed audio conversations/);
  });
});
