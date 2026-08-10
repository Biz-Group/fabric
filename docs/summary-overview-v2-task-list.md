# Fabric Summary and Overview V2 Task List

Status: Phase 9 complete; Phase 10–11 engineering complete, live enablement,
human review, visual QA, and the soak open  
Created: 2026-08-05  
Reference design: [summary-overview-v2-plan.md](summary-overview-v2-plan.md)  
Primary goal: ship structured, evidence-backed process, department, and function
overviews while preserving Process Flow V3 and keeping Process Insights focused
on diagnosis and improvement.

## Implementation Principles

- Read `convex/_generated/ai/guidelines.md` before every Convex implementation
  phase.
- Read the relevant Next.js 16 documentation in `node_modules/next/dist/docs/`
  before changing routing, search parameters, or client/server boundaries.
- Preserve unrelated worktree changes and the untracked automation portfolio
  plan.
- Make every LLM output structured, validated, bounded, and source-resolved
  before persistence.
- One scheduled action makes at most one LLM request.
- Retain the last successful artifact during refreshes and failures.
- Treat interview evidence as reported knowledge, never measured execution.
- Preserve the existing Process Flow pipeline and stored rows.
- Enforce the ownership sequence: Overview understands, Flow inspects, Insights
  improves.
- Do not advance a phase until its exit gate passes.

## Phase 0: Baseline, Fixtures, and Contract Lock

Goal: establish a reproducible baseline and freeze the V2 contracts before
changing persistence or generation.

### Tasks

- [x] Re-read the reference plan and record any approved deviations in its
  Product Decisions section before implementing them.
- [x] Read the current summary, flow, insights, PDF, AI adapter, and usage-meter
  code paths end to end.
- [x] Confirm the existing behavior of:
  - [x] Automatic process summary regeneration.
  - [x] Manual process rebuild.
  - [x] Department/function generation and staleness.
  - [x] Summary deletion and reparenting cascades.
  - [x] Process Flow generation and staleness.
  - [x] Process Insights derivations.
  - [x] Legacy Markdown Copy and PDF export.
- [x] Capture representative anonymized fixtures for:
  - [x] One contributor.
  - [x] Multiple agreeing contributors.
  - [x] Contradicting contributors.
  - [x] Explicit uncertainty and missing steps.
  - [x] A long process requiring multiple reduce chunks.
  - [x] Department/function rollups with missing or stale children.
- [x] Add TypeScript-only contract definitions for review:
  - [x] `SummarySourceRef`.
  - [x] `SummaryFinding`.
  - [x] `SummaryCoverage`.
  - [x] `SummaryProvenance`.
  - [x] Process, department, and function V2 artifacts.
  - [x] Summary run state and public overview response.
- [x] Lock prompt-version identifiers and configured caps.
- [x] Document the source-key resolution rule and the factual-finding rejection
  rule.
- [x] Record a starting usage/latency sample for current process, department,
  and function generation.

### Verification

- [x] Run `npm test` and record the baseline.
- [x] Run `npm run lint` and separate pre-existing failures from new failures.
- [x] Run `npm run build` and record the baseline.
- [x] Run the focused 24-test summary/read-model suite from the design review.
- [x] Confirm no source fixture contains sensitive or tenant-identifying data.

### Exit gate

- [x] Contracts, caps, prompt versions, fixtures, and baseline results are
  reviewed and implemented without changing user-facing runtime behavior.

Phase 0 result: complete in the working tree. No repository commit was created
because committing was not requested. The recorded development usage window had
zero matching summary operations; the measured provider throughput baseline is
retained in the baseline document.

## Phase 1: Schema, Validators, and Compatibility Reads

Goal: make the database and read layer understand V2 while every existing row
and UI continues to work unchanged.

### Tasks

- [x] Add shared Convex validators for evidence level, source references,
  findings, coverage, provenance, and each level-specific artifact.
- [x] Add optional `summaryV2` to functions, departments, and processes.
- [x] Add structured conversation evidence plus transcript hash, prompt version,
  generated time, provider, and model.
- [x] Add a process summary generated timestamp if it is not fully represented
  by V2 provenance.
- [x] Add `summaryRuns` with entity discriminator, typed entity ID, generation
  ID, snapshot, state, progress, error, timestamps, and retry/resume metadata.
- [x] Add `summaryChunks` with bounded intermediate output and run indexes.
- [x] Add optional source-snapshot provenance to new Process Flow generations;
  keep it optional for legacy rows.
- [x] Implement pure normalizers that:
  - [x] Enforce array and string caps.
  - [x] Deduplicate semantically identical returned items by normalized title
    and source set.
  - [x] Resolve only supplied source keys.
  - [x] Reject unsupported factual findings.
  - [x] Allow sourceless `inferred_gap` only when it is phrased as missing
    evidence.
  - [x] Produce deterministic legacy Markdown.
