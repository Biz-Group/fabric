# ElevenLabs Agent — Platform Setup & Architecture Reference

This document records everything needed to configure and maintain the ElevenLabs Conversational AI agent used by Fabric. It serves as both a setup guide and an architecture reference for future development.

---

## 1. Architecture Overview

Fabric uses ElevenLabs as the voice conversation engine. The agent is a **platform-side resource** — you create and configure it in the ElevenLabs dashboard, and the code connects to it at runtime using the agent's ID.

### Responsibility Split

| Concern | Owner | Location |
|---|---|---|
| Agent creation & identity | Human | ElevenLabs dashboard |
| Base system prompt (personality, instructions) | Human | ElevenLabs dashboard |
| Voice selection | Human | ElevenLabs dashboard |
| Conversation Analysis config (success evaluation + data collection) | Human | ElevenLabs dashboard |
| Dynamic context injection (contributor name, process path, existing summary) | Code | `useConversation` overrides at session start |
| First message override ("Hi Sarah, I'm Fabric...") | Code | `useConversation` overrides |
| Session lifecycle (start, end, events) | Code | `useConversation` hook |
| Post-call data retrieval (transcript, summary, analysis) | Code | Convex action polls ElevenLabs REST API |
| Audio playback | Code | Convex HTTP action proxies ElevenLabs Audio API |
| Conversation-level summary | ElevenLabs | Built-in `analysis.transcript_summary` |
| Process-level rolling summary | Code + Claude | Convex action calls Claude Haiku via OpenRouter |

### Runtime Flow

```
User clicks "Record a Conversation"
  │
  ▼
Code: useConversation({ agentId, overrides })
  │  Overrides merge dynamic context into the platform's base prompt
  │  Sets firstMessage: "Hi {name}, I'm Fabric. Let's talk about {process}."
  │
  ▼
ElevenLabs Platform (handles everything during the call):
  ├── Speech-to-Text: user audio → text
  ├── LLM Reasoning: generates agent responses using merged prompt
  ├── Text-to-Speech: agent text → audio
  └── WebRTC: bidirectional audio streaming
  │
  ▼
Call ends → ElevenLabs post-processing:
  ├── Generates full transcript (with timestamps)
  ├── Generates transcript_summary (built-in, no external LLM cost)
  ├── Runs Success Evaluation (your custom criteria → boolean results)
  └── Runs Data Collection (your custom fields → structured extraction)
  │
  ▼
Code: Convex action polls GET /v1/convai/conversations/{id}
  │  Waits for status = "done" (~10-30 seconds)
  │  Extracts: transcript, summary, analysis, duration
  │
  ▼
Code: Inserts conversation record into Convex DB
  │
  ▼
Code: Calls regenerateProcessSummary (Claude Haiku via OpenRouter)
  │  Synthesizes ALL conversation summaries for this process
  │  Updates processes.rollingSummary
  │
  ▼
Convex reactivity auto-updates the frontend UI
```

---

## 2. Platform Setup Steps

### 2.1 Create the Agent

