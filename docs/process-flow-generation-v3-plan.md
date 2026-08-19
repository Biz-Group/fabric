# Process Flow Generation V3 Plan

Status: Proposed (design of record for flow generation; supersedes the v2 plan's
backend design where they differ)
Created: 2026-07-17
Updated: 2026-07-17 — revised after adversarial self-review: added measured
baseline (incl. burst probe + real prod call), re-sized budgets against the
worst observed rate with a TTFT term, specified the watchdog/resume design and
duplicate-trigger guard, redesigned the summary map step around Fabric-owned
summaries, added quality-parity gates to rollout.
Updated: 2026-08-02 — re-verified every code claim against HEAD before starting
step 1: corrected drifted line references, widened P1's test scope from
flow-stage to all budgeted calls (and recorded the six call sites that violate
it today), noted that the reaper needs a new `convex/crons.ts`.
Companion docs: `docs/process-flow-generation-v2-plan.md` (v2 — most of its
Phase 1 carries forward), `docs/pipeline-reliability-and-scale-plan.md`
(incident diagnosis + ops rails), `docs/foundry-migration-runbook.md`.

## Why a v3

Two production incidents, one root-cause class:

1. **Pre-cutover (OpenRouter):** complex processes exceeded the 32,768-token
   output cap → truncated JSON → total failure. This motivated v2.
2. **Post-cutover (Foundry, 2026-07-17):** a 4-contributor / 108-minute process
   failed with `status: undefined` timeouts. Probing proved the deployment
   healthy; the failure was **generation time vs. the 120 s client timeout**.
   A stopgap (450 s single-attempt timeout on the flow call) shipped and the
   real flow then generated successfully.

## Measured baseline (2026-07-17, prod deployment `fabric-claude-haiku-4-5`)

| Observation | Context | TTFT | Gen rate (post-first-token) |
|---|---|---|---|
| Probe, solo, 1,500 tok | idle deployment | 3.0 s | 80.6 tok/s |
| Real flow generation, 9,511 out tok / 6,492 in tok | production, `req_011Cd7LxcFzf8W8Y7guUJ8Pw` | — | ~99 tok/s overall (95.8 s total) |
| Probe burst, 4 × 1,500 tok concurrent | simulates 4 teams at once | 2.8–3.3 s (flat — no queuing) | 65.4–72.5 tok/s |

What the data says:

- **Throughput varies ~1.5× (65–99 tok/s) within a single afternoon.** Global
  Standard routing is global; rate is not a constant. Budgets must be sized
  against the WORST observed rate, and re-measured on any model/deployment
  change (`npm run foundry:throughput <tokens> <waves> <concurrency>`).
- **The original failure was marginal, not catastrophic.** The successful
  response (9,511 tok) takes ~96 s at 99 tok/s and ~121 s at 80 tok/s — it
  straddles the old 120 s timeout; ordinary variance decided pass vs. fail.
- **The 450 s stopgap is provably insufficient under load:** a cap-size
  response at the worst burst rate takes ~504 s. It also leaves only ~90 s of
  slack inside the 10-minute Convex action ceiling.
- **The truncation wall is close.** A 4-conversation process already consumes
  9.5k of the 32,768-token output cap; a process ~3× as complex truncates even
  with unlimited time.
- **Mild concurrency does not queue (TTFT flat) but does slow generation
  ~15–20%.** Capacity 50 is fine for current scale; per-request rate is what
  degrades first.

Same lesson from both: **output volume is the scarce resource.** One giant
completion fails two independent ways — it hits the token cap (truncation) or
it hits the clock (timeout) — and both failures are total: partial output is
discarded, "Try Again" repeats the identical call, and the user waits ~7
minutes to find out. Every scaling dimension (more contributors, richer
analysis, more nodes) pushes output up. The stopgap moved the wall; it did not
remove it.

**Verdict on v2 given the new knowledge: the core design was right** — split
the output across small bounded calls. v3 keeps that backbone and revises it
with what we now know: measured throughput (including its variance under
concurrency) lets us size every call by *time* with ~2× headroom against the
worst observed rate, plus telemetry that surfaces drift before it fails. v3
also trims v2 scope that added mechanism without reliability, and folds in the
concurrency/idempotency fixes the incident surfaced upstream.

## Design principles

