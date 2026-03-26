# Fabric — Product Requirements Document

**Voice-first institutional knowledge capture for organizations**

---

**Version:** 0.7 (POC — Audio Streamed from ElevenLabs + User Authentication)
**Author:** Saish / Biz Group
**Date:** March 2026
**Status:** Draft

---

## 1. Overview

Fabric is a web-based tool that lets organizations capture how their business actually runs — not through documentation projects or process audits, but through natural voice conversations between employees and an AI agent. Employees navigate to their function, department, and process, then simply talk about what they do. The system records, transcribes, summarizes, and stitches those conversations into a living, hierarchical knowledge base of the entire company's operations.

### 1.1 The Problem

Institutional knowledge lives in people's heads. When someone leaves, gets promoted, or goes on leave, that knowledge walks out the door. Traditional process documentation is tedious to create, quickly outdated, and rarely captures the nuance of how things actually get done. People will talk about their work far more naturally and completely than they'll ever write about it.

### 1.2 The Vision

A single-page app that mirrors the way an organization is structured — Function → Department → Process — where anyone can walk up, pick their process, and have a conversation with an AI agent about what they do. Over time, Fabric builds a comprehensive, voice-sourced map of how the entire company operates.

**Phase 1 (this POC):** Capture, summarize, and replay. A company diary with voice — record, listen back, and see how the organization works at a glance.
**Phase 2 (future):** Query, search, and retrieval — so new joiners and cross-functional teams can ask questions and get answers sourced from the captured knowledge.

---

## 2. User Experience

### 2.1 Navigation Model — Miller Columns

The entire app is a single-page interface using a Miller column layout (inspired by macOS Finder). Three columns sit side by side:

| Column 1 | Column 2 | Column 3 |
|---|---|---|
| **Function** | **Department** | **Process** |
| Finance | Payroll | Compensation |
| Operations | Accounts Payable | Commissions |
| Human Resources | Treasury | Bank Transfers |
| Technology | ... | ... |

- Clicking a Function populates the Department column with its children.
- Clicking a Department populates the Process column with its children.
- Clicking a Process opens the **Process Detail Panel** — either as a fourth column or as a slide-over/modal.

The hierarchy is pre-configured (for the POC, seeded in a config file or simple admin UI). The structure is: **Function → Department → Process**.

### 2.2 Process Detail Panel

When a user selects a process, they see:

1. **Process title and breadcrumb** (e.g., Finance > Payroll > Compensation)
2. **"Record a Conversation" button** — launches the ElevenLabs voice agent widget
3. **Process Summary Box** — a prominent, always-visible card at the top displaying the AI-generated rolling summary that synthesizes all conversation summaries for this process. Updated after each new conversation. This is the "at a glance" view of how this process works.
4. **Conversation log** — a reverse-chronological list of all past sessions for this process, each showing:
   - Contributor name (manually entered before recording, since there's no auth in POC)
   - Date and time
   - AI-generated summary (collapsible)
   - **Audio player** — inline playback of the recorded conversation (MP3 streamed from ElevenLabs, using ElevenLabs UI Audio Player / Scrub Bar component)
   - Full transcript (collapsible, nested under summary, using ElevenLabs UI Transcript Viewer)

### 2.3 Conversation Flow

1. User navigates to a process.
2. User clicks "Record a Conversation."
3. A modal appears using **ElevenLabs UI components** (Orb, Conversation, Message, Waveform, Voice Button) with the voice agent connected via the `@elevenlabs/react` SDK.
4. The agent greets the user by name (passed via dynamic context) and asks them to describe what they do as part of this process.
5. The agent conducts a semi-structured interview — asking follow-up questions, clarifying steps, probing for edge cases and exceptions.
6. The user ends the conversation when they're done.
7. Post-call, the frontend triggers a Convex action that polls the ElevenLabs Conversations API until the transcript and analysis are ready, then stores everything in the database.
8. The Convex action calls Claude Haiku (via OpenRouter) for summarization, updates the conversation record, and regenerates the process-level rolling summary.
9. Convex's built-in reactivity pushes the update to the UI — the new conversation appears in the log automatically.

---

## 3. Technical Architecture

### 3.1 Stack

| Layer | Technology |
|---|---|
| Frontend | **Next.js** (React) with **shadcn/ui** + **ElevenLabs UI** components |
| Voice Agent | `@elevenlabs/react` SDK (`useConversation` hook) |
| UI Components | ElevenLabs UI registry (Orb, Conversation, ConversationBar, Message, Transcript Viewer, Audio Player, Scrub Bar, Waveform, Voice Button) — built on shadcn/ui |
| Backend / BaaS | **Convex** (document database, server functions, built-in reactivity) |
| Conversation Summaries | ElevenLabs Conversation Analysis (built-in, no extra cost) |
| Process-level Summaries | Claude Haiku via OpenRouter API (OpenAI-compatible) — only LLM cost |
| Post-call data | ElevenLabs Conversations API (transcript, summary, analysis) |
| Audio playback | ElevenLabs Conversations Audio API (`GET .../audio`) — streamed on demand, no storage needed |
| Hosting | Vercel (frontend) + Convex (backend) |

### 3.2 Data Model (Convex)

**Tables (defined in `convex/schema.ts`):**

Note: Convex auto-generates `_id` and `_creationTime` fields for every document — no need to define them explicitly.

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Organizational hierarchy
  functions: defineTable({
    name: v.string(),
    sortOrder: v.number(),
  }),
  departments: defineTable({
    functionId: v.id("functions"),
    name: v.string(),
    sortOrder: v.number(),
  }).index("by_function", ["functionId"]),
  processes: defineTable({
    departmentId: v.id("departments"),
    name: v.string(),
    sortOrder: v.number(),
    rollingSummary: v.optional(v.string()),
  }).index("by_department", ["departmentId"]),

  // Conversation records
  conversations: defineTable({
    processId: v.id("processes"),
    elevenlabsConversationId: v.string(),   // from startSession() return
    contributorName: v.string(),
    transcript: v.optional(v.any()),         // full structured transcript from ElevenLabs
    summary: v.optional(v.string()),         // from ElevenLabs analysis (no Claude call needed)
    analysis: v.optional(v.any()),           // ElevenLabs evaluation + data collection results
    durationSeconds: v.optional(v.number()),
    status: v.string(),                      // "processing" | "done" | "failed"
  }).index("by_process", ["processId"])
    .index("by_status", ["status"]),
});
```

**Convex features used:**

- **Document database** — schema-validated tables with typed fields, references via `v.id()`, and flexible `v.any()` for transcript/analysis storage
- **Server functions** — `actions` for external API calls (ElevenLabs, OpenRouter), `mutations` for database writes, `queries` for reads, `httpAction` for HTTP endpoints (audio proxy)
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

**Path B: Post-Call Webhooks (recommended for production)**

ElevenLabs supports webhooks that fire when processing is complete:
- **`post_call_transcription`** — contains full transcript, analysis results, and all metadata. This is the primary webhook for Fabric.

Webhook endpoint: a **Convex HTTP action** that receives the webhook payload, extracts transcript + analysis (including the ElevenLabs-generated summary), and inserts directly into the `conversations` table. Then triggers `regenerateProcessSummary` to update the process-level rolling summary via OpenRouter.

#### 3.3.5 Audio Playback — Streamed from ElevenLabs

ElevenLabs provides a dedicated endpoint to retrieve the audio recording of any conversation:

```
GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/audio
Header: xi-api-key: <API_KEY>
```

This returns the raw audio file directly. **Fabric does not store audio files** — instead, a lightweight proxy endpoint (Convex HTTP action) adds the `xi-api-key` header and streams the response to the frontend. The ElevenLabs UI Audio Player / Scrub Bar component points at this proxy URL.

**Why this works for POC:**
- No file storage needed — removes an entire infrastructure layer
- No `post_call_audio` webhook processing — no base64 decoding, no upload pipeline
- No `audio_url` column in the database — the URL is deterministic from `elevenlabs_conversation_id`
- Retrieval is a read operation, not a generation — **no additional credits consumed**
- ElevenLabs retains conversation audio natively as part of the Agents Platform (built-in retention)
- Tradeoff: playback depends on ElevenLabs API availability — acceptable for POC

**Proxy endpoint pattern:**
```
GET /api/audio/:elevenlabs_conversation_id
→ Convex HTTP action calls ElevenLabs API with xi-api-key
→ Streams audio response back to the frontend
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

These results are returned in the `analysis` field of the conversation details API and in the post-call webhook payload. The analysis object also includes a **transcript summary** — a narrative summary of the conversation generated by ElevenLabs' LLM. **This means ElevenLabs handles all conversation-level summarization natively.** Fabric simply stores the summary and structured data as-is, with no additional LLM call needed per conversation. Claude is only used for the process-level rolling summary (synthesizing multiple conversation summaries together).

