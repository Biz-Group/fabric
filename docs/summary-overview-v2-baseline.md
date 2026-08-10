# Summary Overview V2 — Phase 0 Baseline and Contract Record

Date: 2026-08-05  
Repository anchor: `3c3f103`  
Runtime baseline: Node `v24.15.0`, npm `11.18.0`

This record freezes the inputs to Phases 0 through 2. The reference design remains
[summary-overview-v2-plan.md](summary-overview-v2-plan.md), and the execution
sequence remains
[summary-overview-v2-task-list.md](summary-overview-v2-task-list.md).

## Product-decision check

No deviations were approved or introduced in Phases 0 through 2. Two later
deviations apply to what this document records. Product Decision 8 (2026-08-07):
the process Overview carries non-sequential scope and participant findings
instead of an ordered stage timeline, and the prompt/cap tables below reflect it.
Product Decision 10 (2026-08-09): every generation is a human action, so the
automatic post-conversation and refresh-on-view behaviour described below now
only marks summaries stale.

- Overview owns understanding: headline, brief, scope and participants,
  agreement, variations, gaps, notable context, evidence coverage, and
  freshness. It states no step order (Product Decision 8).
- Process Flow owns inspection: topology, branches, node detail, and evidence at
  the step level.
- Process Insights owns improvement: bottlenecks, handoffs, tools, risks,
  confidence, and automation opportunities.
- V2 remains interview-first. It does not claim event-log frequency,
  conformance, throughput, or measured rework.
- Existing Process Flow and Process Insights rows are not regenerated.
- Existing Markdown stays readable and remains the active runtime output until a
  later gated phase switches generation and presentation.

## Current behavior locked as the compatibility baseline

| Behavior | Current implementation | Baseline to preserve |
|---|---|---|
| Automatic process summary | [`postCall.ts`](../convex/postCall.ts) | Coalesced regeneration merges the previous Markdown summary with the latest completed transcript. Failure or truncation retains the prior summary. |
| Manual process rebuild | [`postCall.ts`](../convex/postCall.ts) | Force refresh reuses or backfills per-conversation Markdown map records, then performs one reduce over at most 50 completed conversations. |
| Department summary | [`summaries.ts`](../convex/summaries.ts), [`summariesHelpers.ts`](../convex/summariesHelpers.ts) | Public and cascade paths summarize child process Markdown, cache the result, and clear `summaryStale` on success. |
| Function summary | [`summaries.ts`](../convex/summaries.ts) | Refresh may generate missing child department summaries, then summarizes department Markdown and caches the result. |
| Staleness | [`summariesHelpers.ts`](../convex/summariesHelpers.ts) | Process evidence changes stale the department and cascade staleness to the function. Existing content remains readable. |
| Deletion and reparenting | [`conversations.ts`](../convex/conversations.ts), [`processes.ts`](../convex/processes.ts), [`cleanup.ts`](../convex/cleanup.ts) | Removing evidence rebuilds or clears process output as appropriate, invalidates rollups, and deletes or stales related Flow data. Moving a process invalidates both old and new parents. |
| Process Flow | [`processFlows.ts`](../convex/processFlows.ts), [`flowStages.ts`](../convex/lib/flowStages.ts) | The V3 staged graph/detail/insight pipeline, retained-flow failure behavior, generation ownership, and staleness remain unchanged. Flow generation still has its existing 50-conversation cap. |
| Process Insights | [`insights-derivations.ts`](../src/features/insights/insights-derivations.ts), [`process-insights-tab.tsx`](../src/features/insights/process-insights-tab.tsx) | Insights are derived from ready Process Flow topology and described node details; they do not make a second summary call. |
| Copy | [`process-summary-panel.tsx`](../src/features/workbench/process-summary-panel.tsx) | The active Markdown summary string is copied verbatim. |
| PDF | [`build-process-pdf-data.ts`](../src/features/workbench/process-pdf/build-process-pdf-data.ts), [`process-pdf-document.tsx`](../src/features/workbench/process-pdf/process-pdf-document.tsx) | The report orders summary, flow/steps, then derived insights. V2 PDF work is intentionally deferred. |
| AI adapter and usage | [`aiProvider.ts`](../convex/lib/aiProvider.ts), [`aiUsageMeter.ts`](../convex/lib/aiUsageMeter.ts) | Provider retries, truncation rejection, token accounting, latency measurement, and per-operation attribution remain the shared mechanism. |

