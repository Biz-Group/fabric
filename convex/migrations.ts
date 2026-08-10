import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { DataModel, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  QueryCtx,
} from "./_generated/server";
import { clerkUserIdFromTokenIdentifier } from "./lib/clerkApi";

export const migrations = new Migrations<DataModel>(components.migrations);

// Exposed so the CLI / dashboard can run migrations by name:
//   npx convex run migrations:run '{"fn":"migrations:<migrationName>"}'
export const run = migrations.runner();

// --- Phase 13.3: Biz Group backfill ----------------------------------------
//
// Reads BIZ_GROUP_CLERK_ORG_ID from the Convex deployment environment. Set it
// with:   npx convex env set BIZ_GROUP_CLERK_ORG_ID org_xxxxxx
// Unset it after verification:   npx convex env unset BIZ_GROUP_CLERK_ORG_ID
//
// All migrations here are idempotent — safe to re-run.

function getBizGroupOrgId(): string {
  const id = process.env.BIZ_GROUP_CLERK_ORG_ID;
  if (!id) {
    throw new Error(
      "BIZ_GROUP_CLERK_ORG_ID is not set. Run: npx convex env set BIZ_GROUP_CLERK_ORG_ID org_xxxxxx",
    );
  }
  return id;
}

// Stamp clerkOrgId on every existing row in each tenant-scoped table.
// Each migrator patches only rows that don't already have clerkOrgId set,
// making the migrations safe to re-run.

export const backfillFunctionsOrg = migrations.define({
  table: "functions",
  migrateOne: async (ctx, doc) => {
    if (doc.clerkOrgId) return;
    await ctx.db.patch(doc._id, { clerkOrgId: getBizGroupOrgId() });
  },
});

export const backfillDepartmentsOrg = migrations.define({
  table: "departments",
  migrateOne: async (ctx, doc) => {
    if (doc.clerkOrgId) return;
    await ctx.db.patch(doc._id, { clerkOrgId: getBizGroupOrgId() });
  },
});

export const backfillProcessesOrg = migrations.define({
  table: "processes",
  migrateOne: async (ctx, doc) => {
    if (doc.clerkOrgId) return;
    await ctx.db.patch(doc._id, { clerkOrgId: getBizGroupOrgId() });
  },
});

export const backfillConversationsOrg = migrations.define({
  table: "conversations",
  migrateOne: async (ctx, doc) => {
    if (doc.clerkOrgId) return;
    await ctx.db.patch(doc._id, { clerkOrgId: getBizGroupOrgId() });
  },
});

export const backfillProcessFlowsOrg = migrations.define({
  table: "processFlows",
  migrateOne: async (ctx, doc) => {
    if (doc.clerkOrgId) return;
    await ctx.db.patch(doc._id, { clerkOrgId: getBizGroupOrgId() });
  },
});

// --- Verification ----------------------------------------------------------
//
// Run with:
//   npx convex run migrations:verifyOrgBackfill
//
// Returns counts of total rows vs. rows still missing clerkOrgId, for every
// tenant-scoped table, plus the memberships row count. Expect every `unset`
// count to be 0 before narrowing the schema in Phase 13.8.

type TenantTable =
  | "functions"
  | "departments"
  | "processes"
  | "conversations"
  | "processFlows";

async function countUnsetClerkOrgId(
  ctx: QueryCtx,
  table: TenantTable,
): Promise<{ total: number; unset: number }> {
  let total = 0;
  let unset = 0;
  for await (const doc of ctx.db.query(table)) {
    total++;
    if (!doc.clerkOrgId) unset++;
  }
  return { total, unset };
}

export const verifyOrgBackfill = internalQuery({
  args: {},
  handler: async (ctx) => {
    let membershipCount = 0;
    for await (const membership of ctx.db.query("memberships")) {
      if (membership._id) membershipCount++;
    }
    return {
      functions: await countUnsetClerkOrgId(ctx, "functions"),
      departments: await countUnsetClerkOrgId(ctx, "departments"),
      processes: await countUnsetClerkOrgId(ctx, "processes"),
      conversations: await countUnsetClerkOrgId(ctx, "conversations"),
      processFlows: await countUnsetClerkOrgId(ctx, "processFlows"),
      memberships: { total: membershipCount },
    };
  },
});

