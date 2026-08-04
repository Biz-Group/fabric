# AI Pipeline Reliability & Scale Plan

Status: Ready to execute
Created: 2026-07-17
Trigger: 4 team-member AI interviews (~108 min total) → post-interview "process flow" fails.
Executor: Claude (Opus). Work through phases in order; each phase has a gate.

## Phase 0 findings (recorded 2026-07-17)

Diagnosis ran against prod (`lovable-wolf-596`) by re-running flow generation
and watching `npx convex logs`. **The live failure is a client-side timeout,
not output truncation and not a 429.** Evidence:

```
[CONVEX A(processFlows:generateFlowInternal)] [ERROR] 'AI request failed' {
  operation: 'process-flow-generation',
  provider: 'foundry-claude',
  model: 'foundry:claude-haiku-4-5@2',
  deployment: 'fabric-claude-haiku-4-5',
  latencyMs: 361351,
  status: undefined,
  requestId: null,
  errorType: 'Error'
}
```

- **Prod is on Foundry with the Claude backend** (`provider: foundry-claude`) —
  the runbook's "prod stays on OpenRouter until cutover" is no longer current.
- **`status: undefined` + `requestId: null`** = no HTTP error response ever
  arrived. This rules out 429/quota and token-limit truncation for this run.
- **`latencyMs: 361351` ≈ 3 × 120 s**: the Anthropic SDK client is created with
  `timeout: 120_000` and `maxRetries: 2` (`convex/lib/aiProvider.ts:322-327`);
  the SDK retries timeouts, so 3 attempts × 120 s + backoff = ~361 s. The
  flow-generation call site does not pass `timeoutMs`
  (`convex/processFlows.ts:838-861`), so it gets the 120 s default while
  requesting up to 32,768 output tokens non-streaming.
- **Azure Foundry metrics for the window**: 8 requests, 20.99K input tokens
  (avg 2,624), 3.76K output tokens (avg 471). Two implications: (a) requests DO
  reach Foundry and input size is small — flow-gen input is the rolling summary
  + analysis blobs, a few thousand tokens, so input is not the constraint;
  (b) only ~471 output tokens on average were recorded before the client
  aborted at 120 s, which suggests **very low generation throughput on this
  Foundry deployment** (order of ~4–10 tok/s). At that speed even a modest
  ~4–8k-token flow response can never finish inside 120 s → guaranteed
  timeout loop. Likely related to the small provisioned capacity (Claude
  Haiku 4.5 = 50, `docs/foundry-migration-runbook.md:177-179`).

**Failure chain:** Foundry cutover → slow generation throughput → 120 s
default client timeout expires mid-generation → SDK retries the identical
call twice more → `AIRequestError` → flow `status: "failed"`. The truncation
failure documented in the v2 plan is still real (it predates the cutover, on
OpenRouter), but it is not what is failing right now.

**Priority adjustment:** do Phase 1c (immediate unblock) first, then measure
Foundry throughput (Phase 2c) before deciding capacity vs provider. The v2
staged generation (Phase 1a) remains the durable fix for BOTH failure classes
— smaller per-call outputs finish fast and cannot truncate.

## Context (read first)

The AI pipeline is: **conversation capture → per-conversation analysis → rolling
process summary → process-flow generation** (plus cascaded department/function
summaries). All stages are plain Convex actions chained with
`ctx.scheduler.runAfter(0, …)` — there is no workflow component, no workpool, no
queue, no rate limiter. The single AI entry point is `generateAICompletion`
(`convex/lib/aiProvider.ts:573`), targeting OpenRouter or Azure Foundry
(Claude Haiku 4.5 for all synthesis work).

**The suspected cause ("rate limits/quotas") is probably NOT the primary
failure.** The primary suspect is **output-token truncation**, which is already
documented as failing in production in
`docs/process-flow-generation-v2-plan.md` ("the v2 plan"). Rate limits are a
real secondary risk (Azure Foundry capacities are small), but do not assume —
Phase 0 confirms the actual failure class from logs before any fix ships.

### Ranked failure hypotheses