- [x] Add a compatibility reader that prefers V2 and falls back to the current
  Markdown fields.
- [x] Keep hierarchy list reads lightweight; return state/coverage metadata, not
  full artifacts.

### Tests

- [x] Schema validator tests for every union branch.
- [x] Normalizer tests for malformed payloads, invalid keys, duplicate keys,
  oversized output, unsupported fields, and empty sections.
- [x] Legacy reader tests for existing function, department, and process rows.
- [x] Convex index-name and tenant-isolation tests.
- [x] Document-size tests using maximum normalized artifacts.
- [x] Confirm no existing Flow, Insights, or PDF test changes are required yet.

### Exit gate

- [x] All existing application behavior and tests remain unchanged with V2
  generation disabled.

Phase 1 result: complete. V2 generation remains disabled because no generation
entrypoint uses the new artifacts or run tables yet. List queries omit full V2
artifacts and add only `summaryOverview` state/coverage metadata; selected-entity
reads and all legacy Markdown fields retain their existing shapes.

## Phase 2: Structured Conversation Evidence

Goal: replace Markdown map records with reusable, versioned, structured evidence
without changing the final user-facing summary yet.

### Tasks

- [x] Move conversation evidence prompts, tool schema, request construction, and
  normalizer into one shared module.
- [x] Define the structured evidence tool response for steps, actors, tools,
  dependencies, variations, friction, and uncertainty.
- [x] Use stable conversation source keys and temperature `0`.
- [x] Set the initial 1,536-token / 120-second / 2-retry budget.
- [x] Cache evidence only when transcript hash and evidence prompt version both
  match.
- [x] Regenerate evidence when a transcript changes or the prompt version
  advances.
- [x] Preserve the existing Markdown map record during transition where a legacy
  rebuild still needs it.
- [x] Change the post-conversation scheduling order so summary reduction cannot
  race ahead of required evidence extraction.
- [x] Ensure concurrent completed conversations coalesce without losing an
  evidence refresh.
- [x] Record stage-level usage with the current entity and generation ID.

### Tests

- [x] Tool-request shape and strict-schema tests across every configured AI
  backend.
- [x] Transcript-hash and prompt-version cache tests.
- [x] Extraction truncation and malformed-response tests.
- [x] Race tests for several conversations completing together.
- [x] Speaker-label and conversation-deletion regression tests.
- [x] Tenant-isolation tests for evidence reads and writes.

### Exit gate

- [x] New completed conversations reliably receive valid V2 evidence, and no
  user-facing summary behavior has regressed.

Phase 2 result: complete. Completed-conversation, transcript-refresh, manual
refresh, and deletion paths now enter a paginated preparation gate. It extracts
strict V2 evidence first, maintains the legacy Markdown map second, and only
then hands off to the existing summary reducer. Concurrent completions share one
generation; when more than one lands before reduction, the compatibility path
performs one full rebuild so the legacy incremental reducer cannot omit an
interview. Function, department, and process overview generation remains legacy
until Phase 3.

## Phase 3: Process Summary Run Pipeline

Goal: generate the process overview from the complete structured evidence set
and retire order-dependent incremental merging behind the feature flag.

### Tasks

- [x] Define the strict process overview tool schema containing only headline,
  brief, scope, consensus, variations, gaps, and notable findings. (`stages`
  became `scope` on 2026-08-07; see the Phase 9 amendment.)
- [x] Build stable `C1..Cn` source-key maps ordered by conversation creation
  time.
- [x] Implement exact source snapshot hashing over conversation IDs, transcript
  hashes, and evidence prompt versions.
- [x] Adapt the existing process coalescing gate to own a V2 summary run.
- [x] Query evidence with bounded pagination rather than a hard 50-row summary
  cap.
- [x] Partition evidence into deterministic chunks of 20.
- [x] Generate at most one chunk per scheduled action with the 4,096-token /
  150-second / 2-retry budget.
- [x] Generate the final artifact in its own action with the 3,072-token /
  120-second / 2-retry budget.
- [x] Validate and source-resolve the final artifact before saving it.
- [x] Save `summaryV2` and a deterministic legacy `rollingSummary` in one
  mutation.
- [x] Retain the previous successful artifact until the new artifact is saved.
- [x] Mark the parent department stale only when the saved process source
  snapshot changes.
- [x] Persist and expose progress, partial/failure state, and last error.
- [x] Add bounded cleanup of superseded run chunks.
- [x] Add watchdog/resume behavior consistent with Process Flow V3.
- [x] Switch automatic and manual process generation to the same V2 pipeline
  when `SUMMARY_V2` is enabled. (Automatic generation was removed on 2026-08-09;
  see the second Phase 9 amendment.)
