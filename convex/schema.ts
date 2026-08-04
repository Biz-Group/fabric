import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  descriptionSafetyRiskValidator,
  descriptionSafetyStatusValidator,
} from "./descriptionSafety";

const rgbValidator = v.object({
  r: v.number(),
  g: v.number(),
  b: v.number(),
});

const orgThemeTokensValidator = v.object({
  accent: v.string(),
  accentForeground: v.string(),
  subtle: v.string(),
  border: v.string(),
  ring: v.string(),
  selected: v.string(),
  selectedForeground: v.string(),
  chart1: v.string(),
  chart2: v.string(),
  chart3: v.string(),
  chart4: v.string(),
  chart5: v.string(),
});

const themeSourceValidator = v.union(v.literal("logo"), v.literal("manual"));

const transcriptMessageValidator = v.object({
  role: v.string(),
  content: v.string(),
  time_in_call_secs: v.number(),
  speakerId: v.optional(v.string()),
  speakerName: v.optional(v.string()),
});

const speakerLabelValidator = v.object({
  speakerId: v.string(),
  displayName: v.string(),
  userId: v.optional(v.id("users")),
});

const conversationStatusValidator = v.union(
  v.literal("processing"),
  v.literal("needs_speaker_labels"),
  v.literal("done"),
  v.literal("failed"),
);

export const flowNodeCategoryValidator = v.union(
  v.literal("start"),
  v.literal("end"),
  v.literal("action"),
  v.literal("decision"),
  v.literal("handoff"),
  v.literal("wait"),
);

const automationPotentialValidator = v.union(
  v.literal("none"),
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

const confidenceValidator = v.union(
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
);

export const flowEdgeFields = {
  id: v.string(),
  source: v.string(),
  target: v.string(),
  type: v.union(
    v.literal("sequential"),
    v.literal("conditional"),
    v.literal("parallel"),
    v.literal("fallback"),
  ),
  label: v.optional(v.string()),
  isHappyPath: v.boolean(),
};

/**
 * An automation opportunity identified across the whole enriched graph.
 *
 * Structured rather than prose because it is meant to be built from: an
 * opportunity spanning three approval handoffs is one thing to build, and
 * downstream tooling needs to know which steps it covers and what kind of
 * automation it is, not just read a sentence about it.
 */
export const automationOpportunityValidator = v.object({
  title: v.string(),
  kind: v.union(
    v.literal("agent"),
    v.literal("workflow"),
    v.literal("integration"),
    v.literal("other"),
  ),
  /** Graph node ids this would replace or assist. */
  nodeIds: v.array(v.string()),
  rationale: v.string(),
  expectedBenefit: v.optional(v.string()),
  prerequisites: v.array(v.string()),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
});

/**
 * The enrichable half of a flow node — everything the graph pass does *not*
 * produce. Shared between the aggregate row (where a legacy single-call
 * generation wrote it inline) and `processFlowNodeDetails` (where a staged
 * generation writes it one batch at a time), so the two can never drift.
 */
export const flowNodeDetailFields = {
  description: v.string(),
  actors: v.array(v.string()),
  tools: v.array(v.string()),
  estimatedDuration: v.optional(v.string()),
  painPoints: v.array(v.string()),
  automationPotential: automationPotentialValidator,
  confidence: confidenceValidator,
  isBottleneck: v.boolean(),
  isTribalKnowledge: v.boolean(),
  riskIndicators: v.array(v.string()),
  sources: v.array(v.string()),
};

const roleValidator = v.union(
  v.literal("admin"),
  v.literal("contributor"),
  v.literal("viewer"),
);

const membershipSourceValidator = v.union(
  v.literal("selfSignup"),
  v.literal("adminInvite"),
  v.literal("superAdminFanOut"),
  v.literal("reconcile"),
  v.literal("webhook"),
  v.literal("legacy"),
);

const membershipStatusValidator = v.union(
  v.literal("active"),
  v.literal("removed"),
);

const membershipIntentStatusValidator = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("revoked"),
  v.literal("expired"),
  v.literal("blocked"),
);