1. **Flow-generation output truncation** — `generateFlowInternal`
   (`convex/processFlows.ts:787-914`) merges the rolling summary + ALL
   conversations' `analysis` blobs into one prompt and asks for the entire
   diagram in one ≤32768-token completion (`FLOW_GENERATION_MAX_TOKENS`,
   `processFlows.ts:112`). On truncation → `status: "failed"` with
   `FLOW_TOKEN_LIMIT_ERROR_MESSAGE` (`processFlows.ts:113,858-871`). "Try
   Again" re-runs the identical failing call. Documented as already failing in
   prod (v2 plan, Problem section).
2. **Rolling-summary silent truncation / input blow-up** —
   `regenerateProcessSummary` with `forceRefresh` concatenates EVERY transcript
   into one prompt at `maxTokens: 8192` with **no truncation check**
   (`convex/postCall.ts:838-871`). A truncated summary is saved as complete and
   feeds flow generation. 108 min ≈ 35–50k input tokens today; grows linearly.
3. **Provider 429 / quota exhaustion** — retry layer allows only 2 retries,
   caps Retry-After honor at 10 s and backoff at 4 s
   (`convex/lib/aiProvider.ts:19-20,437-450`). Four interviews finishing
   near-simultaneously each auto-schedule a summary regen
   (`postCall.ts:352-356`), plus a 32k-output flow call. Foundry prod
   capacities are small: Claude Haiku 4.5 = 50, GPT-5 mini = 10, GPT-5 nano =
   50 (`docs/foundry-migration-runbook.md:177-179`).
4. **Voice-analysis truncation** (only if any capture was an upload/recording
   rather than the ElevenLabs agent) — `analyzeTranscript`
   (`convex/voiceRecordings.ts:375-396`) sends the whole transcript in one
   prompt; truncation → conversation marked `failed`
   (`voiceRecordings.ts:345-354,848-855`).
5. **Convex platform limits** — unbounded `.collect()` of full transcripts +
   `analysis` blobs in `getFlowGenerationData` (`processFlows.ts:585-591`) and
   `getConversationSummaries` (`postCall.ts:155-161`); single-doc `processFlows`
   row written with `ctx.db.replace` (1 MB doc limit).
6. **Zombie "generating" state** — `getFlowGenerationData` is called BEFORE the
   try/catch in `generateFlowInternal` (`processFlows.ts:809-812`); a throw
   there leaves the flow stuck at `"generating"` forever with no error and no
   retry affordance.

---

## Phase 0 — Diagnose: confirm which failure actually happened

**Goal:** name the exact failing stage + failure class for the 4-interview batch
before writing any fix. Do not skip.

1. **Identify the active provider.** `AI_PROVIDER`, `FOUNDRY_*` are Convex env
   vars (not in repo files). Run `npx convex env list` against the prod
   deployment (see `docs/foundry-migration-runbook.md` for deployment names).
   Note `AI_PROVIDER` and `FOUNDRY_SYNTHESIS_BACKEND` — if `foundry` +
   `gpt5mini`, hypothesis 3 jumps in likelihood (capacity 10).
2. **Pull the logs.** `npx convex logs --prod` (or the dashboard Logs page).
   The AI layer logs structured lines on every call — `logSuccess`
   (`aiProvider.ts:248-264`) and `logFailure` (`aiProvider.ts:280-296`) include
   `operation`, `finishReason`, token usage, HTTP `status`, `requestId`.
   Classify what you find:
   - `finishReason` = `length` / `max_output_tokens` on `flow-generation` →
     hypothesis 1. On `process-summary-*` → hypothesis 2.
   - `status: 429` → hypothesis 3 (note which provider and how many retries).
   - AbortError / timeout at ~120 s → provider latency; raise `timeoutMs`.
   - Convex errors about query return size / document size → hypothesis 5.
3. **Inspect the data.** In the dashboard (or a throwaway internal query):
   - `processFlows` rows: `status`, `errorMessage` (the token-limit message is
     definitive for hypothesis 1), rows stuck at `"generating"` (hypothesis 6).
   - `conversations` rows for the 4 interviews: any `status: "failed"` /
     `"processing"`; sizes of `transcript` and `analysis`.
   - `processes.rollingSummary`: does it end mid-sentence (silent truncation)?