- [x] Remove the old incremental merge from the enabled path, but retain it for
  flag rollback until rollout completes.

### Tests

- [x] One-source direct reduce.
- [x] Multi-source reduce with agreement, contradiction, and uncertainty.
- [x] More than 50 conversations with exact complete coverage.
- [x] Multi-chunk progress, retry, resume, and cleanup.
- [x] Concurrent requests and superseded-generation writes.
- [x] Truncated and invalid final output retains the old artifact.
- [x] Deleted or relabelled conversations change the source snapshot.
- [x] Legacy Markdown output is stable for identical artifacts.
- [x] Existing flow staleness behavior remains unchanged.

### Exit gate

- [x] V2 process artifacts pass deterministic tests and the process-level golden
  fixtures with exact source coverage.

Phase 3 result: complete. `SUMMARY_V2` is a deployment-level rollback switch
and remains off when unset. When enabled, automatic and manual refreshes share
one durable, coalesced process run that scans all eligible conversations,
reduces deterministic 20-source chunks, and atomically publishes the structured
artifact with its legacy Markdown projection. Previous successful content
remains visible through retries, failures, and superseded writes. Process Flow
generation and Insights derivation were not rebuilt; the existing Flow
staleness contract is unchanged.

## Phase 4: Department and Function Rollups

Goal: generate trustworthy hierarchy summaries without stale-child reuse or
single-action cascades.

### Tasks

- [x] Move all department/function prompts, tools, normalizers, and request
  builders into one canonical rollup module.
- [x] Implement department source snapshots over every eligible child process
  artifact and state.
- [x] Generate department artifacts from current process V2 inputs.
- [x] Save an explicitly partial department artifact when some children cannot
  be included; never silently omit them.
- [x] Mark the parent function stale whenever a department snapshot changes,
  including forced department rebuilds.
- [x] Implement function source snapshots over every eligible department.
- [x] Schedule stale/missing department refreshes as separate actions before the
  function reduce.
- [x] Remove the sequential multi-department LLM cascade from the enabled path.
- [x] Finalize a function as current only when every eligible department is
  current and included; otherwise label it partial with exact coverage.
- [x] Add run progress suitable for “Refreshing 2 of 4 departments” UI.
- [x] Add coalescing and superseded-run protection at department and function
  levels.
- [x] Use the same 3,072-token final-reduce budget and measured budget checks.

### Tests

- [x] Department rollup with current, stale, missing, and failed processes.
- [x] Function rollup with current, stale, missing, and partial departments.
- [x] Regression: a function cannot become current from a stale department.
- [x] Regression: forced department refresh invalidates a current function.
- [x] Create, delete, move, and rename hierarchy operations.
- [x] Concurrent refresh-on-view requests coalesce per entity.
- [x] Cross-org child IDs never enter prompts or results.

### Exit gate

- [x] Every rollup state and coverage count is correct under create, update,
  delete, move, failure, and force-refresh scenarios.

Phase 4 result: complete. Department and function generation now share one
strict hierarchy-overview contract and durable rollup pipeline when
`SUMMARY_V2` is enabled. Exact creation-ordered snapshots include every child
ID, label, artifact version, and state; stale or missing content is never reused
as current. Functions refresh stale/missing departments through separate jobs,
wait for those jobs to settle, and rescan before their only final model call.
Coverage remains explicitly partial whenever any eligible child is not current.
The legacy actions and sequential cascade remain available only on the disabled
flag path for rollback.

## Phase 5: Unified Overview APIs and Refresh-on-View

Goal: expose one bounded typed contract to all hierarchy overview surfaces.

### Tasks

- [x] Add `summaries.getOverview` with the discriminated process/department/
  function entity argument.
- [x] Return V2 or legacy fallback, state, coverage, progress, error, and last
  successful generation time.
- [x] Return only Flow/Insights availability and staleness metadata; explicitly
  omit nodes, node details, metrics, bottlenecks, and opportunities.
- [x] Add `summaries.ensureCurrent` for authenticated org members.
- [x] Make `ensureCurrent` idempotent by entity source snapshot and coalescing
  gate.
- [x] Add `summaries.forceRefresh` for contributors/admins.
- [x] Keep existing generation actions as adapters to the new pipeline.
- [x] Add a client hook that calls `ensureCurrent` once when a stale department
  or function snapshot is opened. (Superseded on 2026-08-09: the hook is
  read-only and nothing refreshes on view; see the second Phase 9 amendment.)
- [x] Do not clear or obscure the previous artifact during refresh.

### Tests