## Locked contracts

The TypeScript and Convex validator source of truth is
[`summaryV2.ts`](../convex/summaryV2.ts). It defines:

- `SummarySourceRef`, with strict conversation, process, and department union
  branches.
- `SummaryFinding`, `SummaryCoverage`, and `SummaryProvenance`.
- Process, department, and function V2 artifacts with level-specific sections.
- Structured per-conversation evidence and its cache metadata.
- Typed summary entities, run state, progress, errors, and bounded chunk output.
- The future public overview response contract and the compatibility-read
  result.

Prompt IDs are immutable once used:

| Stage | Locked prompt version |
|---|---|
| Conversation evidence | `summary-v2-conversation-evidence-v1` |
| Process overview | `summary-v2-process-overview-v2` |
| Department overview | `summary-v2-department-overview-v1` |
| Function overview | `summary-v2-function-overview-v1` |
| Deterministic Markdown projection | `summary-v2-legacy-markdown-v2` |

Configured persistence caps:

| Output | Cap |
|---|---:|
| Any finding group, including process scope | 8 |
| Sources on one finding | 8 |
| Headline / finding title | 120 characters |
| Finding body | 1,200 characters |
| Executive brief | 1,800 characters |
| Conversation steps | 40 |
| Each other conversation-evidence group | 20 |
| Conversation sources per reduce chunk | 20 |

Initial V2 AI budgets are also locked in the contract module: evidence
extraction `1,536 / 120,000 / 2`, chunk reduction `4,096 / 150,000 / 2`, and
final reduction `3,072 / 120,000 / 2` for max tokens, timeout milliseconds, and
retries respectively. Every V2 synthesis request will use temperature `0` and a
strict tool schema when generation is implemented.

## Source resolution and factual rejection

The model receives short source keys such as `C1`, `P2`, and `D3`, never Convex
IDs. The application supplies the only valid key map for a generation snapshot.
Normalization then applies these rules in order:

1. Resolve a returned key only when it exists in that supplied map.
2. Deduplicate repeated keys by source kind and typed ID, then cap the resolved
   sources at eight.
3. Derive `supportCount` and corroboration from the unique resolved sources;
   never trust model-provided counts.
4. Drop any factual finding that has no valid resolved source.
5. Permit a sourceless `inferred_gap` only when its title or body explicitly
   describes missing, unknown, unclear, unconfirmed, or insufficient evidence.
6. Deduplicate findings within a section by normalized title plus sorted source
   set, discard unsupported output fields, and apply all caps before persistence.

The deterministic legacy Markdown projection is generated only from the
normalized artifact. It cannot reintroduce rejected model fields or source keys.

## Synthetic fixtures

The fixtures in
[`testFixtures/summaryV2.ts`](../convex/testFixtures/summaryV2.ts) cover:

- One contributor.
- Multiple agreeing contributors.
- Contradicting contributors without selecting a canonical account.
- Explicit uncertainty, a missing step, and an unsupported factual claim.
- A 45-conversation process that requires three 20-source reduce chunks.
- Department/function rollups with current, stale, and missing children.

The fixture test rejects email-like strings and organization-ID patterns. All
names are synthetic labels such as “Contributor A”; no source text was copied
from a tenant or interview.

## Pre-change verification baseline

All commands ran before Phase 1 schema changes.

| Command | Result |
|---|---|
| `npm test` | Passed: 26 files, 340 tests. Duration 11.37 seconds. |
| `npm run lint` | Passed with no findings. |
| `npm run build` | Passed: compile 19.8 seconds, TypeScript 24.6 seconds, 12 static pages generated. |
| Focused summary/read-model command | Passed: 4 files, 24 tests. Duration 3.48 seconds. |