4. **Record findings** at the top of this file (append a "Phase 0 findings"
   section: failing stage, failure class, provider, token counts from logs).

**Gate:** proceed to Phase 1 regardless (its fixes are needed at any scale),
but reorder Phase 1 vs Phase 2 priority according to what the logs show.

## Phase 1 — Fix output truncation (primary fix)

### 1a. Execute the existing v2 plan, Phase 1 (backend only)

`docs/process-flow-generation-v2-plan.md` is a complete, reviewed design —
execute it as written rather than redesigning. Summary of its Phase 1 scope:

- Split flow generation into `generateGraphInternal` (compact graph only) +
  `generateNodeDetailsBatchInternal` (bounded batches, ~5–8 nodes, bisect on
  truncation) + `finalizeNodeDetailsInternal`.
- New child table `processFlowNodeDetails` (schema + indexes specified in the
  v2 plan, Data Model Plan section) — fixes the 1 MB single-doc risk too.
- `generationId` stale-write protection; **`patch`-not-`replace`** saves (the
  v2 plan flags `replace` clobbering as the top silent-regression risk).
- Wrap every scheduled step so any failure writes a terminal status; add a
  stale-`generating` watchdog/reaper. This closes hypothesis 6 — also move the
  `getFlowGenerationData` call at `processFlows.ts:809-812` inside the
  try/catch.
- Minimal UI: keep the existing spinner until `detailsStatus === "ready"`.
- Test list is in the v2 plan (Testing Plan section) — implement it with
  `convex-test` per `convex/_generated/ai/guidelines.md`.

### 1b. Upstream truncation fixes (v2 plan, "Upstream pipeline audit")

- `regenerateProcessSummary` (`postCall.ts:826-977`): check `finishReason` on
  both paths; on truncation, retry with a "be more concise" instruction or
  fail loudly — never save a truncated summary silently.
- **Replace the forceRefresh concatenate-everything design with map-reduce:**
  summarize per conversation (or reuse stored per-conversation `summary`),
  then merge summaries in a second call. Input then scales with conversation
  count, not total minutes. Keep the incremental path as-is (its lossiness is
  accepted per the v2 plan since flow generation reads raw analysis).
- `analyzeTranscript` (`voiceRecordings.ts:375-396`): verify the existing
  truncation check; on token-limit, chunk the transcript (analyze halves,
  merge) instead of terminally failing the conversation. Consider structured
  tool output per the v2 plan's consistency items.
- `getConversationSummaries` (`postCall.ts:155-161`): stop `.collect()`ing all
  transcripts when the incremental path only needs a count + latest — return a
  denormalized count or use `.take()`. (Convex guidelines: never unbounded
  `.collect()`.)

### 1c. Immediate unblock for the live timeout failure (do this FIRST)

Per Phase 0 findings the live failure is a 120 s client timeout against a
slow Foundry deployment. Two mitigations, fastest first:

1. **Zero-code, instant:** flip synthesis back to OpenRouter in prod
   (`npx convex env set AI_PROVIDER openrouter` against `lovable-wolf-596`) and
   re-run the generation. OpenRouter's Haiku throughput is much higher, so the
   32k-cap call completes within 120 s for a 4-conversation process (this was
   the pre-cutover state; note it can still hit the *truncation* class on very
   complex processes per the v2 plan). Coordinate with whoever owns the Foundry
   cutover before flipping.
2. **Small code fix (needed regardless, for whenever Foundry is active):**
   give long-output operations an adequate timeout without breaching the
   10-minute Convex action ceiling:
   - Add a per-request `maxRetries` to `AIRequest` (plumb through
     `callFoundryClaude`/`callFoundryOpenAI` client construction at
     `aiProvider.ts:322-327,374-379` and the OpenRouter loop at
     `aiProvider.ts:463`).
   - Flow generation call (`processFlows.ts:838-861`): pass
     `timeoutMs: 450_000, maxRetries: 0` (worst case ~7.5 min, inside the
     action ceiling). Do the arithmetic wherever this is applied:
     `(1 + maxRetries) × timeoutMs + overhead < 600_000`.
   - CAUTION: if the total ever exceeds the ceiling, Convex kills the action
     and no terminal status is written → zombie `"generating"` row. This makes
     the Phase 1a watchdog mandatory, not optional.
   - Consider streaming (`client.messages.stream()`) for the Foundry Claude
     path as the cleaner long-term shape for long generations; not required
     once v2's small-output batches land.