- [x] Member, contributor, admin, unauthenticated, and cross-org API tests.
- [x] Every public summary state.
- [x] Viewer refresh cannot create duplicate spend for an unchanged snapshot.
- [x] Public response is bounded and does not leak Flow/Insights detail.
- [x] Existing action compatibility tests.

### Exit gate

- [x] The complete overview lifecycle is available through one typed API without
  requiring UI changes or flow regeneration.

Phase 5 result: complete. `summaries.getOverview` now exposes one org-scoped,
bounded read model for process, department, and function overviews, including
V2/legacy compatibility content, all six lifecycle states, coverage, progress,
the latest applicable error, and last successful generation time. Process
responses expose only three-field Flow and Insights readiness metadata; their
owned graph, node, metric, bottleneck, and opportunity content never enters the
overview payload.

Authenticated members can call the non-forcing `ensureCurrent` mutation, while
`forceRefresh` remains contributor/admin-only. Both reuse the durable pipeline
gates transactionally. Repeated viewer calls neither advance a process evidence
revision nor retry a failed unchanged source snapshot; a deliberate force call
still coalesces with work already in flight. The workbench client hook observes
only the selected department/function overview and makes one ensure attempt per
stale source key. Existing content stays in the query result while the state is
`refreshing`, and all three legacy generation actions retain their response
shapes as V2 scheduling adapters.

## Phase 6: Process Overview UI

Goal: replace the process Markdown page with the layered operational brief.

### Tasks

- [x] Read the relevant Next.js documentation before changing URL tab tokens or
  search-parameter behavior.
- [x] Rename the visible “Process Summary” tab to “Overview” while preserving old
  deep-link compatibility.
- [x] Build shared overview state, provenance, evidence-strength, and source-chip
  primitives.
- [x] Implement the process header: brief, state, source mode,
  generated time, Copy, and Refresh/Rebuild.
- [x] Avoid repeating the process name/headline already owned by the workbench
  header; begin structured content at Overview and legacy content at
  Compatibility view.
- [x] Promote former eyebrow labels to semantic section headings.
- [x] Implement the evidence strip with included/eligible conversations, unique
  contributors, and completeness.
- [x] Implement the process scope and participants section. (Superseded the
  ordered stage timeline on 2026-08-07; see the Phase 9 amendment.)
- [x] Implement reported variations.
- [x] Implement consensus, gaps/tensions, and notable context.
- [x] Make conversation source chips open the Conversations tab and select the
  referenced conversation.
- [x] Add a slim Flow/Insights readiness footer containing navigation only.
- [x] Do not render Flow metrics, bottleneck cards, automation findings, tool
  summaries, handoff analysis, or node detail in Overview.
- [x] Add stale-while-refreshing, partial, failed-refresh, missing, and legacy
  fallback states.
- [x] Generate Copy output from the deterministic structured projection.
- [x] Implement mobile single-column ordering and compact preview content.
- [x] Add semantic headings, focus states, non-color-only labels, ARIA live
  refresh status, and reduced-motion behavior.

### Tests and verification

- [x] Component tests for V2, legacy, missing, stale, refreshing, partial, and
  failed states.
- [x] Source navigation and keyboard tests.
- [x] Contributor/admin action visibility and viewer behavior.
- [ ] Desktop, tablet, and mobile visual verification.
- [x] Long-content, long-name, and maximum-finding stress cases.
- [ ] Dark mode and tenant accent verification.

### Exit gate

- [ ] A viewer can understand the process, assess evidence coverage, and reach
  the owning conversation without encountering duplicated Insight content.

Phase 6 implementation result: complete in the working tree. The visible tab is
now Overview, legacy `tab=summary` links remain valid, the duplicate process
hero has been removed, and all content labels previously presented as eyebrows
are semantic section headings. Source chips clear incompatible conversation
filters, select the owning conversation, scroll it into view, and transfer
keyboard focus. The overview contains only reported process knowledge and a
navigation-only Flow/Insights footer. Automated UI/state/accessibility stress
coverage, the full test suite, lint, and production build pass. The in-app
browser was unavailable in this session, so signed-in desktop/tablet/mobile and
dark/accent visual checks remain open; the Phase 6 exit gate is intentionally
not marked complete until those checks are performed.

## Phase 7: Department and Function Overview UI

Goal: apply the same design system with hierarchy-specific content and coverage.

### Tasks

- [x] Reuse the shared overview header, state, coverage, and source primitives.
- [x] Render department cross-process dependencies, shared patterns,
  variations/tensions, gaps, and notable findings.
- [x] Render function cross-department dependencies, strategic patterns,
  variations/tensions, gaps, and notable findings.
- [x] Add child coverage tables with current, stale, refreshing, partial,
  missing, and failed state.