- **P1 — Budget output by time, sized against the worst measured rate.**
  Every LLM call satisfies
  `maxTokens ≤ (timeoutMs − worstTTFT) / 1000 × worstRate × 0.5`.
  With today's measurements (worstRate 65 tok/s, worstTTFT ~4 s), a 150 s
  timeout supports ~4,700 tokens. This is ~2× headroom against the worst
  observed conditions — not a guarantee. Two backstops make it safe anyway:
  retries (a per-request budget leaves room for 2), and **near-miss
  telemetry**: `logSuccess` warns whenever a call's latency exceeds 60% of its
  timeout, so throughput drift is visible in logs/alerts long before it causes
  failures. The measured constants live in one place in code, dated, with the
  probe command to refresh them; a unit test asserts the inequality against
  those constants for **every** call that declares a budget, not just
  flow-stage calls, so a new over-budget call site is caught as it is added.
  ⚠️ Most synthesis calls violate P1 today: the five 8,192-token calls
  (`postCall` rebuild + incremental, `summaries` ×2, `summariesHelpers`) and
  the 16,384-token voice analysis all run on the default 120 s timeout, whose
  P1 ceiling is ~3,770 tokens. Step 1 only makes this **visible** (a runtime
  warning per over-budget call, plus real latency from near-miss telemetry);
  step 2 resolves it. Note the resolution is not just "raise the timeout":
  8,192 tokens needs ~256 s to be compliant, and 3 attempts × 256 s = 768 s
  breaks the 10-minute action ceiling — so each site needs a declared timeout
  **and** a re-checked `maxRetries`.
- **P2 — One LLM call per scheduled action.** No action makes more than one
  completion call. Each call retries independently (its full
  attempts × timeout budget fits inside one action — see the budgets table),
  the 10-minute ceiling never binds, and a crash loses one small step, not the
  run.
- **P3 — Every step ends in a persisted state.** Terminal (`ready`/`failed`)
  or resumable (`pending` rows). A watchdog reaps anything stuck in
  `generating`. No zombies, no invisible failures.
- **P4 — Input is cheap; don't over-engineer it.** Evidence rides the ~200k
  context window. Bound the DB reads (no unbounded `.collect()` of transcripts)
  but do not build input-compression machinery yet.
- **P5 — Bounded by design beats recovered by cleverness.** Target ≤60 nodes
  in the graph prompt (instruct consolidation beyond that). Enforcement is
  deliberately soft: the normalizer accepts whatever arrives and logs a
  warning above 60 for product review — the *hard* guard is truncation
  detection on the skeleton (fail cleanly), never a count-based reject, which
  would reintroduce a total-failure mode. ⚠️ The 60-node target is a
  **product decision** (it trades diagram granularity for boundedness) —
  confirm it with whoever owns the product, and calibrate against real node
  counts once flows are in the child table. Prefer deleting scope to adding
  mechanisms.

## Architecture

Same three-stage backbone as v2 Phase 1, now with Foundry-derived budgets:

```
generateProcessFlow (public, ms)          — validate, new generationId,
                                            status "generating", cleanup old
                                            detail rows, schedule graph pass
  └─ generateGraphInternal                — compact graph only (nodes, edges,
                                            critical path); save "ready" +
                                            detailsStatus "generating";
                                            insert pending detail rows;
                                            schedule first batch
       └─ generateNodeDetailsBatchInternal (×N, self-scheduling chain)
                                          — enrich ~6 nodes/batch with full
                                            graph + evidence as input;
                                            halve batch once on truncation
            └─ finalizeNodeDetailsInternal — recompute rollups from detail
                                            rows (no LLM); detailsStatus
                                            ready/partial
```

### Per-call budgets (the v3-specific numbers)

| Call | maxTokens | timeoutMs | maxRetries | P1 check (worst 65 tok/s, 4 s TTFT) | Worst-case action | Expected wall time |
|---|---|---|---|---|---|---|
| Graph pass | 6,144 | 210,000 | 1 | (210−4)×65×0.5 = 6,695 ≥ 6,144 ✓ | ~7 min | 35–60 s |
| Detail batch (~6 nodes) | 4,096 | 150,000 | 2 | (150−4)×65×0.5 = 4,745 ≥ 4,096 ✓ | ~7.5 min | 25–55 s |
| Finalize | — (no LLM) | — | — | — | seconds | seconds |