**Gate:** re-run the failing generation on the real 4-interview process in prod
(or a prod-data copy in dev) and confirm it succeeds end-to-end.

## Phase 2 — Rate limits, quotas, concurrency

### 2a. Harden the retry layer (`convex/lib/aiProvider.ts`)

- Raise retries for 429/5xx to 4–5 attempts (`DEFAULT_MAX_RETRIES`,
  `aiProvider.ts:19`); honor `Retry-After` up to ~60 s (currently capped at
  10 s, `aiProvider.ts:442`); raise the backoff cap (currently 4 s,
  `aiProvider.ts:445`) and add jitter. Mirror the same policy in the Foundry
  SDK config (`maxRetries` at `aiProvider.ts:325,377`).
- Keep total worst-case time per call well under the 10-minute Convex action
  ceiling: budget retries × timeout accordingly (e.g. 3 × 120 s + waits).

### 2b. Add concurrency control for AI calls

- Install `@convex-dev/workpool` (register in `convex/convex.config.ts`;
  currently only `@convex-dev/migrations` is installed). Route the AI-calling
  actions (`regenerateProcessSummary`, flow generation stages,
  `analyzeVoiceRecordingInternal`, dept/function summaries) through a pool
  with `maxParallelism: 2–3`. This makes "4 interviews finish at once" a queue,
  not a burst, and gives onError hooks + retries for free.
- **Coalesce summary regens:** each finished conversation schedules
  `regenerateProcessSummary` for the same process (`postCall.ts:352-356`,
  `voiceRecordings.ts:841-845`). Two conversations finishing close together
  race: both incremental runs read "latest conversation" and the earlier
  transcript can be skipped or double-integrated. Add a debounce/dedupe (e.g.
  a `summaryRegenScheduledAt` field checked before scheduling, or workpool
  key-based dedupe) and make the regen idempotent (pass the conversationId to
  integrate instead of reading "latest").

### 2c. Foundry throughput + capacity raise (CHOSEN PATH, 2026-07-17)

Decision (initial): stay on Foundry, raise Claude Haiku 4.5 capacity.

**BASELINE PROBE RESULT (2026-07-17) — updates the diagnosis.** Ran
`node scripts/foundry-throughput.mjs 1500 1` against prod
(`ai-account-yr3a3wrezanyy` / `fabric-claude-haiku-4-5`):

```
run 1/1: 1500 out tok, TTFT 3017 ms, gen 18605 ms (80.6 tok/s), overall 69.4 tok/s, stop=max_tokens
Projected worst-case flow response (32768 tok): ~409 s (fits the 450 s flow-gen timeout).
```

A single request is **healthy**: 3 s TTFT, 80.6 tok/s. So the deployment is not
inherently slow and a lone request is not queued. The real cause of the live
failure is therefore **output volume vs. the old 120 s timeout**, not
throughput: at 80 tok/s a large flow response (up to the 32 768-token cap ≈
409 s) cannot complete in 120 s, so the SDK aborted and retried 3× → the 361 s
`status: undefined` failure. The ~4 tok/s figure inferred earlier was a
wall-clock-over-total-tokens artifact of the aborted request, not the model's
speed.

**Consequence: the shipped 450 s timeout fix (Phase 1c) very likely resolves
the current failure with NO capacity change** — 409 s worst case < 450 s. A
capacity raise is reclassified from "immediate fix" to a **scaling lever** for
concurrent load (many interviews/teams finishing at once), to be validated with
a concurrency probe in Phase 4, not spent now.

**Definitive next check:** deploy the Phase 1c code fix and re-run the real flow
generation on the 4-interview process. If it succeeds, the capacity raise is
unnecessary for this bug. Only if it still times out (or a concurrency probe
shows per-request throughput collapsing under load) do Steps 1–4 below.

**Step 1 — measure the baseline (confirms the hypothesis before spending quota):**