- [x] Make source/child actions navigate to the owning process or department.
- [x] Show automatic refresh progress without blocking the previous artifact.
- [x] Keep manual Rebuild contributor/admin-only.
- [x] Replace mobile full-Markdown previews with brief, coverage, state, and
  generated time without repeating the entity name already in the sheet header.

### Tests and verification

- [x] Empty, single-child, mixed-state, and large-hierarchy cases.
- [x] Refresh-on-view behavior and progress.
- [x] Child navigation and mobile touch targets.
- [ ] Visual hierarchy between executive brief and supporting findings.
- [x] Legacy fallback for ungenerated V2 rows.

### Exit gate

- [ ] Department and function overviews explain cross-child operation and exact
  coverage without pretending missing children were analyzed.

Phase 7 implementation result: complete in the working tree. Department and
function selections now render hierarchy-specific operational briefs backed by
the unified overview API. An exact artifact-level inclusion statement and
progress bar sit above a navigable child ledger whose rows show the current
state separately; this prevents a newly stale, refreshing, partial, missing, or
failed child from being represented as successfully analyzed. Lightweight list
metadata now preserves all six public lifecycle states without exposing full
artifacts or run detail. Both finding sources and child rows navigate to their
owning process or department. Stale rollups refresh on view while retaining the
previous artifact, and manual Build/Refresh/Rebuild remains contributor/admin
only. Mobile previews use the same brief, state, coverage, and provenance model
instead of legacy Markdown. Automated state, navigation, permission,
accessibility, empty/single/mixed/large hierarchy, legacy, and stress coverage
passes. The in-app browser remained unavailable, so signed-in visual hierarchy
verification is intentionally open and the Phase 7 exit gate is not marked
complete yet.

## Phase 8: Flow and Insights Complementarity

Goal: add navigation between surfaces and remove genuine duplication without
rewriting either feature.

### Tasks

- [x] Preserve Process Flow V3 generation prompts, stages, schemas, and storage.
- [x] Add an optional `node` deep-link token and focus/select the matching Flow
  node after navigation.
- [x] Add valid conversation-source navigation from Flow node detail where
  available.
- [x] Populate optional flow source-snapshot provenance on future generations.
- [x] Do not bulk-regenerate legacy flows.
- [x] Update Insights finding rows/cards to carry the owning node IDs.
- [x] Make bottleneck, handoff, decision, confidence, risk, and automation items
  open the matching Flow node.
- [x] Remove any repeated full node description from Insights; retain the
  diagnosis, evidence cue, and link.
- [x] Do not add summary stages or executive prose to Flow or Insights.
- [x] Keep existing legacy flow freshness logic until the next natural flow
  generation supplies an exact snapshot hash.

### Tests and verification

- [x] Existing flow generation/action tests pass unchanged except additive
  provenance assertions.
- [x] Legacy flow rows render and navigate normally.
- [x] Flow node deep links survive reload and invalid node IDs fail safely.
- [x] Every Insight link selects the correct node.
- [x] No new flow generation is scheduled by viewing or regenerating Overview.

### Exit gate

- [x] Overview, Flow, and Insights form a linked sequence without repeated
  detailed content or forced data regeneration.

Phase 8 result: complete. Flow node selection is now represented by an optional
refresh-safe `node` URL token; valid links focus the matching node and invalid
or deleted IDs are removed safely. Insights keeps diagnosis and evidence cues
but no longer repeats full Flow node descriptions. Handoff, tool-area,
bottleneck, automation, tribal-knowledge, decision, confidence, and critical-
path findings link to their owning Flow nodes. Flow's duplicate aggregate
Insights strip has been replaced by navigation-only guidance. Fresh Flow V3
source citations resolve to the owning conversation from the workbench's
already-loaded conversation data; stale or mismatched evidence remains readable
plain text rather than risking an incorrect link. New flow generations retain
optional exact Summary V2 source-snapshot provenance, while legacy rows keep
count-based freshness until naturally regenerated. No prompt, staged action,
persisted node schema, or bulk-regeneration behavior changed. The full 468-test
suite, repository lint, Convex code generation, and the Next.js production
build pass.

## Phase 9: PDF, Copy, and Legacy Migration

Goal: make every exported representation use the same ownership and evidence
contracts.

### Tasks

- [x] Update process PDF data building to prefer the V2 artifact.
- [x] Render PDF sections in this order: Overview narrative, Flow/step detail,
  then Insights diagnosis.
- [x] Keep detailed facts in their owning PDF section; use cross-references
  instead of duplicate paragraphs.