export default defineSchema({
  // App-level user profiles (linked to Clerk identity via tokenIdentifier).
  // Identity is global — membership in a specific org lives in `memberships`.
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkUserId: v.optional(v.string()),
    name: v.string(),
    email: v.string(),
    emailLower: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
    function: v.optional(v.string()),
    department: v.optional(v.string()),
    hireDate: v.optional(v.string()),
    profileComplete: v.boolean(),
    // Platform-level role, orthogonal to per-org roles. Only "superAdmin" today.
    // Absent = regular user. Grants: create/delete orgs, fan-out action, future
    // cross-org dashboards. Does NOT by itself grant access to any tenant's data —
    // super-admins gain that via auto-provisioned memberships (Model A).
    platformRole: v.optional(v.literal("superAdmin")),
    lastSyncedFromClerkAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_email", ["email"])
    .index("by_emailLower", ["emailLower"])
    .index("by_function", ["function"])
    .index("by_department", ["department"])
    .index("by_platformRole", ["platformRole"]),

  // Per-(user, org) role assignments. Fabric owns roles — not Clerk — so a user
  // can hold different roles in different orgs. Auto-provisioned on first
  // authenticated request into an org (see `users.store`).
  memberships: defineTable({
    tokenIdentifier: v.string(),
    userId: v.id("users"),
    clerkOrgId: v.string(),
    role: roleValidator,
    invitedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
    status: v.optional(membershipStatusValidator),
    source: v.optional(membershipSourceValidator),
    clerkUserId: v.optional(v.string()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    emailLower: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
    profileComplete: v.optional(v.boolean()),
    platformRole: v.optional(v.literal("superAdmin")),
    searchText: v.optional(v.string()),
  })
    .index("by_tokenIdentifier_and_clerkOrgId", [
      "tokenIdentifier",
      "clerkOrgId",
    ])
    .index("by_clerkOrgId", ["clerkOrgId"])
    .index("by_clerkOrgId_and_role", ["clerkOrgId", "role"])
    .index("by_clerkOrgId_and_emailLower", ["clerkOrgId", "emailLower"])
    .index("by_userId", ["userId"])
    .searchIndex("search_member", {
      searchField: "searchText",
      filterFields: ["clerkOrgId"],
    }),

  membershipIntents: defineTable({
    clerkOrgId: v.string(),
    email: v.string(),
    emailLower: v.string(),
    requestedRole: roleValidator,
    source: membershipSourceValidator,
    status: membershipIntentStatusValidator,
    invitedBy: v.optional(v.id("users")),
    acceptedUserId: v.optional(v.id("users")),
    acceptedTokenIdentifier: v.optional(v.string()),
    clerkInvitationId: v.optional(v.string()),
    clerkUserId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerkOrgId_and_emailLower", ["clerkOrgId", "emailLower"])
    .index("by_clerkInvitationId", ["clerkInvitationId"])
    .index("by_clerkOrgId_and_status", ["clerkOrgId", "status"]),

  processedWebhookEvents: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    status: v.union(v.literal("processed"), v.literal("failed")),
    processedAt: v.number(),
    error: v.optional(v.string()),
  }).index("by_eventId", ["eventId"]),

  // Platform-level tenant registry backing tenants.<root>. A *mirror* of
  // Clerk organizations (Clerk stays the source of truth), kept in sync by
  // the createTenant provisioning action, organization.* webhooks, and the
  // CLI backfill. Gives the console a reactive list plus per-tenant
  // provisioning state that Clerk has no place for.
  tenants: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    logoUrl: v.optional(v.string()),
    allowedEmailDomains: v.array(v.string()),
    status: v.union(
      v.literal("active"),
      // Provisioning step(s) failed after org creation; see
      // provisioningErrors. "Retry provisioning" re-runs them idempotently.
      v.literal("needsAttention"),
      // Org deleted in Clerk; row kept for audit/history.
      v.literal("deleted"),
    ),
    provisioningErrors: v.optional(v.array(v.string())),
    // Retained so retryProvisioning can re-run failed steps.
    logoStorageId: v.optional(v.id("_storage")),
    firstInviteEmail: v.optional(v.string()),
    firstInviteRole: v.optional(roleValidator),
    createdBy: v.optional(v.id("users")),
    source: v.union(v.literal("console"), v.literal("clerkSync")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerkOrgId", ["clerkOrgId"])
    .index("by_slug", ["slug"]),

  authAuditEvents: defineTable({
    clerkOrgId: v.optional(v.string()),
    actorUserId: v.optional(v.id("users")),
    targetUserId: v.optional(v.id("users")),
    targetEmailLower: v.optional(v.string()),
    membershipId: v.optional(v.id("memberships")),
    action: v.union(
      v.literal("selfSignup"),
      v.literal("inviteCreated"),
      v.literal("inviteRevoked"),
      v.literal("membershipAccepted"),
      v.literal("roleChanged"),
      v.literal("memberRemoved"),
      v.literal("webhookProcessed"),
      v.literal("webhookFailed"),
      v.literal("blockedJoin"),
      v.literal("superAdminFanOut"),
      v.literal("reconcile"),
    ),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_clerkOrgId_and_createdAt", ["clerkOrgId", "createdAt"])
    .index("by_targetUserId", ["targetUserId"]),

  orgMembershipStats: defineTable({
    clerkOrgId: v.string(),
    activeCount: v.number(),
    adminCount: v.number(),
    contributorCount: v.number(),
    viewerCount: v.number(),
    pendingInviteCount: v.number(),
    updatedAt: v.number(),
  }).index("by_clerkOrgId", ["clerkOrgId"]),

  // Per-org visual theme derived automatically from the Clerk org logo.
  // Stored separately from Clerk so the expensive/fragile image read happens
  // once per logo URL and org pages can hydrate CSS variables cheaply.
  orgThemes: defineTable({
    clerkOrgId: v.string(),
    sourceLogoUrl: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("extracting"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("override"),
    ),
    // Deprecated during final-form migration. Kept optional so existing rows
    // remain valid until active/candidate fields are fully backfilled.
    accentRgb: v.optional(rgbValidator),
    lightTokens: v.optional(orgThemeTokensValidator),
    darkTokens: v.optional(orgThemeTokensValidator),
    candidateAccentRgb: v.optional(rgbValidator),
    candidateLightTokens: v.optional(orgThemeTokensValidator),
    candidateDarkTokens: v.optional(orgThemeTokensValidator),
    candidateSource: v.optional(themeSourceValidator),
    candidateGeneratedAt: v.optional(v.number()),
    activeAccentRgb: v.optional(rgbValidator),
    activeLightTokens: v.optional(orgThemeTokensValidator),
    activeDarkTokens: v.optional(orgThemeTokensValidator),
    activeSource: v.optional(themeSourceValidator),
    adminApprovedAt: v.optional(v.number()),
    approvedByUserId: v.optional(v.id("users")),
    extractionAttempts: v.optional(v.number()),
    lastExtractionRequestedAt: v.optional(v.number()),
    lastExtractionError: v.optional(v.string()),
    overrideReason: v.optional(v.string()),
    fallbackReason: v.optional(v.string()),
    extractedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_clerkOrgId", ["clerkOrgId"]),

  // Organizational hierarchy
  functions: defineTable({
    name: v.string(),
    sortOrder: v.number(),
    summary: v.optional(v.string()),
    summaryUpdatedAt: v.optional(v.number()),
    summaryStale: v.optional(v.boolean()),
    clerkOrgId: v.string(),
  }).index("by_clerkOrgId", ["clerkOrgId"]),

  departments: defineTable({
    functionId: v.id("functions"),
    name: v.string(),
    description: v.optional(v.string()),
    descriptionSafetyStatus: v.optional(descriptionSafetyStatusValidator),
    descriptionSafetyCheckedAt: v.optional(v.number()),
    descriptionSafetyModel: v.optional(v.string()),
    descriptionSafetyPromptVersion: v.optional(v.string()),
    descriptionSafetyRisk: v.optional(descriptionSafetyRiskValidator),
    descriptionSafetyReason: v.optional(v.string()),
    sortOrder: v.number(),
    summary: v.optional(v.string()),
    summaryUpdatedAt: v.optional(v.number()),
    summaryStale: v.optional(v.boolean()),
    clerkOrgId: v.string(),
  }).index("by_clerkOrgId_and_functionId", ["clerkOrgId", "functionId"]),

  processes: defineTable({
    departmentId: v.id("departments"),
    name: v.string(),
    description: v.optional(v.string()),
    descriptionSafetyStatus: v.optional(descriptionSafetyStatusValidator),
    descriptionSafetyCheckedAt: v.optional(v.number()),
    descriptionSafetyModel: v.optional(v.string()),
    descriptionSafetyPromptVersion: v.optional(v.string()),
    descriptionSafetyRisk: v.optional(descriptionSafetyRiskValidator),
    descriptionSafetyReason: v.optional(v.string()),
    sortOrder: v.number(),
    rollingSummary: v.optional(v.string()),
    // Coalescing gate for rolling-summary regeneration. Several conversations
    // finishing at once must not each start their own regen: the first sets
    // `summaryRegenScheduledAt`, later ones just raise
    // `summaryRegenRequestedAgain`, and the in-flight run schedules exactly
    // one more pass when it sees that flag. Requests are never dropped — see
    // requestProcessSummaryRegen in postCall.ts.
    summaryRegenScheduledAt: v.optional(v.number()),
    summaryRegenRequestedAgain: v.optional(v.boolean()),
    clerkOrgId: v.string(),
  }).index("by_clerkOrgId_and_departmentId", ["clerkOrgId", "departmentId"]),

  // Conversation records
  conversations: defineTable({
    processId: v.id("processes"),
    elevenlabsConversationId: v.optional(v.string()),
    contributorName: v.string(),
    userId: v.optional(v.id("users")),
    // On-behalf-of attribution. `userId` is always the *submitting* account;
    // `contributorName` / `subjectUserId` describe whose process knowledge the
    // recording captures. Normally they are the same person, and
    // `submittedByName` is absent — its presence is the "recorded on someone
    // else's behalf" flag, and it carries the submitter's display name so read
    // surfaces can show "<subject> · submitted by <submitter>" without an extra
    // lookup (same denormalization rationale as `contributorName`).
    // `consentAttestedAt` records when the submitter asserted the subject was
    // informed and consented.
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
      v.union(v.literal("elevenlabs-convai"), v.literal("elevenlabs-scribe")),
    ),
    analysisProvider: v.optional(
      v.union(
        v.literal("elevenlabs-convai"),
        v.literal("fabric-openrouter"),
        v.literal("fabric-foundry"),
      ),
    ),
    transcript: v.optional(v.array(transcriptMessageValidator)),
    speakerLabels: v.optional(v.array(speakerLabelValidator)),
    summary: v.optional(v.string()),
    // Fabric-owned structured summary of this conversation, written once when
    // the conversation completes and reused as the map input to the rolling
    // summary's reduce pass. Deliberately NOT the vendor `summary` above:
    // that one is ElevenLabs', its depth and shape can change without notice,
    // and it is display-only. `processSummaryInputHash` fingerprints the
    // transcript this was derived from, so a re-transcribed conversation
    // regenerates it and an unchanged one never pays for it twice.
    processSummaryInput: v.optional(v.string()),
    processSummaryInputHash: v.optional(v.string()),
    // One-line headline for the conversation, denormalized out of
    // `analysis.call_summary_title` so list surfaces can label rows without
    // loading the analysis blob. Absent until analysis completes, and on rows
    // written before this column existed — see lib/conversationTitle.ts.
    title: v.optional(v.string()),
    // Opaque ElevenLabs analysis payload — kept as v.any() because the
    // upstream schema is not under our control and may change.
    analysis: v.optional(v.any()),
    durationSeconds: v.optional(v.number()),
    status: conversationStatusValidator,
    clerkOrgId: v.string(),
  })
    .index("by_clerkOrgId", ["clerkOrgId"])
    .index("by_clerkOrgId_and_processId", ["clerkOrgId", "processId"])
    .index("by_clerkOrgId_and_processId_and_status", [
      "clerkOrgId",
      "processId",
      "status",
    ])
    .index("by_clerkOrgId_and_status", ["clerkOrgId", "status"])
    .index("by_clerkOrgId_and_elevenlabsConversationId", [
      "clerkOrgId",
      "elevenlabsConversationId",
    ]),

  // Process flow diagrams — one per process, generated from conversation data
  processFlows: defineTable({
    processId: v.id("processes"),
    status: v.union(
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    stale: v.boolean(),
    generatedAt: v.number(),
    conversationCount: v.number(),
    errorMessage: v.optional(v.string()),

    nodes: v.array(
      v.object({
        id: v.string(),
        label: v.string(),
        category: flowNodeCategoryValidator,
        ...flowNodeDetailFields,
      }),
    ),

    edges: v.array(v.object(flowEdgeFields)),

    insights: v.object({
      // The analysed opportunities, and the one-line form the Insights tab
      // renders. `automationOpportunitiesSource` says which you are looking at:
      // "derived" means the insights stage failed and these are placeholders
      // pointing at automatable-looking steps, which downstream tooling must
      // not treat as analysed opportunities.
      automationOpportunityDetails: v.optional(
        v.array(automationOpportunityValidator),
      ),
      automationOpportunitiesSource: v.optional(
        v.union(v.literal("ai"), v.literal("derived")),
      ),
      totalEstimatedDuration: v.optional(v.string()),
      criticalPath: v.array(v.string()),
      handoffCount: v.number(),
      toolCount: v.number(),
      automationOpportunities: v.array(v.string()),
      topBottlenecks: v.array(v.string()),
    }),

    // --- Staged-generation metadata (absent on legacy single-call rows) ---
    // `generationVersion` is the discriminator: absent means this flow was
    // produced by one big call and its `nodes` are already fully detailed, so
    // reads treat every node as ready. Rows convert to "v3" only when
    // regenerated — no migration needed.
    generationVersion: v.optional(v.literal("v3")),
    // Stamped fresh on every run and copied onto each child row, so a write
    // from a superseded run can be recognised and dropped instead of
    // corrupting the current one.
    generationId: v.optional(v.string()),
    detailsStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("generating"),
        v.literal("ready"),
        // Graph is usable but some node details never landed. Deliberately
        // distinct from "failed": the flow is still worth showing.
        v.literal("partial"),
        v.literal("failed"),
      ),
    ),
    detailNodeCount: v.optional(v.number()),
    detailCompletedCount: v.optional(v.number()),
    detailFailedCount: v.optional(v.number()),
    detailsGeneratedAt: v.optional(v.number()),
    detailErrorMessage: v.optional(v.string()),
    // Heartbeat for the watchdog. Every pipeline mutation bumps it; the reaper
    // finds rows stuck in `generating` with a stale value. A staged pipeline
    // has N+2 scheduled actions instead of one, so an action killed between
    // "write batch" and "schedule next" is a real failure mode, not a
    // hypothetical.
    lastProgressAt: v.optional(v.number()),
    resumeAttempts: v.optional(v.number()),

    clerkOrgId: v.string(),
  })
    .index("by_clerkOrgId_and_processId", ["clerkOrgId", "processId"])
    // Reaper indexes. Not org-scoped: the watchdog is a system cron sweeping
    // every tenant, so scoping by org would force a scan per org.
    .index("by_status_and_lastProgressAt", ["status", "lastProgressAt"])
    .index("by_detailsStatus_and_lastProgressAt", [
      "detailsStatus",
      "lastProgressAt",
    ]),

  // One row per node per generation. A child table rather than a bigger
  // aggregate document because node details are the part that grows without
  // bound — the aggregate row has a 1 MB ceiling, and every batch save would
  // otherwise rewrite the whole document and contend with every read of it.
  processFlowNodeDetails: defineTable({
    clerkOrgId: v.string(),
    processId: v.id("processes"),
    processFlowId: v.id("processFlows"),
    generationId: v.string(),
    nodeId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
    generatedAt: v.optional(v.number()),
    // Nested and optional as a unit: a row that has not been enriched yet has
    // no detail at all, and there is no such thing as half a detail. Flat
    // optional fields would make "pending" and "enriched but empty"
    // indistinguishable.
    detail: v.optional(v.object(flowNodeDetailFields)),
  })
    // Covers per-node lookups, and by prefix every row of one generation —
    // which is what reads, cleanup of superseded generations, and cascade
    // deletes all need.
    .index("by_clerkOrgId_and_processFlowId_and_generationId_and_nodeId", [
      "clerkOrgId",
      "processFlowId",
      "generationId",
      "nodeId",
    ])
    // Finding the next batch to enrich, and counting what failed.
    .index("by_clerkOrgId_and_processFlowId_and_generationId_and_status", [
      "clerkOrgId",
      "processFlowId",
      "generationId",
      "status",
    ]),
});