// --- Membership directory/stat backfill ------------------------------------
//
// Backfills the denormalized member directory fields added for scalable member
// listing/search. Safe to re-run; it only copies current user profile fields
// onto each membership and preserves existing role/source information.
//
// Run with:
//   npx convex run migrations:run '{"fn":"migrations:backfillMembershipDirectory"}'

function normalizeEmail(email?: string | null): string {
  return (email ?? "").trim().toLowerCase();
}

function membershipSearchText(args: {
  name: string;
  email: string;
  jobTitle?: string;
}): string {
  return [args.name, args.email, args.jobTitle ?? ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export const backfillMembershipDirectory = migrations.define({
  table: "memberships",
  migrateOne: async (ctx, membership) => {
    const user = await ctx.db.get(membership.userId);
    if (!user) return;

    const email = user.email ?? "";
    const emailLower = user.emailLower ?? normalizeEmail(email);
    const name = user.name || email || "Anonymous";
    const jobTitle = user.jobTitle?.trim() || undefined;
    const clerkUserId =
      user.clerkUserId ??
      clerkUserIdFromTokenIdentifier(user.tokenIdentifier);

    await ctx.db.patch(membership._id, {
      status: membership.status ?? "active",
      source: membership.source ?? "legacy",
      updatedAt: Date.now(),
      clerkUserId,
      name,
      email,
      emailLower,
      profileComplete: user.profileComplete,
      searchText: membershipSearchText({ name, email, jobTitle }),
      ...(jobTitle ? { jobTitle } : {}),
      ...(user.platformRole ? { platformRole: user.platformRole } : {}),
    });
  },
});

export const verifyMembershipDirectoryBackfill = internalQuery({
  args: {},
  handler: async (ctx) => {
    let total = 0;
    let missingDirectoryFields = 0;
    for await (const membership of ctx.db.query("memberships")) {
      total++;
      if (
        !membership.name ||
        membership.email === undefined ||
        !membership.emailLower ||
        membership.profileComplete === undefined ||
        !membership.searchText ||
        !membership.status ||
        !membership.source
      ) {
        missingDirectoryFields++;
      }
    }
    return { total, missingDirectoryFields };
  },
});

// --- Summary V2: drop pre-`scope` process artifacts ------------------------
//
// The process overview artifact replaced its ordered `stages` findings with
// non-sequential `scope` findings (Product Decision 8). Renaming a required
// field is breaking, so any deployment that generated artifacts under
// `summary-v2-process-overview-v1` must clear them before the narrowed schema
// can be pushed.
//
// Dropping rather than transforming is deliberate: stage findings describe a
// sequence, and scope findings answer different questions (trigger, completion,
// ownership, systems, dependencies). There is no honest mechanical rewrite —
// the evidence has to be re-reduced. The legacy `rollingSummary` projection is
// left in place, so each process keeps showing readable content until it
// regenerates, and clearing `summaryV2SourceRevision` makes refresh-on-view
// treat the row as awaiting backfill.
//
// Run with:
//   npx convex run migrations:run '{"fn":"migrations:dropPreScopeProcessSummaries"}'
//
// Idempotent: rows already carrying `scope` are skipped.

/** Reads an artifact of either generation without asserting the new shape. */
function hasScopeFindings(artifact: unknown): boolean {
  return Array.isArray((artifact as { scope?: unknown } | null)?.scope);
}

export const dropPreScopeProcessSummaries = migrations.define({
  table: "processes",
  migrateOne: async (ctx, doc) => {
    if (!doc.summaryV2 || hasScopeFindings(doc.summaryV2)) return;
    await ctx.db.patch(doc._id, {
      summaryV2: undefined,
      summaryV2SourceRevision: undefined,
    });
  },
});

// Run with:
//   npx convex run migrations:verifyProcessSummaryScope
//
// Expect `preScopeArtifacts: 0` before restoring `schemaValidation` in
// convex/schema.ts.
export const verifyProcessSummaryScope = internalQuery({
  args: {},
  handler: async (ctx) => {
    let total = 0;
    let withArtifact = 0;
    let preScopeArtifacts = 0;
    for await (const process of ctx.db.query("processes")) {
      total++;
      if (!process.summaryV2) continue;
      withArtifact++;
      if (!hasScopeFindings(process.summaryV2)) preScopeArtifacts++;
    }
    return { total, withArtifact, preScopeArtifacts };
  },
});

// ---------------------------------------------------------------------------
// Dev → Prod migration (one-shot tenant move).
//
// Three-step flow orchestrated by `scripts/migrate-dev-to-prod.mjs`:
//   1. `exportForOrg` on dev — returns a JSON payload of all tenant-scoped
//      rows belonging to the source org (functions, departments, processes,
//      conversations, processFlows). Skipped: users + memberships (both
//      auto-provision on first sign-in into prod, driven by the prod Clerk
//      identity which is unrelated to dev's).
//   2. `prodImportGenerateUploadUrl` on prod — returns a one-shot upload URL.
//      The orchestrator HTTP-POSTs the JSON dump to that URL; Convex
//      storage returns a `storageId` the import step can reference.
//   3. `prodImportFromStorage` on prod — fetches the JSON from storage,
//      parses it, then calls `prodImport_insertAll` in a single mutation
//      transaction. Foreign-key IDs are remapped (old dev ids → new prod
//      ids); clerkOrgId is re-stamped with the prod Biz Group org id.
//
// Idempotency: `prodImport_insertAll` refuses to run if the target org
// already contains any functions. To re-run, delete the target org's rows
// from the Convex dashboard first.
// ---------------------------------------------------------------------------

export const exportForOrg = internalQuery({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const functions = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();

    const departments = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .collect();

    const processes = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .collect();

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .collect();

    const processFlows = await ctx.db
      .query("processFlows")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .collect();

    return {
      sourceOrgId: args.clerkOrgId,
      exportedAt: Date.now(),
      functions: functions.map((f) => ({
        oldId: f._id,
        name: f.name,
        sortOrder: f.sortOrder,
        summary: f.summary,
        summaryUpdatedAt: f.summaryUpdatedAt,
        summaryStale: f.summaryStale,
      })),
      departments: departments.map((d) => ({
        oldId: d._id,
        oldFunctionId: d.functionId,
        name: d.name,
        description: d.description,
        descriptionSafetyStatus: d.descriptionSafetyStatus,
        descriptionSafetyCheckedAt: d.descriptionSafetyCheckedAt,
        descriptionSafetyModel: d.descriptionSafetyModel,
        descriptionSafetyPromptVersion: d.descriptionSafetyPromptVersion,
        descriptionSafetyRisk: d.descriptionSafetyRisk,
        descriptionSafetyReason: d.descriptionSafetyReason,
        sortOrder: d.sortOrder,
        summary: d.summary,
        summaryUpdatedAt: d.summaryUpdatedAt,
        summaryStale: d.summaryStale,
      })),
      processes: processes.map((p) => ({
        oldId: p._id,
        oldDepartmentId: p.departmentId,
        name: p.name,
        description: p.description,
        descriptionSafetyStatus: p.descriptionSafetyStatus,
        descriptionSafetyCheckedAt: p.descriptionSafetyCheckedAt,
        descriptionSafetyModel: p.descriptionSafetyModel,
        descriptionSafetyPromptVersion: p.descriptionSafetyPromptVersion,
        descriptionSafetyRisk: p.descriptionSafetyRisk,
        descriptionSafetyReason: p.descriptionSafetyReason,
        sortOrder: p.sortOrder,
        rollingSummary: p.rollingSummary,
      })),
      conversations: conversations.map((c) => ({
        // userId deliberately dropped — dev Clerk identities don't exist in prod
        oldProcessId: c.processId,
        elevenlabsConversationId: c.elevenlabsConversationId,
        contributorName: c.contributorName,
        transcript: c.transcript,
        speakerLabels: c.speakerLabels,
        summary: c.summary,
        analysis: c.analysis,
        durationSeconds: c.durationSeconds,
        status: c.status,
        inputMode: c.inputMode,
        audioMimeType: c.audioMimeType,
        transcriptionProvider: c.transcriptionProvider,
        analysisProvider: c.analysisProvider,
      })),
      processFlows: processFlows.map((f) => ({
        oldProcessId: f.processId,
        status: f.status,
        stale: f.stale,
        generatedAt: f.generatedAt,
        conversationCount: f.conversationCount,
        errorMessage: f.errorMessage,
        nodes: f.nodes,
        edges: f.edges,
        insights: f.insights,
      })),
    };
  },
});

export const prodImportGenerateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

type ExportPayload = {
  sourceOrgId: string;
  exportedAt: number;
  functions: Array<Record<string, unknown>>;
  departments: Array<Record<string, unknown>>;
  processes: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  processFlows: Array<Record<string, unknown>>;
};

export const prodImportFromStorage = internalAction({
  args: {
    storageId: v.id("_storage"),
    targetOrgId: v.string(),
    expectedSourceOrgId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error(`Storage object ${args.storageId} not found`);
    const raw = await blob.text();
    const payload = JSON.parse(raw) as ExportPayload;

    if (
      args.expectedSourceOrgId &&
      payload.sourceOrgId !== args.expectedSourceOrgId
    ) {
      throw new Error(
        `Refusing import: payload sourceOrgId (${payload.sourceOrgId}) != expectedSourceOrgId (${args.expectedSourceOrgId})`,
      );
    }

    const result: {
      targetOrgId: string;
      sourceOrgId: string;
      inserted: Record<string, number>;
    } = await ctx.runMutation(internal.migrations.prodImport_insertAll, {
      payload,
      targetOrgId: args.targetOrgId,
    });

    // Clean up the uploaded dump after a successful import.
    await ctx.storage.delete(args.storageId);
    return result;
  },
});

export const prodImport_insertAll = internalMutation({
  args: {
    payload: v.any(),
    targetOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const payload = args.payload as ExportPayload;

    // Pre-flight: refuse to run if the target org already has any functions.
    const existing = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.targetOrgId))
      .take(1);
    if (existing.length > 0) {
      throw new Error(
        `Refusing import: target org ${args.targetOrgId} already has data. Delete it from the Convex dashboard first, then re-run.`,
      );
    }

    const fnMap = new Map<string, Id<"functions">>();
    for (const f of payload.functions) {
      const oldId = f.oldId as string;
      const newId = await ctx.db.insert("functions", {
        name: f.name as string,
        sortOrder: f.sortOrder as number,
        summary: f.summary as string | undefined,
        summaryUpdatedAt: f.summaryUpdatedAt as number | undefined,
        summaryStale: f.summaryStale as boolean | undefined,
        clerkOrgId: args.targetOrgId,
      });
      fnMap.set(oldId, newId);
    }

    const deptMap = new Map<string, Id<"departments">>();
    for (const d of payload.departments) {
      const oldId = d.oldId as string;
      const oldFunctionId = d.oldFunctionId as string;
      const newFunctionId = fnMap.get(oldFunctionId);
      if (!newFunctionId) {
        throw new Error(
          `Import inconsistency: department ${oldId} references unknown function ${oldFunctionId}`,
        );
      }
      const newId = await ctx.db.insert("departments", {
        functionId: newFunctionId,
        name: d.name as string,
        description: d.description as string | undefined,
        descriptionSafetyStatus: d.descriptionSafetyStatus as
          | "safe"
          | "blocked"
          | undefined,
        descriptionSafetyCheckedAt: d.descriptionSafetyCheckedAt as
          | number
          | undefined,
        descriptionSafetyModel: d.descriptionSafetyModel as string | undefined,
        descriptionSafetyPromptVersion: d.descriptionSafetyPromptVersion as
          | string
          | undefined,
        descriptionSafetyRisk: d.descriptionSafetyRisk as
          | "none"
          | "prompt_injection"
          | "agent_instruction"
          | "policy_override"
          | "sensitive_data_request"
          | "malicious_or_abusive"
          | "irrelevant"
          | undefined,
        descriptionSafetyReason: d.descriptionSafetyReason as string | undefined,
        sortOrder: d.sortOrder as number,
        summary: d.summary as string | undefined,
        summaryUpdatedAt: d.summaryUpdatedAt as number | undefined,
        summaryStale: d.summaryStale as boolean | undefined,
        clerkOrgId: args.targetOrgId,
      });
      deptMap.set(oldId, newId);
    }

    const procMap = new Map<string, Id<"processes">>();
    for (const p of payload.processes) {
      const oldId = p.oldId as string;
      const oldDepartmentId = p.oldDepartmentId as string;
      const newDepartmentId = deptMap.get(oldDepartmentId);
      if (!newDepartmentId) {
        throw new Error(
          `Import inconsistency: process ${oldId} references unknown department ${oldDepartmentId}`,
        );
      }
      const newId = await ctx.db.insert("processes", {
        departmentId: newDepartmentId,
        name: p.name as string,
        description: p.description as string | undefined,
        descriptionSafetyStatus: p.descriptionSafetyStatus as
          | "safe"
          | "blocked"
          | undefined,
        descriptionSafetyCheckedAt: p.descriptionSafetyCheckedAt as
          | number
          | undefined,
        descriptionSafetyModel: p.descriptionSafetyModel as string | undefined,
        descriptionSafetyPromptVersion: p.descriptionSafetyPromptVersion as
          | string
          | undefined,
        descriptionSafetyRisk: p.descriptionSafetyRisk as
          | "none"
          | "prompt_injection"
          | "agent_instruction"
          | "policy_override"
          | "sensitive_data_request"
          | "malicious_or_abusive"
          | "irrelevant"
          | undefined,
        descriptionSafetyReason: p.descriptionSafetyReason as string | undefined,
        sortOrder: p.sortOrder as number,
        rollingSummary: p.rollingSummary as string | undefined,
        clerkOrgId: args.targetOrgId,
      });
      procMap.set(oldId, newId);
    }

    let conversationsInserted = 0;
    for (const c of payload.conversations) {
      const oldProcessId = c.oldProcessId as string;
      const newProcessId = procMap.get(oldProcessId);
      if (!newProcessId) {
        throw new Error(
          `Import inconsistency: conversation references unknown process ${oldProcessId}`,
        );
      }
      await ctx.db.insert("conversations", {
        processId: newProcessId,
        elevenlabsConversationId: c.elevenlabsConversationId as
          | string
          | undefined,
        contributorName: c.contributorName as string,
        inputMode: c.inputMode as
          | "agent"
          | "voiceRecord"
          | "audioUpload"
          | undefined,
        audioMimeType: c.audioMimeType as string | undefined,
        transcriptionProvider: c.transcriptionProvider as
          | "elevenlabs-convai"
          | "elevenlabs-scribe"
          | undefined,
        analysisProvider: c.analysisProvider as
          | "elevenlabs-convai"
          | "fabric-openrouter"
          | "fabric-foundry"
          | undefined,
        transcript: c.transcript as
          | Array<{
              role: string;
              content: string;
              time_in_call_secs: number;
              speakerId?: string;
              speakerName?: string;
            }>
          | undefined,
        speakerLabels: c.speakerLabels as
          | Array<{
              speakerId: string;
              displayName: string;
              userId?: Id<"users">;
            }>
          | undefined,
        summary: c.summary as string | undefined,
        analysis: c.analysis,
        durationSeconds: c.durationSeconds as number | undefined,
        status: c.status as
          | "processing"
          | "needs_speaker_labels"
          | "done"
          | "failed",
        // userId intentionally omitted — will be null in prod
        clerkOrgId: args.targetOrgId,
      });
      conversationsInserted++;
    }

    let processFlowsInserted = 0;
    for (const f of payload.processFlows) {
      const oldProcessId = f.oldProcessId as string;
      const newProcessId = procMap.get(oldProcessId);
      if (!newProcessId) {
        throw new Error(
          `Import inconsistency: processFlow references unknown process ${oldProcessId}`,
        );
      }
      await ctx.db.insert("processFlows", {
        processId: newProcessId,
        status: f.status as "generating" | "ready" | "failed",
        stale: f.stale as boolean,
        generatedAt: f.generatedAt as number,
        conversationCount: f.conversationCount as number,
        errorMessage: f.errorMessage as string | undefined,
        nodes: f.nodes as never,
        edges: f.edges as never,
        insights: f.insights as never,
        clerkOrgId: args.targetOrgId,
      });
      processFlowsInserted++;
    }

    return {
      targetOrgId: args.targetOrgId,
      sourceOrgId: payload.sourceOrgId,
      inserted: {
        functions: fnMap.size,
        departments: deptMap.size,
        processes: procMap.size,
        conversations: conversationsInserted,
        processFlows: processFlowsInserted,
      },
    };
  },
});