- [x] Render evidence labels and source references legibly in PDF.
- [x] Preserve legacy Markdown export for V1-only rows.
- [x] Confirm clipboard Markdown is deterministic and complete.
- [x] Add lazy backfill-on-view only; do not schedule tenant-wide regeneration.
  (Backfill-on-view was retracted on 2026-08-09; a V1 row migrates when someone
  rebuilds it. See the second Phase 9 amendment.)
- [x] Add feature-flag rollback that returns the UI to legacy projection without
  deleting V2 artifacts.

### Tests and verification

- [x] PDF render tests for V2, legacy, missing Flow, stale Flow, and partial
  overview.
- [x] Copy output snapshots.
- [x] No duplicate detailed section across Overview, Flow, and Insights pages in
  the generated report.
- [x] Existing downloadable report behavior remains client-side.

### Exit gate

- [x] UI, clipboard, and PDF tell the same story from the same structured data.

Phase 9 result: complete. The process report now reads the same
`summaries.getOverview` response the Overview tab and the clipboard read,
fetched client-side at click time beside the flow document, so the export can
never disagree with the app or drift behind the stored legacy field. Its pages
follow the ownership sequence — overview narrative, flow diagram and step
detail, then insight diagnosis — with the cover carrying evidence coverage
rather than flow analysis, and a navigation-only contents block that reports a
section as not included when the flow has no described steps. Findings render
the same evidence-strength wording as the in-app chips together with their
resolved source labels, and an explicit evidence gap says it has no direct
source instead of showing an empty row. Insight cards no longer repeat a step's
description; they cross-reference it by step number.

A V1-only row still exports and copies its stored Markdown unchanged.
Clipboard output is the deterministic projection of the artifact for both
formats: repeated projections of one artifact are byte-identical, every
headline, brief, finding, source label, stage number, and coverage line
survives, and a stored legacy string is never preferred over the artifact it
was derived from. Evidence level is carried in the Markdown by section
membership and resolved source count; the labelled chips remain a UI and PDF
affordance, so the legacy projection and its locked prompt version are
unchanged.

`SUMMARY_V2` is now a complete rollback: with the flag off, `getOverview` and
every list projection read the stored deterministic Markdown while all
structured artifacts stay in the database, coverage metadata is withheld rather
than restated, refresh entrypoints report `disabled`, and re-enabling restores
the identical artifact with no regeneration. Migration of existing rows happens
only lazily on view — the refresh-on-view hook now covers processes as well as
departments and functions and fires once per source snapshot for a stale row or
a V1-only row, never for an entity that has no summary at all, and it stops
asking after a rolled-back deployment answers `disabled`. Nothing schedules a
tenant-wide regeneration.

The full 491-test suite, repository lint, Convex code generation, and the
Next.js production build pass.

### Phase 9 amendment, 2026-08-07: scope replaces the stage timeline

Approved as Product Decision 8. The Overview's ordered stage timeline and the Flow
graph were generated independently from the same transcripts, so they always
disagreed on label, granularity, and order; a timeline is also inspection, which
the ownership sequence assigns to Flow.

- **Contract.** The process artifact's `stages` is now `scope`: up to eight
  non-sequential findings — trigger, completion, owning roles, systems of record,
  dependencies — none of which the Flow graph states at process level. Same
  single final reduce call, same source resolution, evidence levels, and caps.
- **Cost.** One prompt-version bump (`processOverview` and `legacyMarkdown` to
  v2). No AI call was added or removed, and output tokens fall slightly.
  `conversationEvidence` is unchanged, so no transcript is re-extracted;
  department and function versions are unchanged, and their rollups re-reduce on
  their own once a child process regenerates.
- **Surfaces.** UI, PDF, and clipboard all read `scope` under "Scope and
  participants", and nothing numbers a group. UI and PDF name Process Flow as the
  owner of step order; the Markdown projection deliberately does not, because it
  is stored as `rollingSummary` and Flow generation reads it back as prompt
  evidence.
- **Migration.** `SUMMARY_V2=true` on dev with old-shape rows made this a
  breaking schema change, and the cleanup could not deploy while the push it
  needed was the one being rejected. Widen (`schemaValidation: false`) →
  `migrations:dropPreScopeProcessSummaries`, which cleared 2 of 5 processes and
  keeps `rollingSummary` so content stays readable until regeneration →
  `migrations:verifyProcessSummaryScope` reporting `preScopeArtifacts: 0` →
  narrow. Both functions are idempotent and retained for any other deployment
  that has run V2. Stored `summaryChunks` were all `queued` with no output, so
  none blocked the push.
- **Accepted consequence.** While a flow is generating or has failed, only the
  executive brief describes how the work runs.
- **Test infrastructure.** `vitest.config.ts` sets `testTimeout: 20_000`: the
  report render tests import `@react-pdf/renderer`, whose transform load pushed
  unrelated `convex-test` suites past the default 5s.