The test runner emitted its existing negative-timeout warning. The production
build emitted its existing workspace-root warning because lockfiles exist both
above the repository and in the repository. Neither warning was introduced by
Summary V2.

## Starting throughput, usage, and latency record

The repository's latest measured synthesis throughput sample, stored in
[`aiProvider.ts`](../convex/lib/aiProvider.ts), is dated 2026-07-17:

- Deployment: `fabric-claude-haiku-4-5`.
- Worst observed generation rate under four-way concurrency: 65 tokens/second.
- Worst observed time to first token: 4,000 milliseconds.
- Budget calculation applies a 0.5 safety factor.

Current generation request ceilings are:

| Operation | Current max tokens | Timeout | Budget observation |
|---|---:|---:|---|
| Conversation map record | 1,024 | 120 seconds | Inside the measured safety budget. |
| Process full reduce | 4,096 | 150 seconds | Inside the measured safety budget. |
| Process incremental summary | 8,192 | Default 120 seconds | Above the measured safety budget. |
| Department public/cascade summary | 8,192 | Default 120 seconds | Above the measured safety budget. |
| Function summary | 8,192 | Default 120 seconds | Above the measured safety budget. |

The usage ledger records provider-reported input/output/cache tokens and
wall-clock `latencyMs` by operation. A read-only, aggregate-only query of the
configured development deployment for 2026-07-06 through 2026-08-05 found zero
events for `conversation-summary-input`, `process-summary-incremental`,
`process-summary-reduce`, `department-summary`,
`department-summary-cascade`, or `function-summary`. The starting development
sample is therefore zero calls, zero tokens, and no latency observation. No
tenant IDs, entity labels, or raw ledger rows were printed or copied. The
measured throughput sample and request ceilings above remain the useful
performance baseline; a redacted non-empty production operation sample remains
a Phase 10 rollout measurement.

## Phase 1 compatibility boundary

Phase 1 may add optional fields, new tables, normalizers, metadata projections,
and tests. It must not enable V2 generation, schedule new AI work, regenerate
Process Flow, change Process Insights derivations, or move the UI away from its
current Markdown fields. Existing rows without any V2 fields must validate and
render as before.

## Phase 1 final verification

Verification after the Phase 1 implementation:

| Command | Result |
|---|---|
| `npm test` | Passed: 28 files, 365 tests. |
| `npm run lint` | Passed with no findings. |
| `npm run build` | Passed with the same pre-existing multi-lockfile workspace-root warning. |
| Focused summary/read-model command | Passed: 4 files, 26 tests; the two additions cover process summary timestamps and optional V2-to-Flow provenance. |
| Focused V2/schema/read/Flow/isolation command | Passed: 5 files, 97 tests. |

No existing Process Flow, Process Insights, or PDF expectation had to be changed.
The Flow pipeline received only an optional snapshot pass-through: a natural
future generation records the V2 overview hash/version it actually used, while a
legacy generation records no snapshot and all legacy rows stay valid.

## Phase 2 implementation and verification

Phase 2 enables reusable structured evidence per completed conversation while
leaving the final process, department, and function summaries on their current
legacy fields and prompts.

- [`conversationEvidenceV2.ts`](../convex/lib/conversationEvidenceV2.ts) owns the
  evidence prompt, strict tool schema, deterministic request, opaque stable
  source keys, cache predicate, and bounded normalizer.
- [`summaryEvidence.ts`](../convex/summaryEvidence.ts) owns tenant-scoped reads
  and stale-safe writes, paginated preparation, coalescing, failure markers, and
  the ordered handoff to legacy summary reduction.
- Conversation evidence uses the locked `1,536 / 120,000 / 2` budget and
  temperature `0`. OpenRouter and both Foundry synthesis backends receive the
  same strict schema.
- Cache validity requires both the current transcript hash and the immutable
  evidence prompt version. Speaker relabeling therefore invalidates evidence;
  a late response for an older transcript is discarded.
- The legacy Markdown map remains dual-written. Both extraction stages attach
  the conversation entity and shared preparation generation ID to usage.
- A bounded failure marker prevents an invalid response from looping within one
  generation while retaining any last successful evidence. A later generation
  retries it.