- Empirical anchors (from the real 4-conversation flow): total rich output
  9,511 tok; input evidence 6,492 tok. If the skeleton is ~25–30% of output,
  details run ~350–500 tok/node → a 6-node batch ≈ 2–3k, comfortably under
  4,096. Recalibrate batch size from actual per-node detail sizes once the
  first v3 flows land in the child table.
- The per-request `timeoutMs`/`maxRetries` plumbing in
  `convex/lib/aiProvider.ts` (shipped 2026-07-17) is exactly the mechanism
  these budgets need. **Retire the 450 s stopgap** in
  `buildFlowGenerationAIRequest` when the graph pass replaces the single call
  — the burst probe showed a cap-size response takes ~504 s at the worst
  observed rate, so the stopgap already fails under mild concurrent load.
- Expected end-to-end: graph visible in <1 min; a 40-node flow fully enriched
  in ~4–6 min sequential — similar to today's single call, but it cannot
  truncate, each step retries cheaply, and Phase 2 UI can show the graph
  immediately. Be explicit about what Phase 1 buys the user: **the same wait,
  ending in success instead of a coin flip** — the perceived-latency win is
  Phase 2.

### Carried forward from v2 unchanged (see v2 for full detail)

- Child table `processFlowNodeDetails` + indexes (also solves the 1 MB
  aggregate-doc risk); legacy rows read as fully detailed.
  - **Shipped 2026-08-03** (step 3), with four decisions worth recording:
    1. **`processFlows.nodes` keeps its detail fields required.** v2 assumed
       reads would merge "compact" nodes with detail rows, which means widening
       those fields to optional — and that breaks every existing reader (flow
       tab, insights, PDF export) for as long as step 4 is in flight. Instead
       the graph pass writes empty placeholders and the read overlays detail
       rows on top. Node-level `detailStatus` is what distinguishes "not
       enriched yet" from "genuinely empty", so nothing is lost.
    2. **`detail` is one optional nested object**, not eleven optional fields.
       A row has no detail or a whole detail; flat optionals would make
       `pending` and `enriched but empty` indistinguishable.
    3. **Dropped v2's `by_clerkOrgId_and_processFlowId_and_generationId`
       index** — it is a prefix of the two longer ones, and Convex serves
       prefix queries from those. Two indexes, not three.
    4. **Two reaper indexes, not one.** The plan's watchdog queries flows stuck
       in `status: "generating"` *or* `detailsStatus: "generating"`; those need
       separate indexes. Neither is org-scoped, since the cron sweeps every
       tenant.
- `generationId` stale-write protection on every mutation; cleanup of
  prior-generation rows in bounded batches.
- **`patch`-not-`replace`** for every save after the initial one (v2 flags
  this as the top silent-regression risk; test it).
- Failure mapping: graph fails → flow `failed`; details fail → flow stays
  `ready` with `detailsStatus: "partial"`/`"failed"`.
- Phase 1 minimal UI (spinner until `detailsStatus === "ready"`), Phase 2
  progressive rendering — unchanged phasing. Cancel/retry affordance on the
  generating state.
- v2's Testing Plan (all items), plus: a unit test asserting every flow-stage
  request satisfies P1's budget inequality against the dated measured
  constants, a watchdog-resume test (see below), and a regen-race test.

### Watchdog & recovery (v3 spec — v2 left this open)

The staged pipeline multiplies scheduled-action surfaces from 1 to N+2, so
recovery is core infrastructure, not an afterthought. Design:

- **Heartbeat:** every pipeline mutation (initial save, graph save, each batch
  save, finalize) patches `processFlows.lastProgressAt = Date.now()`. Add a
  `resumeAttempts: number` field (reset to 0 on each new `generationId`).
- **Reaper cron** (every 5 minutes, `crons.interval`): query flows where
  `status === "generating"` OR `detailsStatus === "generating"` with
  `lastProgressAt` older than 10 minutes (index `by_status_and_lastProgressAt`;
  bounded `.take()`).