```powershell
$account = "ai-account-yr3a3wrezanyy"
$resourceGroup = "rg-fabric-foundry-prod-se"
$env:FOUNDRY_ENDPOINT = "https://$account.services.ai.azure.com"
$env:FOUNDRY_API_KEY = az cognitiveservices account keys list `
  --name $account --resource-group $resourceGroup --query key1 -o tsv
$env:FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude-haiku-4-5"

npm run foundry:throughput          # 4000 tokens x 3 runs
Remove-Item Env:FOUNDRY_API_KEY
```

Read the output: **high TTFT + healthy post-first-token gen rate => capacity
queuing** (a raise will help). **Low gen rate throughout => tier/region limit**
(a raise will NOT help — reconsider OpenRouter or Data Zone/PTU). The probe also
projects whether a worst-case 32 768-token flow response fits the 450 s
flow-gen timeout.

**Step 2 — check available subscription quota:**

```powershell
az cognitiveservices usage list --location swedencentral `
  --subscription dbad1439-85a4-4f10-8b06-e548be4dd778 `
  --query "[?contains(name.value, 'claude-haiku-4-5')]"
```

Dev preflight on 2026-07-14 showed 80 unallocated
(`AIServices.GlobalStandard.claude-haiku-4-5.Azure`,
`docs/foundry-migration-runbook.md:87-89`); prod currently holds 50
(`:177`). Prod + dev share one subscription pool, so confirm headroom before
raising. Request a quota increase in the Azure portal if the pool is short.

**Step 3 — raise the deployment capacity** (a pure capacity bump on the same
model version is a simple update; use blue/green only for version changes):

```powershell
./scripts/deploy-foundry-models.ps1 `
  -ResourceGroup rg-fabric-foundry-prod-se `
  -AccountName ai-account-yr3a3wrezanyy `
  -Industry consulting `
  -ClaudeCapacity 150 `
  -SafetyCapacity 50 `
  -FallbackCapacity 10 `
  -Apply
```

(Start with a target like 150; tune from the Step 1 numbers. The script
preflights catalog + quota before applying.)

**Step 4 — re-measure** with `npm run foundry:throughput` and confirm the
projected flow response now fits the 450 s window, then re-run the real flow
generation on the 4-interview process.

- Optional later: automatic provider fallback in `generateAICompletion`
  (Foundry error after retries → OpenRouter) as a safety net. Keep the manual
  env switch (`npx convex env set --prod AI_PROVIDER openrouter`) as the
  documented instant rollback (`docs/foundry-migration-runbook.md:152-158`).

**Gate:** post-raise throughput probe shows the projected flow response fits the
450 s timeout, AND a real flow generation on the 4-interview process succeeds.
Then the Phase 4 load test with 3 simultaneous completions shows zero terminal
failures.

## Phase 3 — Convex platform limits (data-model scaling)

- Bound the flow-generation reads: `getFlowGenerationData`
  (`processFlows.ts:585-591`) should stop returning full transcripts +
  unbounded `analysis` blobs in one query return. Per the v2 plan: the graph
  pass can run on the rolling summary; detail batches fetch only the
  per-conversation analysis they need, paginated/`.take()`-bounded.