Final verification:

| Command | Result |
|---|---|
| `npx convex codegen` | Passed; generated bindings include the Phase 2 module and schema. |
| Focused Phase 2 command | Passed: 3 files, 29 tests. |
| `npm test` | Passed: 30 files, 379 tests. |
| `npm run lint` | Passed with no findings. |
| `npm run build` | Passed with the same pre-existing multi-lockfile workspace-root warning. |

The focused coverage includes request shape on OpenRouter, Foundry Claude, and
Foundry OpenAI; cache invalidation; malformed and truncated output; stale saves;
speaker labels; deletion; tenant isolation; usage attribution; and concurrent
preparation-gate coalescing. Existing Flow, Insights, Copy, and PDF behavior was
not rebuilt or redirected in this phase.

## Phase 3 implementation and verification

Phase 3 adds the feature-flagged process overview reducer while preserving the
legacy reducer as the default and rollback path.

- [`processOverviewV2.ts`](../convex/lib/processOverviewV2.ts) owns the strict
  seven-field overview contract, deterministic prompts, source-safe chunk
  projection, exact snapshot hashing, and the locked chunk/final budgets.
- [`processSummaryV2.ts`](../convex/processSummaryV2.ts) owns the coalesced,
  durable run. It scans all completed conversations in bounded pages, assigns
  contiguous creation-ordered `C1..Cn` keys to current evidence, partitions
  inputs into chunks of 20, and makes at most one model request per action.
- Final publication source-resolves the model payload and writes `summaryV2`
  with deterministic legacy Markdown atomically. Source revisions and
  generation ownership prevent late or superseded results from publishing.
- Run rows expose progress, exact coverage, partial/failure state, and the last
  bounded error. The watchdog resumes stale scans or reduce stages; cleanup
  removes superseded run chunks in bounded batches.
- `SUMMARY_V2=true` routes manual post-evidence handoffs to V2. Unset or
  `false` retains the Phase 2 compatibility path and its legacy incremental
  reducer. The automatic handoff this originally covered was removed by Product
  Decision 10.
- Process Flow and Process Insights generation remain unchanged. A successful
  V2 save invokes the existing Flow staleness rule, and a regression test
  confirms an unchanged eligible conversation count does not stale a ready
  Flow.

Final verification:

| Command | Result |
|---|---|
| `npx convex codegen` | Passed; generated bindings include the process run pipeline and Phase 3 schema additions. |
| Focused Phase 3 command | Passed: 2 files, 17 tests. |
| `npm test` | Passed: 32 files, 396 tests. |
| `npm run lint` | Passed with no findings. |
| `npm run build` | Passed with the same pre-existing multi-lockfile workspace-root warning. |

The Phase 3 coverage includes direct reduction, partial evidence, 55-source
three-chunk reduction, exact coverage, agreement/variation/uncertainty,
retry/resume/cleanup, invalid and truncated output, request and late-write
supersession, in-flight feature rollback, source relabel/deletion invalidation,
stable Markdown, usage attribution, feature routing, and unchanged Flow
staleness behavior.

## Phase 4 implementation and verification

Phase 4 extends the feature-gated durable run model to department and function
rollups without changing or migrating existing hierarchy rows.

- [`hierarchyOverviewV2.ts`](../convex/lib/hierarchyOverviewV2.ts) is the
  canonical owner of both strict tool schemas, prompts, bounded request
  builders, child-state classification, and exact hierarchy snapshot hashing.
  Prompt projections deliberately remove every persisted child/evidence ID.
- [`hierarchySummaryV2.ts`](../convex/hierarchySummaryV2.ts) owns department and
  function coalescing, paginated child scans, durable progress, exact coverage,
  final reduction, retries, supersession, cleanup, and watchdog recovery.
- Department snapshots contain every eligible process and its current,
  partial, refreshing, stale, missing, or failed state. Only current or
  explicitly partial V2 artifacts enter the model input; omitted children keep
  the saved department artifact partial.
- Function runs schedule stale/missing department runs separately, wait for
  them to settle, and start a fresh function generation when a successful child
  refresh changes the parent revision. No enabled-path action executes a
  sequential multi-department LLM cascade.
