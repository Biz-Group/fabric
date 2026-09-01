# Fabric — Product Requirements Document

**Voice-first institutional knowledge capture for organizations**

| Field | Value |
|---|---|
| Owner | Saish / Biz Group |
| Status | Active product baseline |
| Last updated | 1 September 2026 |
| Current release | 1.5 |

This document defines what Fabric is, who it serves, the product experience, and the requirements that should remain true. It intentionally excludes implementation task lists, database schemas, source-code inventories, full prompts, deployment commands, and migration procedures.

Supporting documents:

- [Platform architecture and security](PLATFORM_ARCHITECTURE.md)
- [Product delivery history](docs/product-delivery-history.md)
- [Summary and Overview V2 design](docs/summary-overview-v2-plan.md)
- [Process-flow generation V3 design](docs/process-flow-generation-v3-plan.md)
- [Process-flow visualization design](docs/process-flow-visualization-ui-ux-plan.md)
- [Automation solution portfolio design](docs/automation-solution-portfolio-agents-library-plan.md)
- [AI usage metering design](docs/ai-usage-metering-plan.md)
- [Foundry migration runbook](docs/foundry-migration-runbook.md)

## 1. Product overview

Fabric helps organizations capture how work actually happens through natural conversations. Contributors select a process and either speak with an AI interviewer, record a conversation, or upload existing audio. Fabric transcribes and analyzes that evidence, then produces a living view of the process: an evidence-backed overview, an interactive process flow, operational insights, actionable automation briefs, and a shareable report.

The organizational model is **Function → Department → Process**. Knowledge is synthesized at process, department, and function level without losing its connection to source conversations.

### 1.1 Problem

Institutional knowledge lives in people's heads and is lost when people leave, change roles, or are unavailable. Traditional documentation is costly to create, quickly becomes stale, and often omits the exceptions, handoffs, workarounds, and judgment that make a process function in practice.

### 1.2 Product promise

Fabric makes process discovery easier than writing a process document. It turns employee testimony into a navigable, traceable operational picture while clearly communicating evidence coverage, confidence, disagreement, and freshness.

### 1.3 Product principles

1. **Voice first, not voice only.** Speaking should be the fastest capture path, while existing audio remains reusable.
2. **Evidence before assertion.** Generated findings must retain source references and coverage context.
3. **Different surfaces answer different questions.** Overview explains, Process Flow shows sequence, and Insights identifies improvement opportunities.
4. **Progress should be visible.** Long-running AI work must expose its stage and recover safely from partial failure.
5. **Tenant boundaries are absolute.** Every read, write, export, and administrative action is organization-scoped.
6. **Human review at consequential boundaries.** Contributors label speakers before recorded or uploaded audio is analyzed; destructive and administrative actions require explicit confirmation.

## 2. Users and permissions

### 2.1 Roles

| Role | Primary needs | Permissions |
|---|---|---|
| Viewer | Understand how the organization works | Browse hierarchy, overviews, conversations, flows, insights, and reports |
| Contributor | Capture and maintain process knowledge | Viewer access plus capture conversations and manage eligible hierarchy items |
| Organization admin | Operate a workspace safely | Contributor access plus member, invitation, conversation, appearance, retry, and deletion controls |
| Platform super admin | Operate the multi-tenant service | Tenant administration and cross-environment usage visibility through the tenant console |

Role enforcement must exist on the server; hidden UI controls are not an authorization boundary.

### 2.2 Primary journeys

- A contributor finds a process, records or uploads evidence, labels speakers when needed, and sees the derived views refresh automatically.
- A viewer opens a function, department, or process and understands its current state, evidence coverage, and important gaps.
- An admin invites members, resolves failed conversations, exports conversation data, manages branding, and safely removes data.
- A platform operator reviews tenant-level AI usage and estimated cost without accessing prompt or response content.

## 3. Product experience

### 3.1 Workspace and navigation