- `conversations.transcript` is an in-document array (`convex/schema.ts:345`).
  Convex limits: 8192 array entries, 1 MB/doc. A 30–60 min interview fits; a
  multi-hour one may not. Add a guard when storing (truncate + warn, or split
  into a `transcriptChunks` child table if/when multi-hour interviews are a
  real requirement — don't build it speculatively).
- `analysis: v.any()` (`schema.ts:352`) is unbounded — same 1 MB guard applies
  when storing ElevenLabs payloads (`postCall.ts:330-350`): strip fields the
  app never reads before saving.
- Denormalize the per-process conversation count (Convex guideline: never
  `.collect().length`) — used by the incremental summary path.

## Phase 4 — Observability & load testing ("how we test for this")

### 4a. Make failures visible

- **Silent-failure fix:** the "Rebuild" summary path is fire-and-forget
  (`summaries.ts:262-280` → scheduled internal action) — a failure is invisible
  to the user. Add a `summaryStatus` (or `lastSummaryError`) field on
  `processes`, set it from `regenerateProcessSummary`, surface it in
  `process-summary-panel.tsx`.
- **Usage metrics:** in `logSuccess`/`logFailure`, also write one row per AI
  call to a small `aiCallLog` table (operation, provider, model, tokens in/out,
  finishReason, status, latency, orgId). Cheap, queryable, and the basis for
  quota planning. Cap growth (cron to purge >30 days).
- **Alerting:** configure a Convex log stream (dashboard → Integrations, e.g.
  Axiom or Sentry) so `logFailure` lines and unhandled action errors page
  someone, instead of living only in the dashboard.

### 4b. Repeatable load-test harness

Create `convex/loadTest.ts` (internal functions, dev-only guard) + a script
`scripts/load-test.ts`:

1. **Seed:** internal mutation that inserts N synthetic `conversations` (status
   `done`) for a test process, with generated transcripts of parameterized
   length (e.g. `--minutes 30` → ~150 turns / ~8k words each) and realistic
   `analysis` blobs (copy the shape from a real row).
2. **Run:** internal action that fires the real pipeline: `forceRefresh`
   summary → flow generation, optionally M processes in parallel to simulate
   concurrent teams.
3. **Assert/report:** query terminal statuses + the `aiCallLog` rows; print
   pass/fail, per-stage latency, token usage, retry counts.

Run the matrix in dev (`npx convex dev` deployment) before each scale-up:

| Scenario | Conversations | Minutes each | Concurrent processes |
|---|---|---|---|
| Current failure repro | 4 | 27 | 1 |
| Near-term target | 10 | 60 | 1 |
| Team rollout | 10 | 60 | 3 |
| Stress | 25 | 90 | 5 |

### 4c. Scale targets (acceptance criteria)

- ✅ 10 conversations × 60 min in one process: summary rebuild, flow
  generation, and dept/function cascade all reach terminal success — no
  truncation, no silent partial saves.
- ✅ 3 processes completing simultaneously: no terminal failures from 429s;
  queue drains within 10 min.
- ✅ No pipeline stage can end in a non-terminal state (`generating`/
  `processing` forever) — watchdog reaps within 15 min.
- ✅ Every failure is visible in the UI with a retry affordance, and in the
  log stream with operation + finishReason/status.

---

## Execution order & sizing (for Opus)

| Step | Work | Size | Depends on |
|---|---|---|---|
| 1 | ~~Phase 0 diagnosis~~ DONE — see "Phase 0 findings" above | — | — |
| 2 | Phase 1c code fix DONE (per-request `timeoutMs`/`maxRetries` plumbed; flow-gen set to 450 s × 1 attempt). Env flip = pending user decision | S | user sign-off on env flip |
| 3 | Phase 2c baseline probe DONE — single-request Foundry is healthy (80 tok/s, 3 s TTFT). Root cause reclassified: **output volume vs. old 120 s timeout, not throughput**. Capacity raise DEFERRED to scaling (Phase 4 concurrency probe), not needed for this bug. NEXT: deploy Phase 1c fix + re-run real flow gen | S | deploy access |
| 4 | Phase 1b upstream fixes (truncation checks, map-reduce rebuild, bounded reads) | M | — |
| 5 | Phase 1a: staged flow generation — now governed by `docs/process-flow-generation-v3-plan.md` (v2 backbone + time-budgeted calls) | L | — |
| 6 | Phase 2a retry hardening (incl. per-request maxRetries from 1c) | S | — |
| 7 | Phase 2b workpool + regen coalescing | M | — |
| 8 | Phase 4a observability (status fields, aiCallLog, log stream) | M | — |
| 9 | Phase 4b load harness + run matrix | M | 4–8 |
| 10 | Phase 3 data-model guards | S–M | findings |

Notes for the executor:

- Read `convex/_generated/ai/guidelines.md` before touching Convex code (repo
  rule; it overrides trained Convex knowledge).
- Read `docs/process-flow-generation-v2-plan.md` in full before step 3 — it is
  the design of record, including its testing plan and the `replace`→`patch`
  hazard.
- `docs/foundry-migration-runbook.md` holds deployment names, env-var setup,
  and capacity numbers.
- Verify with `npx convex dev` typecheck + `convex-test` suite + the load
  harness; do not mark a step done on typecheck alone.