- **Resume, don't just fail.** For each stuck flow:
  - Graph stage stuck (`status: "generating"`, no graph saved) → mark
    `status: "failed"` with a retryable error message. (Re-running the graph
    from the reaper risks duplicate token spend on a run the user abandoned;
    the UI retry is the recovery path.)
  - Detail stage stuck with `pending` rows and `resumeAttempts < 2` →
    increment `resumeAttempts`, schedule the next detail batch. This closes
    the gap that terminal-status try/catch wrapping cannot: **an action killed
    between "write batch rows" and "schedule next batch"** (OOM, platform
    kill) leaves pending rows with nothing scheduled.
  - Detail stage stuck with `resumeAttempts ≥ 2` → run finalize, which lands
    on `detailsStatus: "partial"`/`"failed"` per the normal failure mapping.
    The graph stays usable.
- **Test:** simulate a dead batch (pending rows, nothing scheduled, stale
  heartbeat) and assert the reaper resumes it exactly once per attempt and
  finalizes to `partial` after the attempt cap.

### Duplicate-trigger guard

`generationId` prevents stale *writes*, but two simultaneous "Generate" clicks
would still burn two full pipelines of tokens. `generateProcessFlow` therefore
**joins** an in-flight run instead of starting a new one: if
`status === "generating"` (or `detailsStatus === "generating"`) and
`lastProgressAt` is fresher than 2 minutes, return without creating a new
`generationId`. A stale in-flight run (heartbeat older than that) may be
superseded — that is the manual escape hatch for a wedged run, and the
`generationId` guard makes the takeover safe.

### Changed from v2

| v2 | v3 | Why |
|---|---|---|
| Batch size "start ~5–8 and tune" by token estimate | Batch size derived from the time budget (P1); starting values above | We now have measured tok/s; time is the binding constraint |
| Adaptive bisection (recursive 8→4+4…) | Halve once, then mark the half's stragglers `failed` | Simpler; with time-sized batches truncation is already rare; per-node retry (Phase 2) covers the tail |
| Sequential batches, parallelism "later, maybe" | Sequential, period (Phase 1 and 2) | Parallel batches fight for the capacity-50 pool and OCC on counters; wall-time win is minutes, complexity cost is real. Revisit only if the Phase 4 concurrency probe shows headroom AND users complain about enrichment latency |
| Optional single-call fast path for small processes | Rejected | Two code paths, two failure modes, no reliability gain |
| Deterministic enrichment (gated optimization) | Dropped from scope entirely | v2's own audit showed the prerequisites (provenance mapping) don't exist; LLM detail pass is required anyway |
| OpenRouter assumed | Provider-agnostic via `generateAICompletion`; budgets tuned to Foundry | Cutover happened; OpenRouter remains the documented rollback |

## Upstream stages (must scale with the same principles)

The flow is the last link; the same output-wall exists upstream. v3 scope
includes:

1. **Rolling-summary rebuild → map-reduce, with OUR map step.** The rebuild
   exists to recover fidelity the lossy incremental path loses, so its inputs
   must be faithful. The vendor `transcript_summary` (ElevenLabs) is
   uncontrolled by this repo — depth and shape can change without notice — so
   it must NOT be the foundation (the v2 audit made this exact point about the
   adjacent `analysis` field). Design:
   - **Map:** a Fabric-owned per-conversation summarization prompt (structured
     for downstream merging: steps, actors, tools, pain points, tensions) run
     once per conversation and cached on the row as
     `conversations.processSummaryInput` (never overwritten unless the
     transcript changes). Budgeted per P1 (~1,024 tok, 120 s). The vendor
     summary is display-only.
   - **Orchestration for missing map outputs:** a sequential self-scheduling
     chain, exactly like detail batches (one conversation per action, P2) —
     no fan-out/join barrier, no counter contention. New conversations get
     their map summary at completion time, so the chain only runs when
     backfilling.
   - **Reduce:** one bounded call merging the N cached map summaries
     (N × ~300 tok fits P1 to ~20 conversations per call; chunk the reduce
     into a chain beyond that).
   - This replaces the concatenate-all-transcripts prompt (the `forceRefresh`
     branch at `convex/postCall.ts:969-1002`; prompt constant at `:916`),
     whose input grows linearly with recorded minutes and whose 8,192-token
     output is saved with **no truncation check**. Note this branch is the
     *cold* path — it runs only from the manual rebuild button and
     `conversations.ts:350`. The incremental branch (`:1077-1083`) is what
     fires on every conversation completion, and item 1 deliberately leaves
     its design alone; it needs only the truncation check (item 2) and a P1
     budget.
   - **Quality gate before switching:** run old rebuild vs. new map-reduce on
     the same 3–5 real processes and compare rolling summaries side by side —
     the new path must not lose consensus/tension detail. Boundedness is not
     allowed to silently cost fidelity.
   - **Shipped 2026-08-02** (`conversations.processSummaryInput` +
     `processSummaryInputHash`, `generateConversationSummaryInput`,
     `backfillProcessSummaryInputs`, `getProcessSummaryInputs`, reduce at
     4,096 tok / 150 s). The map record is written when a conversation
     completes and when its transcript is refreshed; the hash makes both
     idempotent. The old transcript-concatenating rebuild and its
     `getConversationSummaries` query are deleted. ⚠️ **The quality gate above
     has NOT been run** — it needs real processes on a dev deployment, so it
     is the gating item before this reaches prod.
