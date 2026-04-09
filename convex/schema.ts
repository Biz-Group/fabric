import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // App-level user profiles (linked to Clerk identity via tokenIdentifier)
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.string(),
    jobTitle: v.optional(v.string()),
    function: v.optional(v.string()),
    department: v.optional(v.string()),
    hireDate: v.optional(v.string()),
    profileComplete: v.boolean(),
    role: v.optional(v.union(v.literal("admin"), v.literal("contributor"), v.literal("viewer"))),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_email", ["email"]),

  // Organizational hierarchy
  functions: defineTable({
    name: v.string(),
    sortOrder: v.number(),
    summary: v.optional(v.string()),
    summaryUpdatedAt: v.optional(v.number()),
    summaryStale: v.optional(v.boolean()),
  }),

  departments: defineTable({
    functionId: v.id("functions"),
    name: v.string(),
    sortOrder: v.number(),
    summary: v.optional(v.string()),
    summaryUpdatedAt: v.optional(v.number()),
    summaryStale: v.optional(v.boolean()),
  }).index("by_functionId", ["functionId"]),

  processes: defineTable({
    departmentId: v.id("departments"),
    name: v.string(),
    sortOrder: v.number(),
    rollingSummary: v.optional(v.string()),
  }).index("by_departmentId", ["departmentId"]),

  // Conversation records
  conversations: defineTable({
    processId: v.id("processes"),
    elevenlabsConversationId: v.string(),
    contributorName: v.string(),
    userId: v.optional(v.id("users")),
    transcript: v.optional(v.any()),
    summary: v.optional(v.string()),
    analysis: v.optional(v.any()),
    durationSeconds: v.optional(v.number()),
    status: v.string(), // "processing" | "done" | "failed"
  })
    .index("by_processId", ["processId"])
    .index("by_status", ["status"])
    .index("by_userId", ["userId"]),
});
