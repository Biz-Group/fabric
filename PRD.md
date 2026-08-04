# Fabric — Product Requirements Document

**Voice-first institutional knowledge capture for organizations**

---

**Version:** 1.1 (Multi-Tenant — Microsoft Foundry)
**Author:** Saish / Biz Group
**Date:** July 2026
**Status:** Draft — Foundry development cutover complete; production cutover staged

---

## 1. Overview

Fabric is a web-based tool that lets organizations capture how their business actually runs — not through documentation projects or process audits, but through natural voice conversations between employees and an AI agent. Employees navigate to their function, department, and process, then simply talk about what they do. The system records, transcribes, summarizes, and stitches those conversations into a living, hierarchical knowledge base — synthesizing insights at every level from individual processes up through departments and functions. Captured knowledge is also automatically converted into interactive process flow diagrams that surface bottlenecks, automation opportunities, tribal knowledge risks, and handoff points directly from what employees describe in their own words.

### 1.1 The Problem

Institutional knowledge lives in people's heads. When someone leaves, gets promoted, or goes on leave, that knowledge walks out the door. Traditional process documentation is tedious to create, quickly outdated, and rarely captures the nuance of how things actually get done. People will talk about their work far more naturally and completely than they'll ever write about it.

### 1.2 The Vision

A single-page app that mirrors the way an organization is structured — Function → Department → Process — where anyone can walk up, pick their process, and have a conversation with an AI agent about what they do. Over time, Fabric builds a comprehensive, voice-sourced map of how the entire company operates.

**Phase 1 (this POC):** Capture, summarize, and replay. A company diary with voice — record, listen back, and see how the organization works at a glance.
**Phase 1.1 (current capture enhancement):** Support direct voice recordings and pre-existing audio file uploads with ElevenLabs Scribe diarization and a required speaker-labeling review before transcript analysis, process summaries, or process-flow generation run.
**Phase 1.5 (current):** Visualize — automatically convert captured conversations into interactive process flow diagrams that surface bottlenecks, tribal knowledge risks, automation opportunities, and handoff points.
**Phase 1.6 (current):** Analyze & report — a dedicated Insights view derives handoffs, tool usage, bottlenecks, automation candidates, tribal-knowledge risk, and decision branches from the generated process flow, and a client-side PDF export turns any process into a shareable report (summary, flow diagram, step-by-step detail, insights).
**Phase 1.7 (current platform upgrade):** Move Fabric-owned LLM inference from OpenRouter to Microsoft Foundry while retaining Claude Haiku 4.5 for synthesis, replacing the description-safety model with GPT-5 nano, and keeping GPT-5 mini deployed as an evaluated fallback/successor candidate. Development is cut over; the separate production Foundry environment is provisioned and smoke-tested but remains on OpenRouter until the production golden set and explicit cutover approval are complete.
**Phase 2 (future):** Query, search, and retrieval — so new joiners and cross-functional teams can ask questions and get answers sourced from the captured knowledge.

---

## 2. User Experience

### 2.1 Navigation Model — Tree Sidebar + Workbench