2. **Truncation checks everywhere.** One shared helper: every synthesis call
   checks `isTokenLimitFinishReason`; truncated output is never persisted
   silently (summary, analysis, dept/function summaries).
3. **Bounded reads.** `getFlowGenerationData` and `getConversationSummaries`
   stop `.collect()`ing full transcripts; the graph pass reads the rolling
   summary + compact per-conversation analysis; detail batches read the
   evidence they need. ~~Denormalize the conversation count.~~ **Decided
   2026-08-02: not doing this.** Convex reads whole documents, so the lever is
   how many rows a query touches, not which columns — both queries now filter
   `status` on the index and cap at 50 rows, and the incremental path's count
   comes from `countDoneConversations`, which returns an integer instead of
   shipping every transcript across the action boundary. A denormalized
   counter would need maintaining at ~9 write sites (4 inserts, 5+ deletes
   incl. cascades) and drifts silently into wrong `[Name, Conv. N]` citations.
   Revisit only if 50 conversations per process stops being a comfortable
   ceiling.
4. **Coalesce summary regens.** Concurrent conversation completions each
   schedule `regenerateProcessSummary`; two near-simultaneous runs race on
   "latest conversation" and can drop or double-integrate a transcript. ~~Make
   the regen take the triggering `conversationId` and dedupe scheduling (skip
   if a regen for this process is already pending).~~ This is a correctness bug
   independent of scale.
   - **Shipped 2026-08-02, with one correction to the design above:** plain
     "skip if already pending" *drops* conversations — if A and B finish
     together and B is skipped, B is never integrated. The gate
     (`requestProcessSummaryRegen` / `finishProcessSummaryRegen` /
     `touchProcessSummaryRegen`, backed by `processes.summaryRegenScheduledAt`
     and `summaryRegenRequestedAgain`) instead **coalesces**: mid-run requests
     raise a flag that schedules exactly one trailing pass, always a full
     rebuild. Passing the triggering `conversationId` turned out to be
     unnecessary — the reduce is idempotent over every cached record, so there
     is no "latest conversation" left to race on. All five trigger sites route
     through the gate; the released-in-`finally` design means a truncation or
     provider error cannot wedge a process, and a 2-minute staleness window
     plus the backfill heartbeat covers a hard crash.

## How this scales

| Dimension | What grows | Why v3 holds |
|---|---|---|
| Minutes per contributor | Input tokens | P4: rides the context window; summaries + bounded reads keep prompts sane |
| Contributors per process | Input + moderate output (more pain points) | Output decoupled: skeleton capped (P5), details per-batch bounded |
| Nodes per process | Output | Soft target ~60 nodes (P5); batches scale linearly in count, never in size |
| Concurrent teams | Request concurrency vs capacity 50 | Measured: 4-concurrent slows generation only ~15–20% with flat TTFT, and budgets are sized to the degraded rate. Levers if a larger concurrency probe shows contention: workpool (`maxParallelism` ~3) and/or the documented capacity raise — measured, not guessed |
| Conversations per process | Rebuild input | Map-reduce over cached Fabric map summaries; map calls are independent (P2); reduce chunks into a chain past ~20 conversations |

## Execution plan