The authenticated workspace uses a collapsible **Function → Department → Process** tree beside a context-sensitive workbench. Selecting an item updates the workbench without losing hierarchy context. Deep links must preserve the selected item and tab.

Required behaviors:

- Search and jump across functions, departments, and processes with the Ctrl/Cmd+K command palette.
- Create, rename, move, and delete eligible hierarchy items according to role.
- Preserve non-cascading hierarchy deletion: functions with departments, departments with processes, and processes with conversations cannot be deleted.
- Show server-computed blockers and route admins to conversation cleanup when relevant.
- Provide a usable mobile drill-down rather than compressing the desktop tree.
- Display the approved organization brand lockup consistently without allowing oversized logos to dominate the workspace header.
- Let each user choose a light, dark, or system appearance, persist that preference on the device, and preserve approved organization accents in every mode.

### 3.2 Function and department overview

Function and department pages provide durable, evidence-backed operational briefs rather than generic prose summaries.

They must:

- lead with a concise overview brief;
- surface cross-process or cross-department patterns, handoffs, risks, and open questions;
- show process coverage and evidence/freshness context;
- retain source references to child entities;
- avoid rebuilding when no unread source input exists; and
- support an explicit manual rebuild when new input is available.

### 3.3 Process workbench

Every process has five complementary tabs.

#### Overview

The Overview tab answers “How does this process work, and what should I know first?” It presents a structured brief built from normalized conversation evidence. It should prioritize readability and decisions over dashboard density.

The overview must include, when supported by evidence:

- purpose and operational context;
- key stages;
- roles and systems involved;
- exceptions, tensions, and gaps;
- risks and improvement opportunities;
- evidence coverage and freshness; and
- source citations that can be traced to conversations.

Inline emphasis in generated content should render consistently in the app and PDF export.

#### Conversations

The Conversations tab is the evidence ledger for a process. Users can filter and sort sessions, review the contributor and capture type, play available audio, and expand the transcript and analysis.

Completed conversations receive a short AI-generated title so the log is scannable. Where a conversation was captured on behalf of someone else, the UI and exports must distinguish the submitting user from the attributed contributor.

#### Process Flow

The Process Flow tab shows the sequence of work as an interactive graph with start, end, action, decision, handoff, and wait steps. Nodes may include actors, tools, duration, pain points, automation potential, confidence, risks, and source citations.

The current interaction requirements are:

- render the topology as soon as the graph stage completes while step descriptions continue in the background;
- show named generation stages and per-step enrichment progress;
- support horizontal and vertical layout preferences and persist them per user/device;
- route edges and branch labels legibly, using distinct conditional, parallel, fallback, and sequential treatments;
- support keyboard navigation between connected steps;
- focus the selected path, dim unrelated content, and open a responsive detail panel;
- open at the entry step, placing horizontal flows at the center-left and vertical flows at the top-center;
- preserve user context when switching orientation or entering fullscreen;
- expose zoom, pan, fit-to-view, and a desktop minimap;
- allow per-step retry when enrichment fails; and
- mark the flow stale when new completed evidence arrives.

Partially enriched flows may be shown, but placeholder values must never be counted as findings.

#### Insights

Insights answers “Where should we investigate or improve?” and is derived from the same process-flow artifact used by the report export. It covers handoffs, systems, bottlenecks, automation candidates, tribal-knowledge risk, decisions, evidence coverage, confidence, and critical path where available.

Insights should wait until step enrichment is complete rather than presenting metrics that change while the user reads them. A partial or failed enrichment state must state that reported findings are a floor, not a complete assessment.

#### Automations

Automations answers “What might we build, and what evidence should inform it?” It lists analyzed automation opportunities from the current process flow and provides a deterministic, copyable brief for each one without spending an additional AI call.

Each brief should include the opportunity type and confidence, the steps it covers, upstream and downstream context, decision branches, current actors and systems, expected benefit, prerequisites, reported friction and risks, and what the evidence does not establish. The tab must explain stale, incomplete, failed, and empty states, and it must not present fallback-derived candidates as build-ready briefs. Insights retains the automation signal and links to this dedicated surface rather than duplicating the recommendations.