Live on the development deployment since 2026-08-07. The full 496-test suite,
repository lint, Convex code generation, and the production build pass.

### Phase 9 amendment, 2026-08-09: generation is a human action

Short test recordings were making every summary stale and paying to regenerate
it. A few seconds of audio with nothing in it cost an evidence extraction, a
compatibility-map extraction, and a reduce — at process level, and again up the
hierarchy. Automatic generation is removed at all three levels.

- **Triggers now invalidate, never generate.** A completed agent conversation, a
  finished voice recording, a rewritten transcript, and a deleted conversation
  all call `summaryEvidence.markProcessSummaryStale`, which raises a new
  `processes.summaryStale` flag and advances the evidence revision. Nothing is
  scheduled and no artifact is touched.
- **Refresh-on-view is gone.** The client hook is now the read-only
  `useSummaryOverview`; viewing a stale or legacy-only overview at any level
  spends nothing. This retracts the Phase 9 lazy backfill-on-view: a V1 row
  migrates when someone rebuilds it. `summaries.ensureCurrent` stays in the API
  with no automatic caller.
- **Staleness works for legacy rows.** A process with only `rollingSummary` had
  no revision pair to compare and always read "current"; the flag is now
  authoritative, and both publish paths clear it.
- **The UI states who can act.** Stale, partial, and missing notices name the
  action and, for viewers, say a contributor or admin can take it. Rebuild
  remains contributor and admin only.
- **Accepted consequence.** A real interview no longer produces a summary on its
  own — someone presses Rebuild. Deleting a conversation leaves its citations in
  place until then.

Deliberately out of scope: junk conversations still mark summaries stale and are
still included when a rebuild runs. Filtering non-substantive recordings out of
evidence needs a content threshold, which is a separate product decision.

The full 572-test suite, repository lint, and the production build pass.

## Phase 10: Golden Set, Soak, and Rollout

Goal: prove fidelity, usability, cost, and operational reliability before broad
enablement.

Operational procedure, thresholds, and worksheets:
[summary-overview-v2-rollout-runbook.md](summary-overview-v2-rollout-runbook.md).

### Tasks

- [x] Extend the prepared golden set with the scenarios in the reference plan.
- [x] Score every factual finding for source validity and support.
  - [x] Deterministic scorer, golden set, and stored-artifact audit query.
  - [ ] Run the audit against a live enabled tenant.
- [x] Review critical-fact recall against source evidence.
  - [x] Recall scorer and per-scenario critical-fact expectations.
  - [ ] Run against live artifacts and their source evidence.
- [x] Review measured-language compliance.
  - [x] Seven-family detector, negative control, and prompt-instruction test.
  - [ ] Run against live artifacts.
- [ ] Run side-by-side V1/V2 human review for fidelity, scannability, and
  operational usefulness. Worksheet prepared; needs two reviewers.
- [x] Measure generation latency and token cost by stage and hierarchy level.
  - [x] Per-stage, per-level report over the AI usage ledger.
  - [ ] Record the internal-tenant baseline from real generations.
- [x] Make `SUMMARY_V2` capable of enabling one tenant at a time.
- [ ] Enable `SUMMARY_V2` for the internal tenant.
- [ ] Complete signed-in desktop/mobile visual QA for all three process tabs and
  department/function overviews.
- [ ] Enable selected external tenants only after internal approval.
- [ ] Run a seven-day selected-tenant soak.
- [x] Monitor invalid source keys, truncation, partial artifacts, stalled runs,
  retries, rebuild frequency, latency near misses, and cost. (Refresh-on-view
  frequency is no longer a signal; see the second Phase 9 amendment.)
  - [x] Four reporting queries plus documented escalation thresholds.
  - [ ] Run them daily through the soak.
- [ ] Exercise the feature-flag rollback during the soak.

### Release gates

- [x] Every factual finding has a valid in-org source. *(golden set; live audit
  pending)*
- [x] Coverage counts exactly match the source snapshot. *(golden set; live
  audit pending)*
- [x] No unsupported measured process-mining language appears. *(golden set;
  live audit pending)*
- [x] No critical labelled fact is lost. *(golden set; live review pending)*
- [ ] Reviewers approve V2 fidelity and scannability.
- [x] No regression in Process Flow generation or stored legacy flows.
- [x] No Overview action triggers unnecessary Flow generation.
- [ ] Seven-day soak has no unresolved P0/P1 reliability or tenant-isolation
  issue.

Phase 10 progress, 2026-08-09: every gate that can be decided without a live
tenant is implemented, and every gate that cannot is now executable rather than
undefined.