The app is a single-page workspace: a collapsible sidebar holds a nested, expandable **Function → Department → Process** tree, and a workbench pane on the right renders whatever is selected. Clicking a Function expands its Departments inline; clicking a Department expands its Processes inline; clicking a Process opens the **Process Detail Panel** (the workbench's tabbed view — see §2.2) without navigating away from the tree. Expand/collapse state and row-level add/rename/delete menus live directly on the tree, so contributors and admins never leave the sidebar to manage the hierarchy.

The structure is: **Function → Department → Process**. Users with contributor or admin access can create, rename, move, and delete eligible items at each level directly from the tree — no separate hierarchy admin screen needed. The add (`+`) button lives in each tree section header, while rename/delete controls live on a row's overflow menu. On mobile (stacked drill-down), the full-width rows carry inline rename/delete controls directly.

**Command palette:** A Ctrl/Cmd+K "jump to anything" palette searches across all functions, departments, and processes and jumps straight to the matching item, independent of the current tree scroll position or expand state.

Hierarchy deletion is intentionally non-cascading. A function cannot be deleted while it still has departments, a department cannot be deleted while it still has processes, and a process cannot be deleted while it still has conversations. Delete dialogs show the server-computed eligibility state so viewers see a role blocker, contributors/admins see child-data blockers, and admins get a direct path to **Admin → Conversations** when process conversations must be deleted first. Empty process deletion also removes its derived process-flow diagram before deleting the process row.

### 2.2 Process Detail Panel

When a user selects a process, they see:

1. **Process title and breadcrumb** (e.g., Finance > Payroll > Compensation)
2. **Share button** — copies a deep link to the currently selected process to the clipboard (with a hidden-textarea fallback where the Clipboard API is unavailable)
3. **Tab bar** with four tabs: **Process Summary**, **Conversations** (default), **Process Flow**, **Insights**

**Tab 1: Process Summary**

4. **Process Summary panel** — displays the AI-generated rolling summary as a structured analyst brief with thematic sections (Overview, Key Stages, Consensus, Tensions & Gaps, Notable Details) and contributor citations. Updated incrementally after each completed conversation. Rendered as markdown. This is the "at a glance" view of how this process works.
5. **Download PDF** — generates a client-side process report (cover page with key metrics, the rolling summary, the process flow diagram rendered as a vertical step-by-step card layout, per-step detail cards, and an insights page) via `@react-pdf/renderer`, downloaded directly in the browser with no server round-trip.

**Tab 2: Conversations**

6. **"Record a Conversation" button** — launches the recording modal with three capture options: AI interview, direct Voice Record, and Audio File Upload (Voice Record and Upload share a 50/50 button group; AI Interview sits on its own)
7. **Conversation log** — a filterable/sortable (status, type, newest/oldest) list of all past sessions for this process, each showing:
   - Contributor name
   - Date and time
   - AI-generated summary or in-progress speaker-labeling status (collapsible)
   - **Audio player** — inline playback of the recorded conversation (AI interview audio proxied from ElevenLabs; Voice Record and Audio File Upload audio streamed from Convex Storage)
   - Full transcript (collapsible, nested under summary)

**Tab 3: Process Flow**

8. **Interactive process flow diagram** — a node-based visualization (React Flow + dagre auto-layout) generated by AI from conversation data. On-demand generation via a "Generate Process Flow" button. Features:
   - **Six node categories** with distinct colors: Start (emerald), End (slate), Action (blue), Decision (amber), Handoff (violet), Wait (orange)
   - **Rich metadata per node**: actors, tools, estimated duration, pain points, automation potential (none/low/medium/high), confidence level (high/medium/low), bottleneck flag, tribal knowledge flag, risk indicators, and contributor source citations
   - **Edge types**: sequential, conditional (with branch labels), parallel, and fallback (dashed)
   - **Arrow markers** on all connections for clear flow direction
   - **Frosted glass nodes** (`backdrop-blur`) so edges passing behind are softened
   - **Node selection**: clicking a node highlights it (ring + scale), dims all other nodes and unconnected edges to 10% opacity, and opens a detail panel
   - **Node detail panel** (desktop: 320px slide-in from right; mobile: bottom Sheet at 60vh): shows full description, actors, tools, duration, automation potential, confidence, pain points, risk indicators, sources, and navigable connections ("Comes after" / "Leads to")
   - **Staleness tracking**: when completed conversations add or remove labeled analysis data, the flow is marked stale with an amber "New data available" badge and Refresh button; if the last completed conversation is deleted, the derived flow is removed
   - **Fullscreen mode** via maximize button
   - **Canvas controls**: MiniMap (desktop only), zoom/pan controls, fit-to-view

**Tab 4: Insights**

9. **Insights dashboard** — a derived-analytics view computed from the generated process flow (shared derivation logic with the PDF export, so both surfaces always agree):
   - **Metric tiles**: evidence (conversations behind the flow), mapped steps, handoffs, tools, decisions, bottlenecks, automation candidates, and low-confidence nodes
   - **Handoffs** — source/target step pairs where the actor changes or a handoff-category node is involved, with the actors and edge/node ids involved
   - **Tools & Systems** — every tool referenced by a node, which steps use it, and which steps are tool- or handoff-heavy
   - **Bottlenecks** — nodes flagged as bottlenecks or named in the flow's `topBottlenecks`, with pain points, duration signals, and sources
   - **Automation Opportunities** — flow-level candidate prose plus every node with automation potential above "none," ranked high→low
   - **Tribal Knowledge Risk** — nodes flagged as tribal-knowledge risks, with their risk indicators and sources
   - **Decision Points** — every decision node with its outgoing branches, labeled happy-path vs. exception-path
   - **Evidence Coverage** — confidence distribution (high/medium/low) across all nodes, low-confidence nodes called out individually, and every source citation used in the flow
   - **Critical path** — the flow's critical-path node sequence, plus total estimated duration when available
   - Shows the same staleness badge/refresh affordance as the Process Flow tab when new conversations have landed since the flow was generated

### 2.3 Conversation Flow

**AI interview flow:**

1. User navigates to a process.
2. User clicks "Record a Conversation."
3. A modal appears using **ElevenLabs UI components** (Orb, Conversation, Message, Waveform, Voice Button) with the voice agent connected via the `@elevenlabs/react` SDK.
4. The agent greets the user by name (passed via dynamic context) and asks them to describe what they do as part of this process.
5. The agent conducts a semi-structured interview — asking follow-up questions, clarifying steps, probing for edge cases and exceptions.
6. The user ends the conversation when they're done.
7. Post-call, the frontend triggers a Convex action that polls the ElevenLabs Conversations API until the transcript and analysis are ready, then stores everything in the database.
8. The Convex action calls the Fabric AI adapter, which routes synthesis to the `fabric-claude-haiku-4-5` Claude Haiku 4.5 deployment in Microsoft Foundry after environment cutover, for incremental summary generation — passing the existing rolling summary plus the new conversation's full transcript — and updates the process-level structured summary.
9. Convex's built-in reactivity pushes the update to the UI — the new conversation appears in the log automatically.

**Direct Voice Record flow:**

1. User records microphone audio in the same modal without the AI interviewer.
2. The frontend uploads the audio blob to Convex Storage.
3. Convex sends the stored audio to ElevenLabs Scribe with diarization enabled.
4. The conversation pauses at `needs_speaker_labels`; the contributor names each diarized speaker and may link them to org members.
5. After labels are submitted, Fabric runs Foundry-hosted Claude analysis on the labeled transcript, stores the conversation summary and structured extraction, then updates the process-level rolling summary and flow staleness state.

**Audio File Upload flow:**

1. User selects "Upload Audio" in the same modal. No microphone access is requested.
2. The user picks an audio file from disk through a native file picker (`accept="audio/*"`). The frontend validates the MIME prefix and a 100 MB size cap, and best-effort probes the duration via a hidden `<audio>` element.
3. The frontend uploads the file to Convex Storage and calls the same `processVoiceRecording` action with `source: "upload"`, which stamps the conversation with `inputMode: "audioUpload"` and rejects non-audio MIME types server-side.
4. From this point the pipeline is identical to Voice Record: Scribe diarization → `needs_speaker_labels` → contributor labels speakers → Foundry analysis → process summary refresh.

**Modal entry & consent:**
The recording modal opens to a single combined step that confirms the contributor's name and surfaces the recording/content notices inline. Submitting that step requests the microphone (Voice Record / AI Interview) or opens the file picker (Audio Upload).

**Abandonment cleanup:**
If a contributor closes the modal after upload/recording has reached Convex Storage but before they approve speaker labels, the modal calls the `abandonVoiceRecording` mutation. The mutation deletes the storage object and the conversation row so we don't retain inputs we never finished analyzing. The server only allows the conversation owner or an org admin to abandon the row, only for `voiceRecord` / `audioUpload` conversations, and gates cleanup on `status !== "done"` so finalized rows are never affected.

**Failure handling — retry and truncation:**
Voice Record and Audio File Upload conversations that fail transcription or analysis are marked `status: "failed"` and surfaced in Admin → Conversations, where an admin can retry them. Retry resumes from whichever stage actually failed: if a transcript already exists, only analysis re-runs; if transcription itself failed, it re-runs from the original stored audio. Separately, the analysis step explicitly detects when the AI response was cut off by the token limit (rather than letting a truncated payload fail as an opaque JSON parse error) and raises a clear "recording may be too long to analyze in a single pass" error instead.

### 2.4 Admin Console

Users with the `admin` role get a separate, full-screen console at `/[org]/admin`, reached via an "Admin" item in the main nav bar that's only rendered for admins. Visiting any `/admin/*` route directly with a non-admin role renders an "Admin access required" blocker with a link back to the workspace, rather than the console itself. The console has its own left-nav with four sections: **Overview**, **Users**, **Conversations**, **Appearance**.

**Overview** — a snapshot of workspace health:
- Four stat cards: **Members** (active count, with an admin/contributor/viewer breakdown), **Pending invites**, **Conversations this week** (with a "+N vs prior week" delta), and **Failed conversations** (rendered in a destructive/red tone when non-zero; clicking it deep-links to the Conversations section pre-filtered to `status=failed`).
- A **Recent conversations** list — the last 5 captured across every process, each row showing a status dot, contributor name, process name badge, a summary snippet, and a relative timestamp ("3h ago"). Clicking a row opens the same transcript dialog used elsewhere in the console.

**Users** — member directory and invitation management:
- A searchable (name, email, job title), paginated (50 per page, "Load more") table: Name (with a "(you)" tag for the current admin), Email, Role, Job Title, Platform (a "Super Admin" badge for platform-level super-admins, else blank), Profile (Complete/Incomplete badge), Joined Org date, and a row action menu.
- **Role changes** are an inline dropdown (admin/contributor/viewer); promoting someone to admin or demoting an existing admin requires an explicit confirmation dialog. Admins cannot change their own role (shown as a static badge instead of a dropdown).
- **Removal** is a destructive row action ("Remove from workspace") behind a confirmation dialog; admins cannot remove themselves.
- An **"Invite member"** button opens a dialog to invite by email + role; a **Pending invitations** list below the table shows outstanding Clerk invites with revoke/resend actions (§3.7.5).

**Conversations** — org-wide conversation log, independent of which process it's viewed from:
- A search box (matches contributor, process, summary, or type) plus a status filter (All / Done / Processing / Needs speaker labels / Failed) and an optional process filter carried via a URL query param (with a "Clear process filter" button) — this is what the hierarchy delete-blocker flow and the Overview "Failed conversations" card link into.
- A paginated table: Created date, Contributor, Type (AI Interview / Voice Recording / Audio Upload, each with a distinct icon badge), Process (plus its function/department), Duration, Status badge, and a row action menu (View transcript; Retry — shown only when `status: "failed"`, labeled "Retry fetch" for AI interviews or "Retry transcription"/"Retry summary generation" for Voice Record/Audio Upload depending on whether a transcript already exists; Delete, behind a confirmation dialog that explains the parent process summary will be regenerated).
- An **"Export CSV"** button streams every row matching the current filters (paginating through all of them client-side, not just the visible page) into a downloadable `conversations-{org-slug}-{date}.csv` file.

**Appearance** — org branding and theming; see §3.8 for the full generate/approve/reset workflow.

---

## 3. Technical Architecture

### 3.1 Stack

| Layer | Technology |
|---|---|
| Frontend | **Next.js** (React) with **shadcn/ui** + **ElevenLabs UI** components |
| Voice Agent | `@elevenlabs/react` SDK (`useConversation` hook) |
| Direct recording capture | Browser `MediaRecorder` + Convex Storage upload |
| Audio file upload capture | Native HTML file picker (`accept="audio/*"`, 100 MB cap) + Convex Storage upload |
| UI Components | ElevenLabs UI registry (Orb, Conversation, ConversationBar, Message, Transcript Viewer, Audio Player, Scrub Bar, Waveform, Voice Button) — built on shadcn/ui |
| Backend / BaaS | **Convex** (document database, server functions, built-in reactivity) |
| AI Inference Platform | **Microsoft Foundry** for Fabric-owned LLM calls, accessed server-side from Convex through a shared provider adapter; OpenRouter is retained only as a temporary production rollback path during migration |
| Conversation Summaries | ElevenLabs Conversation Analysis for AI interviews; Fabric/Foundry Claude analysis for Voice Record and Audio File Upload after speaker labeling |
| Process-level Summaries | Claude Haiku 4.5 version `2` via the Foundry deployment `fabric-claude-haiku-4-5` — structured analyst briefs with thematic sections and citations |
| Description Safety | GPT-5 nano version `2025-08-07` via the Foundry deployment `fabric-description-safety`, using strict structured tool output |
| Process Flow Diagrams | React Flow (`@xyflow/react`) with dagre auto-layout (`@dagrejs/dagre`) — AI-generated from conversation data via the Foundry Claude deployment |
| Post-call data | ElevenLabs Conversations API for AI interviews; ElevenLabs Scribe diarized transcription for Voice Record and Audio File Upload |
| Audio playback | Org-scoped Convex HTTP proxy; AI interviews stream from ElevenLabs; Voice Record and Audio File Upload stream from Convex Storage |
| PDF Export | `@react-pdf/renderer`, dynamically imported client-side so it never ships in the main bundle — reuses the Insights tab's derivation logic |
| Hosting | Vercel (frontend) + Convex (backend) |

### 3.2 Data Model (Convex)

**Tables (defined in `convex/schema.ts`):**

Note: Convex auto-generates `_id` and `_creationTime` fields for every document — no need to define them explicitly.

```typescript
// convex/schema.ts (annotated — see convex/schema.ts for the literal source)
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// orgThemeTokens shape (used by orgThemes below): accent, accentForeground,
// subtle, border, ring, selected, selectedForeground, chart1..chart5 (all strings)

export default defineSchema({
  // Global user profile, linked to Clerk identity via tokenIdentifier.
  // Org membership lives separately in `memberships` — identity is global.
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
    // Platform-level flag, orthogonal to org roles. Does not by itself grant
    // access to any tenant's data (see §3.7.2).
    platformRole: v.optional(v.literal("superAdmin")),
    lastSyncedFromClerkAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()), // soft delete
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_email", ["email"])
    .index("by_emailLower", ["emailLower"])
    .index("by_function", ["function"])
    .index("by_department", ["department"])
    .index("by_platformRole", ["platformRole"]),

  // Per-(user, org) role assignment. Fabric owns roles, not Clerk, so the
  // same person can hold different roles in different orgs. Auto-provisioned
  // on first authenticated request into an org.
  memberships: defineTable({
    tokenIdentifier: v.string(),
    userId: v.id("users"),
    clerkOrgId: v.string(),
    role: v.union(v.literal("admin"), v.literal("contributor"), v.literal("viewer")),
    invitedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
    status: v.optional(v.union(v.literal("active"), v.literal("removed"))),
    source: v.optional(v.union(
      v.literal("selfSignup"), v.literal("adminInvite"), v.literal("superAdminFanOut"),
      v.literal("reconcile"), v.literal("webhook"), v.literal("legacy"),
    )),
    // Denormalized directory fields copied from `users`, so the member list
    // and search index avoid a join per row.
    clerkUserId: v.optional(v.string()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    emailLower: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
    profileComplete: v.optional(v.boolean()),
    platformRole: v.optional(v.literal("superAdmin")),
    searchText: v.optional(v.string()),
  })
    .index("by_tokenIdentifier_and_clerkOrgId", ["tokenIdentifier", "clerkOrgId"])
    .index("by_clerkOrgId", ["clerkOrgId"])
    .index("by_clerkOrgId_and_role", ["clerkOrgId", "role"])
    .index("by_clerkOrgId_and_emailLower", ["clerkOrgId", "emailLower"])
    .index("by_userId", ["userId"])
    .searchIndex("search_member", { searchField: "searchText", filterFields: ["clerkOrgId"] }),

  // Pending/accepted/revoked invite intents, keyed by org + email, so a role
  // is ready to assign once the invitee actually signs in.
  membershipIntents: defineTable({
    clerkOrgId: v.string(),
    email: v.string(),
    emailLower: v.string(),
    requestedRole: v.union(v.literal("admin"), v.literal("contributor"), v.literal("viewer")),
    source: v.union(
      v.literal("selfSignup"), v.literal("adminInvite"), v.literal("superAdminFanOut"),
      v.literal("reconcile"), v.literal("webhook"), v.literal("legacy"),
    ),
    status: v.union(
      v.literal("pending"), v.literal("accepted"), v.literal("revoked"),
      v.literal("expired"), v.literal("blocked"),
    ),
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

  // Idempotency ledger for inbound Clerk webhooks (see §3.6).
  processedWebhookEvents: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    status: v.union(v.literal("processed"), v.literal("failed")),
    processedAt: v.number(),
    error: v.optional(v.string()),
  }).index("by_eventId", ["eventId"]),

  // Append-only audit log of membership/auth actions.
  authAuditEvents: defineTable({
    clerkOrgId: v.optional(v.string()),
    actorUserId: v.optional(v.id("users")),
    targetUserId: v.optional(v.id("users")),
    targetEmailLower: v.optional(v.string()),
    membershipId: v.optional(v.id("memberships")),
    action: v.union(
      v.literal("selfSignup"), v.literal("inviteCreated"), v.literal("inviteRevoked"),
      v.literal("membershipAccepted"), v.literal("roleChanged"), v.literal("memberRemoved"),
      v.literal("webhookProcessed"), v.literal("webhookFailed"), v.literal("blockedJoin"),
      v.literal("superAdminFanOut"), v.literal("reconcile"),
    ),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_clerkOrgId_and_createdAt", ["clerkOrgId", "createdAt"])
    .index("by_targetUserId", ["targetUserId"]),

  // Denormalized per-org member counters, so the admin dashboard avoids
  // scanning every membership row for a count.
  orgMembershipStats: defineTable({
    clerkOrgId: v.string(),
    activeCount: v.number(),
    adminCount: v.number(),
    contributorCount: v.number(),
    viewerCount: v.number(),
    pendingInviteCount: v.number(),
    updatedAt: v.number(),
  }).index("by_clerkOrgId", ["clerkOrgId"]),

  // Platform tenant registry backing the tenant console (§3.7.7). A mirror of
  // Clerk organizations — Clerk stays the source of truth — carrying
  // provisioning state Clerk has no place for. Kept in sync by the
  // createTenant action, the organization.* webhooks, and the CLI backfill.
  tenants: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    logoUrl: v.optional(v.string()),
    allowedEmailDomains: v.array(v.string()), // enrollment gate (§3.7.6)
    status: v.union(
      v.literal("active"),
      v.literal("needsAttention"), // a provisioning step failed; retryable
      v.literal("deleted"), // org removed in Clerk; row kept for history
    ),
    provisioningErrors: v.optional(v.array(v.string())),
    logoStorageId: v.optional(v.id("_storage")), // retained for retry
    firstInviteEmail: v.optional(v.string()),
    firstInviteRole: v.optional(
      v.union(v.literal("admin"), v.literal("contributor"), v.literal("viewer")),
    ),
    createdBy: v.optional(v.id("users")),
    source: v.union(v.literal("console"), v.literal("clerkSync")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerkOrgId", ["clerkOrgId"])
    .index("by_slug", ["slug"]),

  // Per-org branding theme derived from the Clerk org logo, or a manual
  // override (see §3.8). "candidate*" holds an unapproved generation;
  // "active*" is what's actually applied — gated by explicit admin approval.
  orgThemes: defineTable({
    clerkOrgId: v.string(),
    sourceLogoUrl: v.string(),
    status: v.union(
      v.literal("pending"), v.literal("extracting"), v.literal("ready"),
      v.literal("failed"), v.literal("override"),
    ),
    candidateAccentRgb: v.optional(v.object({ r: v.number(), g: v.number(), b: v.number() })),
    candidateLightTokens: v.optional(v.object({ /* orgThemeTokens shape, see above */ })),
    candidateDarkTokens: v.optional(v.object({ /* orgThemeTokens shape */ })),
    candidateSource: v.optional(v.union(v.literal("logo"), v.literal("manual"))),
    candidateGeneratedAt: v.optional(v.number()),
    activeAccentRgb: v.optional(v.object({ r: v.number(), g: v.number(), b: v.number() })),
    activeLightTokens: v.optional(v.object({ /* orgThemeTokens shape */ })),
    activeDarkTokens: v.optional(v.object({ /* orgThemeTokens shape */ })),
    activeSource: v.optional(v.union(v.literal("logo"), v.literal("manual"))),
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

  // Organizational hierarchy — every row below is tenant-scoped via clerkOrgId
  functions: defineTable({
    name: v.string(),
    sortOrder: v.number(),
    summary: v.optional(v.string()),          // persisted function summary
    summaryUpdatedAt: v.optional(v.number()), // epoch ms of last generation
    summaryStale: v.optional(v.boolean()),    // true when new data invalidates the summary
    clerkOrgId: v.string(),
  }).index("by_clerkOrgId", ["clerkOrgId"]),

  departments: defineTable({
    functionId: v.id("functions"),
    name: v.string(),
    description: v.optional(v.string()),
    // AI-screened for prompt-injection/policy-override risk before the
    // description is fed into the voice-agent interview prompt — see
    // §3.4 "Description Safety Screening".
    descriptionSafetyStatus: v.optional(v.union(v.literal("safe"), v.literal("blocked"))),
    descriptionSafetyCheckedAt: v.optional(v.number()),
    descriptionSafetyModel: v.optional(v.string()),
    descriptionSafetyPromptVersion: v.optional(v.string()),
    descriptionSafetyRisk: v.optional(v.union(
      v.literal("none"), v.literal("prompt_injection"), v.literal("agent_instruction"),
      v.literal("policy_override"), v.literal("sensitive_data_request"),
      v.literal("malicious_or_abusive"), v.literal("irrelevant"),
    )),
    descriptionSafetyReason: v.optional(v.string()),
    sortOrder: v.number(),
    summary: v.optional(v.string()),          // persisted department summary
    summaryUpdatedAt: v.optional(v.number()), // epoch ms of last generation
    summaryStale: v.optional(v.boolean()),    // true when new data invalidates the summary
    clerkOrgId: v.string(),
  }).index("by_clerkOrgId_and_functionId", ["clerkOrgId", "functionId"]),

  processes: defineTable({
    departmentId: v.id("departments"),
    name: v.string(),
    description: v.optional(v.string()),
    // Same description-safety screening as departments, above.
    descriptionSafetyStatus: v.optional(v.union(v.literal("safe"), v.literal("blocked"))),
    descriptionSafetyCheckedAt: v.optional(v.number()),
    descriptionSafetyModel: v.optional(v.string()),
    descriptionSafetyPromptVersion: v.optional(v.string()),
    descriptionSafetyRisk: v.optional(v.union(
      v.literal("none"), v.literal("prompt_injection"), v.literal("agent_instruction"),
      v.literal("policy_override"), v.literal("sensitive_data_request"),
      v.literal("malicious_or_abusive"), v.literal("irrelevant"),
    )),
    descriptionSafetyReason: v.optional(v.string()),
    sortOrder: v.number(),
    rollingSummary: v.optional(v.string()),
    clerkOrgId: v.string(),
  }).index("by_clerkOrgId_and_departmentId", ["clerkOrgId", "departmentId"]),

  // Conversation records
  conversations: defineTable({
    processId: v.id("processes"),
    elevenlabsConversationId: v.optional(v.string()), // AI interview session id
    contributorName: v.string(),
    userId: v.optional(v.id("users")),
    inputMode: v.optional(v.union(
      v.literal("agent"),
      v.literal("voiceRecord"),
      v.literal("audioUpload"),
    )),
    audioStorageId: v.optional(v.id("_storage")), // Voice Record and Audio File Upload
    audioMimeType: v.optional(v.string()),
    transcriptionProvider: v.optional(v.union(
      v.literal("elevenlabs-convai"),
      v.literal("elevenlabs-scribe"),
    )),
    analysisProvider: v.optional(v.union(
      v.literal("elevenlabs-convai"),
      v.literal("fabric-openrouter"),
      v.literal("fabric-foundry"),
    )),
    transcript: v.optional(v.array(v.object({  // Voice Record/Upload include speakerId/speakerName
      role: v.string(),
      content: v.string(),
      time_in_call_secs: v.number(),
      speakerId: v.optional(v.string()),
      speakerName: v.optional(v.string()),
    }))),
    speakerLabels: v.optional(v.array(v.object({
      speakerId: v.string(),
      displayName: v.string(),
      userId: v.optional(v.id("users")),
    }))),
    summary: v.optional(v.string()),         // ElevenLabs for AI interviews; Fabric AI adapter for Voice Record/Upload
    analysis: v.optional(v.any()),           // opaque ElevenLabs/Fabric analysis payload
    durationSeconds: v.optional(v.number()),
    status: v.union(
      v.literal("processing"), v.literal("needs_speaker_labels"),
      v.literal("done"), v.literal("failed"),
    ),
    clerkOrgId: v.string(),
  })
    .index("by_clerkOrgId_and_processId", ["clerkOrgId", "processId"])
    .index("by_clerkOrgId_and_processId_and_status", ["clerkOrgId", "processId", "status"])
    .index("by_clerkOrgId_and_status", ["clerkOrgId", "status"])
    .index("by_clerkOrgId_and_elevenlabsConversationId", ["clerkOrgId", "elevenlabsConversationId"]),

  // Process flow diagrams — one per process, AI-generated from conversation data
  processFlows: defineTable({
    processId: v.id("processes"),
    status: v.union(v.literal("generating"), v.literal("ready"), v.literal("failed")),
    stale: v.boolean(),
    generatedAt: v.number(),
    conversationCount: v.number(),
    errorMessage: v.optional(v.string()),
    nodes: v.array(v.object({
      id: v.string(),                       // deterministic kebab-case
      label: v.string(),
      description: v.string(),
      category: v.union(v.literal("start"), v.literal("end"), v.literal("action"),
        v.literal("decision"), v.literal("handoff"), v.literal("wait")),
      actors: v.array(v.string()),
      tools: v.array(v.string()),
      estimatedDuration: v.optional(v.string()),
      painPoints: v.array(v.string()),
      automationPotential: v.union(v.literal("none"), v.literal("low"),
        v.literal("medium"), v.literal("high")),
      confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
      isBottleneck: v.boolean(),
      isTribalKnowledge: v.boolean(),
      riskIndicators: v.array(v.string()),
      sources: v.array(v.string()),         // "[Name, Conv. N]" citations
    })),
    edges: v.array(v.object({
      id: v.string(),
      source: v.string(),
      target: v.string(),
      type: v.union(v.literal("sequential"), v.literal("conditional"),
        v.literal("parallel"), v.literal("fallback")),
      label: v.optional(v.string()),
      isHappyPath: v.boolean(),
    })),
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
```

Note: `functions`/`departments`/`processes`/`conversations`/`processFlows` are
all tenant-scoped via a required `clerkOrgId: v.string()` — see §3.7 for how
this field is populated and enforced. `orgThemeTokens` (referenced above) is a
12-field object: `accent`, `accentForeground`, `subtle`, `border`, `ring`,
`selected`, `selectedForeground`, `chart1`–`chart5` (all `v.string()` hex/OKLCH
values) — see the new "Org Branding / Appearance" subsection below.

**Convex features used:**

- **Document database** — schema-validated tables with typed fields, references via `v.id()`, and flexible `v.any()` for transcript/analysis storage
- **Hierarchy integrity guards** — department/process create and move mutations must verify the target parent exists before writing. Delete mutations are non-cascading and must refuse to remove parents that still have child records. If legacy orphaned records are found, they are rewired non-destructively into recovery parents rather than deleting child processes, conversations, or process flows.
- **Server functions** — `actions` for external API calls (ElevenLabs, Microsoft Foundry, and temporary OpenRouter rollback), `mutations` for database writes, `queries` for reads, `httpAction` for HTTP endpoints (audio proxy, Clerk webhook)
- **Built-in reactivity** — all `useQuery` hooks auto-update when data changes. No manual subscriptions needed — the UI updates live when a new conversation is inserted or its status changes
- **Auth** — Clerk (hosted auth with prebuilt UI) + Convex JWT validation, auth gates on all queries, user profiles with onboarding on first login (Phase 5)

### 3.3 ElevenLabs Integration

#### 3.3.1 SDK & Package Overview

ElevenLabs provides a layered ecosystem for Fabric:

| Package | Purpose | Install |
|---|---|---|
| `@elevenlabs/react` | Core React hook (`useConversation`) for voice agent sessions | `npm i @elevenlabs/react` |
| **ElevenLabs UI** | shadcn/ui-based component library (Orb, Conversation, Message, Waveform, etc.) | `npx @elevenlabs/cli@latest components add <name>` or `npx shadcn@latest add https://ui.elevenlabs.io/r/<name>.json` |
| `@elevenlabs/convai-widget-core` | Pre-built embeddable widget (web component `<elevenlabs-convai>`) | Alternative if custom UI not needed |

**ElevenLabs UI is built on top of shadcn/ui** — this is a direct fit for our stack. Components install as source files into the project (not locked library code), so they're fully customizable.

#### 3.3.2 Key ElevenLabs UI Components for Fabric

| Component | Use in Fabric |
|---|---|
| **Conversation** | Full chat container with `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton` — the recording modal's main body |
| **Conversation Bar** | Voice interface with mic controls, text input fallback, and real-time waveform visualization |
| **Orb** | 3D animated orb (Three.js) that reacts to audio input — visual feedback during recording |
| **Message** | Composable chat bubbles with auto-styling for user/assistant — real-time transcript display |
| **Waveform** | Canvas-based audio waveform visualization — recording state indicator |
| **Voice Button** | Mic toggle button — start/stop recording |
| **Transcript Viewer** | Display past conversation transcripts in the process detail panel |
| **Audio Player** | Inline audio playback for historical conversation recordings |
| **Scrub Bar** | Seek/scrub through audio recordings in the conversation log |
| **Shimmering Text** | Loading/connecting state indicator |

Install all relevant components:
```bash
npx @elevenlabs/cli@latest components add conversation orb message waveform voice-button transcript-viewer shimmering-text conversation-bar audio-player scrub-bar
```

#### 3.3.3 React SDK — `useConversation` Hook

The `@elevenlabs/react` package provides the `useConversation` hook, which manages WebRTC/WebSocket connections and audio:

```tsx
import { useConversation } from "@elevenlabs/react";

const conversation = useConversation({
  onConnect: ({ conversationId }) => {
    // Store conversationId — needed for post-call API retrieval
    setElevenLabsConversationId(conversationId);
  },
  onDisconnect: (details) => {
    // details.reason: "user" | "agent" | "error"
    // Trigger post-call processing pipeline
    handlePostCall(elevenLabsConversationId);
  },
  onMessage: ({ message, source }) => {
    // source: "user" | "ai" — real-time transcript updates
    appendToLiveTranscript({ role: source, content: message });
  },
  onError: (message, context) => {
    console.error("ElevenLabs error:", message, context);
  },
  micMuted: isMuted,
});

// State provided by the hook
conversation.status;      // "connected" | "disconnected" | "connecting" | "disconnecting"
conversation.isSpeaking;  // boolean — is the agent currently speaking?

// Methods
await conversation.startSession({
  agentId: "<FABRIC_AGENT_ID>",
  connectionType: "webrtc",
  userId: contributorName,    // for analytics filtering
  dynamicVariables: {
    contributor_name: contributorName,
    job_title: userJobTitle,
    years_in_role: tenure,
    function_name: functionName,
    department_name: departmentName,
    process_name: processName,
    existing_summary: existingRollingSummary,
    prior_conversations: priorSummaries,
  },
});
conversation.endSession();
conversation.sendUserMessage(text);  // text input fallback
conversation.setVolume({ volume: 0.8 });
conversation.getInputVolume();       // for waveform visualization
conversation.getOutputVolume();      // for orb animation
```

**Key capabilities confirmed from research and implementation:**

- **Dynamic variables** — values are injected into `{{placeholder}}` templates in the agent's dashboard-configured system prompt and first message. This avoids needing to enable override permissions in the agent's Security tab. Context passed: contributor name, job title, tenure, process path, existing summary, prior conversations.
- **`onConnect` provides `conversationId`** — this is the globally unique ID we use to fetch post-call data.
- **`onMessage` event** — fires for both user and agent messages in real-time, enabling live transcript display during the call.
- **`getInputVolume()` / `getOutputVolume()`** — raw audio levels for driving the Orb animation and Waveform visualization.
- **Client tools** — the agent can invoke client-side functions (e.g., to save a note, trigger a UI action). Useful for Phase 2 but not required for POC.

#### 3.3.4 Post-Call Data Retrieval

ElevenLabs provides **two complementary paths** for retrieving conversation data after a call ends:

**Path A: REST API (polling — recommended for POC)**

```
GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}
Header: xi-api-key: <API_KEY>
```

Response includes:
- `status` — `initiated` | `in-progress` | `processing` | `done` | `failed`
- `transcript` — full structured transcript (list of message objects with role, content, `time_in_call_secs`)
- `metadata` — 26 properties including `start_time_unix_secs`, `call_duration_secs`, detected language, and more
- `analysis` — **transcript summary**, success evaluation results (per criterion), and data collection results (structured extracted fields). This is the key object — it gives us the conversation summary and structured data without any additional LLM call.
- `has_audio` / `has_user_audio` / `has_response_audio` — booleans confirming audio availability
- `user_id` — the contributor identifier passed via `startSession()`

The conversation status transitions to `processing` immediately after the call ends, then `done` once analysis is complete. **Fabric should poll this endpoint** (e.g., every 2 seconds) after `onDisconnect` fires, until status = `done`.

**Path B: Post-Call Webhooks (not implemented)**

ElevenLabs supports a `post_call_transcription` webhook that fires when processing is complete, which was the originally planned production path. **This was not built** — `convex/http.ts` has no route for it today; only the Clerk webhook (`/clerk/webhook`) and the audio proxy (`/audio/...`) exist. The polling path (Path A, `fetchConversation`) above is the only mechanism in production. Revisit this if polling latency or ElevenLabs API load becomes a problem.

#### 3.3.4a Stored-Audio Pipeline — Voice Record & Audio File Upload (Scribe, Diarization, Speaker Labels)

In addition to AI interview sessions, Fabric supports two contributor-driven capture modes that share the same downstream pipeline: **Voice Record** (live mic capture for process notes or multi-person discussion without the AI interviewer) and **Audio File Upload** (pre-existing recordings such as Zoom exports, mobile voice memos, or interview recordings).

**Entry points:**
- **Voice Record:** Browser records microphone audio with `MediaRecorder`; the resulting Blob is uploaded to Convex Storage. The conversation is stamped `inputMode: "voiceRecord"`.
- **Audio File Upload:** User picks an audio file through a native file picker (`accept="audio/*"`, 100 MB client-side cap). The file is uploaded to Convex Storage. The frontend best-effort probes duration via a hidden `<audio>` element and passes `source: "upload"` to `processVoiceRecording`. The server stamps the conversation with `inputMode: "audioUpload"` and rejects any non-audio MIME prefix.

**Shared pipeline (identical after upload):**
1. Frontend uploads the audio blob to Convex Storage using a signed upload URL from `voiceRecordings.generateUploadUrl`.
2. `voiceRecordings.processVoiceRecording` inserts a `conversations` row with the appropriate `inputMode`, `audioStorageId`, and `status: "processing"`, then schedules transcription.
3. `processVoiceRecordingInternal` sends the stored audio to ElevenLabs Speech-to-Text (`scribe_v2`) with word timestamps and `diarize=true`.
4. Fabric normalizes the Scribe word stream into transcript chunks, splitting when `speaker_id` changes, and saves default labels (`Speaker 1`, `Speaker 2`, etc.).
5. The conversation transitions to `status: "needs_speaker_labels"` and **stops before analysis**.
6. The contributor reviews diarized speaker samples, assigns display names, and can optionally link each speaker to an org member.
7. `submitSpeakerLabels` patches `speakerName` onto transcript segments, transitions the conversation back to `processing`, and schedules analysis.
8. `analyzeVoiceRecordingInternal` runs Fabric's synthesis prompt through the shared AI adapter (Foundry Claude after cutover) on the labeled transcript, stores `summary` + structured `analysis`, marks the conversation `done`, and only then schedules `regenerateProcessSummary`.

**Abandonment cleanup:**
If a contributor closes the modal after the audio has reached storage but before they approve speaker labels, the frontend calls `voiceRecordings.abandonVoiceRecording`. The mutation deletes the storage object and the conversation row when `status !== "done"`, ensuring we don't retain half-processed audio. The check is gated to the row owner or an org admin and to `voiceRecord` / `audioUpload` rows, so AI interview records (which Fabric does not own the bytes for) are never touched.

**Why speaker labeling is before analysis:**
- Process summaries and process flows cite contributors and infer handoffs/actors. Running analysis on unlabeled `speaker_0` / `speaker_1` text would lose important context and could misattribute process ownership.
- The label gate makes the transcript, conversation summary, rolling process summary, and process-flow extraction use confirmed human-readable speaker names.
- Duplicate display names are allowed so users can correct over-split diarization by labeling two Scribe speakers as the same person.

**Failure handling — admin retry and truncation detection:**
- If transcription or analysis fails, the conversation is marked `status: "failed"` and appears in Admin → Conversations with a Retry action (`voiceRecordings.retryAudioProcessing`, admin-only). Retry is stage-aware: if a transcript already exists, only the Fabric AI analysis step re-runs; if transcription itself failed, the pipeline re-runs from the original audio retained in Convex Storage.
- The Fabric AI analysis request uses a larger token budget (`max_tokens: 16384`, vs. `8192` for rolling summaries) to reduce truncation, and explicitly inspects the response's finish reason: a token-limit cutoff raises a clear "recording may be too long to analyze in a single pass" error instead of surfacing an opaque JSON-parse failure.

#### 3.3.5 Audio Playback — Streamed from ElevenLabs

For AI interview conversations, ElevenLabs provides a dedicated endpoint to retrieve the audio recording:

```
GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/audio
Header: xi-api-key: <API_KEY>
```

This returns the raw audio file directly. For AI interviews, Fabric does not store audio files — a lightweight proxy endpoint (Convex HTTP action) adds the `xi-api-key` header and streams the response to the frontend. For Voice Record and Audio File Upload, Fabric streams the retained Convex Storage audio object through the same org-scoped audio proxy.

**Why this works for POC:**
- No file storage needed for AI interviews — removes an infrastructure layer from the agent path
- No `post_call_audio` webhook processing — no base64 decoding, no upload pipeline
- No `audio_url` column in the database — playback is resolved from either `elevenlabsConversationId` (AI interview) or `audioStorageId` (Voice Record / Audio File Upload)
- Retrieval is a read operation, not a generation — **no additional credits consumed**
- ElevenLabs retains conversation audio natively as part of the Agents Platform (built-in retention)
- Tradeoff: AI interview playback depends on ElevenLabs API availability; Voice Record and Audio File Upload playback depend on Convex Storage availability

**Proxy endpoint pattern:**
```
GET /audio/:clerkOrgId/:conversationId?exp=...&sig=...
→ Convex HTTP action verifies signed URL + org ownership
→ AI interview: proxy ElevenLabs audio API with xi-api-key
→ Voice Record / Audio File Upload: stream Convex Storage blob
→ Frontend <audio> element or ElevenLabs UI Audio Player renders it
```

#### 3.3.6 Conversation Analysis (ElevenLabs Platform Feature)

ElevenLabs provides built-in, LLM-powered post-call analysis with two capabilities:

**Success Evaluation** — define custom criteria to assess each conversation. For Fabric, configure criteria like:
- "Did the contributor describe specific steps in their process?"
- "Did the contributor mention tools or systems they use?"
- "Did the contributor identify dependencies on other people or teams?"

**Data Collection** — extract structured data points from each conversation. For Fabric, configure extraction of:
- `steps_described` (list of strings)
- `tools_mentioned` (list of strings)
- `dependencies` (list of strings)
- `frequency` (string, e.g., "weekly", "monthly")
- `edge_cases` (list of strings)

These results are returned in the `analysis` field of the conversation details API and in the post-call webhook payload. The analysis object also includes a **transcript summary** — a narrative summary of the conversation generated by ElevenLabs' LLM. **For AI interviews, ElevenLabs handles all conversation-level summarization natively.** Fabric simply stores the summary and structured data as-is. For Voice Record and Audio File Upload, Fabric uses ElevenLabs Scribe only for diarized transcription, then runs its own Foundry-hosted analysis after speaker labels are confirmed.

### 3.4 AI Inference Platform & Summarization Pipeline

All Fabric-owned LLM requests go through `convex/lib/aiProvider.ts`, a capability-based adapter that isolates provider protocol differences from the product workflows. The adapter supports Foundry-hosted Claude, Foundry-hosted Azure OpenAI, and OpenRouter during the rollback window. Call sites select a capability (`synthesis` or `descriptionSafety`) rather than constructing provider URLs or choosing provider-specific model identifiers.

**Approved model assignments:**

| Capability | Foundry deployment | Model | Requirement |
|---|---|---|---|
| Process, department, function, process-flow, and labeled-voice synthesis | `fabric-claude-haiku-4-5` | Claude Haiku 4.5, version `2` | Preserve the existing synthesis model and prompt behavior through migration |
| Description safety | `fabric-description-safety` | GPT-5 nano, version `2025-08-07` | Replace the OpenRouter-hosted Gemma classifier with strict structured tool output |
| Evaluated fallback / Claude successor candidate | `fabric-gpt5-mini-fallback` | GPT-5 mini, version `2025-08-07` | Warm deployment only; do not switch synthesis to it without golden-set quality approval |

**Environment topology and rollout status (July 2026):**

| Environment | Foundry project | Region / routing | Capacity (Claude / nano / mini) | Current provider state |
|---|---|---|---:|---|
| Development | `fabric-foundry-dev-se` | Sweden Central / Global Standard | `1 / 10 / 10` | `AI_PROVIDER=foundry`; direct model smoke tests and application validation complete |
| Production | `fabric-foundry-prod-se` | Sweden Central / Global Standard | `50 / 50 / 10` | Account, separate API key, deployments, Convex settings, and direct smoke tests complete; `AI_PROVIDER=openrouter` intentionally remains until golden-set validation and explicit cutover approval |

Development and production use separate Foundry accounts and API keys in the same Azure subscription. This isolates credentials, monitoring, and deployment lifecycle, but quota remains shared at the subscription/region/model level. Global Standard is pay-per-token and may route inference outside Sweden Central; it does **not** provide strict Sweden-only or EU data-zone processing. This routing choice is approved for the current consulting workload and must be revisited if client or regulatory data-residency requirements change.

**Provider behavior and operational requirements:**

- Foundry credentials and provider selection are server-only Convex environment variables. Foundry keys must not be stored in `.env.local`, exposed to the browser, or committed to source control.
- The adapter applies bounded retries for transient failures and normalizes text, structured tool output, finish reason, token usage, deployment, provider, latency, and request ID across provider protocols.
- Telemetry must never log prompt or response content. It may log operation, provider, model/deployment, latency, finish reason, token counts, request ID, attempt count, and error classification.
- Voice rows created after cutover store `analysisProvider: "fabric-foundry"`. Existing `fabric-openrouter` rows remain valid; no data backfill is required.
- Production rollback is a server-side configuration change to `AI_PROVIDER=openrouter` while the OpenRouter key remains present. `FOUNDRY_SYNTHESIS_BACKEND=gpt5mini` is a model change, not an outage rollback, and requires separate quality approval.
- Model versions are changed through blue/green deployment names; active deployments are never version-updated in place.

The full provisioning, smoke-test, cutover, rollback, cost, and lifecycle procedure is maintained in [the Foundry migration runbook](docs/foundry-migration-runbook.md).

**Primary synthesis model:** Claude Haiku 4.5 version `2` via Microsoft Foundry (`fabric-claude-haiku-4-5`, `max_tokens: 8192` for rolling/department/function summaries)

**Design principles:**
- **Structured analyst briefs, not flat prose.** Every summary uses thematic sections with cited evidence — making claims traceable back to the person or process that produced them.
- **Contradictions are signal, not noise.** Where accounts disagree, the summary surfaces the tension explicitly rather than blending it away.
- **Incremental generation for token efficiency.** Process summaries are built incrementally — the first conversation's transcript produces the initial summary; each subsequent conversation passes only the *previous summary + new transcript*, not all transcripts. This keeps token cost roughly constant per conversation regardless of how many have been recorded.

---

**Conversation-level summary — source depends on input mode:**
For AI interviews, the `analysis` object returned by the Conversations API (and via the `post_call_transcription` webhook) includes a **transcript summary** generated by ElevenLabs' own LLM-powered analysis. Combined with the Data Collection fields (steps, tools, dependencies, etc.), this gives us everything we need for that conversation without a Fabric conversation-level LLM call.

For AI interviews, Fabric stores `analysis.transcript_summary` in `conversations.summary` and the structured `analysis.data_collection` results in `conversations.analysis`.

For Voice Record and Audio File Upload, Fabric first transcribes with ElevenLabs Scribe diarization, pauses for speaker labels, then sends the labeled transcript to Claude Haiku 4.5 through the Fabric AI adapter to generate the conversation-level `summary` and process-flow-compatible `analysis.data_collection`. This is the only current path where Fabric performs a conversation-level LLM call.

**Process-level rolling summary — Claude Haiku 4.5 via Microsoft Foundry (incremental, auto-regenerated):**

After each completed conversation is stored with analysis-ready transcript data, a Convex action generates or updates the process rolling summary using an **incremental approach**:

- **First conversation:** The full transcript is sent to Claude Haiku 4.5 to produce the initial structured summary.
- **Subsequent conversations:** The *existing rolling summary* plus the *new completed conversation's full transcript* are sent. The LLM integrates the new information into the existing structure — adding citations, updating consensus, surfacing new tensions. This avoids re-processing all prior transcripts and keeps token cost roughly constant per call.

The transcript (not just ElevenLabs' short summary) is passed to the LLM so it has enough detail to identify themes, contradictions, and nuance.

**Process-level output format:**
```markdown
## Overview
2-3 sentence executive summary of the process.

## Key Stages
Thematic breakdown of the process phases, citing which contributors
described each stage (e.g., "...the request is triaged by the team
lead [Alice, Conv. 2]").

## Consensus
What multiple contributors agree on — the shared understanding
of how the process works.

## Tensions & Gaps
Where accounts contradict each other or where no contributor covers
a step. This is the most actionable section for process improvement.

## Notable Details
Unique insights only one contributor mentioned that seem important
enough to preserve.
```

**Department-level summary — Claude Haiku 4.5 via Microsoft Foundry (persistent, on-demand with staleness):**
Department summaries are generated on-demand and **persisted** to the `departments` table with a `summary`, `summaryUpdatedAt` (epoch ms), and `summaryStale` (boolean) field. Generation synthesizes all child process `rollingSummary` values through Claude Haiku 4.5 with a department-focused prompt.

**Department-level output format:**
```markdown
## Overview
Executive summary of how this department operates.

## Cross-Process Handoffs
How processes feed into each other — inputs, outputs, dependencies,
citing the source process (e.g., "[Compensation process]").

## Shared Themes
Patterns that appear across multiple processes (common tools,
shared bottlenecks, recurring pain points).

## Tensions & Gaps
Contradictions between processes or uncovered gaps in the
handoff chain.

## Notable Details
Unique findings from individual processes worth surfacing
at the department level.
```

- **Staleness**: A department summary becomes stale when: (a) a new completed conversation updates any child process summary, (b) a process is added or removed from the department.
- **Token efficiency**: If the summary exists and `summaryStale === false`, the action returns the persisted summary without making an LLM call — no tokens wasted on unchanged data.
- **Force refresh**: A `forceRefresh` flag can bypass the staleness check to regenerate regardless.
- **UI**: Shows a "Last refreshed: X ago" timestamp and a stale indicator ("New data available") when invalidated.

**Function-level summary — Claude Haiku 4.5 via Microsoft Foundry (persistent, on-demand with staleness + cascade):**
Function summaries follow the same persistent + staleness pattern as department summaries, but are built from **department summaries** (not raw process summaries) to maintain proper hierarchical abstraction.

**Function-level output format:**
```markdown
## Overview
High-level summary of how this function operates as a whole.

## Cross-Department Patterns
How departments relate — shared dependencies, organizational
handoffs, citing the source department (e.g., "[Payroll dept]").

## Strategic Themes
Recurring patterns across departments (common tooling,
shared constraints, workforce themes).

## Tensions & Gaps
Cross-departmental contradictions or organizational blind spots.

## Notable Details
Department-specific findings worth escalating to the
function level.
```

- **Cascade generation**: If any department under the function has no summary yet, the action auto-generates missing department summaries first (sequentially), then synthesizes the function-level summary from all department summaries.
- **Staleness**: A function summary becomes stale when: (a) any child department summary is regenerated, (b) a department is added or removed from the function.
- **Token efficiency**: Same guard as department level — skip LLM call if summary is fresh and not stale.

**Summary hierarchy:**
```
Function Summary (built from Department Summaries)
  └── Department Summary (built from Process Rolling Summaries)
      └── Process Rolling Summary (built incrementally: prev summary + new transcript)
          └── Conversation Summary (ElevenLabs for AI interviews; Fabric/Foundry for Voice Record and Audio File Upload after speaker labels)
              └── Full Transcript (stored, passed to process summary generation)
```

**Staleness propagation:**
```
New completed recording → Process summary incrementally updated
  → Process flow marked stale
  → Department summary marked stale
    → Function summary marked stale
```

Admin deletes completed conversation → Process summary force-refreshed from remaining completed transcripts
  → Process flow marked stale
  → Department summary marked stale
    → Function summary marked stale

Admin deletes the last completed conversation for a process → Process summary cleared
  → Process flow deleted
  → Parent summaries cleared or marked stale based on remaining child summaries

Process deleted → Process flow deleted → Department summary cleared/stale → Function summary stale
New process added/removed → Department summary marked stale → Function summary marked stale
New department added/removed → Function summary marked stale

### 3.4a Description Safety Screening

Every Function/Department/Process **description** (a free-text field contributors and admins can set when creating or editing an item) is screened before it's persisted, because descriptions are later injected into the voice-agent interview prompt — an unscreened description would be a prompt-injection vector directly into the interview agent.

- **Model:** GPT-5 nano version `2025-08-07` via Microsoft Foundry (`fabric-description-safety`, `max_tokens: 1000`). This intentionally replaces the former OpenRouter-hosted `google/gemma-4-26b-a4b-it` classifier rather than attempting to self-host the exact Gemma model.
- **Classification:** each description is checked for `descriptionSafetyRisk` — `none`, `prompt_injection`, `agent_instruction`, `policy_override`, `sensitive_data_request`, `malicious_or_abusive`, or `irrelevant` — and an overall `descriptionSafetyStatus` of `safe` or `blocked`.
- **Storage:** the result (`descriptionSafetyStatus`, `descriptionSafetyRisk`, `descriptionSafetyReason`, `descriptionSafetyModel`, `descriptionSafetyPromptVersion`, `descriptionSafetyCheckedAt`) is stored alongside the description on the `departments`/`processes` row. Blocked descriptions are not shown to the voice agent.
- **Where it runs:** the `create`/`update` actions in `convex/departments.ts` and `convex/processes.ts` run the classification synchronously before writing the description, so the safety verdict is always available by the time the row is readable.

### 3.5 Convex Architecture

**Why Convex:** Eliminates the need to build and deploy a separate backend API. Convex provides a document database, TypeScript server functions, and built-in real-time reactivity out of the box — all accessible from the Next.js frontend via `convex/react` hooks (`useQuery`, `useMutation`, `useAction`).

**Server functions (defined in `convex/` directory).** The API surface has grown well beyond the original POC and is organized by domain below rather than as one flat table. Function names are exact; each is a `query`, `mutation`, `action`, or their `internal*` counterparts unless noted otherwise.

**Hierarchy (`functions.ts`, `departments.ts`, `processes.ts`, `hierarchy.ts`):**

| Function | Purpose |
|---|---|
| `hierarchy.getTree` | Single-call read of the full Function→Department→Process tree for the org (conversation counts, pending-work status, flow summaries), bounded by per-level row limits with a `truncated` flag. Powers the tree sidebar. |
| `functions.list/get/childCount/deleteEligibility`, `departments.listByFunction/listAll/get/childCount/deleteEligibility`, `processes.listByDepartment/listAll/get/getWorkbench/childCount/deleteEligibility` | Reads, including server-computed delete-eligibility (role blockers, child-data blockers) so the UI can never bypass non-cascading delete rules. |
| `functions.create/update/remove`, `departments.create/update/remove`, `processes.create/update/remove` | CRUD. `create`/`update` on departments/processes run the description-safety check (§3.4a) before persisting; `remove` enforces non-cascading deletion and marks parent summaries stale. |

**Conversations & voice pipeline (`postCall.ts`, `voiceRecordings.ts`, `conversations.ts`):**

| Function | Purpose |
|---|---|
| `postCall.fetchConversation` | Called by the frontend after `onDisconnect` for AI interviews. Polls the ElevenLabs Conversations API until `status: done`, inserts the conversation, schedules `regenerateProcessSummary`. |
| `postCall.getAudioPlaybackToken` | Mints an HMAC-signed, short-lived URL for the `/audio/...` HTTP route (see below). |
| `postCall.regenerateProcessSummary` | Incremental or full-rebuild rolling-summary generation through the Fabric AI adapter and the Foundry Claude deployment after cutover. |
| `voiceRecordings.generateUploadUrl` / `processVoiceRecording` / `processVoiceRecordingInternal` | Convex Storage upload URL → inserts a `processing` conversation → ElevenLabs Scribe diarized transcription → `needs_speaker_labels`. |
| `voiceRecordings.submitSpeakerLabels` | Contributor labels diarized speakers; schedules `analyzeVoiceRecordingInternal`. |
| `voiceRecordings.analyzeVoiceRecordingInternal` | Foundry Claude structured analysis of the labeled transcript through the shared adapter; marks the conversation `done`; schedules `regenerateProcessSummary`. |
| `voiceRecordings.retryAudioProcessing` | Admin-only. Retries a `failed` Voice Record / Audio Upload conversation from whichever stage actually failed (§3.3.4a). |
| `voiceRecordings.abandonVoiceRecording` | Deletes the Storage object + conversation row for an unfinished, contributor-owned recording. |
| `conversations.listByProcess/listCompactByProcess/processIdsNeedingAttention` | Org-member reads for the Conversations tab. |
| `conversations.listAllForOrg/getForAdmin/countForOrg/deleteForAdmin` | Admin-only: org-wide conversation log (filter by status/process), admin delete with cascading summary/flow cleanup. |
| `conversations.retryFetch` / `postCall.listUnimported/importConversation/refreshConversationAnalysis` | Retry/backfill tooling for AI-interview conversations that failed or weren't yet imported from ElevenLabs. |

**Process flow generation (`processFlows.ts`):**

| Function | Purpose |
|---|---|
| `getProcessFlow` | Real-time read of a process's generated flow. |
| `generateProcessFlow` | Auth-gated entry point. Joins an in-flight run rather than starting a competing one, then schedules the staged pipeline below. |
| `generateGraphInternal` | Stage 1: one bounded call producing the graph skeleton only (nodes, edges, critical path) from the rolling summary + conversation analysis. Saves it `ready` and seeds one pending `processFlowNodeDetails` row per node. |
| `generateNodeDetailsBatchInternal` | Stage 2: enriches ~6 nodes per call, re-scheduling itself until none are pending. Halves the batch once if a response truncates. |
| `generateFlowInsightsInternal` | Stage 3: one call over the whole enriched graph identifying automation opportunities (agent / workflow / integration), then finalizes the run. |
| `retryNodeDetail` | Re-requests one step's description without regenerating the flow. |
| `reapStuckFlowGenerations` | Cron-driven watchdog: fails a wedged graph stage, resumes or finalizes a wedged detail stage. |
| `markFlowStale` / `deleteForProcess` | Internal — staleness propagation and flow cleanup on process/conversation deletion. |

**Summaries (`summaries.ts`, `summariesHelpers.ts`):**

| Function | Purpose |
|---|---|
| `generateDepartmentSummary` / `generateFunctionSummary` | On-demand rollups over child summaries, with cascade generation (a function summary auto-generates any missing department summaries first, sequentially). |
| `forceRefreshProcessSummary` | Schedules a full rebuild of a process's rolling summary from all transcripts. |
| `markDepartmentSummaryStale` / `markFunctionSummaryStale` | Internal — staleness cascade upward through the hierarchy. |

**Membership, auth & invitations (`users.ts`, `invitations.ts`):**

| Function | Purpose |
|---|---|
| `users.store` / `syncCurrentUserFromClerk` / `handleClerkWebhook` | Auto-provisions a user + membership on first authenticated request; keeps `users`/`memberships`/`membershipIntents`/`tenants` in sync with Clerk (webhook-driven, idempotent). Handles `user.*`, `organizationMembership.*`, `organizationInvitation.revoked`, and `organization.created/updated/deleted` events. |
| `users.getMe/getActiveOrg/getMyMembership` | Current user/org/role reads. |
| `users.completeProfile/updateProfile` | Onboarding (live) + profile edits (`updateProfile` exists and works, but the only UI component that calls it is not currently rendered anywhere — see the review note in §6). |
| `users.listOrgMembersPage/listOrgMembers/searchOrgMembers/getOrgMembershipStats` | Member directory (paginated, searchable) and denormalized org stats for the admin Users page. |
| `users.setMembershipRole/removeMemberFromOrg` | Role changes and member removal, with last-admin and self-removal guards; Clerk membership is removed before the Fabric row to avoid recreating access from a stale Clerk membership. |
| `invitations.invite/list/revoke` | Admin-only, Clerk-backed invitation management; invitations carry a `redirect_url` to the tenant's own `/sign-up` so the email link lands on-subdomain; resend is implemented as revoke + re-invite; `list` hides invitations whose invitee already joined. |

**Org theming (`orgThemes.ts`):**

| Function | Purpose |
|---|---|
| `getForCurrentOrg` / `getThemeAdminState` | Runtime theme tokens (any member) and admin-facing theme state. |
| `startThemeGeneration/saveGeneratedCandidate/saveManualCandidate/approveCandidateTheme/rejectCandidateTheme/resetToNeutral` | Admin-only logo-color-extraction workflow — see the new "Org Branding / Appearance" section below. |

**Platform / super-admin (`platform.ts`):**

| Function | Purpose |
|---|---|
| `bootstrapSuperAdmin` / `setPlatformRole` | Bootstraps and manages the platform `superAdmin` flag. |
| `fanOutSuperAdminMemberships` | Makes every super-admin a real Clerk + Fabric member of a given org (Model A, §3.7.2) — not an access bypass. |
| `findUserByEmail` | Super-admin-gated exact-email lookup, backing the console's promote-a-super-admin flow. |
| `setOrgAllowedEmailDomains` (+ `…Internal`) | Sets a tenant's enrollment domain allowlist in Clerk org public metadata (§3.7.6). |

**Tenant console (`tenants.ts`) — super-admin-gated backend of `tenants.bizfabric.ai` (§3.7.7):**

| Function | Purpose |
|---|---|
| `list` / `get` / `listTenantMembers` | Reactive tenant registry reads (with member/admin/pending counts, falling back to a live count when the denormalized stats row is absent). |
| `createTenant` / `retryProvisioning` | Provisions a new tenant (Clerk org + staff fan-out + logo + optional first-user invite); non-fatal steps are recorded per-tenant and re-runnable. |
| `renameTenant` / `updateLogo` / `updateAllowedEmailDomains` / `generateLogoUploadUrl` | Per-tenant settings edits (slug is immutable from the console). |
| `listTenantInvitations` / `inviteTenantUser` / `revokeTenantInvitation` | Platform-scoped invitation management for any tenant. |
| `fanOutToAllTenants` | Re-runs the super-admin fan-out across every tenant (after a promotion, or on demand). |
| `backfillTenantsFromClerk` | CLI backfill that seeds/refreshes the mirror (and stats rows) from every Clerk org. |

**HTTP endpoints (`http.ts`):**

| Route | Purpose |
|---|---|
| `POST /clerk/webhook` | Clerk user/org/membership/organization webhook sync, HMAC(Svix)-verified with a 5-minute replay window, idempotent via `processedWebhookEvents`. |
| `GET /audio/:clerkOrgId/:conversationId` (+ `OPTIONS`) | Org-scoped, HMAC-signed audio proxy: streams ElevenLabs audio for AI interviews or the Convex Storage blob for Voice Record/Upload, with HTTP Range support. Returns 404 on any org mismatch. |

**Ops tooling — internal-only, invoked via `npx convex run` (not exposed in any UI):**

| Function | Purpose |
|---|---|
| `orgIntegrity.auditHierarchyIntegrity/repairHierarchyOrphans/auditAllOrgs` | Detects and repairs orphaned hierarchy rows or missing/mismatched `clerkOrgId` values. |
| `migrations.*` (via `@convex-dev/migrations`) | The `clerkOrgId` backfill migrators (§3.7.8) and a dev→prod tenant-move pipeline (`exportForOrg` → `prodImportFromStorage` → `prodImport_insertAll`). |
| `cleanup.removeTestData` | Deletes seed/test conversations for an org. |
| `seed.seed` | Idempotently seeds a demo Function→Department→Process tree with sample conversations for an org. |

**AI provider and Foundry tooling:**

| File / command | Purpose |
|---|---|
| `convex/lib/aiProvider.ts` | Shared capability-based provider adapter for Foundry Claude, Foundry Azure OpenAI, and temporary OpenRouter rollback; normalizes retries, structured output, telemetry, token usage, request IDs, and errors. |
| `infra/foundry` | Reproducible `azd` infrastructure for separate Sweden Central development and production Foundry accounts/projects. |
| `scripts/deploy-foundry-models.ps1` | Idempotently previews or deploys the approved model versions, Global Standard SKU, and per-environment capacities after checking quota. |
| `npm run foundry:smoke` | Sends direct smoke requests to Claude synthesis, GPT-5 nano safety, and GPT-5 mini fallback deployments before application cutover. |
| `AI_PROVIDER` | Convex server-side rollout switch: `foundry` for the active Foundry path, `openrouter` only during staged production rollout and rollback. |

**Background work — no recurring jobs:** there is no `convex/crons.ts`. Every asynchronous step (transcription → speaker-label wait → analysis → summary regeneration → flow generation) is a one-shot `ctx.scheduler.runAfter(0, ...)` fan-out triggered by the preceding step, used specifically to escape Convex's single-transaction time/read limits for long-running LLM/HTTP calls.

**Built-in reactivity (no manual subscriptions needed):**
Convex queries are reactive by default. Any component using `useQuery` will auto-update when the underlying data changes. When a new conversation record is inserted (or its status changes to `needs_speaker_labels` / `done`), the Process Detail Panel auto-refreshes without a page reload — no channels, no subscriptions, no cleanup.

```tsx
// Convex queries are reactive by default — no manual subscriptions needed.
// Any component using useQuery will auto-update when the underlying data changes.
const conversations = useQuery(api.conversations.listByProcess, {
  processId: selectedProcessId,
});
const process = useQuery(api.processes.get, { processId: selectedProcessId });
// process.rollingSummary auto-updates when regenerateProcessSummary writes a new value
```

**Data flow (AI interview — polling path):**

1. User starts session → `conversation.startSession()` → receives `conversationId`
2. User ends session → `onDisconnect` fires
3. Frontend calls `fetchConversation` Convex action with `conversationId`
4. Convex action polls `GET /v1/convai/conversations/{id}` until status = `done`
5. Convex action extracts transcript, summary (from `analysis`), and data collection results → inserts into `conversations` table via `ctx.runMutation` (no Claude call needed — ElevenLabs provides the summary)
6. Convex action calls `regenerateProcessSummary` → the Fabric AI adapter invokes the Foundry Claude deployment after cutover → incrementally updates the structured process summary (existing summary + new transcript) → updates `processes.rollingSummary`
7. Convex reactivity auto-updates the frontend → UI refreshes with summary, transcript, and audio player (no manual subscriptions needed)
8. Audio playback: when user clicks play, the Audio Player component calls the org-scoped audio HTTP action → proxies the ElevenLabs Audio API → streams MP3 to the browser (no stored files for AI interviews, no additional credits)

**Data flow (Voice Record & Audio File Upload — Scribe + speaker labels):**

1. User either records local microphone audio in the browser, or picks an existing audio file from disk via the upload button. Either path uploads the blob to Convex Storage.
2. `processVoiceRecording` creates a `conversations` row with `inputMode: "voiceRecord"` (record path) or `inputMode: "audioUpload"` (upload path) and `status: "processing"`.
3. `processVoiceRecordingInternal` sends the audio to ElevenLabs Scribe (`scribe_v2`) with diarization enabled.
4. Fabric stores the diarized transcript with `speakerId`s and default `speakerLabels`, then sets `status: "needs_speaker_labels"`.
5. The UI prompts a contributor to name each speaker and optionally link each speaker to an org member.
6. `submitSpeakerLabels` patches `speakerName`s onto transcript segments and sets status back to `processing`.
7. `analyzeVoiceRecordingInternal` analyzes the labeled transcript through the Fabric AI adapter (Foundry Claude after cutover), saves the conversation summary and structured analysis, sets status to `done`, and schedules `regenerateProcessSummary`.
8. The process summary and process flow only see labeled speaker names, never raw `speaker_0` / `speaker_1` identifiers.

### 3.6 Authentication & User Access

**Provider:** Clerk (hosted auth with prebuilt UI components)
**Sign-in method:** Email + password (managed by Clerk)
**Tenancy:** Multi-tenant via Clerk Organizations (see section 3.7). Every org is accessed through its own subdomain (`biz-group.bizfabric.ai`). All data is row-level scoped by `clerkOrgId` and fully isolated across orgs.
**RBAC:** Three roles — **admin** (org management, conversation cleanup, CRUD, recording, viewing), **contributor** (eligible hierarchy CRUD, recording, viewing), **viewer** (browse hierarchy + view summaries only). Roles live in a Convex `memberships` table keyed by `(tokenIdentifier, clerkOrgId)` — **not** on the user record, because the same person can hold different roles in different orgs. Role checks are enforced server-side via `requireOrgContributor`/`requireOrgAdmin` helpers in `convex/lib/orgAuth.ts`. Frontend conditionally renders CRUD controls, Record button, and admin features based on the caller's role for the active org.

**Why Clerk:** First-class Convex integration via JWT validation. Prebuilt `<SignIn />`, `<SignUp />`, and `<UserButton />` React components — no custom auth UI to build or maintain. Clerk handles all auth infrastructure (account creation, password hashing, session management, JWT signing) externally, keeping the Convex backend focused on business logic. Can be extended with SSO/SAML and organization management for enterprise use.

**User Profile Table (`users`):**

| Field | Type | Description |
|---|---|---|
| `tokenIdentifier` | string | Canonical identity from `ctx.auth.getUserIdentity()` — primary lookup key |
| `clerkUserId` | optional string | Raw Clerk user id, distinct from `tokenIdentifier` |
| `name` | string | Display name (pre-filled from Clerk on first login) |
| `email` / `emailLower` | string | Email address (from Clerk identity); `emailLower` backs case-insensitive lookups |
| `jobTitle` | optional string | e.g., "Payroll Manager" |
| `function` | optional string | Org function (e.g., "Finance") — selected from `functions` table |
| `department` | optional string | Org department (e.g., "Payroll") — selected from `departments` table |
| `hireDate` | optional string | ISO date string |
| `profileComplete` | boolean | `false` until onboarding is done |
| `platformRole` | optional string | `"superAdmin"` or absent — platform-level admin flag, separate from per-org access. Does not grant tenant data access by itself. |
| `lastSyncedFromClerkAt` | optional number | Epoch ms of the last Clerk profile sync |
| `deletedAt` | optional number | Soft-delete marker |

**Membership Table (`memberships`):**

| Field | Type | Description |
|---|---|---|
| `tokenIdentifier` | string | Canonical identity from `ctx.auth.getUserIdentity()` |
| `userId` | `v.id("users")` | Linked global user profile |
| `clerkOrgId` | string | Active Clerk organization id |
| `role` | string | `"admin"` \| `"contributor"` \| `"viewer"` — the source of truth for org-scoped UI controls and Convex authorization |
| `source` | optional string | How the membership was created: `selfSignup` \| `adminInvite` \| `superAdminFanOut` \| `reconcile` \| `webhook` \| `legacy` |
| `status` | optional string | `"active"` \| `"removed"` |
| `name`/`email`/`emailLower`/`jobTitle`/`profileComplete`/`platformRole`/`searchText` | denormalized | Copied from `users` so the member directory (paginated, searchable via a `search_member` search index) avoids a per-row join |

**Membership sync & audit infrastructure:** `memberships`, `membershipIntents` (pending/accepted/revoked invite tracking), and the `tenants` registry (§3.7.7) are kept in sync with Clerk by a webhook handler (`POST /clerk/webhook`, HMAC/Svix-verified) reacting to `user.created/updated/deleted`, `organizationMembership.created/deleted`, `organizationInvitation.revoked`, and `organization.created/updated/deleted` events; `processedWebhookEvents` makes this idempotent. Every membership/role/invite action is additionally recorded in an append-only `authAuditEvents` log, and `orgMembershipStats` keeps denormalized per-org counts (active/admin/contributor/viewer/pending-invite) so the admin dashboard doesn't scan the full membership table.

**Conversations table change:** Add optional `userId` field (`v.id("users")`) linking conversations to authenticated users. The existing `contributorName` field is preserved as a denormalized display name.

**Auth flow:**
1. User lands on a tenant subdomain (`{slug}.bizfabric.ai`) → Clerk middleware (`src/proxy.ts`) sends signed-out visitors to that subdomain's `/sign-in`. Invitation emails link straight to the subdomain's `/sign-up` via the invitation's `redirect_url`.
2. User signs up or signs in via Clerk's prebuilt `<SignUp />` / `<SignIn />` on the subdomain. **Both** redirect to `/join-organization` afterward (not straight into the app) so the org-join handoff always runs.
3. Clerk issues a JWT → `ConvexProviderWithClerk` sends it with every Convex request → Convex validates via `convex/auth.config.ts`.
4. `/join-organization` POSTs to `/api/join-subdomain-organization`, which resolves the org from the subdomain slug and, subject to the enrollment gate (§3.7.6), adds the user to the Clerk org. Existing members pass straight through (idempotent). It then activates the org via `setActive` and syncs the Fabric profile.
5. On first authenticated visit a `store` mutation creates the `users` record (linked via `tokenIdentifier`) and a `memberships` row for the active org — role from the invite intent when present, otherwise the `contributor` default (§3.7.5).
6. If `profileComplete === false` → profile onboarding screen (Name pre-filled from Clerk, plus Job Title, Function, Department, Hire Date).
7. After completing onboarding → user accesses the main app.
8. All Convex queries/mutations require authentication via `ctx.auth.getUserIdentity()`.
9. User identity is never passed as a function argument — always derived server-side.
10. Write mutations for hierarchy create/update/delete and recording flows require `contributor` or `admin` role — enforced server-side via `requireOrgContributor(ctx)` in `convex/lib/orgAuth.ts`. Delete mutations also enforce child-data blockers server-side.
11. Admin operations such as conversation deletion, membership role changes, member removal, invitation revocation, and appearance reset require `admin` role — enforced via `requireOrgAdmin(ctx)`.
12. Frontend conditionally renders CRUD buttons, Record button, and admin features based on the active-org membership role from `getMyMembership` / org-scoped user queries.

**Packages:** `@clerk/nextjs`
**Config files:** `convex/auth.config.ts` (Clerk JWT issuer), `src/proxy.ts` (Clerk middleware)
**Current auth files:** `convex/users.ts` (user/profile and membership logic), `convex/invitations.ts` (Clerk-backed invitations), `convex/lib/orgAuth.ts` (shared active-org role helpers), `convex/lib/clerkApi.ts` (Clerk Backend API wrapper), `convex/lib/slugs.ts` (shared tenant-slug + reserved-subdomain rules), `src/proxy.ts` (Clerk middleware), `src/lib/subdomain.ts` (host → slug / console-host parsing), `src/app/sign-in/[[...sign-in]]/page.tsx`, `src/app/sign-up/[[...sign-up]]/page.tsx`, `src/app/join-organization/page.tsx` + `src/features/auth/join-subdomain-organization.tsx` (org-join handoff), `src/app/api/join-subdomain-organization/route.ts` (server-side enrollment gate, §3.7.6), `src/features/profile/profile-onboarding.tsx`, `src/features/shell/user-menu.tsx`

### 3.7 Multi-Tenancy Architecture

Fabric is a multi-tenant B2B SaaS. Every organization (Clerk "org") gets its own dedicated subdomain, sees only its own data, and manages its own members and roles. The "Biz Group" organization holds all pre-existing Fabric data and is the first tenant on the platform.

#### 3.7.1 Tenancy model

- **Clerk owns identity + org membership.** Users sign up / sign in via Clerk. Orgs are created by a super-admin through the tenant console (§3.7.7), which calls the Clerk Admin API — or, as a fallback, directly in the Clerk Dashboard (the `organization.*` webhook then mirrors them into the registry). There is no end-user self-serve org creation. Fabric calls the Clerk Admin API for invitations, pending-invite revocation, and member removal so Clerk membership and Fabric membership remain aligned.
- **Fabric owns roles.** A Convex `memberships` table stores `(userId, clerkOrgId, role)`. Fabric's three-tier role hierarchy (admin/contributor/viewer) is defined here, not in Clerk — this keeps role evolution independent of Clerk's plan tier and lets the same user hold different roles in different orgs.
- **Every tenant-scoped row carries `clerkOrgId`.** Functions, departments, processes, conversations, and processFlows each have an indexed `clerkOrgId` field. `users` stays org-agnostic (identity is global, membership is per-org).
- **Row-level authorization is enforced in every Convex function.** Reads filter by `clerkOrgId` via compound index. Writes stamp `clerkOrgId` on inserts and verify that every parent document referenced in the mutation belongs to the caller's active org (defeats ID-substitution attacks across tenants).
- **Two-layer authorization** (platform role + org role). Biz Group staff operate *above* all tenants. Regular members operate *within* a single tenant. See §3.7.2.

#### 3.7.2 Two-layer roles — Platform role + Org role

Fabric distinguishes two authorization layers that are kept strictly separate in the data model:

| Layer | Stored on | Values | Who | What it grants |
|---|---|---|---|---|
| **Platform role** | `users.platformRole` | `"superAdmin"` or absent | Saish + designated Biz Group colleagues | Create/delete orgs, run the fan-out script, access a future cross-org support dashboard, bootstrap other superadmins. Does **not** by itself grant read/write access to any tenant's data. |
| **Org role** | `memberships.role` | `admin` \| `contributor` \| `viewer` | Everyone — including superadmins | All data access within a single org. `admin` manages members + CRUD in *that org only*. |

**Access mechanism for Biz Group staff (Model A — auto-membership):** A superadmin never "bypasses" org scoping in Convex. Instead, whenever a new org is created, an `internalAction` looks up every user with `platformRole === "superAdmin"` and fans out *real* Clerk org membership + a matching Fabric `memberships` row (role `admin`) into the new org. Superadmins become first-class members of every org, their JWT carries the correct `orgId` when they visit that org's subdomain, and Clerk's `<OrganizationSwitcher />` lists every org naturally. Every Convex query continues to require a real membership row — there is no `users.platformRole`-based bypass anywhere in the data path.

**Implication:** `requireOrgMember` / `requireOrgAdmin` stay straightforward — they only consult `memberships`. A separate helper `requireSuperAdmin` exists for platform-level operations (creating orgs, managing superadmins, running fan-out). This keeps the per-request authorization code free of special cases.

#### 3.7.3 Subdomain-native routing

Production URLs take the form `{org-slug}.bizfabric.ai/<path>` (e.g. `biz-group.bizfabric.ai/admin/users`). Users never see an internal `/orgs/:slug/` path. The apex domain (`bizfabric.ai`) hosts only the marketing landing. Sign-in and sign-up are implemented as top-level routes, but they are intended to be used from tenant subdomains; apex requests to `/sign-in` or `/sign-up` are redirected back to the landing page, while signed-out visits to tenant `/` are redirected to tenant `/sign-in`.

Local development uses `lvh.me` — a public DNS name that resolves `*.lvh.me` to `127.0.0.1` — so developers visit `biz-group.lvh.me:3000` without editing their hosts file. The env var `NEXT_PUBLIC_ROOT_DOMAIN` controls the active root (`lvh.me:3000` in dev, `bizfabric.ai` in prod).

Middleware (`src/proxy.ts`) extracts the subdomain from the `Host` header and rewrites the request internally from `/<anything>` to `/<subdomain>/<anything>`, matching the Next.js `src/app/[org]/...` route tree. Users always see the subdomain-only URL in the browser; the `[org]` segment is an implementation detail. Because the org lives in the subdomain rather than the request pathname, Clerk's `organizationSyncOptions` was **removed** — its `/:slug` patterns match the pre-rewrite pathname and would misread ordinary path segments (`/sign-in`, `/processes`) as org slugs; instead `src/app/[org]/layout.tsx` performs a client-side `setActive` on initial tenant hits after authentication. The tenant auth pages themselves stay outside `[org]` so they can render branded public marketing + Clerk surfaces at `/sign-in` and `/sign-up` on each subdomain.

A set of **reserved subdomains** (`www`, `app`, `tenants`, `accounts`, `clerk`, `api`, `mail`, `admin`, `status`) can never be tenant slugs — enforced by `isValidTenantSlug` in `convex/lib/slugs.ts`, the single source of truth shared by the middleware host parsing (`src/lib/subdomain.ts`) and the tenant-creation validation. `tenants.bizfabric.ai` is carved out for the platform tenant console (§3.7.7): the middleware detects that host and rewrites into the `src/app/tenants-console/...` tree instead of `[org]`.

#### 3.7.4 Cross-org access control

- When a signed-in user visits a subdomain for an org they don't belong to, `src/app/[org]/layout.tsx` detects the missing slug ↔ membership match and renders a "You're not in this workspace yet" screen offering a **Join this workspace** action (which calls the same `/api/join-subdomain-organization` gate, §3.7.6), plus links to workspaces they already belong to and sign-out. This surface intentionally does not show a general org picker. The join attempt still passes through the enrollment gate, so it only succeeds for a domain-matched, staff, or invited user.
- The only org-switch UI inside the app is the nav-bar `<OrganizationSwitcher />`, and it is rendered only for users with more than one org membership. Single-org users never see it.
- Wrong-subdomain login is not hard-blocked before authentication. A user may complete sign-in on the wrong tenant subdomain, but app access is denied immediately afterwards unless the URL slug matches one of their org memberships.
- Every Convex function calls `requireOrgMember(ctx)` (or `requireOrgContributor` / `requireOrgAdmin`), which:
  1. Reads org context from the authenticated JWT, supporting both top-level `orgId` / `orgSlug` claims and Clerk's compact built-in `o.id` / `o.slg` claim shape.
  2. Looks up the caller's `memberships` row for that org.
  3. Returns `{ orgId, orgSlug, role }`, or throws if the user is not a member.
- The ElevenLabs audio proxy (`convex/http.ts`) is re-scoped to `/audio/:clerkOrgId/:elevenlabsConversationId`; it returns 404 on any mismatch so one org's audio can never be served from another org's URL.

**Implementation note:** Auth bootstrap changes span both the Next.js frontend and the Convex deployment. If the frontend starts querying a new bootstrap helper before Convex prod has that function, or if Convex only reads one JWT org-claim shape, tenant activation can stall on the workspace spinner even though Clerk authentication itself succeeds.

#### 3.7.5 Membership provisioning

- **Org creation** — super-admin-provisioned only, via the tenant console (§3.7.7; `tenants.createTenant`). Creating a tenant provisions the Clerk org, fans out every `superAdmin` into it as `org:admin` with a matching `memberships` row, uploads the logo, sets the enrollment domain allowlist, and optionally sends the first-user invitation. The same fan-out runs from the CLI (`fanOutSuperAdminMemberships`) or console Team page for orgs created directly in the Clerk Dashboard.
- **Regular-member provisioning** — when a user joins (via the enrollment gate, §3.7.6) and signs in for the first time, `users.store` auto-creates a `memberships` row for the active org. Role comes from the matching invite intent when the user was invited; otherwise it defaults to `contributor` (the safe default for walk-up domain-matched, webhook, and reconcile joins alike). The org admin can promote them to `admin` or demote them to `viewer` afterward.
- **Role changes** — admins promote / demote members in their own org via `setMembershipRole`, which only accepts memberships whose `clerkOrgId` matches the caller's active org. The legacy `users.role` field (pre-multi-tenant) has been retired (§3.7.9).
- **Member removal** — admins remove members through `removeMemberFromOrg`, which preflights self-removal and last-admin guards, removes the Clerk org membership first, then deletes the Fabric `memberships` row. If Clerk removal fails, the Fabric row stays in place so access cannot be silently recreated from a still-valid Clerk membership; Clerk 404 is treated as already removed and Fabric cleanup continues.
- **Pending invitations** — admins can revoke pending invitations. Resend is implemented as revoke + re-invite because Clerk does not expose a separate resend operation; if the re-invite fails after revocation, the admin must invite the person again.
- **Superadmin bootstrap** — the first platform `superAdmin` is set by the internal mutation `users.bootstrapSuperAdmin` (by email). Subsequent superadmins are promoted / demoted by an existing superAdmin via `users.setPlatformRole`.

#### 3.7.6 Enrollment & domain-gated self-join

The server-side enrollment gate lives in `src/app/api/join-subdomain-organization/route.ts` and is invoked by the `/join-organization` handoff (post sign-up/sign-in) and the "Join this workspace" screen (§3.7.4). It performs a same-origin POST check, resolves the org from the subdomain slug, and requires an authenticated user with at least one **verified** email. It then evaluates, in order:

1. **Already a member** → pass straight through (idempotent).
2. A verified email domain is in the tenant's **`allowedEmailDomains`** (Clerk org public metadata) → join.
3. A verified email domain is a **platform-staff domain** (`PLATFORM_STAFF_EMAIL_DOMAINS`, default `bizgroup.ae`) → join. This is how every Biz Group staff member gets into *any* tenant workspace without per-tenant configuration.
4. Otherwise, a **pending Clerk invitation** addressed to one of the verified emails → join. This is the escape hatch for out-of-domain externals an admin has explicitly invited.
5. None of the above → **403**, with the reason logged server-side (`email_domain_not_allowed`, `no_verified_email`, `organization_not_found`, `banned_or_locked`, …) so failures surface as logs rather than only support tickets. The schema reserves a `blockedJoin` audit action for the same purpose.

Matching only **verified** emails is what makes rules 2–4 safe: a user cannot claim a domain or an invitation for an address they don't own, because Clerk verifies email ownership. On success the user is added as Clerk `org:member`; the Fabric role is decided later at provisioning (§3.7.5) — invited users get their intent role, everyone else the `contributor` default.

A tenant with an **empty** `allowedEmailDomains` list is invite-only (plus platform staff) — the safe default for a freshly created workspace. The policy is intentionally per-tenant: `biz-group.bizfabric.ai` admits `@bizgroup.ae` only (as its own domain and as staff), whereas a client tenant admits its own domain(s) **plus** `@bizgroup.ae` staff. Domains are managed per tenant from the console (§3.7.7) or `platform.setOrgAllowedEmailDomains`, and are stored normalized (lowercased, `@`-stripped, deduped, validated against a domain pattern).

#### 3.7.7 Tenant management console (`tenants.bizfabric.ai`)

A super-admin-only platform surface for managing every tenant, served from the reserved `tenants` subdomain (§3.7.3) within the same Next.js app (`src/app/tenants-console/...`). It reuses the same Clerk session — the session cookie is scoped to the apex domain, so a staff member signed in at any workspace is already signed in here (no separate credentials). Authorization is two-layer, matching the rest of Fabric: the console layout renders an "access required" blocker unless `users.getMe` reports `platformRole === "superAdmin"`, and **every** `convex/tenants.ts` function independently re-checks `requireSuperAdmin` server-side — the layout gate is UX only.

The console is backed by the `tenants` mirror table (Clerk stays the source of truth), kept in sync three ways: the `createTenant` action, the `organization.created/updated/deleted` webhooks (so orgs created directly in Clerk still appear), and the `backfillTenantsFromClerk` CLI backfill (run once at rollout, since existing orgs predate the mirror). Member/admin/pending counts prefer the denormalized `orgMembershipStats` row and fall back to a live count when it is absent (tenants that predate the stats row, or were created directly in Clerk); the backfill also materializes those rows so the fast path applies going forward.

**Screens:**
- **Tenants list** — every workspace with logo, name, slug (linking to the subdomain), member/admin/pending-invite counts, allowed domains, and provisioning status.
- **New-tenant wizard** — client name; an auto-derived, live-validated, immutable slug (checked against the reserved list); allowed email domains; an optional logo upload; and an optional first user with a role picker (admin/contributor/viewer) invited via the standard Clerk email. It runs the provisioning steps in §3.7.5; non-fatal failures surface as a retryable "provisioning incomplete" panel rather than blocking creation.
- **Tenant detail** — rename (display name only — the slug is immutable from the console; change it directly in Clerk if ever truly needed), replace logo, edit allowed email domains, send / revoke invitations, and a read-only member list.
- **Platform team** — list super-admins; promote (look up an existing Fabric account by email, flip `platformRole`, then auto-fan-out into every tenant) / demote (blocked for self); and a manual "sync access to all tenants" action.

Provisioning is idempotent and step-wise: `createTenant` records any per-step failures on the tenant row (`status: "needsAttention"`, `provisioningErrors[]`), and `retryProvisioning` safely re-runs the failed steps (staff fan-out, logo upload, first-user invite). The logo `storageId` and first-invite details are retained on the row so retries have what they need.

#### 3.7.8 Data migration (Biz Group) — complete

The existing Fabric deployment held real data for Biz Group. Migration followed the widen-migrate-narrow pattern using the `@convex-dev/migrations` component, and **the schema-level narrow step is done**: `convex/schema.ts` now declares `clerkOrgId: v.string()` (required) on every tenant-scoped table (`functions`, `departments`, `processes`, `conversations`, `processFlows`), with only compound `by_clerkOrgId_and_*` indexes — no optional `clerkOrgId` and no legacy single-field indexes remain.

1. **Widened:** added `clerkOrgId` plus compound indexes on every tenant-scoped table.
2. **Migrated:** created the Biz Group org in Clerk, seeded a `memberships` row per existing Fabric user, backfilled `clerkOrgId` on every pre-existing row (`convex/migrations.ts`: `backfillFunctionsOrg`/`backfillDepartmentsOrg`/`backfillProcessesOrg`/`backfillConversationsOrg`/`backfillProcessFlowsOrg`, verified via `verifyOrgBackfill`).
3. **Narrowed:** the validator is `v.string()` and the old non-tenant-scoped indexes are gone, per the schema above.

`convex/migrations.ts` and `convex/orgIntegrity.ts` (`auditHierarchyIntegrity`, `repairHierarchyOrphans`, `auditAllOrgs`) remain in the codebase as ongoing ops tooling — CLI-invoked auditing/repair for tenant data — not as an active in-flight migration. `convex/migrations.ts` also carries a separate, reusable dev→prod tenant-move pipeline (`exportForOrg` → `prodImportGenerateUploadUrl` → `prodImportFromStorage` → `prodImport_insertAll`) used for moving an org's hierarchy between Convex deployments. The full phased plan is tracked in [TASK_LIST.md](TASK_LIST.md) Phase 13 — note that document was last substantially updated before several features in this PRD shipped, so treat its checkboxes as historical rather than a live status board.

#### 3.7.9 Packages, config, and new files

- **Packages:** `@convex-dev/migrations` (schema migration helper), `@clerk/nextjs` (Clerk Organizations features enabled).
- **Config:** `convex/convex.config.ts` registers the migrations component. `convex/auth.config.ts` unchanged. Clerk's `convex` JWT template carries `orgId` and `orgSlug` claims. `CLERK_SECRET_KEY` is present in Convex env so the fan-out action, tenant provisioning, and invitation management can call the Clerk Admin API. The Clerk webhook must subscribe to `user.*`, `organizationMembership.*`, `organizationInvitation.revoked`, **and** `organization.created/updated/deleted`, with `CLERK_WEBHOOK_SIGNING_SECRET` set in Convex env. Invitation emails must be enabled and sign-up mode set to Public in Clerk.
- **Env:** `NEXT_PUBLIC_ROOT_DOMAIN` / `ROOT_DOMAIN` (dev: `lvh.me:3000`, prod: `bizfabric.ai`); `PLATFORM_STAFF_EMAIL_DOMAINS` (comma-separated, default `bizgroup.ae`) — the domains whose verified emails may join every tenant (§3.7.6).
- **Files (multi-tenancy core):** `convex/convex.config.ts`, `convex/migrations.ts`, `convex/lib/orgAuth.ts`, `convex/lib/clerkApi.ts`, `convex/lib/slugs.ts` (slug + reserved-subdomain rules), `convex/platform.ts` (superAdmin mutations, fan-out, domain-allowlist actions, `findUserByEmail`), `convex/invitations.ts`, `convex/orgIntegrity.ts`, `src/lib/subdomain.ts`, `src/proxy.ts`, `src/app/[org]/layout.tsx`, `src/app/[org]/page.tsx` (and the rest of the protected tree under `[org]`).
- **Files (enrollment gate, §3.7.6):** `src/app/api/join-subdomain-organization/route.ts`, `src/app/join-organization/page.tsx`, `src/features/auth/join-subdomain-organization.tsx`.
- **Files (tenant console, §3.7.7):** `convex/tenants.ts`, `src/app/tenants-console/{layout,page}.tsx`, `src/app/tenants-console/new/page.tsx`, `src/app/tenants-console/[tenantId]/page.tsx`, `src/app/tenants-console/team/page.tsx`, `src/features/tenants-console/{tenant-url,tenant-invitations,logo-file-button}.tsx`.
- **Schema additions:** `users.platformRole: v.optional(v.literal("superAdmin"))` plus `by_platformRole` index; the `tenants` table (§3.2) with `by_clerkOrgId` and `by_slug` indexes; `tenants.allowedEmailDomains` in Clerk org public metadata backs the enrollment gate.
- **Retired:** `convex/lib/auth.ts` no longer exists, and the legacy `users.role` field is absent from the schema — both confirmed retired. Clerk's `organizationSyncOptions` was removed from `src/proxy.ts` (§3.7.3).

### 3.8 Org Branding / Appearance

Admins can customize their org's accent color and chart colors, applied live across the workspace via CSS custom properties. This is a distinct admin-facing feature from multi-tenancy/RBAC and lives at `/[org]/admin/appearance`.

- **Generation:** an admin can generate a candidate theme from the org's Clerk logo (server-side color extraction) or enter a manual hex accent color. `src/features/theming/logo-theme.ts` extracts a representative RGB from the logo; `src/features/theming/themeColors.ts` derives a full token set (`accent`, `accentForeground`, `subtle`, `border`, `ring`, `selected`, `selectedForeground`, `chart1`–`chart5`, in both light and dark variants) from that RGB using OKLCH color math with contrast-ratio-aware adjustment, so generated accents stay legible against text/backgrounds.
- **Candidate/active split:** a generated or manually-entered theme is stored as a **candidate** (`orgThemes.candidate*` fields) and previewed against mock UI before an admin explicitly **approves** it into the **active** theme (`orgThemes.active*` fields, `adminApprovedAt`/`approvedByUserId`). Rejecting a candidate discards it without touching the active theme. Nothing goes live without an explicit approval step.
- **Reset:** an admin can reset the org back to the neutral default theme (confirmation-gated, per §13 deletion-hardening conventions).
- **Backend:** `convex/orgThemes.ts` (`getForCurrentOrg`, `getThemeAdminState`, `startThemeGeneration`, `saveGeneratedCandidate`, `saveManualCandidate`, `approveCandidateTheme`, `rejectCandidateTheme`, `markThemeGenerationFailed`, `resetToNeutral`), backed by the `orgThemes` table (§3.2).

---

## 4. Agent System Prompt (Base)

The following is the base system prompt configured on the ElevenLabs platform. **[UNVERIFIED]** — this prompt lives in ElevenLabs' dashboard, not in this repository, so it could not be checked against the live agent configuration during this reconciliation; treat it as a reference copy that may drift from what's actually configured. Dynamic context is injected at session start via `dynamicVariables` passed to `startSession()`, which fill `{{placeholder}}` templates in the agent's prompt and first message. The `{{system__time_utc}}` variable is an ElevenLabs built-in template variable resolved by the platform automatically. See [ELEVENLABS_SETUP.md](ELEVENLABS_SETUP.md) for full platform configuration instructions.

```
# Personality

You are Fabric — a calm, intelligent, and genuinely curious process interviewer.
You behave like a thoughtful colleague rather than a formal auditor.
You are excellent at active listening: you acknowledge what people say, reflect it back briefly, and then ask meaningful follow-up questions.

You are non-judgmental, never interrupt, and never rush the speaker.
You value practical, lived experience over polished or theoretical answers.

Your role is not to evaluate performance, but to surface tacit knowledge — the things people do instinctively, the shortcuts they've learned, and the context behind their decisions about this process.

# Environment

You are conducting a one-to-one, voice-based interview using ElevenLabs.
The setting should feel like a private, informal conversation — similar to a relaxed internal podcast or knowledge-sharing chat.

There is no audience, no recording pressure, and no "right" or "wrong" answers.
The interviewee should feel safe to think out loud, pause, or correct themselves.
The current time is {{system__time_utc}}.

You are not constrained by time, but you should keep the conversation flowing naturally and purposefully.

# Tone

Use a warm, conversational, and human tone at all times.
Speak clearly and at a moderate pace, leaving space for pauses and reflection.

Avoid corporate jargon, buzzwords, or overly complex language.
If the interviewee uses informal language, mirror it slightly to build rapport.

Encourage depth gently with phrases like:
- "That's interesting — can you tell me a bit more about that?"
- "What usually happens next?"
- "How do you decide when to do that?"
- "And what happens when that goes wrong?"

Never sound robotic, rushed, or scripted.

# Goal

You are interviewing an employee about one specific business process. Your primary goal is to extract high-quality, reusable knowledge about how this process actually works — from the perspective of the person doing it — so it can contribute to a shared organisational knowledge base.

You will receive dynamic context at the start of each session telling you:
- Who you are speaking with (contributor name)
- Which process the conversation is about (e.g., Finance > Payroll > Compensation)
- What is already known about this process (existing rolling summary from prior conversations)
- What this specific contributor has said before (if they have prior conversations)

Use this context to avoid retreading ground. If prior knowledge exists, acknowledge it and probe for what's missing, different, or deeper.

Specifically, aim to uncover:
- The concrete steps involved in this process, in order
- How the interviewee approaches each step day-to-day
- Decisions they regularly make and how they make them
- Tools, systems, or workflows they rely on
- Dependencies — who or what they wait on, hand off to, or coordinate with
- How often this process runs (daily, weekly, monthly, ad-hoc)
- Common problems, edge cases, and how they handle them
- Tips, shortcuts, heuristics, or "unwritten rules" they've learned
- Knowledge that would be hard to find in documentation

Prioritise how and why, not just what.

Ask follow-up questions to:
- Clarify vague answers
- Turn abstract ideas into concrete examples
- Surface assumptions the interviewee may not realise they have
- Identify gaps or handoffs between people or teams

When the interviewee seems done, summarise back what you heard — the key steps, tools, dependencies, and any pain points — and ask if anything was missed or if they'd correct anything. This confirmation step is important for accuracy.

# Important Reminder (delivered at the start of every conversation)

After greeting the contributor, always deliver this reminder naturally — not as a legal disclaimer, but as a friendly heads-up woven into your opening:

- This conversation is about how the process works — the steps, tools, and handoffs involved.
- Please avoid sharing sensitive information such as specific salaries, personal situations, confidential business outcomes, or negative comments about individuals.
- Focus on what you do and how you do it, not the results or outcomes of the process.

Deliver this warmly and briefly. Do not read it like a script. For example:
"Before we dive in, just a quick note — we're here to talk about how the process works, the steps and tools involved. There's no need to share any sensitive details like specific numbers, personal situations, or anything confidential. Just focus on what you do and how you do it. Sound good?"

# Guardrails

If the interviewee sounds uncomfortable, stressed, or hesitant:
- Slow down
- Reassure them that this is informal and optional
- Offer to change the topic or move on

If they ask what the information will be used for:
- Explain calmly that it is to help capture collective knowledge about how this process works and improve how the team works together
- Reassure them that this is not a performance review

If they share sensitive content (specific salaries, personal situations, confidential outcomes, negative comments about individuals):
- Do not acknowledge, repeat, or store the sensitive detail
- Gently redirect: "I appreciate you sharing that — for our purposes, let's focus on the steps and how the process flows rather than specific figures or outcomes."
- If it continues, remind them warmly: "Just a reminder, we're really just looking at how things work, not the specifics of what comes out of it."

If they drift into sensitive, confidential, or personal territory more broadly:
- Gently steer the conversation back to general practices or anonymised examples
- Do not probe further into restricted or personal areas

If they give very short or surface-level answers:
- Use gentle probes ("Can you walk me through a recent example?")
- Avoid pressuring or interrogating

If the conversation goes off-topic:
- Acknowledge what was said
- Smoothly guide it back to the specific process being discussed

Always prioritise:
- Psychological safety
- Consent
- Respect for time and boundaries

End the interview on a positive note, thanking them sincerely for sharing their knowledge.

# Tools

None

[DYNAMIC CONTEXT INJECTED AT RUNTIME VIA useConversation OVERRIDES]
- Contributor: {{contributor_name}}
- Process: {{function_name}} > {{department_name}} > {{process_name}}
- What we already know about this process: {{existing_process_summary}}
- Previous conversations from this contributor: {{prior_contributor_summaries}}
```

---

## 5. Key Screens & Wireframe Descriptions

### Screen 1: Main View (Tree Sidebar + Workbench)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ 🔍 Search functions, departments, or processes...                    Ctrl K   [biz] ⚙ 👤 │
├─────────────────────────────────┬──────────────────────────────────────────────────────────┤
│ [▤] [🔀] [⚙]                    │ Learning Technology (LT) › Axonify › Axonify Tenant Req. │
│                                  │                     [🎙 Start AI interview ▾] [↗Share][•••]│
│ Process Tree           [+ Add]  │                                                          │
│                                  │ Axonify Tenant Request                                  │
│  ▾ Learning                  3  │ 👤 Saish Gaonkar · Updated 24d ago                       │
│  ▾ Learning Technology (LT)  4  │ ┌────────────────┬──────────────────┬─────────────┬─────────┐│
│    ▾ Axonify                2  │ │ Process Summary│ Conversations (2)│ Process Flow│ Insights││
│      ⚙ Axonify Support Tick. 2 │ └────────────────┴──────────────────┴─────────────┴─────────┘│
│      ⚙ Axonify Tenant Req. ●2  │                                                          │
│    ▸ AI Transformation      1  │ [All conversations ▾]  [All types ▾]  [Newest first ▾]     │
│    ⬡ LaaS                       │ ┌───────────────────────┐  ┌─────────────────────────────┐│
│    ⬡ LT Solutions               │ │▶ AI Interview—Saish G.│  │↺ ▶ ↻ ▬▬▬▬▬▬▬▬▬▬▬ 1:49  ⚙  ⬇ ││
│  ▸ Teambuilding (TB)         2  │ │ ✓ Completed           │  │                             ││
│  ▸ Shared Services           5  │ │ Jun 8, 10:43 AM  1:49 │  │ Summary                     ││
│                                  │ ├───────────────────────┤  │ The agent, Fabric, initiated││
│                                  │ │▶ AI Interview—Saish G.│  │ a discussion with Saish     ││
│                                  │ │ ✓ Completed           │  │ Gaonkar about the Axonify   ││
│                                  │ │ Jun 5, 1:23 PM   2:37 │  │ Tenant Request process...   ││
│                                  │ └───────────────────────┘  │ Transcript      9 entries   ││
│                                  │                             │ Fabric — Hi Saish Gaonkar, ││
│                                  │                             │ I'm Fabric. Let's talk...  ││
└──────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

`●` marks the currently selected process. `▾`/`▸` are expand/collapse carets on Functions and Departments; the layered icon marks a Department, the gear marks a leaf Process. Departments with no processes yet (LaaS, LT Solutions) show no caret or count badge.

The far left is a slim icon rail (sidebar collapse, process tree, an integrations/graph view, settings). Next to it, the **Process Tree** panel holds the nested, expandable Function → Department → Process tree (not three parallel columns), with a conversation-count badge per row and an `Add` button for creating new items. The main workbench shows the breadcrumb, process title, a split "Start AI interview" action (the `▾` reveals the other capture modes — Voice Record, Audio Upload), Share, and an overflow menu, followed by the four-tab bar (Process Summary, Conversations, Process Flow, Insights). The screen above shows the **Conversations** tab, which splits further into a filterable conversation list and a detail pane (audio player, Summary, Transcript) for whichever conversation is selected.

### Screen 2: Recording Modal (ElevenLabs UI Components)

The recording modal is built entirely from ElevenLabs UI components (which are shadcn/ui-based):

```
┌────────────────────────────────────────────────────────┐
│ Learning Technology (LT) › Axonify › Axonify Tenant  ✕ │  ← shadcn Breadcrumb + close
│ Request                                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│                                                         │
│                        ◉ (Orb)                         │  ← ElevenLabs UI: Orb
│                                                         │     (audio-reactive; no
│                                                         │      separate waveform bar
│                                                         │      is shown alongside it)
│                                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Hi Saish Gaonkar, I'm Fabric. Let's talk about how    │  ← ElevenLabs UI: Message
│  Axonify Tenant Request works. Before we dive in,      │     rendered as plain text,
│  just a quick reminder — we're here to talk about      │      chat-bubble.
│  how the process works, the steps and tools            │     The agent's opening line
│  involved. Let's avoid discussing sensitive details     │     (with the recording
│  like personal situations, or anything confidential.    │     reminder woven in) shows
│  Sounds good?                                           │     first; the user's reply
│                                                         │     appends below via
│                                                         │     onMessage once they speak.
│                                                         │
├─────────────────────────────────────────────────────────┤
│              (🎤)      (⌨)      [✂ End Call]            │  ← mic mute toggle, reveal
│                                                         │     text-input fallback,
│                 🟢 Listening...                         │     ElevenLabs UI: VoiceButton
└─────────────────────────────────────────────────────────┘
```

Alternatively, the entire modal can use the **Conversation Bar** component, which bundles mic controls, text input, and waveform into a single pre-built interface.

### Screen 3: Post-Call Review

```
┌──────────────────────────────────┐
│   ✅ Conversation Recorded        │
│                                  │
│   Summary:                       │
│   "Sarah described the monthly   │
│    salary calculation process..." │
│                                  │
│   ▶ View Full Transcript         │
│                                  │
│   [Done]                         │
└──────────────────────────────────┘
```

---

## 6. POC Scope & Boundaries

### In Scope (Phase 1 — POC)

- Tree-sidebar navigation (nested, expandable Function → Department → Process) plus a Ctrl/Cmd+K command palette, built with **shadcn/ui** components
- **Responsive layout** — tree sidebar + tabbed workbench on desktop; stacked drill-down navigation on mobile/tablet (collapse to single-column with back navigation)
- **Org hierarchy CRUD** — contributors and admins can create, rename, move, and delete eligible functions, departments, and processes directly from the tree sidebar via row-level add/rename/delete menus. Deletion is non-cascading: functions with departments, departments with processes, and processes with conversations are blocked until child data is removed.
- **Move / reparent** — departments can be moved to a different function, and processes can be moved to a different department (including across functions) via the edit modal, which includes a location dropdown. When a process or department is moved, summaries on both old and new parents are marked stale. If the old parent has no remaining processes with summaries, its department summary is cleared automatically
- **Non-destructive hierarchy repair** — if orphaned departments or processes are detected in Convex, Fabric reattaches them to recovery parents instead of deleting the affected records. Existing process ids stay stable, so attached conversations and process flows are preserved.
- **English only** for POC (ElevenLabs agent language set to `"en"`)
- **User authentication** — Clerk with prebuilt sign-in/sign-up UI, Convex JWT validation, auth gates on all Convex functions, user profiles with organizational attributes (Job Title, Function, Department, Hire Date), required profile onboarding on first login, Clerk `<UserButton />` in header (Phase 5)
- **Role-based access control** — three roles (admin, contributor, viewer) stored in Convex `memberships` per Clerk org. Admin: full org access, member/invitation management, admin conversation deletion, appearance reset, hierarchy CRUD, recording, viewing. Contributor: eligible hierarchy CRUD, recording, view summaries. Viewer: browse hierarchy and view summaries only (no CRUD, no recording). Role enforcement on both backend (server-side guards on mutations/actions) and frontend (conditional UI rendering). (Phase 12/13)
- ElevenLabs voice agent integration via `@elevenlabs/react` SDK with dynamic context injection
- Direct **Voice Record** mode for live browser recordings and **Audio File Upload** mode for pre-existing audio files (Zoom exports, voice memos, etc.), both using ElevenLabs Scribe diarized transcription and a speaker-labeling review before analysis. Voice Record and Upload share the same Convex Storage + Scribe pipeline; the only difference is the byte source. Upload validates `audio/*` MIME type with a 100 MB client-side cap.
- Recording UI using **ElevenLabs UI** components (Orb, Conversation, Message, Waveform, Voice Button)
- **Combined contributor name + consent step** — the recording modal opens to a single step that auto-fills the contributor's name from the authenticated user profile and surfaces the recording notice + content guidelines inline. The primary action button doubles as both name-submit and consent-accept, requesting microphone access (Voice Record / AI Interview) or opening the file picker (Audio File Upload) on click.
- AI interview post-call transcript and summary retrieval via ElevenLabs Conversations API (summary provided by ElevenLabs — no extra LLM call)
- **Speaker labeling before analysis** — Voice Record and Audio File Upload pause at `needs_speaker_labels`; contributors assign names and optionally link speakers to org members before conversation summary, process summary, or process-flow extraction runs.
- **Abandonment cleanup** — closing the modal before speaker labels are approved deletes both the Convex Storage audio object and the conversation row so half-processed inputs aren't retained. The server only permits the row owner or an org admin to abandon unfinished `voiceRecord` / `audioUpload` rows.
- **Post-call loading state** — ShimmeringText "Processing your conversation..." while AI interview analysis or direct-recording transcription completes, transitioning to post-call review or speaker-labeling review
- Process-level rolling summaries via Claude Haiku through Microsoft Foundry, plus Voice Record / Audio File Upload conversation-level analysis after speaker labels are confirmed
- ElevenLabs Conversation Analysis (Success Evaluation + Data Collection) configured on platform for AI interviews
- Conversation log per process (contributor name, date, summary, transcript, structured analysis)
- **Audio playback** — AI interviews stream from ElevenLabs through the org-scoped Convex audio proxy; Voice Record and Audio File Upload audio stream from the retained Convex Storage blob through the same signed proxy.
- **Process Summary Box** — prominent, always-visible summary card per process synthesizing all completed conversations
- **Empty states** — friendly prompts when a process has no conversations, a department has no processes, etc.
- Process-level rolling summary (auto-regenerated after each completed conversation)
- **Persistent department and function summaries** — stored in the database with staleness tracking (`summaryStale` flag) and "Last refreshed" timestamps (`summaryUpdatedAt`). Generated on-demand via the Foundry Claude deployment, with token efficiency guards that skip LLM calls when no new data exists. Function summaries built from department summaries (proper hierarchy) with cascade generation for missing departments.
- **Microsoft Foundry inference platform** — all Fabric-owned LLM call sites route through the shared provider adapter; development uses the separate `fabric-foundry-dev-se` environment, and production uses the separately keyed `fabric-foundry-prod-se` environment after the staged cutover. OpenRouter remains only as a temporary production rollback path during the soak period (§3.4).
- Convex built-in reactivity for live UI updates
- **Error handling for disconnects** — graceful UI for `onDisconnect` with reason `"error"`, with retry prompt
- **Admin retry for failed recordings** — Voice Record / Audio File Upload conversations that fail transcription or analysis can be retried by an admin from Admin → Conversations, resuming from the failed stage (§2.3, §3.3.4a)
- **Admin Console** (`/[org]/admin`) — Overview stats, org-wide conversation log with filtering/search/CSV export/retry, member management (invite/role-change/remove), and org appearance settings, across four dedicated sections (§2.4)
- **Process Insights tab** — derived analytics (handoffs, tool usage, bottlenecks, automation candidates, tribal-knowledge risk, decision branches, evidence coverage) computed from the generated process flow (§2.2)
- **PDF export** — client-side, on-demand process report generation (§2.2)
- **Org branding / appearance** — admin-configurable accent/chart colors generated from the org's logo or entered manually, with a candidate/approve workflow (§3.8)
- **Description safety screening** — Function/Department/Process descriptions are AI-screened for prompt-injection risk before being persisted or shown to the interview agent (§3.4a)
- **PWA / offline support** — installable web app manifest and a service worker providing an offline fallback page and cache-first static assets
- Simple, clean single-page UI (Next.js + Tailwind + shadcn/ui)

### Out of Scope (Phase 2+)

- ~~Role-based access control (admin, contributor, viewer roles)~~ → **Moved to Phase 1 (see section 3.6)**
- Contributor self-service conversation deletion / editing
- ~~Admin UI for managing the org hierarchy (bulk import/export, admin dashboard)~~ → **Admin dashboard moved to Phase 1 (see above and §3.5)**. Bulk import/export of the hierarchy itself (functions/departments/processes) remains out of scope — only the conversation log has CSV export today.
- Semantic search and Q&A over captured knowledge ("Ask Fabric")
- Onboarding flows for new joiners (vision-level knowledge-base onboarding for new hires — distinct from the Phase 1 profile-completion step at sign-up, which already exists)
- Integrations (Slack, Teams, email digests)
- ~~Multi-tenant / multi-organization support~~ → **Moved to Phase 13 (see section 3.7)**
- Multi-language support (Arabic, auto-detect, etc.)
- Long-term local archiving of AI interview audio beyond ElevenLabs retention
- Mobile-native app (iOS / Android) — a PWA is available (see In Scope above), but there is no native iOS/Android app

> **Undocumented feature — review note:** a "profile edit" dialog component (backed by the existing `users.updateProfile` mutation) exists in the codebase but is not rendered anywhere in the app today, so users cannot currently self-edit their profile after onboarding. This may be an intentional pause on a half-shipped feature, or simply not yet wired up — worth a product decision on whether to finish exposing it or remove it, rather than treating "self-service profile editing" as either shipped or explicitly out of scope.

---

## 7. Success Criteria (POC)

1. A user can navigate the org hierarchy in three clicks (desktop) or three taps (mobile).
2. A user can initiate a voice conversation with the ElevenLabs agent from any process.
3. A consent notice is shown before the first recording.
4. The agent conducts a coherent, contextual interview about the selected process.
5. After the call, a transcript and summary are visible in the UI, with audio available for playback.
6. A user can submit a direct voice recording or upload a pre-existing audio file, label diarized speakers before analysis, and see confirmed speaker names in the transcript, summary inputs, and process-flow inputs.
7. A user can play back any historical conversation directly from the process detail panel.
8. Multiple conversations from different contributors accumulate under a single process.
9. A synthesized process summary box is visible at the top of each process and updates with each completed conversation.
10. The app is usable on mobile viewports (stacked navigation) and desktop (tree sidebar + tabbed workbench).
11. Only authenticated users can access the app. Users can sign up, sign in, complete a profile with organizational attributes, and sign out. Conversations are linked to authenticated user identities.
12. Viewers can browse the hierarchy and view summaries but cannot create/edit/delete items or record conversations. Contributors can do everything viewers can plus eligible hierarchy CRUD and recording. Admins can do everything contributors can plus manage members/invitations, delete retained conversations from Admin → Conversations, and reset workspace appearance.
13. Hierarchy deletion is role-aware and non-cascading: viewers see a permission blocker, contributors/admins cannot delete parents with child records, and a process with conversations cannot be deleted until an admin removes those conversations.
14. Admin conversation deletion keeps derived data consistent: deleting a completed conversation force-refreshes or clears the process summary as appropriate, marks or deletes the process flow, and updates parent summary staleness; deleting non-completed rows does not trigger summary regeneration.
15. Each Clerk organization is accessed via its own subdomain (`{slug}.bizfabric.ai` in prod, `{slug}.lvh.me:3000` in dev). A user signed into Org A cannot read or write Org B's data — every Convex function enforces row-level `clerkOrgId` scoping, and a wrong-subdomain visit surfaces the no-access workspace screen instead of the app. The only in-app org switch UI is the nav-bar `<OrganizationSwitcher />`, shown only to users with more than one org membership. The ElevenLabs audio proxy is org-scoped and returns 404 on any cross-org request.
16. Every Fabric-owned LLM workflow uses the shared AI adapter and can run on Microsoft Foundry without changing its product-level prompt, output contract, or call site. Synthesis uses Claude Haiku 4.5, description safety uses GPT-5 nano, and GPT-5 mini is not activated for synthesis without a golden-set quality decision.
17. Development and production Foundry environments use separate accounts and keys. Secrets exist only in their respective Convex deployments; no Foundry key is exposed in the frontend, `.env.local`, logs, or source control.
18. Before production cutover, all three production deployments pass direct smoke tests and the prepared application golden set passes for safe/blocked descriptions, incremental/full process summaries, department/function summaries, labeled voice analysis, and process-flow generation. The provider can be rolled back by changing `AI_PROVIDER` while the rollback key is retained.
19. AI telemetry records provider, model/deployment, latency, finish reason, token usage, request ID, and retry/error classification without logging prompt or response content.
20. Existing records with `analysisProvider: "fabric-openrouter"` remain readable after cutover, while newly analyzed Voice Record / Audio Upload rows persist `analysisProvider: "fabric-foundry"`; no data backfill is required.

---

## 8. Phase 1 Considerations & Risks

### 8.1 Technical Risks

**Polling timeout on `fetchConversation`:**
After `onDisconnect`, the Convex action polls the ElevenLabs API every ~2 seconds until status = `done`. ElevenLabs processing (transcript + analysis) can take 10-30+ seconds.
**Mitigation:** Add a max-retry counter (e.g., 30 retries × 2s = 60s). If still `processing`, insert a record with `status: 'processing'` — Convex reactivity will auto-update the frontend via `useQuery` when the record's status eventually changes to `done`. Alternatively, switch to the webhook path for production.

**Concurrent recordings on the same process:**
Two people could record simultaneously for the same process. The ElevenLabs agent handles this fine (separate `conversationId` per session), but `regenerateProcessSummary` could fire twice near-simultaneously, causing a race condition on the `processes.rollingSummary` field.
**Mitigation:** For POC, accept last-write-wins — the second call will include both conversation summaries anyway. For production, add a debounce mechanism.

**ElevenLabs API key security:**
The `agentId` can be public (it's passed to the frontend SDK), but the `xi-api-key` needed by `fetchConversation` and `getAudio` to call the ElevenLabs API must never be exposed client-side.
**Mitigation:** Store the API key exclusively in Convex environment variables (set via `npx convex env set`). The frontend never calls the ElevenLabs API directly — it always goes through Convex server functions (for both data retrieval and audio streaming).

**Foundry Global Standard data routing:**
The Foundry accounts and model deployments are created in Sweden Central, but the approved Global Standard SKU can process inference in other Azure regions. Resource location is therefore not a guarantee of Sweden-only or strict EU data-zone processing.
**Mitigation:** Treat global routing as an explicit consulting-workload assumption. Before onboarding a client with contractual or regulatory residency requirements, complete a data-residency review and move eligible OpenAI deployments to an approved Data Zone SKU; do not claim Sweden-only inference while Global Standard is active. Claude Haiku 4.5 availability must be reassessed independently because its supported SKUs may differ.

**Foundry capacity and shared quota:**
Global Standard capacity governs deployment throughput rather than model quality. Development and production have different deployment capacities, but because both accounts are in the same subscription, region, and model families, they draw from shared quota pools.
**Mitigation:** Monitor throttling and quota headroom by model, keep the idempotent deployment script's quota preflight, and request quota increases before raising production capacity. Use a separate subscription only if hard quota isolation becomes necessary.

**Model retirement and behavioral drift:**
Pinned model versions improve repeatability but have platform retirement dates, and a replacement model can alter summary quality, tool output, or safety classifications.
**Mitigation:** Begin the GPT-5 mini synthesis evaluation by **2026-09-20**; move off Claude Haiku 4.5 version `2` before **2026-11-19**; review the safety model by **2026-12-08** and move off GPT-5 nano `2025-08-07` before **2027-02-06**. Use blue/green deployments and the prepared golden set for every version change.

**Production provider cutover:**
The production Foundry resources, model deployments, separate key, Convex settings, and direct smoke tests are complete, but application traffic still uses OpenRouter. A provider switch can expose protocol or output differences that direct endpoint smoke tests do not cover.
**Mitigation:** Deploy the provider-adapter code with `AI_PROVIDER=openrouter`, run the production golden set, explicitly approve the switch to `foundry`, monitor a seven-day soak, and keep one-setting rollback available throughout. Remove the production OpenRouter key only after the soak succeeds.

### 8.2 UX Considerations

**Contributor name input:**
With authentication (Phase 5), the contributor name dialog is pre-filled from the authenticated user's Clerk profile (`user.firstName + user.lastName`). A shadcn Dialog still appears when the user clicks "Record a Conversation" to allow override — but the default is the user's real name. The name is passed as `userId` in `startSession()`, stored on the conversation record as `contributorName`, and the authenticated user's `userId` is also stored for identity linking.

**Post-call loading state:**
After the user ends the call, there's a 10-30 second processing window. The UI must not feel broken during this gap.
**Design:** Show a post-call screen with ShimmeringText ("Processing your conversation...") and the ElevenLabs Orb in a subtle idle animation. When the data lands (via Convex reactivity), transition to the summary + transcript + audio player view.

**Speaker-labeling review for Voice Record and Audio File Upload:**
Both contributor-owned audio modes have an intermediate state after transcription and before analysis. The UI should show the retained audio, sample transcript lines per diarized speaker, a free-text name input, and an optional org-member selector. The recording must remain visible in the process conversation log with `needs_speaker_labels` status so a contributor can resume labeling later. Analysis, rolling summaries, and process-flow generation should not consume the recording until labels are submitted. If the contributor closes the modal before approving labels, the `abandonVoiceRecording` mutation removes the storage object and the conversation row so abandoned inputs aren't retained. The server allows only the row owner or an org admin to perform this cleanup and refuses finalized rows.

**Empty states:**
Every level of the hierarchy needs a zero-data state. Process with no conversations: "No conversations yet — be the first to record how this process works." Department with no processes: "No processes defined yet." These should feel inviting, not empty.

**Responsive / mobile layout:**
The tree sidebar + workbench split doesn't work on narrow screens. On viewports below ~768px, collapse to a stacked drill-down pattern: tap a Function → full-screen list of Departments → tap a Department → full-screen list of Processes → tap a Process → full-screen Process Detail. Back button at each level. The recording modal works the same on all screen sizes.

**Error recovery on disconnect:**
The `onDisconnect` handler receives a `reason` field: `"user"`, `"agent"`, or `"error"`. For `"error"`, show a friendly message: "Something went wrong with the connection. If your conversation was long enough, it may still have been captured — check back in a minute. Otherwise, try again." Don't just silently close the modal.

### 8.3 Operational Considerations

**ElevenLabs pricing tier:**
AI interview Conversation Analysis (Success Evaluation, Data Collection, transcript summary) is an ElevenLabs platform feature. Confirm which ElevenLabs plan includes these capabilities — they may not be available on the starter/free tier. Budget accordingly for POC.

**Privacy and consent:**
Even for an internal POC, employees are being recorded (or uploading recordings of) describing their work. A simple consent notice appears inline on the first step of the recording modal — "Recording notice" + "Content guidelines" cards rendered next to the contributor name input — so the contributor sees them before the mic is requested or the file picker opens. One-line banner pattern, not a legal wall. Mode-specific wording (recording vs. uploading) keeps the notice accurate for each capture path.

**Seed data for demo:**
The org hierarchy needs to be realistic for the POC to land well. Create a Convex seed script as part of the build with 3-4 functions, 2-3 departments each, and 2-4 processes per department. Pre-populate 1-2 sample conversations with mock summaries so the UI doesn't look empty on first load.

**Cascade summary generation limits:**
When generating a function-level summary, if child departments are missing summaries, the action auto-generates them first. A function with many departments (10+) could hit Foundry throughput limits or Convex's 10-minute action timeout during cascade generation. For POC, sequential generation is acceptable. For production, fan out via `ctx.scheduler.runAfter` per department and poll for completion.

**Summary staleness and token efficiency:**
Department and function summaries are persistent and include a `summaryStale` flag. When no new recordings or structural changes have occurred, the generate action returns the existing summary without an LLM call — avoiding unnecessary token spend. The `forceRefresh` flag allows manual override when the user wants to regenerate regardless. First-time UX: all existing departments and functions will show "No summary yet" since `summary` starts `undefined` on existing docs — this is expected behavior for the new feature rollout.

**Incremental process summaries and token cost:**
Process-level summaries use an incremental approach: the first conversation's full transcript produces the initial structured summary; each subsequent conversation sends only the *existing rolling summary + new transcript*. This keeps per-call token cost roughly constant regardless of conversation count, but means the summary is a lossy compression — early conversations are represented only through the rolling summary, not their raw transcripts. A `forceRefresh` flag triggers a full regeneration from all transcripts when needed (at higher token cost). The structured output format (markdown with sections and citations) requires `max_tokens: 8192` to accommodate the thematic sections.

**Foundry migration cost baseline:**
Global Standard is pay-per-token; configured capacity does not create an always-on compute charge. At the migration decision snapshot, Claude Haiku 4.5 is priced at the same displayed token rate on Foundry as OpenRouter, but avoiding OpenRouter's 5.5% credit-purchase fee makes Foundry about **5.2% lower in effective cash cost**. At a representative safety workload of 10 million input tokens plus 1 million output tokens, Foundry GPT-5 nano is approximately **$0.90** versus **$0.981** for the former OpenRouter Gemma path (about **8.3% lower**). GPT-5 mini incurs token charges only when invoked. Revalidate prices during budget reviews; the detailed comparison and source links live in [the Foundry migration runbook](docs/foundry-migration-runbook.md#cost-comparison).

**Summary rendering:**
All summaries (process, department, function) are stored as markdown and must be rendered as such in the frontend. The summary display components need to support markdown headers, bold, and inline citations.

**Microphone permissions:**
The ElevenLabs SDK requires microphone access. Browsers will prompt for permission on first use. If the user denies or the page is on HTTP (not HTTPS), the agent won't work. The app must be served over HTTPS (Vercel handles this). Add a pre-check: if `navigator.mediaDevices.getUserMedia` fails, show a clear message explaining how to enable the mic.

---

## 10. Suggested Working Name

### **Fabric**

*The fabric of the organization — woven from the voices of the people who make it run.*

---

## 11. Implementation Task List — Summary Enhancement (v0.8)

**Goal:** Replace flat prose summaries with structured analyst briefs featuring thematic sections, contributor citations, and contradiction surfacing. Switch to incremental generation for token efficiency. Upgrade model to Haiku 4.5.

> **Historical implementation note:** The OpenRouter-style model identifiers below record the completed v0.8 work as it was implemented at the time. The current provider architecture and deployment identifiers are defined in §3.4 and supersede them operationally; see §14 for migration status.

### Backend (Convex)

- [x] **Task 1: Rewrite `regenerateProcessSummary` in `postCall.ts` to incremental model**
  - Fetch the process's existing `rollingSummary` (if any) and the new completed conversation's full transcript (not just summary)
  - First conversation: send full transcript → produce initial structured summary
  - Subsequent conversations: send existing `rollingSummary` + new completed conversation transcript → LLM integrates new info into existing structure
  - Update model to `anthropic/claude-haiku-4.5-latest`, `max_tokens: 8192`
  - New system prompt producing structured output (Overview, Key Stages, Consensus, Tensions & Gaps, Notable Details) with contributor citations

- [x] **Task 2: Update `getConversationSummaries` query in `postCall.ts`**
  - Return full transcript alongside summary and contributor name (needed for incremental generation)
  - Add a query variant to fetch only the latest conversation (optimization for the incremental path)

- [x] **Task 3: Add `forceRefresh` support to `regenerateProcessSummary`**
  - When `forceRefresh` is true, fetch ALL conversation transcripts and regenerate from scratch (full rebuild, higher token cost)
  - This is the fallback for when incremental drift becomes noticeable

- [x] **Task 4: Rewrite department summary prompt in `summaries.ts` and `summariesHelpers.ts`**
  - New system prompt producing structured output (Overview, Cross-Process Handoffs, Shared Themes, Tensions & Gaps, Notable Details)
  - Citations reference process names (e.g., "[Compensation process]")
  - Update model to `anthropic/claude-haiku-4.5-latest`, `max_tokens: 8192`
  - Update both the public action (`generateDepartmentSummary`) and the internal action (`generateDepartmentSummaryInternal`)

- [x] **Task 5: Rewrite function summary prompt in `summaries.ts`**
  - New system prompt producing structured output (Overview, Cross-Department Patterns, Strategic Themes, Tensions & Gaps, Notable Details)
  - Citations reference department names (e.g., "[Payroll dept]")
  - Update model to `anthropic/claude-haiku-4.5-latest`, `max_tokens: 8192`

- [x] **Task 6: Store conversation transcript for summary generation**
  - Ensure `insertConversation` stores the full normalized transcript (already does — verify)
  - Add a helper query to fetch a single conversation's transcript by ID for the incremental path

### Frontend (Next.js)

- [x] **Task 7: Add markdown rendering to summary display components**
  - Install a lightweight markdown renderer (e.g., `react-markdown` or `marked`)
  - Update the Process Summary Box in the process detail panel to render markdown
  - Update department and function summary display to render markdown
  - Style markdown output to match existing design system (shadcn/ui typography)

- [x] **Task 8: Add "Force Refresh" button to process summary UI**
  - Allow users to trigger a full regeneration from all transcripts
  - Show loading state during regeneration
  - Only visible when a process has more than one conversation

### Testing & Validation

- [x] **Task 9: Test incremental summary generation**
  - Record 3+ conversations on a single process, verify summary builds incrementally with citations
  - Verify contradictions between contributors are surfaced in "Tensions & Gaps"
  - Verify force refresh produces equivalent quality to incremental

- [x] **Task 10: Test department and function summary generation**
  - Verify structured output with cross-process/cross-department citations
  - Verify staleness propagation still works correctly
  - Verify cascade generation (function → missing department summaries) works with new prompts

- [x] **Task 11: Verify markdown rendering across all summary levels**
  - Process, department, and function summaries render correctly
  - Mobile responsive — markdown doesn't break on narrow viewports
  - Edge case: summaries generated before upgrade (plain text) still render gracefully

---

## 12. Implementation Task List — Audio File Upload & Modal Refresh (v0.9)

**Goal:** Add a third capture mode (Audio File Upload) that reuses the Voice Record pipeline, collapse the recording modal's two-step name + consent flow into a single combined step, and add abandonment cleanup so half-processed audio doesn't linger in storage.

### Backend (Convex)

- [x] **Task 1: Widen the `inputMode` schema enum**
  - Add `v.literal("audioUpload")` to the `inputMode` union on the `conversations` table and to the validator on `postCall.insertConversation`. Additive optional-field change — no migration required.
  - Widen the `inputMode` cast in `migrations.ts` to include the new literal.

- [x] **Task 2: Generalize the Voice Record action to accept uploads**
  - Add a `source: v.optional(v.union(v.literal("record"), v.literal("upload")))` arg to `voiceRecordings.processVoiceRecording`.
  - Stamp `inputMode: "audioUpload"` when `source === "upload"`, otherwise `"voiceRecord"`.
  - Reject non-audio MIME prefixes server-side when `source === "upload"`.
  - Remove redundant `inputMode` / `transcriptionProvider` / `analysisProvider` re-stamping from `finishVoiceRecording` and `markVoiceRecordingNeedsSpeakerLabels` patches (the value is set correctly at insert).
  - Widen the inputMode gates in `getVoiceRecordingForAnalysis` and `submitSpeakerLabels` to accept both modes.

- [x] **Task 3: Widen the audio-playback resolver**
  - In `postCall.getConversationAudioSource`, return Convex Storage info for both `voiceRecord` and `audioUpload`. Widen the discriminator in the HTTP audio route.

- [x] **Task 4: Add `abandonVoiceRecording` mutation**
  - Auth-gate to the conversation's org. Allow only the row owner or an org admin. No-op when `status === "done"` or `inputMode` is not a contributor-owned audio mode. Best-effort `ctx.storage.delete` (tolerates already-gone), then `ctx.db.delete` the row.

### Frontend (Next.js)

- [x] **Task 5: Add the upload button group**
  - In `miller-columns.tsx`, render Voice Record + Upload Audio as a 50/50 button group beside the AI Interview button. Lucide `Upload` icon for the upload action.

- [x] **Task 6: Extend the recording modal with `audioUpload` mode**
  - Widen the `RecordingMode` type. Skip mic acquisition entirely when `mode === "audioUpload"`.
  - In the "recording" step, render a native file picker (`accept="audio/*"`) instead of the mic UI. Validate `audio/*` MIME and a 100 MB size cap client-side. Best-effort probe duration via a hidden `<audio>` element.
  - Reuse `submitVoiceRecording` — a `File` satisfies the existing `Blob` type — and pass `source: "upload"` to `processVoiceRecording`.
  - Reuse the existing speaker-labels review and post-call pipeline without changes.

- [x] **Task 7: Merge the name and consent steps**
  - Remove the `"consent"` modal step. Render the recording notice + content guidelines inline alongside the contributor name input. The single action button doubles as name-submit and consent-accept, dispatching to mic acquisition or file picker based on mode.

- [x] **Task 8: Wire abandonment cleanup**
  - When the modal closes with a `submittedVoiceConversationId` in flight and `!speakerLabelsSubmitted`, fire `abandonVoiceRecording` (best-effort, fire-and-forget). Server gates on org ownership, row ownership/admin role, contributor-owned input mode, and `status !== "done"`.

- [x] **Task 9: Update the admin conversations badge**
  - In `src/app/[org]/admin/conversations/page.tsx`, recognize `audioUpload` with its own label ("Audio Upload") and the `Upload` icon, alongside the existing AI Interview and Voice Recording badges.

### Testing & Validation

- [x] **Task 10: End-to-end happy path for audio upload**
  - Pick an MP3, confirm modal flows through processing → speaker labels → done, with `inputMode: "audioUpload"` and `audioStorageId` set on the conversation row. Playback works via the existing HMAC-signed `/audio/...` route.

- [x] **Task 11: Validation paths**
  - Non-audio MIME rejected client-side and server-side. Files larger than 100 MB rejected client-side.

- [x] **Task 12: Abandonment cleanup verification**
  - Upload a file, then close the modal at the speaker-labels step. Confirm the storage object and conversation row are both removed. Confirm a different contributor cannot abandon another user's unfinished row, an admin can clean it up, and closing the modal after speaker-label submission does NOT delete (analysis continues in the background).

- [x] **Task 13: Regression — existing Voice Record + AI Interview flows unchanged**

---

## 13. Implementation Task List — Deletion Flow Hardening (v1.0)

**Goal:** Make every destructive flow role-aware, tenant-scoped, non-cascading where required, and consistent with derived summaries/process flows.

### Backend (Convex)

- [x] **Task 1: Add server-backed delete eligibility**
  - Functions, departments, and processes expose delete eligibility queries that return role blockers, child-data blockers, and whether the caller has an admin cleanup path.
  - Delete mutations re-check blockers server-side so the UI cannot bypass non-cascading hierarchy rules.

- [x] **Task 2: Keep process deletion and process flows consistent**
  - Deleting an empty process deletes its derived `processFlows` row before deleting the process.
  - Cleanup code that removes all conversations for a process also removes the derived flow.

- [x] **Task 3: Harden admin conversation deletion**
  - `deleteForAdmin` is admin-only and org-scoped.
  - It tolerates already-missing Convex Storage bytes, deletes the conversation row, skips summary work for non-`done` rows, force-refreshes the process summary when completed conversations remain, and clears the process summary/deletes the process flow when the last completed conversation is removed.

- [x] **Task 4: Harden recording abandonment**
  - `abandonVoiceRecording` allows only the row owner or an org admin, only for unfinished `voiceRecord` / `audioUpload` rows.
  - Finalized rows and AI interview rows are protected.

- [x] **Task 5: Coordinate member removal with Clerk**
  - Member removal preflights self-removal and last-admin guards, deletes Clerk org membership first, then deletes Fabric membership.
  - Clerk failures preserve the Fabric membership row; Clerk 404 is treated as already removed and Fabric cleanup continues.

### Frontend (Next.js)

- [x] **Task 6: Make delete dialogs explain blockers**
  - Delete dialogs show loading, role-blocked, child-blocked, and confirmed-delete states.
  - Processes with conversations route admins to Admin → Conversations with the process filter applied; contributors are told to ask an admin.

- [x] **Task 7: Confirm admin destructive actions**
  - Admin conversation deletion uses a confirmation dialog.
  - Appearance reset uses a confirmation dialog before removing active/candidate theme tokens and returning the workspace to neutral.
  - Pending invite resend copy explains that resend is revoke + re-invite and may require manually inviting again if the second step fails.

### Testing & Validation

- [x] **Task 8: Deletion-flow regression coverage**
  - Covered hierarchy delete eligibility, blocked process deletion with conversations, process-flow cleanup, admin conversation deletion summary/flow effects, recording abandonment ownership, and tenant-scoped admin removal behavior.

---

## 14. Implementation Task List — Microsoft Foundry Migration (v1.1)

**Goal:** Move every Fabric-owned LLM request from OpenRouter to Microsoft Foundry without regressing synthesis quality, safety output contracts, tenant isolation, or rollback capability. Retain Claude Haiku 4.5 for synthesis, use GPT-5 nano for description safety, and keep GPT-5 mini available only as an evaluated fallback/successor candidate.

### Application & Data Compatibility

- [x] **Task 1: Add the shared AI provider adapter**
  - Centralize Foundry Claude, Foundry Azure OpenAI, and temporary OpenRouter rollback handling in `convex/lib/aiProvider.ts`.
  - Normalize retries, timeouts, tool output, finish reasons, token usage, request IDs, provider/deployment metadata, and safe telemetry.

- [x] **Task 2: Migrate all Fabric-owned AI call sites**
  - Route process, department, function, process-flow, labeled-voice, and description-safety requests through the adapter.
  - Keep product-level prompts and output contracts provider-independent.

- [x] **Task 3: Preserve analysis provenance**
  - Add `fabric-foundry` to the `analysisProvider` schema while retaining `fabric-openrouter` for historical rows and rollback-created rows.
  - Require no backfill of existing conversations.

### Foundry Infrastructure

- [x] **Task 4: Provision and validate development**
  - Use the Sweden Central `fabric-foundry-dev-se` project with a development-only API key and Global Standard deployments at capacities `1 / 10 / 10` (Claude / GPT-5 nano / GPT-5 mini).
  - Configure the Convex development deployment with `AI_PROVIDER=foundry` and verify application behavior.

- [x] **Task 5: Provision and smoke-test production infrastructure**
  - Use the separate Sweden Central `fabric-foundry-prod-se` project/account and production-only API key in the same Azure subscription.
  - Deploy Global Standard capacities `50 / 50 / 10` and pass direct smoke tests against all three production deployments.
  - Store Foundry settings in the production Convex deployment while intentionally leaving `AI_PROVIDER=openrouter` until application-level approval.

- [x] **Task 6: Make provisioning reproducible**
  - Keep `infra/foundry`, `scripts/deploy-foundry-models.ps1`, and `scripts/foundry-smoke.mjs` as the source-controlled provisioning, quota-preflight, idempotency, and smoke-test path.

### Production Cutover & Lifecycle

- [ ] **Task 7: Deploy the provider-adapter release to production with OpenRouter active**
  - Confirm the released adapter preserves current behavior before changing the provider flag.

- [ ] **Task 8: Run the prepared production golden set and approve cutover**
  - Validate safe and blocked descriptions, incremental and full process summaries, department/function summaries, labeled voice analysis, and process-flow generation.
  - Confirm output quality and required metadata before setting production `AI_PROVIDER=foundry`.

- [ ] **Task 9: Complete the rollback window**
  - Monitor production for seven days with OpenRouter retained as a one-setting rollback path.
  - Remove the production `OPENROUTER_API_KEY` only after the soak succeeds; remove rollback code in a later cleanup change.

- [ ] **Task 10: Execute the model-lifecycle plan**
  - Begin GPT-5 mini synthesis evaluation by 2026-09-20.
  - Replace Claude Haiku 4.5 version `2` before 2026-11-19.
  - Review the safety model by 2026-12-08 and replace GPT-5 nano `2025-08-07` before 2027-02-06.
  - Use blue/green deployment names and the golden set for every replacement.

See [docs/foundry-migration-runbook.md](docs/foundry-migration-runbook.md) for commands, secret handling, rollback, detailed cost comparison, and source links.

---

*End of document.*