### 3.4 Capture modes

Fabric supports three capture modes, exposed directly from the process header:

1. **AI Interview** — a voice agent conducts a semi-structured interview and asks follow-up questions.
2. **Voice Record** — the browser records one or more people without an AI interviewer.
3. **Audio Upload** — a contributor uploads an existing audio file, subject to audio-type validation and a 100 MB client-side limit.

The three actions must remain clear and directly accessible across responsive layouts rather than hiding secondary capture modes behind a menu.

The entry step confirms the contributor identity and presents concise, mode-appropriate recording/content notices.

For Voice Record and Audio Upload, the shared pipeline is:

`upload → diarized transcription → speaker-label review → normalized analysis → overview/flow refresh`

Analysis must not begin until speaker labels are submitted. Closing an unfinished capture before approval should remove its retained audio and conversation record when it is safe to do so.

### 3.5 Pipeline behavior

Completed capture should automatically start eligible downstream work; users should not need to discover a second “generate” action after providing evidence.

The product must:

- normalize analysis output from all capture modes into a shared evidence contract;
- generate a conversation title and analysis before refreshing higher-level artifacts;
- prevent duplicate concurrent runs for the same artifact;
- expose meaningful progress rather than an indefinite spinner;
- recover stale runs through a watchdog;
- retry only the failed stage where possible;
- distinguish truncation from invalid structured output; and
- preserve the last valid artifact until a replacement succeeds.

### 3.6 PDF report

Users can download a client-generated process report containing the overview, key metrics, a readable step sequence, step detail, and insights. The report must use the same current artifacts and derivation rules as the application so numbers and findings do not disagree between surfaces.

### 3.7 Administration

The organization admin console provides:

- workspace health and recent-conversation indicators;
- member roles, duplicate-safe invitations with clear member/pending feedback, and protected removal flows;
- an org-wide searchable conversation table with stage-aware retry and confirmed deletion;
- filtered CSV export with contributor attribution; and
- organization appearance generation, approval, and reset.

The platform tenant console provides tenant-level AI usage and estimated cost views, including daily and cumulative cost trends, date, environment, provider, model, feature, and organization breakdowns plus export. Usage reporting must explicitly identify known coverage gaps rather than implying invoice-grade completeness.

### 3.8 Public landing experience

Unauthenticated visitors see a responsive product landing page with clear positioning and representative product demonstrations. Authenticated users should transition to their organization workspace without ambiguity.

## 4. Product requirements

### 4.1 Evidence and synthesis

- Conversation, process, department, and function artifacts must remain traceable to their source evidence.
- Overview generation must be deterministic in structure even when wording varies.
- New evidence marks dependent artifacts stale or unread and schedules eligible refresh work.
- Manual build or rebuild is available only when a usable source exists and an artifact is missing, unread input is available, or an operational retry or override is justified.
- Deleted completed evidence triggers regeneration; deleting the last completed conversation clears derived process artifacts.
- Summaries must communicate disagreement and missing evidence instead of manufacturing consensus.

### 4.2 Reliability

- Pipeline state is persisted so refreshes and reconnects do not lose progress.
- Duplicate triggers join or no-op against the active run.
- Duplicate or concurrent invitation submissions must not create multiple pending invitations for the same workspace and email address.
- Stalled runs are detected and resolved without manual database repair.
- Partial completion is represented explicitly and can be retried at the smallest safe unit.
- Destructive flows are idempotent where practical and reconcile dependent artifacts.

### 4.3 Security, privacy, and tenancy

- All domain records carry an organization identity and all access is tenant-scoped.
- Clerk provides identity and organization membership; Fabric maintains application role and profile data.
- Audio access uses short-lived authorized delivery rather than public storage URLs.
- Secrets and provider credentials remain server-side.
- Fabric-owned AI inference uses Microsoft Foundry only and fails closed when its configuration is missing or invalid rather than routing to an external provider.
- AI telemetry stores operational metadata but not prompt or response content.
- Description inputs are screened before being used in AI-facing workflows.
- Production and development credentials, deployments, and tenant data remain separated.

