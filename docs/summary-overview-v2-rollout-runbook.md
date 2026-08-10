# Summary and Overview V2 — Rollout, Soak, and Evaluation Runbook

Status: Phase 10 in progress  
Created: 2026-08-09  
Reference design: [summary-overview-v2-plan.md](summary-overview-v2-plan.md)  
Task list: [summary-overview-v2-task-list.md](summary-overview-v2-task-list.md)

This runbook covers everything Phase 10 needs after the code is written:
how to turn V2 on for one tenant at a time, what to measure, what the numbers
have to say before the next tenant, and how to roll back.

---

## 1. The rollout switch

`SUMMARY_V2` takes three forms. It is read by
[`convex/lib/summaryV2Feature.ts`](../convex/lib/summaryV2Feature.ts).

| Value | Meaning |
| --- | --- |
| unset, empty, `false` | Off for every tenant. Reads fall back to the stored deterministic Markdown. No artifact is deleted. |
| `true` | On for every tenant on this deployment. |
| `org_a,org_b` | On for exactly those Clerk organization IDs. Every other tenant on the same deployment stays on the legacy path. |

The allowlist form exists because production is **one Convex deployment shared
by every tenant**. A boolean cannot express "internal tenant first, selected
external tenants next", which is the sequence this phase requires. A typo in
the list matches no organization, so it fails closed to the legacy path.

Setting it:

```
npx convex env set SUMMARY_V2 "org_internal"                 # internal only
npx convex env set SUMMARY_V2 "org_internal,org_pilot_one"   # add a pilot
npx convex env set SUMMARY_V2 true                           # broad enablement
npx convex env set SUMMARY_V2 false                          # full rollback
```

The change takes effect on the next function invocation. Nothing needs
redeploying and no data is rewritten in either direction.

### What flipping the switch does and does not do

- **Does**: hide `summaryV2` from every read path, make refresh entrypoints
  answer `disabled`, and return UI, clipboard, and PDF to the stored legacy
  Markdown.
- **Does not**: delete or alter a stored artifact, cancel work already
  scheduled (in-flight runs finish and record their terminal state), or
  regenerate anything on re-enable. Re-enabling restores the identical
  artifact.

---

## 2. Enablement sequence

Do not skip a step, and do not run two steps on the same day — each one needs
its own clean monitoring window.

1. **Internal tenant.** Set `SUMMARY_V2` to the internal org ID alone.
2. **Golden-set and stored-artifact evaluation** (§3). Every release gate must
   pass on the internal tenant's own artifacts.
3. **Side-by-side V1/V2 review** (§4) and **visual QA** (§5). Both need a
   signed-in human; neither can be automated.
4. **Cost and latency baseline** (§6) recorded for the internal tenant.
5. **Internal approval** recorded in the task list, naming the approver.
6. **Selected external tenants.** Append one or two org IDs.
7. **Seven-day soak** (§7) with daily monitoring.
8. **Rollback drill** (§8) executed once during the soak, deliberately.
9. **Broad enablement** only after the soak closes with no unresolved P0/P1.

---

## 3. Evaluation gates

### 3.1 Golden set (deterministic, runs in CI)

```
npx vitest run convex/summaryEvaluation.test.ts
```

Eleven scenarios in
[`convex/testFixtures/summaryV2.ts`](../convex/testFixtures/summaryV2.ts):
the six Phase 0 baseline shapes plus overlapping accounts, more than fifty
conversations, malformed and invented source keys, uneven rollup coverage, and
a deliberately non-compliant measured-language control.

The scorers live in
[`convex/lib/summaryEvaluation.ts`](../convex/lib/summaryEvaluation.ts) and
re-derive their verdicts from the artifact alone — they never ask the
normalizer whether it thinks its own output is valid.

| Gate | What it proves | Scorer |
| --- | --- | --- |
| Source validity and support | Every factual finding cites at least one source that resolves inside the entity's own snapshot; `supportCount` matches; `corroborated` really has two or more sources; a sourceless gap says out loud that evidence is missing | `scoreSourceValidity` |
| Measured language | No event-log, throughput, rework-rate, conformance, percentage, or statistical claim appears | `scoreMeasuredLanguage` |
| Critical-fact recall | Every fact a scenario declares critical survives normalization | `scoreCriticalFactRecall` |
| Coverage integrity | Coverage matches the source snapshot exactly, and `complete` is never true while a source was left out | `scoreCoverageIntegrity` |

### 3.2 Stored artifacts (run against the live deployment)

The same scorers run over real rows:

```
npx convex run summaryOps:auditStoredArtifacts '{"clerkOrgId":"org_internal"}'
```

`passed: false` blocks the phase. `violationsByCategory` names the failing
gate; `violations[]` names the entity and the exact failing statement.

Run this after every enablement step and once daily during the soak. Omitting
`clerkOrgId` audits every tenant.

> **Note on the measured-language gate.** Nothing in the write path strips this
> wording — the normalizer bounds, sources, and deduplicates text, it does not
> police claims. The gate is an evaluation and audit control, so a violation
> means the prompt needs work, not that a filter failed.

---

## 4. Side-by-side V1/V2 reviewer worksheet

Two reviewers, independently, on at least five processes spanning one
contributor, several agreeing contributors, and one with known contradictions.
Show the stored legacy Markdown beside the V2 Overview for the same process.

Score each 1–5, then record which version the reviewer would rather hand to an
operations lead.

| Dimension | Question |
| --- | --- |
| Fidelity | Does it match what the interviews actually said, without inventing certainty? |
| Scannability | Can you answer "what is this process and who runs it" in under 30 seconds? |
| Operational usefulness | Would this change what you do next? |
| Evidence honesty | Is it clear what is corroborated, single-sourced, and missing? |
| Coverage honesty | Does the coverage claim match the conversations you can see? |