| Step | Work | Size |
|---|---|---|
| 1 | Shared budget/truncation helpers in `aiProvider.ts` (P1 assertion + `isTokenLimitFinishReason` wrapper) | S |
| 2 | Upstream items 1–4 (map-reduce rebuild, truncation checks, bounded reads, regen coalescing) | M |
| 3 | Schema: `processFlowNodeDetails` + v2 metadata fields on `processFlows` | S |
| 4 | ~~Staged pipeline~~ **DONE 2026-08-03.** `lib/flowStages.ts` (per-stage prompts, schemas, normalizers, budgets), `generateGraphInternal` → `generateNodeDetailsBatchInternal` (self-scheduling) → `finalizeNodeDetails`, `generationId` guards on every write, patch-only saves, read merge in `getProcessFlow`, reaper in the new `convex/crons.ts`, and the 32,768-token single call plus its 450 s stopgap deleted. ⚠️ **Do not deploy without step 6** — `status` now flips to `ready` when the *graph* lands, and the flow tab, insights tab, and PDF export all gate on `status` alone, so users would see a diagram with blank step details for the minutes the detail batches take. Four deviations: (a) no separate `finalizeNodeDetailsInternal` action — the batch action calls the finalize mutation when no pending rows remain, and the watchdog schedules it directly; (b) ~~`automationOpportunities` derived mechanically~~ **corrected same day — the mechanical version was wrong.** Automation opportunities are load-bearing product output (they are what a future Agents Library / Power Automate scaffolding builds from), not a rollup, so they get their own **stage 3**: `generateFlowInsightsInternal` makes one bounded call (4,096 tok / 135 s — raised from 2,048 tok / 120 s on 2026-08-19 after real runs truncated) over the *whole* enriched graph, because several manual handoffs in a row are one thing to build and no per-node call can see that. Output is structured (`title`, `kind` of agent/workflow/integration/other, the `nodeIds` it spans, `rationale`, `expectedBenefit`, `prerequisites`, `confidence`) and stored in `insights.automationOpportunityDetails`, with the flat string array kept for the existing Insights tab. Failing this stage costs only the opportunities: finalize still lands the run, falls back to flagging automatable-looking steps, and sets `insights.automationOpportunitiesSource: "derived"` so downstream tooling can never mistake a placeholder for an analysed opportunity; (c) `startFlowGeneration` leaves the previous graph in place instead of wiping it, so a failed run no longer costs the user the flow they already had; (d) the reaper schedules finalize rather than calling it inline, since sweeping 25 flows × their detail rows would not fit one transaction | L |
| 5 | ~~Tests~~ **DONE 2026-08-03.** 220 tests total; ~85 cover this work across `processFlows.test.ts` (stage budgets, normalizers, opportunity structure), `processFlowSchema.test.ts` (indexes, stale-generation guard, reaper queries), `processFlowPipeline.test.ts` (mutation layer: join guard, patch-not-replace, all finalize states, read merge, watchdog resume/cap), `processFlowActions.test.ts` (the stages driven against a stubbed provider: graph truncation, batch halving, tenant isolation, per-stage prompt contents), `summaryRegen.test.ts` (the regen race), and `src/lib/flow-status.test.ts` (the UI gate). Every item on v2's list is covered except deterministic enrichment, which is out of scope. One harness limitation worth knowing: convex-test does not execute scheduled *actions* here, so the chain is driven stage by stage and each hand-off is asserted from `_scheduled_functions` instead — the scheduling decision is verified, its execution by the platform is not | M |
| 6 | ~~Phase 1 UI~~ **DONE 2026-08-03.** The rule lives once in `src/lib/flow-status.ts` (`flowStage` / `isFlowRenderable` / `flowDetailProgress` / `flowHasIncompleteDetails`) instead of being re-derived at each surface, and the flow tab, insights tab, and PDF export all gate on it. The generating state now names which stage it is in and shows "N of M steps described", because the detail phase is minutes long and a bare spinner reads as hung. A `partial`/`failed` run renders with a notice saying the metrics are a floor, and says so explicitly when the automation opportunities were the derived fallback rather than analysed. `vitest.config.ts` now includes `src/**/*.test.ts` — frontend logic had no test path at all before. **Not done: cancel.** It needs a backend mutation to abandon an in-flight run, and the watchdog already resolves a wedged generation within ~15 minutes, so it is not load-bearing; retry on the failed state was already there | S |
| 7 | Rollout with a **quality-parity gate** — tooling ready 2026-08-03, the run itself needs a dev deployment and real data. See "Running the quality-parity gate" below | M |
| 8 | ~~Phase 2 progressive UI~~ **DONE 2026-08-04.** Only the graph stage blocks now: `canRenderGraph` gates the diagram, so the topology appears as soon as it lands with a non-blocking "Describing steps — N of M" indicator. Node cards and the detail panel read each node's own `detailStatus` (shimmer while pending, "no description" plus a per-step retry when failed); `retryNodeDetail` / `requeueNodeDetail` re-request one step instead of the whole run. **Fixed a live bug from step 6 while doing it:** a `partial` flow rendered, and its un-described nodes' placeholders were being counted as findings — `deriveAutomationCandidates` treated the `"low"` placeholder as a candidate and `deriveConfidenceCounts` counted `"medium"` for steps nobody assessed. Detail-derived derivations now filter through `isNodeDescribed`; graph-derived ones (handoffs, decision branches) still use every node, since topology is settled when the graph lands. **Deliberately not done: progressive Insights sections.** v2 wanted graph-level metrics immediately with detail-derived ones filling in; the tab stays gated until details are ready, because metrics that climb while you read them are worse than a short wait — and the flow tab now covers the "show me something" need | L |

