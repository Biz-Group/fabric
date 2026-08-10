# Fabric Summary and Overview V2 Plan

Status: Implementation in progress — Phases 0–4 complete  
Created: 2026-08-05  
Companion task list: [summary-overview-v2-task-list.md](summary-overview-v2-task-list.md)  
Related designs: [fabric-ui-ux-redesign-brief.md](fabric-ui-ux-redesign-brief.md), [process-flow-generation-v3-plan.md](process-flow-generation-v3-plan.md), [pipeline-reliability-and-scale-plan.md](pipeline-reliability-and-scale-plan.md)

## 1. Summary

Fabric's process, department, and function summaries are currently generated as
Markdown strings and rendered as long-form prose. The pipeline already has good
reliability foundations — source citations, cached per-conversation map records,
a full process rebuild path, staleness propagation, coalescing, and truncation
protection — but the stored result is not structured enough to validate,
prioritize, link, or present as a high-quality operational brief.

V2 replaces prompt-shaped Markdown with bounded, evidence-backed summary
artifacts. The UI becomes a layered overview: a short executive brief followed
by the operating narrative, reported variations, agreements, gaps, and evidence
coverage. Every factual finding links back to a valid conversation, process, or
department source.

The redesign does **not** rebuild Process Flow or Process Insights. Those
surfaces remain the owners of topology and diagnosis respectively. Overview is
substantially redesigned; Flow receives only additive deep-link and provenance
support; Insights receives only the presentation changes needed to remove
duplicated prose and link findings to flow nodes.

## 2. Product Decisions

The following decisions are locked for implementation:

1. **Primary experience: layered overview.** Lead with an executive brief, then
   progressively reveal operational detail and evidence.
2. **Data scope: interview-first.** V2 uses Fabric's conversation evidence. It
   does not introduce event-log ingestion or claim measured process-mining
   metrics.
3. **Surface integration: complementary, not merged.** Overview, Process Flow,
   and Process Insights remain separate tabs with non-overlapping ownership.
4. ~~**Rollup freshness: refresh on view.** A stale department or function keeps
   showing its previous brief while an idempotent background refresh runs.~~
   Superseded by Product Decision 9: the previous brief is still shown, but no
   refresh starts on its own.
5. **No bulk flow regeneration.** Existing flows and insights remain valid.
   Optional provenance fields populate on the next natural flow refresh.
6. **No destructive summary migration.** Existing Markdown remains readable
   until V2 coverage, UI migration, PDF migration, and evaluation gates pass.
7. **One source of detail per finding.** Other surfaces may provide a short
   status or navigation link, but must not copy the owning surface's detailed
   content.
8. **Step order is stated once, by Process Flow.** Approved deviation recorded
   2026-08-07, replacing the ordered stage timeline this plan originally
   specified for the process Overview (§9.2 item 3). The Overview and the Flow
   generate independently from the same transcripts, so two orderings of the
   same process always diverged in label, granularity, and sequence, and the
   divergence was most visible when both artifacts were fresh. A stage timeline
   is also inspection, which §2.3 assigns to Flow. The process artifact now
   carries a non-sequential `scope` group — trigger, completion, owning roles,
   systems of record, and upstream/downstream dependencies — which the Flow
   graph cannot state at process level. Accepted consequence: while a flow is
   generating or failed, only the executive brief describes how the work runs.
   Implemented as `processOverview` prompt version v2 with no change to
   `conversationEvidence`, so no transcript is re-extracted.
9. **`SUMMARY_V2` gates per tenant, not per deployment.** Approved deviation
   recorded 2026-08-09, widening the boolean switch §12 originally specified.
   Production is one Convex deployment shared by every tenant, so a boolean
   cannot express §12's own rollout sequence — internal tenant first, selected
   external tenants next — and the only way to try V2 on one tenant would be to
   enable it for all of them. `SUMMARY_V2` now accepts `true` (all tenants),
   `false`/unset (no tenants), or a comma-separated Clerk organization
   allowlist. Every read gate and every generation entrypoint takes the owning
   organization, so one tenant's rollout state can never gate another's row. A
   malformed entry matches no organization and therefore fails closed to the
   legacy path. Rollback is unchanged and still deployment-wide: setting
   `false` returns every tenant to the deterministic Markdown projection
   without deleting an artifact.
