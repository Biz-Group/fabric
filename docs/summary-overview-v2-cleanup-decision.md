# Summary and Overview V2 — Consumer Inventory and Cleanup Decision Record

Status: Phase 11 prepared; no removal approved or executed  
Created: 2026-08-09  
Reference design: [summary-overview-v2-plan.md](summary-overview-v2-plan.md)  
Rollout runbook: [summary-overview-v2-rollout-runbook.md](summary-overview-v2-rollout-runbook.md)

Phase 11 removes legacy mechanisms only after broad V2 confidence, as a
separate explicit decision. This document is the evidence and the
recommendation. **Nothing in it has been executed.** Each decision below is
reversible through an ordinary deploy rollback, and each is gated on the
Phase 10 soak closing.

---

## 1. How to measure V2 share

```
npx convex run summaryOps:v2CoverageReport '{}'
```

Reports, per hierarchy level and overall:

- `rows` — entities that exist.
- `withAnySummary` — entities that have a summary of any kind. **This is the
  denominator that matters**: an entity nobody has ever interviewed is not
  evidence for or against migration.
- `withV2` / `legacyOnly` — the split.
- `staleV2`, `partialV2` — quality of the V2 side.
- `v2Share` — `withV2 / withAnySummary`.

Migration is lazy and on-view only, so this number rises as tenants browse.
Nothing schedules a tenant-wide regeneration, and nothing should.

**Recommended threshold before any removal below:** `v2Share ≥ 0.95` at every
level across enabled tenants, sustained for the full seven-day soak, with
`legacyOnly` rows individually accounted for (a legacy-only row that nobody has
opened in a month is fine; one that is opened daily and never migrates is a
bug).

---

## 2. Consumer inventory

Audited 2026-08-09 by tracing every read of `summaryV2`, `rollingSummary`, and
the `summary` fields on `departments` and `functions`.

### 2.1 Compliant — reads V2 or the deterministic projection

| Consumer | Path | Reads |
| --- | --- | --- |
| Process Overview tab | `src/features/overview/process-overview.tsx` | `summaries.getOverview` |
| Department / function overview | `src/features/overview/hierarchy-overview.tsx` | `summaries.getOverview` |
| Clipboard Copy | `src/features/overview/overview-view-model.ts` | deterministic projection of the artifact |
| PDF report | `src/features/workbench/process-pdf/*` | `summaries.getOverview`, fetched client-side at click time |
| Refresh-on-view | `src/features/workbench/use-ensure-current-summary.ts` | `summaries.getOverview` → `ensureCurrent` |
| Hierarchy tree, process/department/function lists | `convex/hierarchy.ts`, `convex/processes.ts`, `convex/departments.ts`, `convex/functions.ts` | `summaryOverview` list metadata behind the per-tenant read gate |

### 2.2 Fixed during this audit

| Finding | Fix |
| --- | --- |
| `processes.getWorkbench` returned the raw `summaryV2` artifact, bypassing both the `SUMMARY_V2` rollback switch and per-tenant gating. No client read it, so it was also dead payload on a hot query. | Removed from the payload. Every overview surface reads the artifact through `summaries.getOverview`, which applies both gates. |
| The workbench process list "knowledge" indicator keyed off `proc.rollingSummary`, so a V2-only process would lose its dot the moment the legacy field stops being written. | Now reads `proc.summaryOverview.format !== "none"`. |

### 2.3 Legitimate remaining legacy-field readers

These are **not** overview surfaces. They consume `rollingSummary` as an input,
which is why the field cannot simply be deleted.

| Consumer | Path | Why it reads the legacy field |
| --- | --- | --- |
| Process Flow generation | `convex/processFlows.ts` | Feeds the stored Markdown into the flow prompt as process evidence. This is deliberate and documented in the Phase 9 amendment: the Markdown projection intentionally omits step-order attribution because Flow reads it back. |
| Flow quality checks | `convex/lib/flowQuality.ts` | Same snapshot, used to judge flow inputs. |
| Recording agent context | `src/features/recording/recording-modal.tsx` | Injects the existing summary into the ElevenLabs agent prompt so an interview does not re-ask what is already known. |
| Legacy department/function rollup | `convex/summariesHelpers.ts` | The V1 cascade, retained only on the disabled-flag path for rollback. |
| Legacy incremental writer | `convex/postCall.ts` | The V1 reducer, same rollback role. |
| Deletion and cleanup cascades | `convex/cleanup.ts`, `convex/conversations.ts`, `convex/processes.ts` | Clear the field and test "does this department still have knowledge". |
| Migrations and seed | `convex/migrations.ts`, `convex/seed.ts` | Historical and fixture data. |

### 2.4 Dead code found

| Item | Status |
| --- | --- |
| `src/features/workbench/process-summary-panel.tsx` | No importer anywhere in `src/`. Superseded by `process-overview.tsx` in Phase 6. Safe to delete; left in place pending the cleanup approval. |

---

## 3. Decisions

### 3.1 Remove the old incremental prompt and duplicate rollup prompt code

**Recommendation: not yet — remove in one change after the soak, not before.**

The V1 incremental reducer in `convex/postCall.ts` and the sequential cascade in
`convex/summariesHelpers.ts` are unreachable while `SUMMARY_V2` names a tenant,
and are the *only* thing that runs for a tenant it does not name. They are the
rollback path itself. Removing them converts `SUMMARY_V2=false` from "return to
the legacy path" into "no summary generation at all".

Precondition: broad enablement (`SUMMARY_V2=true`) held for a full release cycle
with no rollback, so the flag's off position is no longer an operational
option.

### 3.2 Keep or remove the legacy Markdown fields

**Recommendation: keep `processes.rollingSummary` as a cache. Reconsider
`departments.summary` and `functions.summary` separately.**

`rollingSummary` is not only an export cache — Process Flow generation and the
recording agent read it as prompt input (§2.3). Removing it means rewriting
those two prompt paths to render the projection on demand, which is a change to
Flow's input contract and belongs to a Flow initiative, not to this one.

`departments.summary` and `functions.summary` have no prompt consumer. Once
`v2Share` at those levels is at threshold, they are removable through a
dedicated migration. That migration must widen → backfill → narrow, per the
Phase 9 amendment's experience: `convex dev` pushes edits live, so a breaking
schema change fails the push mid-session.

### 3.3 Remove compatibility actions

**Recommendation: not yet.**

`summaries.generateDepartmentSummary`, `summaries.generateFunctionSummary`, and
`summaries.forceRefreshProcessSummary` are public actions retained as V2
scheduling adapters with unchanged response shapes. A deployed client may still
call them.

Precondition: instrument each with a usage counter, observe zero calls for a
full release cycle, then remove.

### 3.4 Documentation

**Recommendation: do now, independent of any removal.** Tracked in §4.

---

## 4. Documentation updates owed

- [ ] PRD: replace the process-summary section with the Overview / Flow /
      Insights ownership sequence.
- [ ] Architecture diagram: add the evidence → chunk → final → rollup pipeline
      and the `summaryRuns` / `summaryChunks` tables.
- [ ] Operations runbook: link
      [summary-overview-v2-rollout-runbook.md](summary-overview-v2-rollout-runbook.md)
      from the on-call index.
- [ ] Usage-operation documentation: add the five Summary V2 operation names to
      the cost-attribution table in
      [ai-usage-metering-plan.md](ai-usage-metering-plan.md).

---

## 5. Exit gate status

- [ ] Legacy cleanup separately approved — **not requested; no approval on
      record.**
- [x] Every proposed change is reversible through normal deploy rollback.
- [ ] Supported by production usage evidence — **blocked on the Phase 10
      soak.**
