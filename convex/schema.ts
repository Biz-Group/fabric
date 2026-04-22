import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // App-level user profiles (linked to Clerk identity via tokenIdentifier).
  // Identity is global — membership in a specific org lives in `memberships`.
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.string(),
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
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_email", ["email"])
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
    role: v.union(
      v.literal("admin"),
      v.literal("contributor"),
      v.literal("viewer"),
    ),
    invitedBy: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_tokenIdentifier_and_clerkOrgId", ["tokenIdentifier", "clerkOrgId"])
    .index("by_clerkOrgId", ["clerkOrgId"])
    .index("by_userId", ["userId"]),

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
    sortOrder: v.number(),
    summary: v.optional(v.string()),
    summaryUpdatedAt: v.optional(v.number()),
    summaryStale: v.optional(v.boolean()),
    clerkOrgId: v.string(),
  }).index("by_clerkOrgId_and_functionId", ["clerkOrgId", "functionId"]),

  processes: defineTable({
    departmentId: v.id("departments"),
    name: v.string(),
    sortOrder: v.number(),
    rollingSummary: v.optional(v.string()),
    clerkOrgId: v.string(),
  }).index("by_clerkOrgId_and_departmentId", ["clerkOrgId", "departmentId"]),

  // Conversation records
  conversations: defineTable({
    processId: v.id("processes"),
    elevenlabsConversationId: v.string(),
    contributorName: v.string(),
    userId: v.optional(v.id("users")),
    transcript: v.optional(
      v.array(
        v.object({
          role: v.string(),
          content: v.string(),
          time_in_call_secs: v.number(),
        }),
      ),
    ),
    summary: v.optional(v.string()),
    // Opaque ElevenLabs analysis payload — kept as v.any() because the
    // upstream schema is not under our control and may change.
    analysis: v.optional(v.any()),
    durationSeconds: v.optional(v.number()),
    status: v.union(
      v.literal("processing"),
      v.literal("done"),
      v.literal("failed"),
    ),
    clerkOrgId: v.string(),
  })
    .index("by_clerkOrgId_and_processId", ["clerkOrgId", "processId"])
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
        description: v.string(),
        category: v.union(
          v.literal("start"),
          v.literal("end"),
          v.literal("action"),
          v.literal("decision"),
          v.literal("handoff"),
          v.literal("wait"),
        ),
        actors: v.array(v.string()),
        tools: v.array(v.string()),
        estimatedDuration: v.optional(v.string()),
        painPoints: v.array(v.string()),
        automationPotential: v.union(
          v.literal("none"),
          v.literal("low"),
          v.literal("medium"),
          v.literal("high"),
        ),
        confidence: v.union(
          v.literal("high"),
          v.literal("medium"),
          v.literal("low"),
        ),
        isBottleneck: v.boolean(),
        isTribalKnowledge: v.boolean(),
        riskIndicators: v.array(v.string()),
        sources: v.array(v.string()),
      }),
    ),

    edges: v.array(
      v.object({
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
      }),
    ),

    insights: v.object({
      totalEstimatedDuration: v.optional(v.string()),
      criticalPath: v.array(v.string()),
      handoffCount: v.number(),
      toolCount: v.number(),
      automationOpportunities: v.array(v.string()),
      topBottlenecks: v.array(v.string()),
    }),

    clerkOrgId: v.string(),
  }).index("by_clerkOrgId_and_processId", ["clerkOrgId", "processId"]),
});