Steps 1–2 are independently shippable and de-risk production **before** the
big step 4 lands. Load-test scenarios and observability rails stay in
`docs/pipeline-reliability-and-scale-plan.md` (Phase 4) and apply unchanged.

## Running the quality-parity gate

⚠️ **Capture the "before" report first.** Regenerating patches the flow row in
place, so the single-call flow you are comparing against is gone the moment the
new graph saves. There is no undo. Same for `processes.rollingSummary`, which the
summary rebuild overwrites.

Tooling: `convex/lib/flowQuality.ts` measures a flow; `processFlows.flowQualityReport`
captures a report; `processFlows.compareFlowQuality` diffs the current state
against a captured one. The comparison sorts differences into **regressions**
(objective losses — dangling edges, no end step, coverage down, fallback
opportunities, a summary section gone), **judgement calls** (step count changed,
descriptions shorter, fewer opportunities — could be consolidation or loss), and
**improvements**.

Per process, on a dev deployment carrying a copy of real data:

1. Capture the baseline, **before touching anything**:
   ```
   npx convex run processFlows:flowQualityReport \
     '{"processId":"<id>","clerkOrgId":"<org>"}' > before-<process>.json
   ```
   Also save the rendered flow and summary — screenshot the Process Flow and
   Insights tabs, and copy the rolling summary text. The numbers cannot tell you
   whether the prose is good.
2. Regenerate the flow in the app. Wait for `detailsStatus: "ready"` — the UI
   shows "N of M steps described" while it works.
3. Diff:
   ```
   npx convex run processFlows:compareFlowQuality \
     '{"processId":"<id>","clerkOrgId":"<org>","before":<contents of before-<process>.json>}'
   ```
4. **Read both flows side by side.** Every `judgementCall` needs an answer, and
   the question is always the same one: did the new flow say less about how this
   work actually happens? Pay particular attention to the automation
   opportunities — they are the product's output, and a plausible-sounding
   opportunity nobody described is worse than none.
5. Same for the rolling summary: rebuild it and check consensus/tension detail
   survived, not just that sections are present.

Choose the processes deliberately: **the 4-contributor / 108-minute one that
started this**, at least one that succeeded easily before (parity check), and at
least one large enough to approach the 60-node target (where consolidation
behaviour shows up).

Any `regressions` entry blocks the gate until it is explained or fixed. An empty
`regressions` list is necessary, not sufficient — the human read is the gate.

Then, in prod, verify with `npx convex logs`:

- every stage logs sub-budget latency, and **zero** `AI request latency neared
  its timeout` warnings;
- zero `AI request exceeds its time budget` warnings from the flow stages (any
  remaining ones will be the summary call sites, which still need their budgets
  declared — see P1);
- no `Reaping a flow stuck in...` warnings, which would mean the pipeline is
  dying rather than completing.

## Deferred cleanup — things to delete once v3 has settled

**1. The retained-previous-flow fallback.** *(Added 2026-08-04, kept
deliberately. Delete when v3 has run in prod long enough to trust.)*

When a generation fails at the graph stage, the previous flow survives in the
row and the UI renders it under a "Couldn't refresh — showing the previous
version" banner instead of an error page. This exists because the single-call
design used to *destroy* the previous flow on failure, and the 108-conversation
process had already burned the user once.