10. **Every generation is a human action.** Approved deviation recorded
    2026-08-09, replacing the automatic regeneration this plan specified in
    Product Decision 4, §10 item 4, and §12 item 5. Short test recordings were
    reliably making every summary stale and paying to rebuild it: a few seconds
    of audio with nothing in it cost an evidence extraction, a
    compatibility-map extraction, and a reduce, at process level and again up
    the hierarchy. New evidence — a completed conversation, a rewritten
    transcript, a deleted conversation — now only advances the evidence
    revision and raises a stale flag, at every level. Nothing regenerates on
    view, and nothing backfills a V1 row on view; a stale overview keeps
    showing its last good content and offers Rebuild to contributors and
    admins. Accepted consequence: a real interview produces no summary until
    someone asks for one, and a deleted conversation stays cited until then.
    Not addressed: a non-substantive recording still marks summaries stale and
    still enters a rebuild, which needs a content threshold to fix.

## 3. Current-State Review

### 3.1 Strengths to preserve

- The process pipeline stores a Fabric-owned intermediate record per completed
  conversation and hashes the transcript to avoid unnecessary remapping.
- Force rebuild uses a map/reduce shape instead of concatenating raw transcripts.
- Contributor citations survive into the process brief.
- Process regeneration requests coalesce, retain the previous summary on
  failure, and release stale generation gates.
- Department and function summaries persist, expose staleness, and avoid paying
  for fresh unchanged results.
- Process Flow V3 already stores structured nodes, edges, details, confidence,
  sources, bottlenecks, risks, and analyzed automation opportunities.
- Process Insights already derives its dashboard from Process Flow rather than
  making a separate ungrounded summary call.

### 3.2 Quality and correctness gaps

- The normal process update path merges the previous prose summary with only
  the newest raw transcript. This is order-dependent and can gradually lose or
  distort older evidence.
- Full process rebuilds read at most 50 conversations. The result does not tell
  the user whether later conversations were excluded.
- Conversation map records and final summaries are Markdown strings. Prompt
  wording is the only output contract; malformed sections, invalid citations,
  and duplicated findings cannot be rejected mechanically.
- Department and function prompts summarize already-compressed prose, causing
  abstraction loss at each hierarchy level.
- A function refresh may reuse a department summary even when that department is
  stale, then save the function as fresh. A forced department rebuild also does
  not always invalidate an otherwise-current parent function.
- The department prompt exists in both the public and cascade implementations,
  allowing the two paths to drift.
- Rollup actions request up to 8,192 output tokens on the default 120-second
  timeout. That exceeds the conservative budget calculated from the project's
  measured Foundry throughput.
- There is no persisted process summary generation time, prompt version, model,
  exact source snapshot, or visible coverage completeness.

### 3.3 Presentation gaps

- Markdown gives every section the same visual weight and turns the summary into
  a document users must read from top to bottom.
- Citations are plain text rather than navigable evidence.
- Department and function views do not show how many children are documented,
  current, stale, or missing.
- Mobile previews render the same long summary inside a sheet instead of a
  deliberately compact preview.
- Summary, Flow, and Insights currently share concepts such as stages, handoffs,
  bottlenecks, and evidence, but their ownership is not explicit enough to
  prevent future duplication.

### 3.4 Test baseline

The focused summary/read-model baseline on 2026-08-05 passes 24 tests across
`summaryReads`, `summaryRegen`, `deletionFlows`, and `readModels`. These tests
cover orchestration and consistency, not LLM output structure or summary
quality.

## 4. Research Principles Applied to Fabric

Process-mining tools lead with the shape of work, variants, frequency,
performance, rework, bottlenecks, coverage, and drill-down rather than treating
one prose summary as the analysis. Relevant primary references include:

- The [IEEE Process Mining Manifesto](https://www.tf-pm.org/resources/manifesto),
  which separates discovery, conformance, and enhancement and treats event data
  quality as foundational.
- [Microsoft Process Mining analytics](https://learn.microsoft.com/en-us/power-automate/process-mining-visualize),
  where maps, variants, frequency/performance layers, rework, KPIs, filters, and
  drill-down are complementary views.
- [PM4Py's LLM-oriented process abstractions](https://processintelligence.solutions/pm4py/api/_modules/pm4py/algo/querying/llm/abstractions/log_to_variants_descr.html),
  which bound prompt length and keep sequence, frequency, and performance as
  structured inputs.
- [Abstractions, Scenarios, and Prompt Definitions for Process Mining with LLMs](https://arxiv.org/abs/2307.02194),
  which recommends compact abstractions of process artifacts and verification
  against the underlying data rather than providing an entire log as prose.

Fabric does not yet have process case events with activity timestamps. Interview
timestamps are capture metadata, not execution timestamps. V2 therefore borrows
the information architecture but uses explicit interview-evidence language:

- `supportCount` means the number of independent sources supporting a finding,
  not execution frequency.
- Durations are labelled **reported duration**, never throughput time.
- Variations are **reported ways of working**, not mined case variants.
- Bottlenecks are contributor-reported or flow-inferred signals, not measured
  queue or waiting-time statistics.
- Conformance and rework rates remain unavailable until an event-log or hybrid
  source mode is deliberately introduced.

## 5. Surface Responsibilities

### 5.1 Overview — understand

Question answered: **What is this process, and what should I understand first?**

Overview owns:

- Executive headline and brief.
- Process scope and participants: trigger, completion, owning roles, systems of
  record, and dependencies. Not a sequence; see Product Decision 8.
- Agreements across contributors.
- Reported variations in how work is performed.
- Knowledge gaps and unresolved tensions.
- Notable operational context.
- Evidence coverage, source strength, freshness, and generation status.

Overview does not own:

- A full process graph, node detail, or any statement of step order.
- Bottleneck, tool, handoff, automation, or risk dashboards.
- Ranked intervention recommendations.
- Repeated Flow or Insights cards.

Overview may show only compact readiness/navigation messages such as “Process
Flow is available,” “Insights are based on older evidence,” or “Open the three
identified bottlenecks.” It must not reproduce the underlying descriptions.

### 5.2 Process Flow — inspect

Question answered: **How does the work move step by step?**

Process Flow remains the owner of:

- Nodes, edges, branches, parallel work, waits, and fallback paths.
- Step-level actors, tools, reported duration, pain points, risk indicators,
  confidence, and source citations.
- Graph navigation, selection, layout, fullscreen mode, and node detail.

Flow does not render the executive brief, summary sections, aggregate metrics,
or ranked recommendations. V2 changes are additive only:

- Accept an optional `node` deep-link parameter and select/focus that node.
- Add source navigation where a valid conversation source is available.
- Record optional source-snapshot provenance on future generations.

The existing graph-generation stages, schemas, stored rows, and generation
triggers remain intact.

### 5.3 Process Insights — improve

Question answered: **Where should we investigate or intervene?**

Insights remains the owner of:

- Handoff analysis.
- Tool concentration and tool-heavy areas.
- Bottlenecks and associated evidence.
- Automation opportunities.
- Tribal-knowledge risk.
- Decision-point analysis.
- Confidence distribution and detailed evidence diagnostics.
- Critical path and reported total duration when available.

Insights findings reference node IDs and sources instead of repeating full node
descriptions. Clicking a finding opens the owning Flow node. Insights does not
render the executive brief, the overview scope findings, or a second process
walkthrough.

### 5.4 Department and function overviews

Departments and functions do not currently have dedicated Flow or Insights
tabs. Their overviews may therefore own cross-child dependencies, common
patterns, tensions, strategic gaps, and notable child findings. They must still
link to the child process or department that owns the evidence instead of
copying its full detail.

### 5.5 Cross-surface invariant

Each detailed fact has one rendering owner:

```
Overview: understand  ->  Process Flow: inspect  ->  Process Insights: improve
```

Cross-navigation is the integration mechanism. Copying content is not.

## 6. Summary V2 Data Contracts

### 6.1 Shared source and finding types

```ts
type SummarySourceRef =
  | {
      kind: "conversation";
      conversationId: Id<"conversations">;
      label: string;
    }
  | { kind: "process"; processId: Id<"processes">; label: string }
  | {
      kind: "department";
      departmentId: Id<"departments">;
      label: string;
    };

type SummaryEvidenceLevel =
  | "corroborated"
  | "single_source"
  | "inferred_gap";

type SummaryFinding = {
  id: string;
  title: string;
  body: string;
  evidenceLevel: SummaryEvidenceLevel;
  supportCount: number;
  sources: SummarySourceRef[];
};
```

The model never receives Convex IDs. Prompt inputs assign stable short keys
(`C1`, `P2`, `D3`); the normalizer resolves returned keys against the supplied
map. Unknown keys are dropped. A factual finding with no valid source is
dropped; `inferred_gap` may have no source only when its wording is explicitly a
coverage gap rather than an asserted fact.

### 6.2 Process overview artifact

```ts
type ProcessOverviewArtifactV2 = {
  schemaVersion: "v2";
  sourceMode: "interview_evidence";
  headline: string;
  executiveBrief: string;
  /** Trigger, completion, roles, systems, dependencies. Unordered. */
  scope: SummaryFinding[];
  consensus: SummaryFinding[];
  variations: SummaryFinding[];
  gaps: SummaryFinding[];
  notable: SummaryFinding[];
  coverage: SummaryCoverage;
  provenance: SummaryProvenance;
};
```

This contract intentionally excludes insight groups such as bottlenecks,
automation, tool concentration, and ranked handoffs.

### 6.3 Department and function artifacts

Department artifacts contain `crossProcessDependencies`, `sharedPatterns`,
`variationsAndTensions`, `gaps`, and `notable`. Function artifacts use
`crossDepartmentDependencies`, `strategicPatterns`, `variationsAndTensions`,
`gaps`, and `notable`. Both share the headline, executive brief, coverage, and
provenance fields.

### 6.4 Coverage and provenance

```ts
type SummaryCoverage = {
  includedSources: number;
  totalEligibleSources: number;
  uniqueContributors?: number;
  complete: boolean;
};

type SummaryProvenance = {
  sourceSnapshotHash: string;
  generatedAt: number;
  promptVersion: string;
  provider: string;
  model: string;
};
```

Persist `summaryV2` on the owning function, department, or process for reactive
reads without extra joins. All arrays are normalized and capped before saving:

- Every finding group, including process scope: 8.
- Source references per finding: 8.
- Title: 120 characters.
- Finding body: 1,200 characters.
- Executive brief: 1,800 characters.

The caps keep the objects bounded and well below Convex's document limit.

### 6.5 Conversation evidence

Add a structured `processSummaryEvidenceV2` object to completed conversations:

- Ordered steps, capped at 40.
- Actors and tools.
- Handoffs/dependencies.
- Reported variations and exceptions.
- Friction/pain points.
- Uncertainties and explicitly missing knowledge.
- Transcript hash, evidence prompt version, generated time, provider, and model.

Each non-step group is capped at 20 items. An evidence record is reusable only
when both transcript hash and evidence prompt version match.

### 6.6 Run and chunk state

Add bounded `summaryRuns` and `summaryChunks` tables rather than growing arrays
on hierarchy documents:

- `summaryRuns`: entity discriminator and typed entity ID, generation ID,
  source snapshot, status, progress, error, timestamps, and retry/resume count.
- `summaryChunks`: run ID, chunk index, bounded intermediate artifact, and
  status.
- Index every entity/run lookup with `clerkOrgId` and all equality fields in the
  index name.
- Retain only the active run plus the most recent terminal run required for
  diagnostics; clean older chunks in bounded scheduled batches.

Public reads continue to return the last successful artifact while a run is in
progress or has failed.

## 7. Generation Architecture

### 7.1 Process generation

```
completed conversation
  -> requestProcessSummaryRegen (existing coalescing gate)
  -> ensure structured evidence for changed/missing conversations
  -> group evidence into deterministic creation-order chunks
  -> reduce each chunk in one scheduled action
  -> final structured reduce across chunks
  -> validate and save summaryV2 + deterministic legacy Markdown
  -> mark department stale
```

The old incremental merge path is retired after V2 is enabled. Every automatic
update and manual rebuild uses the same evidence/reduce pipeline, so output no
longer depends on arrival order.

Chunk size starts at 20 conversation evidence records. One scheduled action
makes at most one LLM request. A run may reduce directly without chunks when the
bounded input fits the configured context threshold, but the persisted result
and validation path are identical.

### 7.2 Department generation

- Input every child process V2 artifact using stable process keys.
- Record missing, stale, or failed child artifacts in coverage.
- Do not silently use stale child content as if it were current.
- A department may publish `partial` only when its coverage explicitly reports
  the omitted children.
- Successful save marks the parent function stale whenever the department's
  source snapshot differs from its previous snapshot, including force refresh.

### 7.3 Function generation

- Refresh stale or missing departments through the scheduled pipeline before
  the final function reduce.
- Never execute a sequential multi-department cascade inside one action.
- Finalize as `current` only when all eligible departments are included and
  current; otherwise save a clearly labelled `partial` artifact.

### 7.4 Refresh behavior

- `ensureCurrent` is available to authenticated org members and is idempotent
  for a source snapshot. A viewer can cause at most one coalesced regeneration
  for genuinely stale data.
- Opening a stale department or function calls `ensureCurrent` once for that
  snapshot.
- The previous artifact remains fully readable with a “Refreshing from new
  evidence” notice and progress.
- Manual force refresh remains contributor/admin-only and bypasses the fresh
  artifact guard, not authorization or generation coalescing.
- A failed refresh keeps the prior artifact and exposes a retryable error.

### 7.5 AI request budgets

Initial budgets, all compliant with the measured throughput constants in
`convex/lib/aiProvider.ts`:

| Stage | maxTokens | timeoutMs | maxRetries |
|---|---:|---:|---:|
| Conversation evidence | 1,536 | 120,000 | 2 |
| Summary chunk reduce | 4,096 | 150,000 | 2 |
| Final process/rollup reduce | 3,072 | 120,000 | 2 |

Use temperature `0`, strict tools, truncation rejection, and per-stage usage
operations. Recalibrate only from golden-set outputs and measured provider
throughput.

## 8. Public APIs and Read Models

Add a discriminated public query:

```ts
summaries.getOverview({
  entity:
    | { kind: "process"; processId: Id<"processes"> }
    | { kind: "department"; departmentId: Id<"departments"> }
    | { kind: "function"; functionId: Id<"functions"> };
})
```

It returns:

- The matching V2 artifact or legacy fallback.
- `state: "missing" | "current" | "stale" | "refreshing" | "partial" | "failed"`.
- Generation progress and last error when applicable.
- Coverage and last successful generation time.
- Flow/Insights readiness metadata only: availability, staleness, and matching
  generation status. It does **not** return flow nodes or insight findings.

Add actions:

- `summaries.ensureCurrent({ entity })` — org member, non-forcing, idempotent.
- `summaries.forceRefresh({ entity })` — contributor/admin, coalesced force run.

Hierarchy/list queries return only lightweight summary state and coverage counts
for row indicators. Full artifacts are loaded only for the selected overview.

Existing `generateDepartmentSummary`, `generateFunctionSummary`, and
`forceRefreshProcessSummary` remain temporary adapters. They schedule the V2
pipeline and preserve their existing response shapes until all clients migrate.

## 9. Overview Experience

### 9.1 Visual direction

Use an editorial operational-brief treatment rather than a grid of generic AI
cards:

- A strong headline and compact executive brief with generous space.
- Existing UI type for controls; the already-installed `Newsreader` face may be
  reused selectively for the editorial brief rather than introducing another
  font dependency.
- Organization accent for navigation and evidence links.
- Amber only for stale, partial, or attention states, consistent with the brand
  kit.
- Thin rules, restrained surfaces, and an ordered reading rhythm instead of
  giving every section a bordered card.

### 9.2 Process Overview layout

1. Header: headline, brief, state badge, source mode, generated time, Copy, and
   Refresh/Rebuild.
2. Evidence strip: included conversations, total eligible conversations,
   unique contributors, and coverage completeness.
3. Scope and participants: trigger, completion, owning roles, systems of record,
   and dependencies, with evidence-strength labels and source chips. Never a
   sequence — see Product Decision 8 — with a pointer to Process Flow for step
   order when a flow exists.
4. Reported ways of working: variations without claiming execution frequency.
5. Agreements and open questions: consensus, tensions, and knowledge gaps.
6. Notable context.
7. A slim navigation footer for Flow and Insights readiness; no duplicated
   metrics or findings.

### 9.3 Department and function layouts

Use the same header and evidence treatment, followed by hierarchy-appropriate
dependencies, patterns, tensions, gaps, and notable findings. Finish with a
child coverage table showing current, stale, missing, or partial state and a
direct navigation action for each child.

### 9.4 Mobile behavior

- Mobile preview sheets show the headline, brief, coverage, and freshness only.
- Opening the entity renders the complete overview as a single ordered column.
- Source chips and child rows meet touch-target requirements.
- Background refresh uses an inline live status and never blocks navigation.

### 9.5 Copy and PDF

Generate clipboard Markdown deterministically from the structured artifact.
Update the PDF renderer to consume the same artifact and preserve the ownership
sequence: overview narrative, flow diagram and step detail, then insights. The
legacy Markdown renderer remains a fallback only.

## 10. Compatibility and Migration

1. Add optional V2 schema fields and new tables; do not rewrite existing rows.
2. Behind `SUMMARY_V2`, generate one structured artifact and derive the legacy
   Markdown string from it. Do not make parallel V1 and V2 LLM calls.
3. Use V2 when present and the existing Markdown renderer otherwise.
4. Backfill a V1 row when someone rebuilds it. Do not backfill on view and do
   not launch a tenant-wide regeneration. (Product Decision 10; this item
   originally backfilled lazily on view or on the next process update.)
5. Existing processFlows rows remain readable. Optional source-snapshot fields
   are absent on legacy rows and populate on the next ordinary flow generation.
6. Treat existing Flow/Insights freshness (`stale` plus conversation count) as
   authoritative for legacy rows. Exact snapshot matching becomes available for
   new rows without forcing regeneration.
7. Remove legacy prompts and fields only after V2 coverage, UI, PDF, and
   evaluation gates pass and a separate cleanup decision is approved.

## 11. Testing and Quality Evaluation

### 11.1 Deterministic tests

- Validator/normalizer tests for caps, invalid source keys, deduplication,
  evidence levels, unsupported fields, and legacy Markdown projection.
- Pipeline tests for prompt-version invalidation, changed transcripts,
  coalescing, staged chunks, more than 50 sources, retries, retained previous
  artifacts, partial completion, and stale run supersession.
- Correctness tests for department/function cascading, forced department
  refresh invalidation, deletion, reparenting, and tenant isolation.
- Public API tests for roles, summary states, bounded list payloads, and the
  guarantee that `getOverview` does not expose Flow/Insights detail.
- UI tests for every state, source navigation, child navigation, permissions,
  mobile ordering, accessibility, and legacy fallback.
- Flow regression tests proving summary V2 does not alter graph generation,
  existing stored flows, or regeneration triggers.

### 11.2 Complementarity acceptance test

Perform a content-ownership audit across all three process tabs:

- Scope, participants, agreement, variation, and gap findings render only in
  Overview.
- Full node detail, and every statement of step order, render only in Flow.
- Detailed bottleneck, handoff, risk, confidence, and automation analysis renders
  only in Insights.
- Cross-surface references are short status/navigation controls linked to the
  owning entity, node, or tab.
- The PDF follows the same ownership boundaries.

### 11.3 Golden-set evaluation

Extend the prepared production golden set with:

- One-contributor and many-contributor processes.
- Overlapping accounts, contradictions, and explicit uncertainty.
- Long processes requiring multiple chunks.
- Processes with more than 50 conversations.
- Missing or stale child summaries.
- Department and function rollups with uneven coverage.
- Malformed or invented source-key responses.

Release gates:

- Every factual finding has at least one valid stored source.
- Every source reference resolves within the owning organization.
- Coverage counts match the exact source snapshot.
- No interview-derived result uses measured frequency, throughput, rework-rate,
  or conformance language.
- No critical labelled fact is lost relative to the source evidence.
- Reviewers prefer V2 for fidelity, scannability, and operational usefulness.

## 12. Rollout and Observability

1. Ship schemas, normalizers, and read compatibility with the flag off.
2. Enable V2 generation for an internal tenant and run the golden set.
3. Enable the new Overview for V2 rows while retaining V1 fallback.
4. Migrate Copy and PDF rendering.
5. Add selected tenants to the `SUMMARY_V2` allowlist. (Product Decision 10
   removed the lazy refresh-on-view this item originally enabled.)
6. Monitor per-stage latency, input/output tokens, truncation, invalid tool
   output, partial coverage, run age, retry count, rebuild frequency, and cost by
   entity level.
7. Run a seven-day selected-tenant soak before enabling broadly.
8. Keep rollback at the UI/read-contract level: disable `SUMMARY_V2` and render
   the deterministic legacy Markdown projection already stored.

## 13. Non-Goals

- Event-log ingestion, case correlation, or XES support.
- Measured throughput, case-frequency, rework, or conformance analytics.
- Replacing the Process Flow V3 generation pipeline.
- Bulk-regenerating existing flows or summaries.
- Merging Overview, Process Flow, and Process Insights into one tab.
- Creating department- or function-level Flow/Insights dashboards in this
  initiative.
- General organizational search or natural-language querying.