1. Log in to [ElevenLabs](https://elevenlabs.io)
2. Navigate to **Conversational AI** > **Agents**
3. Click **Create Agent**
4. Give it a name: **Fabric**

### 2.2 Configure the Base System Prompt

Paste the following into the agent's system prompt field:

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
```

> **Note:** Dynamic context is injected at runtime via `dynamicVariables` passed to `startSession()`. These fill `{{placeholder}}` templates in the prompt. Add the following **Dynamic Context** block at the end of the system prompt on the ElevenLabs dashboard:
>
> ```
> --- Dynamic Context ---
> Contributor: {{contributor_name}}
> Job title: {{job_title}}
> Tenure: {{years_in_role}}
> Process: {{function_name}} > {{department_name}} > {{process_name}}
> What we already know about this process: {{existing_summary}}
> Previous conversations from this contributor: {{prior_conversations}}
> ```
>
> The `{{system__time_utc}}` variable in the Environment section is an ElevenLabs built-in template variable — it is resolved by the platform automatically, not by our code.

### 2.3 Choose a Voice

Select a natural-sounding English voice. Recommendations:
- Pick something warm and conversational (not robotic or overly formal)
- Test the voice with a sample prompt to confirm it fits the "friendly interviewer" persona
- The voice can be changed at any time without affecting code

### 2.4 Set Language

Set the agent's default language to **English (`en`)**.

### 2.5 Configure First Message

**On the platform**, set the first message using `{{dynamic_variable}}` placeholders that are filled at session start via `dynamicVariables`:

```
Hi {{contributor_name}}, I'm Fabric. Let's talk about how {{process_name}} works.
Before we dive in, just a quick note — we're here to talk about how the process
works, the steps and tools involved. There's no need to share any sensitive details
like specific numbers, personal situations, or anything confidential. Just focus on
what you do and how you do it. Sound good?
```

This first message serves three purposes:
1. **Personal greeting** — uses the contributor's name and the specific process
2. **Content disclaimer** — sets boundaries on what to share (no salaries, personal situations, outcomes)
3. **Warm handoff** — ends with an open question to get the conversation started

### 2.6 Configure Conversation Analysis

This is the most important platform configuration. It tells ElevenLabs what to extract from each conversation after it ends. Navigate to the agent's **Analysis** or **Evaluation** settings.

#### Success Evaluation

Add the following criteria (these produce boolean results per conversation):

| Criterion | Description |
|---|---|
| `described_specific_steps` | "Did the contributor describe specific steps in their process?" |
| `mentioned_tools_or_systems` | "Did the contributor mention tools or systems they use?" |
| `identified_dependencies` | "Did the contributor identify dependencies on other people or teams?" |

#### Data Collection

Add the following extraction fields:

| Field Name | Type | Description |
|---|---|---|
| `steps_described` | List of strings | The specific steps the contributor described in their process |
| `tools_mentioned` | List of strings | Tools, software, or systems the contributor mentioned using |
| `dependencies` | List of strings | People, teams, or external parties the contributor depends on |
| `frequency` | String | How often the process runs (e.g., "weekly", "monthly", "daily") |
| `edge_cases` | List of strings | Edge cases, exceptions, or "when things go wrong" scenarios described |

#### Where these results end up

ElevenLabs returns all of this in the `analysis` field of the Conversations API response:
```json
{
  "analysis": {
    "transcript_summary": "Sarah described the monthly salary calculation...",
    "data_collection": {
      "steps_described": ["Pull data from HRIS", "Validate against bands", ...],
      "tools_mentioned": ["Workday", "HSBC portal", ...],
      "dependencies": ["Employee Relations team", ...],
      "frequency": "monthly",
      "edge_cases": ["Terminated employees in export", ...]
    },
    "success_evaluation": {
      "described_specific_steps": true,
      "mentioned_tools_or_systems": true,
      "identified_dependencies": true
    }
  }
}
```

The code stores:
- `analysis.transcript_summary` → `conversations.summary` (displayed in UI)
- Full `analysis` object → `conversations.analysis` (stored for future use)

### 2.7 Copy Credentials

After creating the agent:

| Credential | Where to find it | Where it goes |
|---|---|---|
| **Agent ID** | Agent settings page (or URL) | `.env.local` as `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` |
| **API Key** | ElevenLabs > Profile > API Keys | Convex env var: `npx convex env set ELEVENLABS_API_KEY <key>` |

> **Security:** The Agent ID is safe to expose client-side (it identifies which agent to connect to). The API Key is a secret — it must ONLY live in Convex environment variables and is used server-side by `fetchConversation` and `getAudio` actions.

---

## 3. How the Code Uses the Agent

### 3.1 Starting a Session

```tsx
import { useConversation } from "@elevenlabs/react";

const conversation = useConversation({
  onConnect: ({ conversationId }) => { /* store conversationId */ },
  onMessage: ({ message, source }) => { /* update live transcript */ },
  onDisconnect: (details) => { /* trigger post-call pipeline */ },
  onError: (message, context) => { /* handle errors */ },
  micMuted: isMuted,
});

await conversation.startSession({
  agentId: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID,
  connectionType: "webrtc",
  userId: contributorName,
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
```

> **Note:** We use `dynamicVariables` (not `overrides`) to inject context. Dynamic variables fill `{{placeholder}}` templates in the agent's dashboard-configured prompt and first message. This avoids needing to enable override permissions in the agent's Security tab.

### 3.2 During a Session

| Method/Property | Purpose |
|---|---|
| `conversation.status` | `"connecting"` / `"connected"` / `"disconnecting"` / `"disconnected"` |
| `conversation.isSpeaking` | Boolean — is the agent currently speaking? |
| `conversation.getInputVolume()` | User's mic level (drives Waveform visualization) |
| `conversation.getOutputVolume()` | Agent's audio level (drives Orb animation) |
| `conversation.sendUserMessage(text)` | Text input fallback (alternative to voice) |
| `conversation.endSession()` | End the call |

### 3.3 Post-Call Data Retrieval

After `onDisconnect`, the code calls a Convex action that polls:

```
GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}
Header: xi-api-key: <ELEVENLABS_API_KEY>
```

Polls every ~2 seconds until `status = "done"` (max 30 retries = 60 seconds). Extracts:
- `transcript` → structured message list with roles and timestamps
- `analysis.transcript_summary` → conversation summary (ElevenLabs-generated)
- `analysis` → full object including success evaluation + data collection
- `metadata.call_duration_secs` → duration

### 3.4 Audio Playback

Audio is NOT stored. It's streamed on-demand through a Convex HTTP action proxy:

```
GET {CONVEX_SITE_URL}/audio/{elevenlabs_conversation_id}
  → Convex HTTP action adds xi-api-key header
  → Proxies GET https://api.elevenlabs.io/v1/convai/conversations/{id}/audio
  → Streams MP3 back to browser
```

No additional ElevenLabs credits consumed — retrieval is a read operation.

---

## 4. ElevenLabs Pricing Considerations

- **Conversation Analysis** (Success Evaluation, Data Collection, transcript summary) is a platform feature. Verify which ElevenLabs plan includes these capabilities — they may not be available on the free/starter tier.
- **Audio retention** is built into the Agents Platform — ElevenLabs retains conversation audio natively.
- **Audio retrieval** is a read operation, not a generation — no additional credits consumed.
- The main cost is **agent minutes** (voice conversation time).

---

## 5. Future Considerations

### Webhooks (Production Path)

For production, replace polling with ElevenLabs webhooks:
- Configure a `post_call_transcription` webhook pointing to a Convex HTTP action
- The webhook payload contains the same transcript + analysis data
- Eliminates polling delay and retry logic

### Additional Analysis Criteria

The Success Evaluation and Data Collection fields can be expanded over time:
- Add criteria like "Did the contributor describe handoffs to other teams?"
- Add extraction fields like `pain_points`, `workarounds`, `compliance_requirements`
- Changes are made on the platform — no code changes needed

### Multi-Language Support

Currently English-only. To add languages:
- Update the agent's language setting on the platform
- Remove the `language: "en"` override in code (or make it dynamic)
- ElevenLabs supports automatic language detection

---

## 6. Environment Variables Summary

| Variable | Location | Purpose |
|---|---|---|
| `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` | `.env.local` | Agent ID — safe for client-side |
| `ELEVENLABS_API_KEY` | Convex env var (`npx convex env set`) | API key — server-side only |
| `NEXT_PUBLIC_CONVEX_URL` | `.env.local` | Convex deployment URL |
| `OPENROUTER_API_KEY` | Convex env var (`npx convex env set`) | For Claude Haiku (process summaries only) |

---

*Last updated: March 2026*