**Gate:** both reviewers prefer V2 on fidelity, scannability, and operational
usefulness, and neither finds a critical labelled fact present in V1 and absent
from V2. Record dissent verbatim — a split decision is a blocker, not an
average.

---

## 5. Signed-in visual QA checklist

Open as a signed-in member of the enabled tenant. This closes the open Phase 6
and Phase 7 exit gates as well.

For each of desktop, tablet, and mobile, in both light and dark mode, with the
tenant accent applied:

- [ ] **Process → Overview**: header, evidence strip, scope and participants,
      reported variations, agreements, gaps, notable context, Flow/Insights
      footer.
- [ ] **Process → Flow**: graph renders; a `node` deep link focuses the right
      node; an invalid node ID fails safely.
- [ ] **Process → Insights**: findings link to their owning Flow node; no
      repeated node description.
- [ ] **Department overview**: brief, child coverage ledger, progress bar.
- [ ] **Function overview**: same, one level up.
- [ ] **Mobile preview sheets**: brief, coverage, state, generated time — no
      full Markdown, no repeated entity name.
- [ ] **States**: current, stale-while-refreshing, partial, failed, missing,
      and legacy fallback all readable and not misleading.
- [ ] **Visual hierarchy**: the executive brief reads as primary; supporting
      findings do not compete with it.
- [ ] **Accessibility**: focus rings visible, headings semantic, evidence
      strength never conveyed by colour alone, refresh status announced.
- [ ] **PDF export**: sections in Overview → Flow → Insights order, evidence
      labels and sources legible, no duplicated detail.
- [ ] **Copy**: clipboard Markdown matches what the page shows.

---

## 6. Cost and latency measurement

```
npx convex run summaryOps:stageCostReport '{"clerkOrgId":"org_internal"}'
```

Reports per stage and per hierarchy level: call count, failures, truncations,
input and output tokens, cost in micro-USD, and p50/p95/max latency. It reads
the AI usage ledger, which is the only place per-tenant spend exists — every
tenant shares one provider deployment, so provider telemetry cannot attribute
cost to a tenant.

Watch for, and investigate before proceeding:

| Signal | Threshold | Why it matters |
| --- | --- | --- |
| `truncated > 0` on any stage | any | A truncated call is billed work that produced nothing usable; the token budget is too small for that content. |
| p95 latency within 20% of the stage timeout | evidence 120s, chunk 150s, final 120s | Near misses become failures under load. |
| `costPerCallMicroUsd` more than 2× the internal baseline | per stage | Prompt or evidence growth that will not scale to a larger tenant. |
| `truncatedSample: true` | any | The report hit its row limit; raise `rowLimitPerOperation` before trusting the totals. |

Record the internal-tenant figures in the task list before enabling anyone
else. They are the baseline every later comparison uses.

---

## 7. Seven-day soak

Daily, for each enabled tenant:

```
npx convex run summaryOps:runHealthReport '{}'
npx convex run summaryOps:auditStoredArtifacts '{}'
npx convex run summaryOps:stageCostReport '{}'
npx convex run summaryOps:v2CoverageReport '{}'
```

| Watch | Source | Escalate at |
| --- | --- | --- |
| Invalid source keys | `auditStoredArtifacts` → `factual_finding_without_source`, `source_outside_snapshot` | any occurrence — P0 if the source is another tenant's |
| Measured language | `auditStoredArtifacts` → `measured_language` | any occurrence |
| Coverage mismatch | `auditStoredArtifacts` → `coverage_integrity` | any occurrence |
| Truncation | `stageCostReport` → `truncated` | any occurrence |
| Stalled runs | `runHealthReport` → `stalled[]` | any run idle beyond 15 minutes |
| Retries and resumes | `runHealthReport` → `retriedRuns`, `resumedRuns` | a sustained rise, or any run reaching `maxAttempts` |
| Partial artifacts | `runHealthReport` → `partialSnapshots` | partial that does not resolve on the next refresh |
| Failure codes | `runHealthReport` → `errorsByCode` | any new code, or `generation_failed` trending up |
| Refresh-on-view frequency | `stageCostReport` call counts against known content changes | calls without a corresponding source change — the idempotence gate is leaking |
| Cost | `stageCostReport` → `totalCostMicroUsd` | day-over-day growth without matching interview volume |

**Soak gate:** seven consecutive days with no unresolved P0 or P1 reliability
or tenant-isolation issue.

---

## 8. Rollback drill

Run once, deliberately, during the soak — a rollback path that has never been
exercised is not a rollback path.

1. Record the current artifact and coverage for one process, one department,
   and one function on an enabled tenant.
2. `npx convex env set SUMMARY_V2 false`.
3. Confirm within one minute: Overview, clipboard, and PDF all render the
   stored legacy Markdown; coverage metadata is withheld rather than restated;
   `ensureCurrent` answers `disabled`; the refresh-on-view hook stops asking.
4. Confirm the artifacts are still in the database:
   `npx convex run summaryOps:v2CoverageReport '{}'` still counts them.
5. Restore the previous allowlist value.
6. Confirm the same three entities render the identical artifact, with the
   same `provenance.generatedAt` — nothing regenerated.

Record the elapsed time from step 2 to step 3. That is the real recovery time.

---

## 9. Open gates

These require a signed-in human, a live deployment, or elapsed time, and
cannot be closed by code:

- Internal tenant enablement and approval (§2 steps 1–5).
- Side-by-side V1/V2 human review (§4).
- Signed-in visual QA, which also closes the Phase 6 and Phase 7 exit gates
  (§5).
- Recorded cost and latency baselines from real generations (§6).
- External tenant enablement and the seven-day soak (§7).
- The rollback drill (§8).