### 4.4 Accessibility and responsive behavior

- All core journeys work with keyboard navigation and visible focus states.
- Status is communicated with text as well as color.
- Dialogs, sheets, and graph controls expose accessible names and predictable focus behavior.
- The workspace, capture flow, overview, conversations, and admin surfaces remain usable on mobile.
- Motion respects reduced-motion preferences.

### 4.5 Observability and cost

- Every Fabric-owned AI request records provider, model/deployment, feature, environment, organization, latency, outcome, token usage where available, and request identifiers.
- ElevenLabs agent and transcription usage is recorded using the best available billable unit and a versioned price snapshot.
- Usage reports separate raw usage, estimated list cost, and known unmetered or delayed charges.
- Cost trend views show both daily spend and a cumulative total scoped to the selected date range.
- Retry attempts are attributable without double-counting successful work.

## 5. Success measures

The product is successful when:

1. A new contributor can find a process and begin the correct capture mode without training.
2. A typical capture reaches a usable process overview automatically and makes its processing state understandable throughout.
3. Readers can trace important claims and process steps back to source conversations.
4. The Overview, Process Flow, Insights, and PDF agree on evidence, status, and derived findings.
5. A maker can copy an automation brief that distinguishes supported findings from gaps and omits incomplete step details.
6. Admins can identify and recover failed processing without engineering intervention.
7. New evidence refreshes the right artifacts without unnecessary AI calls.
8. Cross-tenant access tests remain negative across user, admin, export, audio, and metering paths.
9. Platform operators can attribute the large majority of variable AI spend to a tenant and product feature, with gaps clearly disclosed.

## 6. Scope and roadmap

### 6.1 Shipped product baseline

- Multi-tenant Function → Department → Process workspace
- AI interview, direct voice recording, and audio upload capture
- Diarized transcription and required speaker labeling
- On-behalf contributor attribution and conversation titles
- Evidence-backed Overview V2 at process, department, and function level
- Staged Process Flow V3 generation with automatic pipeline start and recovery
- Interactive process-flow layout, orientation, entry-point framing, focus, and keyboard controls
- Derived Insights, copyable automation build briefs, and client-side PDF reporting
- Organization administration, branding, appearance preferences, invitations, exports, retries, and hardened deletion
- Tenant-level AI usage and daily/cumulative estimated-cost reporting
- Microsoft Foundry-only AI processing in provisioned development and production environments
- Public marketing landing page

See [Product delivery history](docs/product-delivery-history.md) for dated changes.

### 6.2 Current operational work

- Close known metering coverage gaps and reconcile estimates against provider billing.
- Validate the latest process-flow interaction changes across representative large and branching flows.

### 6.3 Future scope

- Natural-language search and question answering across captured organizational knowledge
- Cross-process and cross-functional discovery beyond the current hierarchy overviews
- Lifecycle workflows for review, ownership, and scheduled recertification of process knowledge
- Deeper improvement planning and automation-solution workflows after evidence quality is proven

### 6.4 Explicit non-goals for the current baseline

- Fabric is not an authoritative workflow execution engine.
- Generated findings are not automatically approved policy or compliance evidence.
- Usage estimates are not a replacement for provider invoices.
- Fabric does not infer speaker identity from voice biometrics.
- The PRD is not the source of truth for deployment commands, database field definitions, or sprint task tracking.

## 7. Open product decisions

1. What evidence threshold should qualify an overview or flow as sufficiently covered for executive use?
2. Who owns periodic review of stale process knowledge, and what notification model should support it?
3. Which process findings may be promoted into tracked improvement initiatives, and where should that workflow live?
4. What retention controls should organizations have for source audio versus transcripts and derived artifacts?

---

Detailed technical plans and completed implementation checklists belong in `docs/`; active delivery work should be tracked in the team's issue system rather than appended to this PRD.