Once graph-stage failures are known-rare in practice, this is arguably worse
than an honest error: a stale flow behind a banner is easy to misread as
current. To remove it, delete:

- `hasRetainedPreviousFlow` in `src/lib/flow-status.ts` (+ its tests)
- the `showingRetained` branch and banner in
  `src/features/process-flow/process-flow.tsx`
- the `showingRetained` branch and `InlineNotice` in
  `src/features/insights/process-insights-tab.tsx`
- restore `useProcessFlowLayout`'s `status === "ready"` guard

Keep, regardless of that decision: `startFlowGeneration` and
`failFlowGeneration` not touching `nodes`/`edges`/`insights`/`conversationCount`
on failure. Retaining the *data* costs nothing and is strictly better than the
old `replace`-based save; only the *rendering* is the transitional part.

## Known gaps and open work

Not blocking, but real. Roughly in priority order:

1. **P1 budgets on the five remaining synthesis call sites.** The incremental
   process summary, both rollup summaries, the cascade (8,192 tokens each) and
   voice analysis (16,384) still run on the default 120 s timeout, whose P1
   ceiling is ~3,770. Truncation is caught at all of them, so a failure is
   visible rather than silent — but the timeouts are undeclared. This is now
   *decidable*: prod has been running with the near-miss telemetry from step 1,
   so `npx convex logs` can say whether any of them actually approach their
   limit. Each site needs a declared `timeoutMs` **and** a re-checked
   `maxRetries`, since 3 attempts × a compliant 256 s breaks the 10-minute
   action ceiling.
2. **Re-transcribed conversations don't mark a flow stale.** `markFlowStale`'s
   `summaryRebuilt` trigger compares conversation counts, so editing a
   transcript in place changes nothing it can see. Needs a content fingerprint
   on the flow, the way `processSummaryInputHash` does for summaries.
3. **PDF export skips a retained flow.** `hasFlow` requires details ready, so a
   failed refresh exports without the diagram rather than exporting the previous
   version. Deliberate — a document that doesn't say which generation it came
   from is worse — but it could carry the previous version plus a note.
4. **No cancel on an in-flight generation.** The watchdog resolves a wedged run
   within ~15 minutes, so this is convenience, not safety. Needs a mutation to
   abandon a run.
5. **Insights sections are not progressive.** v2's Phase 2 wanted graph-level
   metrics immediately with detail-derived ones filling in; the tab waits for
   details instead, because numbers that climb while you read them are worse
   than a short wait. Revisit if the wait is felt now that the flow tab renders
   early.
6. **`vite/client` typecheck noise.** Nine convex-test files carry
   `/// <reference types="vite/client" />` per the Convex guidelines, but the
   types are not resolvable, so `npx tsc --noEmit` reports TS2688 for each.
   Pre-existing and cosmetic — tests run fine — but it makes a clean typecheck
   impossible to read at a glance.

## Alternatives considered and rejected

- **Keep the single call; stream the response.** Fixes the timeout fragility
  only. The 32k truncation wall remains (documented production failures),
  recovery is still all-or-nothing, and a 7-minute opaque wait remains the UX.
- **Keep the single call; raise capacity.** The probe showed a lone request is
  healthy at capacity 50 — capacity was never this bug. It is a concurrency
  lever, kept for Phase 4.
- **Keep the single call; move to a larger-output model.** Trades a hard wall
  for a farther wall, adds model-lifecycle risk (Haiku 4.5 v2 already retires
  2026-11-19), and keeps all-or-nothing failure.
- **Deterministic merge instead of the LLM graph pass.** v2's audit: analysis
  taxonomy lacks `start`/`end`, per-conversation step ids have no provenance
  mapping — cannot produce a valid graph without the LLM.
- **Incremental regeneration (only reprocess the new conversation).** Every
  finished interview marks the flow stale, and each refresh re-runs the whole
  pipeline — at scale that is repeated full regenerations. Rejected anyway:
  node ids are not stable across generations, so "update only affected nodes"
  has no reliable join key, and a merged graph must be re-derived when new
  evidence changes the topology. Full regeneration costs roughly
  $0.05–0.15 and ~5 minutes — acceptable. Revisit only if usage data shows
  processes regenerating many times per day; the cheaper mitigation then is
  debouncing staleness prompts, not incremental generation.