### 3.4 Summarization Pipeline

**Conversation-level summary — handled entirely by ElevenLabs:**
The `analysis` object returned by the Conversations API (and via the `post_call_transcription` webhook) includes a **transcript summary** generated by ElevenLabs' own LLM-powered analysis. Combined with the Data Collection fields (steps, tools, dependencies, etc.), this gives us everything we need per conversation — **no Claude API call required**.

We simply store `analysis.transcript_summary` in `conversations.summary` and the structured `analysis.data_collection` results in `conversations.analysis`.

**Process-level rolling summary — Claude Haiku via OpenRouter (the only LLM cost):**
After each new conversation is stored, a Convex action fetches all conversation summaries for that process and sends them to Claude Haiku (via OpenRouter's OpenAI-compatible API) with a prompt like:

> "You are synthesizing multiple employee accounts of a single business process. Combine these into a coherent narrative that describes the full process end-to-end, noting which contributors handle which parts, and highlighting any overlaps or gaps."

This is a lightweight call — it's combining short summary strings, not processing full transcripts. Cost is minimal.

**Department and Function summaries (lightweight for POC):**
These are generated on-demand (not stored) by concatenating child process summaries and passing them through a similar synthesis prompt. This avoids a cascade of re-summarizations on every new conversation. Can be upgraded to stored + incrementally updated summaries in Phase 2.

### 3.5 Convex Architecture

**Why Convex:** Eliminates the need to build and deploy a separate backend API. Convex provides a document database, TypeScript server functions, and built-in real-time reactivity out of the box — all accessible from the Next.js frontend via `convex/react` hooks (`useQuery`, `useMutation`, `useAction`).

**Server functions (defined in `convex/` directory):**

| Function | Type | Trigger | Purpose |
|---|---|---|---|
| `postCallWebhook` | `httpAction` | HTTP POST (from ElevenLabs `post_call_transcription` webhook) | Receives transcript, summary, analysis, and metadata. Stores in `conversations` table. Triggers process summary regeneration. |
| `regenerateProcessSummary` | `action` | Called after conversation is inserted | Fetches all conversation summaries for a process → sends to Claude Haiku via OpenRouter → updates `processes.rollingSummary` |
| `fetchConversation` | `action` | Called by frontend after `onDisconnect` (polling path) | Polls ElevenLabs API for conversation details, inserts into DB when status = `done`, then triggers `regenerateProcessSummary` |
| `getAudio` | `httpAction` | Called by frontend audio player | Proxies `GET /v1/convai/conversations/{id}/audio` with `xi-api-key` header, streams MP3 back to client |

**Built-in reactivity (no manual subscriptions needed):**
Convex queries are reactive by default. Any component using `useQuery` will auto-update when the underlying data changes. When a new conversation record is inserted (or its status changes to `done`), the Process Detail Panel auto-refreshes without a page reload — no channels, no subscriptions, no cleanup.

```tsx
// Convex queries are reactive by default — no manual subscriptions needed.
// Any component using useQuery will auto-update when the underlying data changes.
const conversations = useQuery(api.conversations.listByProcess, {
  processId: selectedProcessId,
});
const process = useQuery(api.processes.get, { processId: selectedProcessId });
// process.rollingSummary auto-updates when regenerateProcessSummary writes a new value
```

**Data flow (POC — polling path):**

1. User starts session → `conversation.startSession()` → receives `conversationId`
2. User ends session → `onDisconnect` fires
3. Frontend calls `fetchConversation` Convex action with `conversationId`
4. Convex action polls `GET /v1/convai/conversations/{id}` until status = `done`
5. Convex action extracts transcript, summary (from `analysis`), and data collection results → inserts into `conversations` table via `ctx.runMutation` (no Claude call needed — ElevenLabs provides the summary)
6. Convex action calls `regenerateProcessSummary` → Claude Haiku (via OpenRouter) synthesizes all conversation summaries into a rolling process narrative → updates `processes.rollingSummary`
7. Convex reactivity auto-updates the frontend → UI refreshes with summary, transcript, and audio player (no manual subscriptions needed)
8. Audio playback: when user clicks play, the Audio Player component calls `getAudio` HTTP action → proxies the ElevenLabs Audio API → streams MP3 to the browser (no stored files, no additional credits)

### 3.6 Authentication & User Access

**Provider:** Clerk (hosted auth with prebuilt UI components)
**Sign-in method:** Email + password (managed by Clerk)
**Tenancy:** Single-tenant (one organization)
**RBAC:** Not implemented for POC — all authenticated users get full access

**Why Clerk:** First-class Convex integration via JWT validation. Prebuilt `<SignIn />`, `<SignUp />`, and `<UserButton />` React components — no custom auth UI to build or maintain. Clerk handles all auth infrastructure (account creation, password hashing, session management, JWT signing) externally, keeping the Convex backend focused on business logic. Can be extended with SSO/SAML and organization management for enterprise use.

**User Profile Table (`users`):**

| Field | Type | Description |
|---|---|---|
| `tokenIdentifier` | string | Canonical identity from `ctx.auth.getUserIdentity()` — primary lookup key |
| `name` | string | Display name (pre-filled from Clerk on first login) |
| `email` | string | Email address (from Clerk identity) |
| `jobTitle` | optional string | e.g., "Payroll Manager" |
| `function` | optional string | Org function (e.g., "Finance") — selected from `functions` table |
| `department` | optional string | Org department (e.g., "Payroll") — selected from `departments` table |
| `hireDate` | optional string | ISO date string |
| `profileComplete` | boolean | `false` until onboarding is done |

**Conversations table change:** Add optional `userId` field (`v.id("users")`) linking conversations to authenticated users. The existing `contributorName` field is preserved as a denormalized display name.

**Auth flow:**
1. User visits the app → Clerk middleware (`src/proxy.ts`) redirects to `/sign-in` if not authenticated
2. User signs up via Clerk's prebuilt `<SignUp />` component (collects name, email, password)
3. Clerk issues a JWT → `ConvexProviderWithClerk` sends it with every Convex request → Convex validates via `convex/auth.config.ts`
4. On first authenticated visit, a `store` mutation creates a `users` record linked via `tokenIdentifier`
5. If `profileComplete === false` → user sees a profile onboarding screen (Name pre-filled from Clerk, plus Job Title, Function, Department, Hire Date)
6. After completing onboarding → user accesses the main app
7. All Convex queries/mutations require authentication via `ctx.auth.getUserIdentity()`
8. User identity is never passed as a function argument — always derived server-side

**Packages:** `@clerk/nextjs`
**Config files:** `convex/auth.config.ts` (Clerk JWT issuer), `src/proxy.ts` (Clerk middleware)
**New files:** `convex/users.ts` (user CRUD), `convex/lib/auth.ts` (shared `requireAuth` helper), `src/app/sign-in/page.tsx`, `src/app/sign-up/page.tsx`, `src/components/profile-onboarding.tsx`, `src/components/user-menu.tsx`

---

## 4. Agent System Prompt (Base)

The following is the base system prompt configured on the ElevenLabs platform. Dynamic context is injected at session start via `dynamicVariables` passed to `startSession()`, which fill `{{placeholder}}` templates in the agent's prompt and first message. The `{{system__time_utc}}` variable is an ElevenLabs built-in template variable resolved by the platform automatically. See [ELEVENLABS_SETUP.md](ELEVENLABS_SETUP.md) for full platform configuration instructions.

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

### Screen 1: Main View (Miller Columns)

```
┌─────────────┬─────────────┬─────────────┬──────────────────────────────┐
│  Functions   │ Departments │  Processes  │    Process Detail             │
│             │             │             │                              │
│ ► Finance   │ ► Payroll   │ ● Compen... │  Finance > Payroll >         │
│   Operations│   AP        │   Commis... │  Compensation                │
│   HR        │   Treasury  │   Bank Tr.. │                              │
│   Technology│             │             │  [🎙 Record a Conversation]  │
│             │             │             │                              │
│             │             │             │  ┌──────────────────────────┐ │
│             │             │             │  │ 📋 PROCESS SUMMARY       │ │
│             │             │             │  │                          │ │
│             │             │             │  │ Compensation is handled  │ │
│             │             │             │  │ by three team members    │ │
│             │             │             │  │ who collectively manage  │ │
│             │             │             │  │ salary calculations,     │ │
│             │             │             │  │ bank transfers, and...   │ │
│             │             │             │  └──────────────────────────┘ │
│             │             │             │                              │
│             │             │             │  ── Conversations ────────── │
│             │             │             │                              │
│             │             │             │  📝 Sarah K. — Mar 24        │
│             │             │             │  "Described monthly salary   │
│             │             │             │   calculation process..."    │
│             │             │             │  ▶ ──●─────────── 4:32       │
│             │             │             │  ▸ View Transcript           │
│             │             │             │                              │
│             │             │             │  📝 Ahmed R. — Mar 20        │
│             │             │             │  "Explained bank transfer    │
│             │             │             │   workflow and approvals..." │
│             │             │             │  ▶ ────────●───── 6:15       │
│             │             │             │  ▸ View Transcript           │
│             │             │             │                              │
│             │             │             │  📝 Sarah K. — Mar 18        │
│             │             │             │  "Initial walkthrough of     │
│             │             │             │   payroll data sourcing..."  │
│             │             │             │  ▶ ─────────────● 3:48       │
│             │             │             │  ▸ View Transcript           │
└─────────────┴─────────────┴─────────────┴──────────────────────────────┘
```

### Screen 2: Recording Modal (ElevenLabs UI Components)

The recording modal is built entirely from ElevenLabs UI components (which are shadcn/ui-based):

```
┌──────────────────────────────────────┐
│  Finance > Payroll > Compensation    │  ← shadcn Breadcrumb
│                                      │
│         ┌──────────────┐             │
│         │   ◉ (Orb)    │             │  ← ElevenLabs UI: Orb
│         │  reacts to   │             │     (3D Three.js, audio-reactive)
│         │  audio input │             │
│         └──────────────┘             │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ Agent: "Tell me about how    │    │  ← ElevenLabs UI: Message
│  │ you handle compensation..."  │    │
│  │                              │    │
│  │ You: "So basically every     │    │  ← ElevenLabs UI: Message
│  │ month I pull the report..."  │    │     (live via onMessage)
│  └──────────────────────────────┘    │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ ≋≋≋≋≋ (waveform) ≋≋≋≋≋≋≋≋≋  │    │  ← ElevenLabs UI: Waveform
│  └──────────────────────────────┘    │
│                                      │
│  [🎤 Voice Button]  [End Call 📞]    │  ← ElevenLabs UI: VoiceButton
│                                      │
│  Or type: [___________________] ➤    │  ← shadcn Input + SendIcon
└──────────────────────────────────────┘
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

- Miller column navigation (Function → Department → Process) built with **shadcn/ui** components
- **Responsive layout** — Miller columns on desktop; stacked drill-down navigation on mobile/tablet (collapse to single-column with back navigation)
- Pre-seeded organizational hierarchy (Convex seed script)
- **English only** for POC (ElevenLabs agent language set to `"en"`)
- **User authentication** — Clerk with prebuilt sign-in/sign-up UI, Convex JWT validation, auth gates on all Convex functions, user profiles with organizational attributes (Job Title, Function, Department, Hire Date), required profile onboarding on first login, Clerk `<UserButton />` in header (Phase 5)
- ElevenLabs voice agent integration via `@elevenlabs/react` SDK with dynamic context injection
- Recording UI using **ElevenLabs UI** components (Orb, Conversation, Message, Waveform, Voice Button)
- **Contributor name prompt** — auto-filled from authenticated user profile; shadcn Dialog still allows override before recording starts
- **Consent banner** — simple notice before first recording: "This conversation will be recorded, transcribed, and stored."
- Post-call transcript and summary retrieval via ElevenLabs Conversations API (summary provided by ElevenLabs — no extra LLM call)
- **Post-call loading state** — ShimmeringText "Processing your conversation..." while ElevenLabs analysis completes, transitioning to post-call review screen
- Process-level rolling summaries via Claude Haiku through OpenRouter (the only LLM cost — called from Convex actions)
- ElevenLabs Conversation Analysis (Success Evaluation + Data Collection) configured on platform
- Conversation log per process (contributor name, date, summary, transcript, structured analysis)
- **Audio playback streamed from ElevenLabs** — no local storage; audio served on-demand via `GET /v1/convai/conversations/{id}/audio` through a proxy Convex HTTP action, rendered with ElevenLabs UI Audio Player / Scrub Bar
- **Process Summary Box** — prominent, always-visible summary card per process synthesizing all conversations
- **Empty states** — friendly prompts when a process has no conversations, a department has no processes, etc.
- Process-level rolling summary (auto-regenerated after each new conversation)
- On-demand department and function summaries
- Convex built-in reactivity for live UI updates
- **Error handling for disconnects** — graceful UI for `onDisconnect` with reason `"error"`, with retry prompt
- Simple, clean single-page UI (Next.js + Tailwind + shadcn/ui)

### Out of Scope (Phase 2+)

- Role-based access control (admin, contributor, viewer roles)
- Conversation deletion / editing
- Admin UI for managing the org hierarchy
- Semantic search and Q&A over captured knowledge ("Ask Fabric")
- Onboarding flows for new joiners
- Integrations (Slack, Teams, email digests)
- Multi-tenant / multi-organization support
- Multi-language support (Arabic, auto-detect, etc.)
- Local audio archiving (backup of ElevenLabs audio for long-term retention)
- Mobile-native app (iOS / Android)

---

## 7. Success Criteria (POC)

1. A user can navigate the org hierarchy in three clicks (desktop) or three taps (mobile).
2. A user can initiate a voice conversation with the ElevenLabs agent from any process.
3. A consent notice is shown before the first recording.
4. The agent conducts a coherent, contextual interview about the selected process.
5. After the call, a transcript and summary are visible in the UI, with audio available for playback.
6. A user can play back any historical conversation directly from the process detail panel.
7. Multiple conversations from different contributors accumulate under a single process.
8. A synthesized process summary box is visible at the top of each process and updates with each new conversation.
9. The app is usable on mobile viewports (stacked navigation) and desktop (Miller columns).
10. Only authenticated users can access the app. Users can sign up, sign in, complete a profile with organizational attributes, and sign out. Conversations are linked to authenticated user identities.

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

### 8.2 UX Considerations

**Contributor name input:**
With authentication (Phase 5), the contributor name dialog is pre-filled from the authenticated user's Clerk profile (`user.firstName + user.lastName`). A shadcn Dialog still appears when the user clicks "Record a Conversation" to allow override — but the default is the user's real name. The name is passed as `userId` in `startSession()`, stored on the conversation record as `contributorName`, and the authenticated user's `userId` is also stored for identity linking.

**Post-call loading state:**
After the user ends the call, there's a 10-30 second processing window. The UI must not feel broken during this gap.
**Design:** Show a post-call screen with ShimmeringText ("Processing your conversation...") and the ElevenLabs Orb in a subtle idle animation. When the data lands (via Convex reactivity), transition to the summary + transcript + audio player view.

**Empty states:**
Every level of the hierarchy needs a zero-data state. Process with no conversations: "No conversations yet — be the first to record how this process works." Department with no processes: "No processes defined yet." These should feel inviting, not empty.

**Responsive / mobile layout:**
Miller columns don't work on narrow screens. On viewports below ~768px, collapse to a stacked drill-down pattern: tap a Function → full-screen list of Departments → tap a Department → full-screen list of Processes → tap a Process → full-screen Process Detail. Back button at each level. The recording modal works the same on all screen sizes.

**Error recovery on disconnect:**
The `onDisconnect` handler receives a `reason` field: `"user"`, `"agent"`, or `"error"`. For `"error"`, show a friendly message: "Something went wrong with the connection. If your conversation was long enough, it may still have been captured — check back in a minute. Otherwise, try again." Don't just silently close the modal.

### 8.3 Operational Considerations

**ElevenLabs pricing tier:**
Conversation Analysis (Success Evaluation, Data Collection, transcript summary) is a platform feature. Confirm which ElevenLabs plan includes these capabilities — they may not be available on the starter/free tier. Budget accordingly for POC.

**Privacy and consent:**
Even for an internal POC, employees are being recorded describing their work. A simple consent notice should appear before the first recording: "This conversation will be recorded, transcribed, and stored to help document our processes." One-line banner in the recording modal, not a legal wall. But it needs to be there.

**Seed data for demo:**
The org hierarchy needs to be realistic for the POC to land well. Create a Convex seed script as part of the build with 3-4 functions, 2-3 departments each, and 2-4 processes per department. Pre-populate 1-2 sample conversations with mock summaries so the UI doesn't look empty on first load.

**Microphone permissions:**
The ElevenLabs SDK requires microphone access. Browsers will prompt for permission on first use. If the user denies or the page is on HTTP (not HTTPS), the agent won't work. The app must be served over HTTPS (Vercel handles this). Add a pre-check: if `navigator.mediaDevices.getUserMedia` fails, show a clear message explaining how to enable the mic.

---

## 10. Suggested Working Name

### **Fabric**

*The fabric of the organization — woven from the voices of the people who make it run.*

---

*End of document.*