- Successful hierarchy artifacts and their deterministic legacy Markdown are
  saved atomically. A function is complete only when every eligible department
  is included and current. Forced department rebuilds invalidate a current
  function even when the child snapshot hash is unchanged.
- Create, delete, move, rename, last-child removal, and concurrent refresh paths
  increment monotonic hierarchy revisions. Deleted hierarchy entities schedule
  bounded run/chunk cleanup.
- Existing rows remain valid because every new entity/run/chunk field is
  optional. No backfill or data migration is required; unset/false
  `SUMMARY_V2` retains the legacy hierarchy actions and cascade.

Final verification:

| Command | Result |
|---|---|
| `npx convex codegen` | Passed; generated bindings include hierarchy rollup functions and additive schema fields. |
| Focused Phase 4 command | Passed: 3 files, 18 tests. |
| `npm test` | Passed: 34 files, 410 tests. |
| `npm run lint` | Passed with no findings. |
| `npm run build` | Passed with the same pre-existing multi-lockfile workspace-root warning. |

The focused coverage includes strict ownership schemas and budgets, exact hash
sensitivity, mixed process and department states, explicit partial coverage,
child refresh success/failure, no stale-child reuse, forced invalidation,
coalescing, late-write rejection, lifecycle invalidation, usage attribution,
and cross-organization prompt/result isolation.

## Phase 5 implementation and verification

Phase 5 adds the unified public overview lifecycle without changing the visible
Overview, Process Flow, or Process Insights presentation.

- [`summaries.ts`](../convex/summaries.ts) now provides the discriminated
  `getOverview`, `ensureCurrent`, and `forceRefresh` API. Reads authenticate the
  active organization, reject cross-tenant entity IDs as not found, prefer V2
  content, and fall back to the existing Markdown artifact.
- The read state is derived from durable runs, generation gates, source
  revisions, coverage, and the last terminal failure. A prior artifact remains
  present for both `refreshing` and `failed` states.
- Process-only Flow and Insights projections contain exactly `available`,
  `stale`, and `generationStatus`. No graph nodes, node detail, counts, metrics,
  bottlenecks, or automation opportunities cross the API boundary.
- `ensureCurrent` is available to viewers as well as contributors/admins. It
  checks current, active, and failed-same-revision work inside the scheduling
  transaction, preventing duplicate viewer spend for one source snapshot.
  `forceRefresh` uses the same coalescing gates after contributor authorization.
- The existing department/function/process generation actions continue to
  return their legacy shapes and schedule the feature-gated V2 pipeline.
- [`use-ensure-current-summary.ts`](../src/features/workbench/use-ensure-current-summary.ts)
  observes only the hierarchy overview currently open in the workbench and
  calls `ensureCurrent` once per stale source key. It does not alter rendered
  content or any Flow/Insights trigger.

Final verification:

| Command | Result |
|---|---|
| `npx convex codegen` | Passed; generated bindings include all three public summary lifecycle functions. |
| Focused Phase 5 command | Passed: 2 files, 7 tests. |
| `npm test` | Passed: 36 files, 417 tests. Existing negative-timeout warnings remain unchanged. |
| `npm run lint` | Passed with no findings. |
| `npm run build` | Passed with the same pre-existing multi-lockfile workspace-root warning. |

The Phase 5 coverage includes V2 and legacy reads, all six public states,
retained artifacts, progress/error projection, viewer/contributor/admin and
unauthenticated authorization, tenant isolation, in-flight and terminal
same-source idempotency, bounded Flow/Insights responses, once-per-snapshot
client keys, and compatibility for all three existing generation actions.

## Phase 6 implementation and verification

Phase 6 replaces the process Markdown panel with the unified process Overview
surface while leaving Process Flow and Process Insights generation unchanged.

- The visible tab is now Overview. The URL continues to accept the legacy
  `tab=summary` token and the explicit `tab=overview` alias, while the canonical
  default URL omits the tab token.