The golden set is eleven scenarios: the six Phase 0 baseline shapes stay frozen,
and the reference plan's remaining cases are added — overlapping accounts, more
than fifty conversations, malformed and invented source keys, uneven rollup
coverage, and a deliberately non-compliant measured-language control. Four
deterministic scorers in `convex/lib/summaryEvaluation.ts` judge source validity
and support, measured process-mining language, critical-fact recall, and
coverage integrity. They re-derive every verdict from the artifact alone, so a
normalizer that silently accepted an unsourced factual finding fails the gate
instead of being believed. The same scorers run over stored rows through
`summaryOps:auditStoredArtifacts`, which makes the release gates measurable on
production data rather than only on fixtures. The measured-language detector is
an evaluation and audit control, not a write-path filter: nothing strips this
wording during generation, so a violation means the prompt needs work.

`SUMMARY_V2` now gates per tenant. Production is one deployment shared by every
tenant, so the boolean the plan specified could not express this phase's own
sequence — internal tenant, then selected external tenants — and would have
forced an all-or-nothing enablement. The switch accepts `true`, `false`, or a
Clerk organization allowlist; a malformed entry matches nobody and fails closed
to the legacy path. Every read gate and generation entrypoint now takes the
owning organization, so one tenant's rollout state can never gate another's
row, and rollback stays deployment-wide and non-destructive. Recorded as
Product Decision 9.

Four internal reporting queries in `convex/summaryOps.ts` cover the monitoring
list: per-stage and per-level latency and token cost from the usage ledger,
run health with stalled-run detection and failure codes, the stored-artifact
audit, and V2 coverage share. All are bounded and report when a sample was
truncated, so a large deployment degrades to "sampled" rather than to a failed
transaction.

What remains needs a live deployment, a signed-in human, or elapsed time:
internal tenant enablement and its cost baseline, the side-by-side V1/V2 review,
signed-in visual QA (which also closes the open Phase 6 and Phase 7 exit gates),
external tenant enablement, the seven-day soak, and the rollback drill. The
runbook gives each one its procedure and its escalation threshold.

The full 569-test suite, repository lint, Convex code generation, and the
Next.js production build pass.

## Phase 11: Cleanup Decision

Goal: remove legacy mechanisms only after broad V2 confidence, as a separate
explicit decision.

Evidence, inventory, and recommendations:
[summary-overview-v2-cleanup-decision.md](summary-overview-v2-cleanup-decision.md).

### Tasks

- [x] Measure the share of active summaries with V2 artifacts.
  - [x] `summaryOps:v2CoverageReport`, counting against summarized entities
    rather than all entities.
  - [ ] Record the measured share once tenants are enabled.
- [x] Confirm all UI, PDF, Copy, and API consumers use V2 or deterministic
  projection.
- [x] Decide whether to remove the old incremental prompt and duplicate rollup
  prompt code. *Decision: not yet — it is the rollback path itself.*
- [x] Decide whether legacy Markdown fields remain as export caches or are
  removed through a dedicated migration. *Decision: `rollingSummary` stays;
  `departments.summary` and `functions.summary` are removable later.*
- [x] Decide the removal condition for compatibility actions. *Decision: not
  yet — instrument first, remove after a release cycle of zero calls.*
- [ ] Update PRD, architecture diagrams, operations runbooks, and usage-operation
  documentation.
- [ ] Archive this checklist with final outcomes, deviations, and measured
  results.

### Exit gate

- [ ] Legacy cleanup is separately approved, reversible through normal deploy
  rollback, and supported by production usage evidence.

Phase 11 progress, 2026-08-09: the measurement and the inventory are done; no
removal has been approved or executed, which is the phase's own instruction.

The consumer audit traced every read of `summaryV2`, `rollingSummary`, and the
department and function `summary` fields. It found two real defects, both fixed.
`processes.getWorkbench` returned the raw structured artifact, bypassing both
the rollback switch and per-tenant gating — no client read it, so it was also
dead payload on a hot query, and it is now removed. The workbench process list's
"knowledge" indicator keyed off `rollingSummary`, so a V2-only process would
have lost its dot the moment the legacy field stopped being written; it now
reads the projection's format.

The audit also established why the legacy field cannot simply be deleted:
Process Flow generation and the recording agent read `rollingSummary` as prompt
input, not as an export cache. Removing it means changing Flow's input contract,
which belongs to a Flow initiative. `departments.summary` and
`functions.summary` have no prompt consumer and are removable through a
dedicated widen → backfill → narrow migration once coverage holds.

`src/features/workbench/process-summary-panel.tsx` has no importer anywhere; it
was superseded in Phase 6. It is safe to delete and has been left in place
pending the cleanup approval this phase requires.

The remaining tasks — documentation updates and archiving this checklist with
final measured results — depend on the Phase 10 soak producing those results.