- The duplicate process-name hero was removed after desktop review. The compact
  status/action/provenance toolbar is followed directly by Overview for V2
  content or Compatibility view for legacy content. Former eyebrow labels are
  now semantic section headings.
- V2 content renders the executive brief, exact evidence coverage, scope and
  participants, reported practice, evidence alignment, and notable context. Evidence
  strength is explicit in text rather than color alone.
- Conversation evidence chips open the Conversations tab, clear incompatible
  filters, select and reveal the exact source, and transfer keyboard focus.
- Flow and Insights appear only as readiness-aware navigation destinations; no
  owned graph, metric, bottleneck, automation, handoff, tool, or node detail is
  duplicated into Overview.
- Refresh and failure states retain prior content. Manual Build/Refresh/Rebuild
  remains contributor/admin-only, and Copy uses the deterministic Markdown
  projection returned by the unified API.
- Mobile previews now show state, coverage, brief, and generated time without
  repeating the process name already present in the sheet header.

Verification:

| Command | Result |
|---|---|
| Focused Phase 6 command | Passed: 3 files, 27 tests. |
| `npm test` | Passed: 39 files, 444 tests. Existing negative-timeout warnings remain unchanged. |
| `npm run lint` | Passed with no findings. |
| `npm run build` | Passed with the same pre-existing multi-lockfile workspace-root warning. |
| Signed-in browser visual QA | Pending: the in-app browser was unavailable in this session. |

Automated coverage includes all six lifecycle states, legacy fallback,
structured content ownership, deterministic navigation-only readiness,
source-button semantics and routing, action permissions, maximum finding/body/name
stress, responsive/theme class hooks, and legacy URL
compatibility. Interactive desktop/tablet/mobile and dark/accent visual checks
remain open before the Phase 6 exit gate can be signed off.

## Phase 7 implementation and verification

Phase 7 replaces the department and function Markdown cards with unified,
hierarchy-specific Overview surfaces.

- The shared control header, lifecycle notice, provenance, evidence-strength,
  finding, source-chip, and section primitives now serve process, department,
  and function views.
- Department overviews render cross-process dependencies, shared patterns,
  variations/tensions, knowledge gaps, and notable context. Function overviews
  render cross-department dependencies, strategic patterns, variations/
  tensions, gaps, and context.
- Each hierarchy overview presents artifact-time inclusion counts separately
  from a current child-state ledger. The ledger supports current, stale,
  refreshing, partial, missing, and failed states, exact child coverage where
  available, generated time, and keyboard-native navigation.
- Lightweight summary list metadata now projects refreshing and failed states
  and detects process V2 staleness from evidence/source revisions. It remains
  bounded and omits full artifacts and run details.
- Finding sources and child rows open the owning process or department through
  the existing workbench selection model. No new URL token or route was added.
- Stale hierarchy overviews keep their previous successful artifact visible and
  wait for Rebuild; progress is announced with the child unit while a rebuild
  runs. The once-per-source refresh-on-view hook this originally described was
  removed by Product Decision 10.
- Manual force refresh is contributor/admin-only. Legacy and missing states
  remain readable and honest about unavailable inclusion data.
- Function and department mobile sheets now show the unified compact brief,
  state, coverage, and generated time instead of the legacy Markdown renderer.

Verification:

| Command | Result |
|---|---|
| `npx convex codegen` | Passed; generated bindings reflect the six-state lightweight metadata projection. |
| Focused Phase 7 command | Passed: 5 files, 46 tests. |
| `npm test` | Passed: 40 files, 454 tests. Existing negative-timeout warnings remain unchanged. |
| `npm run lint` | Passed with no findings. |
| `npm run build` | Passed with the same pre-existing multi-lockfile workspace-root warning. |
| Signed-in browser visual QA | Pending: the in-app browser was unavailable in this session. |

Automated coverage includes department/function content ownership, exact parent
coverage wording, all six child states, source routing, permission boundaries,
retained refresh content and progress, legacy/missing/failed behavior, compact
mobile content, empty and single-child rollups, and an 80-child long-name stress
case. Interactive visual hierarchy verification remains open before the Phase
7 exit gate can be signed off.
