# AI usage & cost metering — plan

**Surface:** the platform tenant console (`tenants.bizfabric.ai`), not tenant
`/admin`. Per-tenant and per-action breakdowns, spanning **both the production
and dev Convex deployments**.

**Decisions taken (2026-08-04):**

| Decision | Choice |
| --- | --- |
| Scope | LLM tokens **and** ElevenLabs voice minutes, one ledger with a `unit` discriminator |
| Attribution | operation + model + linked entity + triggering actor |
| Cost basis | internal provider cost only (no markup / billable column) |
| Audience | platform super-admins in the tenants console; cross-tenant is the primary view |
| Deployments | prod + dev, merged into the prod console with a filter |

---

## 1. Why this cannot be "procured from Foundry"

The instinct is to read usage back from the provider. That does not work for
per-tenant attribution, for a structural reason:

- **Every tenant shares one Foundry deployment.** `fabric-claude-haiku-4-5`,
  `fabric-gpt5-mini-fallback`, and `fabric-description-safety` are account-level
  deployments (`convex/convex.config.ts:16-18`). Azure Monitor metrics and Cost
  Management report per-deployment and per-subscription. There is no dimension
  in that telemetry that says "Acme Corp" — because we never send one.
- **Microsoft's own answer is a gateway, not an API.** Their recommended pattern
  for per-caller token attribution is Azure API Management stamping caller
  metadata into headers, Foundry emitting run telemetry, and Application
  Insights as the queryable store, sliced with KQL. That is an extra network
  hop in front of every AI call, a second datastore to operate, and it *still*
  only works because you stamp the tenant id yourself — which we can do at the
  source for free.
- **OpenRouter does better but is going away.** It now returns `usage.cost` plus
  `prompt_tokens_details.cached_tokens` / `cache_write_tokens` on every
  response, and `/api/v1/generation` gives native-tokenizer counts after the
  fact. But OpenRouter is only the documented rollback path
  (`docs/foundry-migration-runbook.md:152-158`); building the ledger on its
  richer telemetry would leave us blind on the provider we actually run.

**Conclusion:** meter in-process at the chokepoint we already own, and treat
provider/invoice numbers as a *reconciliation* input rather than the source of
truth. `generateAICompletion` (`convex/lib/aiProvider.ts:720`) is the single
entry point for every AI call in the codebase — verified: the only call sites
are `descriptionSafety.ts:202`, `postCall.ts:1139/1452/1519`,
`processFlows.ts:1516/1710/1883`, `summaries.ts:121/251`,
`summariesHelpers.ts:228`, `voiceRecordings.ts:393`.

## 2. What we already have (and what's missing)

Most of the ledger is already computed and then thrown away into `console.info`
(`aiProvider.ts:370-410`).

| Field | Already available | Gap |
| --- | --- | --- |
| `operation` | ✅ on every `AIRequest` — this *is* the "per action" axis, free | — |
| input/output tokens | ✅ `AIUsage` from all three backends | — |
| cached / cache-write tokens | ❌ | `AIUsage` drops them. Foundry Claude returns `cache_creation_input_tokens` / `cache_read_input_tokens`; OpenAI returns `prompt_tokens_details.cached_tokens`; OpenRouter returns both. At 0.1× read / 1.25× write these materially change cost. |
| provider / model / deployment | ✅ on `AICompletion` | — |
| latency | ✅ computed in `logSuccess` | not persisted |
| finishReason, requestId | ✅ | not persisted |
| tenant | ❌ | `generateAICompletion` has no notion of org. Must be threaded in. |
| entity + actor | ❌ | Must be threaded from call sites. |
| voice minutes | ⚠️ partial | `conversations.durationSeconds` exists; the Scribe call is `voiceRecordings.ts:790`, the agent-conversation fetch is in `http.ts`/`postCall.ts`. Neither is metered. |

### Undercounts to state on the page, not hide

1. **SDK-internal retries.** Both provider SDKs retry up to `maxRetries`
   (default 2) inside one `generateAICompletion` call. Only the attempt that
   succeeded reports usage; failed attempts burned input tokens invisibly. Our
   ledger will read slightly *below* the invoice, and long-prompt operations
   (flow graph, process-summary reduce) will skew most.
2. **Failed calls report no usage.** A row is still written with
   `status: "failed"` and zero tokens — valuable as a log, useless as spend.
3. **Truncated calls are billed.** `AITruncationError` is thrown by call sites
   *after* the provider returned. Metering must happen inside the wrapper, so
   these are captured.

## 3. Schema

New table in `convex/schema.ts`. Append-only; nothing mutates a row after
insert except `forwardedAt`.

```ts
aiUsageEvents: defineTable({
  // --- provenance ---------------------------------------------------------
  // Which Convex deployment produced this row. Set from USAGE_DEPLOYMENT_LABEL.
  deployment: v.union(v.literal("prod"), v.literal("dev")),
  // Stable dedupe key so cross-deployment forwarding can retry safely.
  idempotencyKey: v.string(),
  createdAt: v.number(),

  // --- tenant -------------------------------------------------------------
  // clerkOrgId is the join key, NOT an Id<"tenants">: a forwarded dev row
  // references a dev-only document id that resolves to nothing in prod.
  clerkOrgId: v.string(),
  // Denormalized for the same reason — the console must label a dev tenant it
  // has no local row for.
  tenantName: v.optional(v.string()),

  // --- what was metered ---------------------------------------------------
  // The *billing basis*, not an exclusive tag: an ElevenLabs agent row is
  // billed per second but also carries the agent LLM's token counts, so both
  // `seconds` and the token fields are populated on it.
  unit: v.union(v.literal("tokens"), v.literal("seconds")),
  operation: v.string(),          // "process-flow-node-details", "voice-scribe", ...
  provider: v.string(),           // "foundry-claude" | "foundry-openai" | "openrouter" | "elevenlabs"
  model: v.string(),
  providerDeployment: v.optional(v.string()),
  status: v.union(v.literal("ok"), v.literal("truncated"), v.literal("failed")),

  // token rows
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  cachedReadTokens: v.optional(v.number()),
  cacheWriteTokens: v.optional(v.number()),
  // seconds rows
  seconds: v.optional(v.number()),

  // --- cost ---------------------------------------------------------------
  // Integer micro-USD. Floats accumulate drift over thousands of rows and the
  // per-token rates are 1e-6-scale to begin with.
  //
  // ALWAYS notional list-rate cost, never the marginal amount the provider
  // charged. See §4.2: ElevenLabs plan-included minutes are a workspace-wide
  // pool shared by every tenant, so the marginal cost of an identical call is
  // $0 or $0.08 depending purely on which tenant happened to call first. Only a
  // list-rate figure is comparable across tenants.
  costMicroUsd: v.number(),
  priceVersion: v.string(),       // e.g. "2026-08-04"; rows keep the rate they were priced at
  costSource: v.union(v.literal("computed"), v.literal("provider")),
  // What the provider says it actually charged, for invoice reconciliation.
  // OpenRouter: usage.cost. ElevenLabs agents: metadata.cost_fiat — which is
  // legitimately 0 for calls absorbed by the plan allowance.
  providerReportedCostMicroUsd: v.optional(v.number()),
  // ElevenLabs agent calls arrive pre-itemised (metadata.charging); keeping the
  // split lets the console separate voice cost from pass-through LLM cost.
  llmCostMicroUsd: v.optional(v.number()),
  callCostMicroUsd: v.optional(v.number()),
  platformCostMicroUsd: v.optional(v.number()),
  // Distinguishes our own synthesis tokens from the agent's LLM tokens, which
  // are a different provider's model on a different bill (§4.2).
  tokenClass: v.optional(
    v.union(v.literal("fabric-synthesis"), v.literal("agent-llm")),
  ),

  // --- attribution --------------------------------------------------------
  // Opaque strings, not Ids, for the cross-deployment reason above. Paired
  // with a denormalized label so the log is readable without a join.
  entityType: v.optional(v.string()),   // "process" | "conversation" | "department" | "function"
  entityId: v.optional(v.string()),
  entityLabel: v.optional(v.string()),
  actorUserId: v.optional(v.string()),
  actorName: v.optional(v.string()),
  // Groups every call in one pipeline run (reuse processFlows.generationId
  // where it exists) so "what did this flow cost end to end" is one query.
  runId: v.optional(v.string()),

  // --- diagnostics --------------------------------------------------------
  latencyMs: v.optional(v.number()),
  finishReason: v.optional(v.string()),
  requestId: v.optional(v.string()),
  errorType: v.optional(v.string()),

  // --- forwarding ---------------------------------------------------------
  // Set at insert on the sink deployment; left unset on dev until forwarded.
  forwardedAt: v.optional(v.number()),
  forwardAttempts: v.optional(v.number()),
})
  .index("by_idempotencyKey", ["idempotencyKey"])
  .index("by_createdAt", ["createdAt"])
  .index("by_deployment_and_createdAt", ["deployment", "createdAt"])
  .index("by_clerkOrgId_and_createdAt", ["clerkOrgId", "createdAt"])
  .index("by_operation_and_createdAt", ["operation", "createdAt"])
  .index("by_runId", ["runId"])
  .index("by_forwardedAt", ["forwardedAt"]),
```

Plus a rollup table so the console does not scan the ledger for history:

```ts
aiUsageRollups: defineTable({
  period: v.string(),            // "2026-08-04" (UTC day)
  deployment: v.union(v.literal("prod"), v.literal("dev")),
  clerkOrgId: v.string(),
  operation: v.string(),
  model: v.string(),
  callCount: v.number(),
  failedCount: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  cachedReadTokens: v.number(),
  cacheWriteTokens: v.number(),
  seconds: v.number(),
  costMicroUsd: v.number(),
  updatedAt: v.number(),
})
  .index("by_period", ["period"])
  .index("by_clerkOrgId_and_period", ["clerkOrgId", "period"])
  .index("by_period_and_deployment_and_clerkOrgId_and_operation_and_model", [
    "period", "deployment", "clerkOrgId", "operation", "model",
  ]),
```

**Why a cron-built rollup rather than incrementing counters inline:** the flow
pipeline fires many calls in quick succession, and a per-write counter update
would serialize on the same document and trip OCC. A daily fold job has zero
contention, is re-runnable from the ledger if it is ever wrong, and makes the
ledger the single source of truth.

## 4. Price table

`convex/lib/aiPricing.ts` — a versioned, pure module, unit-tested. Same pattern
as `MEASURED_THROUGHPUT`: constants with a date and a comment saying how to
re-derive them.

```ts
export const PRICE_VERSION = "2026-08-04";

// Micro-USD per token (i.e. USD-per-MTok, since 1 MTok × 1e-6 USD = 1 micro-USD).
export const RATES = {
  "foundry-claude:foundry:claude-haiku-4-5@2": {
    input: 1.00, output: 5.00, cachedRead: 0.10, cacheWrite: 1.25,
  },
  "foundry-openai:foundry:gpt-5-nano@2025-08-07": {
    input: 0.05, output: 0.40, cachedRead: 0.005, cacheWrite: 0,
  },
  // ...
} as const;

// Micro-USD per second. Voice is billed per minute upstream; per-second here so
// the ledger never has to round a duration.
export const VOICE_RATES = {
  // ElevenAgents call minutes, $0.08/min list. Burst (over the workspace
  // concurrency limit) is $0.16/min — we cannot tell from the payload whether a
  // call bursted, so this under-prices bursted calls. Reconciliation catches it.
  "elevenlabs:agent-call": 0.08 / 60,
  // Scribe v2, $0.22/hour.
  "elevenlabs:scribe_v2": 0.22 / 3600,
} as const;
```

Confirmed rates:

- **Claude Haiku 4.5 on Foundry: $1.00 / $5.00 per MTok.** Anthropic's
  first-party rates apply to Claude on Microsoft Foundry — it is billed through
  the Microsoft Marketplace at standard API rates, *not* at partner rates like
  Bedrock/Vertex. Cache reads ~0.1×, cache writes 1.25× (5-min TTL).
- **gpt-5-nano: $0.05 / $0.40 per MTok** (Azure Global Standard).

- **OpenRouter**: no table needed — it reports `usage.cost` directly. Store it
  in both `costMicroUsd` and `providerReportedCostMicroUsd`, `costSource: "provider"`.

Still open: **gpt-5-mini** on Azure Global Standard. Only the fallback path uses
it (`FOUNDRY_SYNTHESIS_BACKEND=gpt5mini`), so it ships as `null` → rows priced
`costMicroUsd: 0` with `priceVersion: "unpriced"` and a warning banner, rather
than a wrong number.

Deployment-name → rate-key resolution must be explicit, and an unknown key must
log loudly and price at zero rather than silently pick a default. A silently
mis-priced ledger is worse than a visibly incomplete one.

### 4.1 ElevenLabs agent conversations — the API already itemises the bill

**We are currently throwing away a complete billing breakdown on every
interview.** `postCall.ts:417` fetches
`GET /v1/convai/conversations/{id}` and reads exactly one field from the
metadata — `call_duration_secs` (`postCall.ts:476`, and again at `:774`, `:832`).
That same `metadata` object carries:

| Field | Meaning |
| --- | --- |
| `cost` | total cost in ElevenLabs credits |
| `cost_fiat` | **total cost in USD** |
| `charging.call_charge` | the voice-minutes portion |
| `charging.llm_charge`, `charging.llm_price` | the agent's LLM portion (passed through at cost) |
| `charging.llm_usage` | the agent LLM's **token counts** |
| `charging.platform_charge`, `charging.platform_usage` | platform portion |
| `charging.tts_usage`, `charging.asr_usage` | TTS / ASR components |
| `charging.free_minutes_consumed`, `charging.free_llm_dollars_consumed` | how much of the plan allowance this call absorbed |
| `call_duration_secs` | billed connection duration |

So for agent interviews there is **no estimation to do** — capture
`metadata.charging` at ingest. This is strictly better than a per-minute
estimate, because ElevenLabs' billed duration is *not* the conversation length:

- Duration is measured on **connection** time — from call start until the call
  ends *or the window is closed*. A contributor who leaves the tab open is
  billed for that.
- Voice-only and multimodal calls get a **95% discount on any silence period
  longer than 10 seconds**.

Multiplying `durationSeconds × $0.08` would therefore be wrong in both
directions at once. Read the provider's number.

### 4.1a What a real payload showed (2026-08-04, `conv_1601kz632c9hfyevs9h3vzw9gz6s`)

Probed with `npm run elevenlabs:charging`. Three findings changed the design;
all are now encoded in `convex/lib/elevenLabsCharging.ts` and pinned by a
verbatim fixture in its test.

**The credit fields do not reconcile; the USD fields do, exactly.**

```
llm_price 0.0220345 + platform_price 0.003 = 0.0250345 = cost_fiat   ✓ exact
llm_charge 111      + platform_charge 15   = 126       = cost        ✓ (call_charge 15 EXCLUDED)
```

Credits are ~$0.0002 each, rounded up, and `call_charge` appears in *neither*
total on a text-only call. **Rule: read `*_price`, never sum `*_charge`.**

**`llm_usage` will double-count if summed naively.** It holds two sibling
blocks — `irreversible_generation` and `initiated_generation` — with identical
contents, and `llm_price` equals **one** of them. The parser takes
`irreversible_generation` (the committed work), falls back to `initiated_`, and
warns if they disagree rather than guessing the semantics from one sample.

**ElevenLabs passes through Anthropic list rates exactly**, on
`claude-haiku-4-5` — the same model as our synthesis: input $1.00/MTok, cache
write $1.25/MTok (1.25×), output $5.00/MTok, all three derivable from their
per-bucket prices. So their numbers are used directly rather than re-derived.

Also learned: **`tier: "pro"`** (1,238 included minutes/month), and
`environment` distinguishes their production from ours.

Cost on this call was **88% LLM** ($0.022 of $0.025) — 12,877 input tokens for a
five-second exchange, because the agent's prompt and knowledge base are re-sent
each turn. **Agent conversations are LLM-heavy, not minute-heavy**, which
inverts the assumption this plan was written on.

> ⚠️ Caveat: this sample had `text_only: true`, so `tts_usage` and `asr_usage`
> were zeroed and no voice minutes were billed. The voice-populated shape — and
> whether `cost`/`cost_fiat` then include `call_charge` — is still unverified.
> The parser derives the voice portion as a residual and warns if the itemised
> parts exceed the total, so a wrong model announces itself.

### 4.2 …but attribute at list rate, not at what we were charged

`cost_fiat` is the *marginal* cost. Plan-included minutes (Business = 12,375/mo)
are a **workspace-wide pool shared by every tenant**, so two identical calls cost
$0 and $0.08 depending purely on which tenant happened to run first in the
billing period. Attributing that to tenants produces a number that reorders
itself month to month and cannot be compared across tenants.

The payload makes this **exact rather than estimated**, which is better than the
list-rate reconstruction originally planned here: `free_minutes_consumed` and
`free_llm_dollars_consumed` state precisely how much allowance a call absorbed,
and `is_burst` states whether minutes billed at $0.08 or $0.16.

- `costMicroUsd` = **notional** = `cost_fiat + free_minutes_consumed ×
  minuteRate + free_llm_dollars_consumed`, where `minuteRate` follows
  `is_burst`. Every input comes from the provider, so `costSource: "provider"` —
  our rate table is not involved.
- `providerReportedCostMicroUsd` = `cost_fiat`, stored untouched. Inside the
  allowance it is legitimately lower than notional; the gap *is* the plan
  discount, and §8 Phase 5 reconciles it against the invoice.
- The itemised split is kept too — `llmCostMicroUsd`, `callCostMicroUsd`
  (residual), `platformCostMicroUsd` — so the console can separate voice spend
  from pass-through LLM spend.
- The console shows notional cost by default with a footnote, and the
  reconciliation view shows both.

**Burst is not invisible after all.** An earlier draft of this plan claimed
nothing in the payload reveals a bursted call and that notional cost would
therefore under-price them. `charging.is_burst` exists, so bursted minutes are
priced correctly. The concurrency-ceiling alarm that idea justified is still
worth having, but it should watch `is_burst` directly rather than infer it from a
cost gap.

The same reasoning does not apply to Foundry, which is pay-per-token with no
allowance pool — there, computed and actual coincide.

### 4.3 Token totals must not blend two different models

`charging.llm_usage` is the **agent's** LLM (ElevenLabs-hosted, billed by them,
passed through at cost) — a completely different model from our Foundry Haiku
synthesis calls. Summing them into one "input tokens" figure produces a number
that means nothing. Hence `tokenClass` on the ledger:
`"fabric-synthesis"` vs `"agent-llm"`, split in every token column in the UI.

### 4.4 Scribe (speech-to-text) does need a rate

The `POST /v1/speech-to-text` response (`voiceRecordings.ts:333`) returns no cost
field, so this one is computed from duration:

- **Scribe v2: $0.22 per hour** ≈ $0.003667/min. Our call
  (`voiceRecordings.ts:326-331`) uses `scribe_v2` with `diarize`,
  `tag_audio_events`, `timestamps_granularity: word`, `no_verbatim` — none of
  which are the metered add-ons, so the base rate applies.
- Priced add-ons we do **not** use, listed so a future change is costed:
  entity detection +$0.070/hr, keyterm prompting +$0.050/hr. Scribe v2 Realtime
  is $0.39/hr.
- Duration source is `args.durationSeconds` (already captured at
  `voiceRecordings.ts:469`).

## 5. The metering hook

`generateAICompletion` stays a pure function with no `ctx` — that keeps
`aiProvider.test.ts` working unchanged and keeps the provider adapter free of
database concerns. Extend only `AIUsage`:

```ts
export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
};
```

…and add `costUsd?: number` to `AICompletion` for the OpenRouter case.

New file `convex/lib/aiUsageMeter.ts`:

```ts
export type UsageAttribution = {
  clerkOrgId: string;
  tenantName?: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  actorUserId?: string;
  actorName?: string;
  runId?: string;
};

/** Drop-in replacement for generateAICompletion that records a ledger row. */
export async function meteredCompletion(
  ctx: ActionCtx,
  attribution: UsageAttribution,
  request: AIRequest,
): Promise<AICompletion>;

/** Scribe transcription — cost computed from duration. */
export async function recordTranscriptionUsage(
  ctx: ActionCtx,
  attribution: UsageAttribution,
  args: { model: string; seconds: number; status: UsageStatus },
): Promise<void>;

/**
 * ElevenLabs agent conversation. Takes the raw `metadata` from
 * GET /v1/convai/conversations/{id} and derives both the notional cost (§4.2)
 * and the provider-reported one, plus the agent-LLM token counts (§4.3).
 * Every field is treated as absent-by-default — this is an upstream schema we
 * do not control, exactly as `conversations.analysis` is (`schema.ts:464`).
 */
export async function recordAgentConversationUsage(
  ctx: ActionCtx,
  attribution: UsageAttribution,
  metadata: unknown,
): Promise<void>;
```

`recordAgentConversationUsage` is called from the three places that already
fetch the conversation — `postCall.ts:417`, `:754`, `:832` — and needs no new
network call, only the metadata object those handlers already have in hand.

Non-negotiable properties:

1. **Metering never breaks an AI call.** The `ctx.runMutation` is wrapped in
   `try/catch`; a failure logs `console.error` and is swallowed. A billing
   ledger must never be able to take down process-flow generation.
2. **Both outcomes are recorded.** Success writes tokens and cost; a thrown
   `AIRequestError` writes a `failed` row with `errorType`/`status` and
   re-throws unchanged.
3. **Recorded inside the wrapper**, before call sites run
   `assertCompletionNotTruncated`, so a truncated-but-billed call lands as
   `status: "truncated"` with its real token counts.
4. **`idempotencyKey`** = `${deployment}:${requestId ?? crypto.randomUUID()}:${startedAt}`.

Then migrate the 10 AI call sites. Every one is already inside an action with org
context in scope (`resolveOrgForAction` / an explicit `orgId` arg), so the
threading is mechanical. Voice metering adds four more: the Scribe call
(`voiceRecordings.ts:790`) and the three conversation fetches
(`postCall.ts:417`, `:754`, `:832`).

One asymmetry to keep in mind: an agent-conversation row is written at *ingest*
time, not at call time, and a re-fetch (`postCall.ts:832` retry path) will
present the same `metadata` again. `idempotencyKey` for these rows must be
derived from `elevenlabsConversationId`, not from a timestamp, so a retried
fetch updates rather than duplicates.

## 6. Prod + dev in one view

Convex dev and prod are separate deployments with separate databases, so "show
both" needs an explicit bridge. Design:

- Every deployment sets `USAGE_DEPLOYMENT_LABEL` (`prod` | `dev`) and writes its
  own rows locally — each deployment stays self-sufficient and debuggable.
- **Prod is the sink.** New HTTP route in `convex/http.ts`:
  `POST /ai-usage/ingest`, authenticated with a bearer `USAGE_SINK_SECRET`
  (mirroring the existing `AUDIO_SIGNING_SECRET` / Clerk-webhook secret
  patterns), accepting a batch of rows. Inserts are idempotent on
  `by_idempotencyKey`, so retries cannot double-count.
- **Dev forwards asynchronously**, not inline: rows are written with
  `forwardedAt` unset, and a cron sweep (`{ minutes: 5 }`, alongside the
  existing flow reaper in `convex/crons.ts`) batches unforwarded rows to the
  sink and stamps `forwardedAt`. Inline forwarding would put a network call to
  another deployment on the pipeline's critical path — exactly the failure mode
  `docs/pipeline-reliability-and-scale-plan.md` was written about.
- Prod stamps `forwardedAt = createdAt` at insert so the sweep never picks up
  its own rows, and the ingest handler **rejects any row whose `deployment`
  equals the local label** to make a self-ingest loop impossible.
- `forwardAttempts` caps retries; rows that exhaust it are logged and left for
  manual inspection rather than retried forever.

**Caveat to design around:** if the dev deployment points at a Clerk *dev*
instance, its `clerkOrgId` values will not match prod's. That is why tenant
grouping in the console is keyed on `(deployment, clerkOrgId)` and labels come
from the denormalized `tenantName` on the row, falling back to the local
`tenants` table only for prod rows.

## 7. Console UI

Add a `Usage` nav item to `src/app/tenants-console/layout.tsx` (`navItems`,
line 64). All queries go through `requireSuperAdmin`
(`convex/lib/orgAuth.ts:150`) — same as `platform.ts` does today.

**`/usage` — platform overview**

- Controls: date range (7d / 30d / this month / custom) and a deployment filter
  (Prod / Dev / Both, defaulting to Prod).
- Stat row: total cost, total tokens (in / out), total voice minutes, call
  count, failure rate — reusing `StatCard`
  (`src/features/admin/stat-card.tsx`).
- Daily spend chart, stacked by provider. **Load the `dataviz` skill before
  writing any chart code.**
- Tenants table sorted by spend: tenant, deployment badge, calls, input tokens,
  output tokens, voice minutes, cost, share of total. Row links to the tenant
  detail.
- Breakdown tables: by operation, and by model.

**Per-tenant** — a `Usage` tab on the existing
`src/app/tenants-console/[tenantId]/page.tsx`, or `/usage/[clerkOrgId]` if that
page is already dense:

- Same stat row and chart, scoped to the tenant.
- Per-operation table (the "per action" view: calls, avg tokens/call, avg
  latency, total cost).
- Paginated call log — time, deployment, operation, model, in/out tokens, cost,
  latency, status, entity, actor — via `usePaginatedQuery` over
  `by_clerkOrgId_and_createdAt`, matching the conversations admin table
  (`src/app/[org]/admin/conversations/page.tsx`).
- Cost-per-run grouping on `runId` so a flow generation reads as one line item.
- CSV export following `src/features/admin/conversations-export.ts`.

Reads: closed days come from `aiUsageRollups`; the current day comes from a
bounded ledger scan. The log itself always paginates the ledger.

## 8. Phasing

| Phase | Work | Done when |
| --- | --- | --- |
| 0 ✅ built, ⏳ unverified | `aiPricing.ts` + schema + ledger mutation + `meteredCompletion`, wired to **one** call site (`description-safety` — cheapest, highest volume) | A real Foundry call produces a row whose cost matches a hand calculation |
| 0b ✅ | Probe a real `metadata.charging` payload and pin it into a typed parser. `npm run elevenlabs:charging` | Done — see §4.1a. Fixture-pinned in `elevenLabsCharging.test.ts` |
| 1a ✅ | Remaining 10 synthesis call sites + `AIUsage` cache tokens | `generateAICompletion` has exactly one caller: the meter |
| 1b ✅ | Scribe transcription metering (`voiceRecordings.ts`), success and failure paths | A voice upload produces a `voice-transcription` row |
| 1c ✅ built, ⏳ unverified | 3 agent-conversation sites (`postCall.ts`) via `recordAgentConversationUsage` | A live interview produces an `agent-conversation` row whose `providerReportedCostMicroUsd` matches `cost_fiat` |
| 2 ✅ built, ⏳ unverified | `POST /ai-usage/ingest`, `USAGE_SINK_*` env vars, forwarding action + 5-min cron | A dev-deployment call appears in prod tagged `dev`, and re-running the sweep does not duplicate it |
| 3 ✅ built, ⏳ unverified | `aiUsageRollups` + daily fold cron + retention cron for raw rows (180 days) | Rollups reproduce a ledger scan exactly for a closed day |
| 4 ✅ built, ⏳ unverified | Console UI (overview, per-tenant, log, CSV) | Super-admin can answer "what did Acme cost last month, and on which actions" |
| 5 | Reconciliation: compare a month of ledger cost against the Azure invoice and OpenRouter analytics; document the gap | Variance explained and written into this doc |

Phases 0–1 are independently valuable — they replace `console.info` telemetry
with queryable data even before any UI exists.

### Phase 0 as built (branch `feat/ai-usage-metering`)

| File | Change |
| --- | --- |
| `convex/lib/aiPricing.ts` | new — versioned rate table, micro-USD math, `inputIncludesCached` reconciliation |
| `convex/lib/aiUsageMeter.ts` | new — `meteredCompletion` + the pure `buildCompletionUsageEvent` |
| `convex/aiUsage.ts` | new — `record` internal mutation (upsert on `idempotencyKey`), `listRecent` super-admin query |
| `convex/schema.ts` | `aiUsageEvents` table + 7 indexes |
| `convex/lib/aiProvider.ts` | `AIUsage` gains cache tokens; `AICompletion` gains `costUsd`; all three adapters populate them |
| `convex/convex.config.ts` | `USAGE_DEPLOYMENT_LABEL` |
| `convex/descriptionSafety.ts` | `classifyDescriptionSafety(ctx, attribution, description)` |
| `convex/departments.ts`, `convex/processes.ts` | thread `ctx` + attribution through `buildDescriptionUpdate`; capture `userId` from the existing `requireOrgContributorInternal` call, which already returned it |
| `convex/lib/aiPricing.test.ts`, `convex/lib/aiUsageMeter.test.ts` | new — 25 tests |

Two decisions worth recording, because both are load-bearing and neither is
obvious from the diff:

1. **The provider adapters keep raw provider numbers.** `AIUsage.inputTokens` is
   whatever the provider said, *not* normalised — because this feeds a billing
   ledger and raw fidelity is what makes an invoice dispute winnable.
   Anthropic's three buckets are disjoint; OpenAI folds cached tokens into
   `prompt_tokens`. `TokenRate.inputIncludesCached` owns that difference in one
   place, and `aiPricing.test.ts` has an explicit regression test for the
   double-charge it prevents.
2. **The meter is split pure/impure.** `buildCompletionUsageEvent` is a pure
   function holding every decision (status, cost source, token class,
   timestamp); `meteredCompletion` only calls the provider and the mutation. All
   25 tests run with no Convex harness and no mocks.

Not yet done in Phase 0: the live verification below. Everything above is
green — 276 tests pass, no new type errors, lint clean — but no real Foundry
call has produced a row yet.

### Phases 2–3 as built

| File | Change |
| --- | --- |
| `convex/lib/aiUsageRollup.ts` | new — pure UTC-day fold, `rollupKey`, absolute (idempotent) totals |
| `convex/aiUsage.ts` | forwarding (`listUnforwarded`, `markForwarded`, `recordForwardFailure`, `forwardPendingUsage`), sink (`ingestBatch`), rollups (`pageUsageForDay`, `writeRollups`, `foldUsageDay`), retention (`pruneOldUsageEvents`) |
| `convex/http.ts` | `POST /ai-usage/ingest` — constant-time bearer check, 404 when not configured as a sink, batch cap 500 |
| `convex/schema.ts` | `aiUsageRollups` table + 4 indexes |
| `convex/convex.config.ts` | `USAGE_SINK_URL`, `USAGE_SINK_SECRET` |
| `convex/crons.ts` | forward every 5 min; fold daily 00:30 UTC; prune daily 03:00 UTC |
| `convex/lib/aiUsageRollup.test.ts` | new — 14 tests |

Four decisions worth recording:

1. **Forward failures retry forever.** No abandonment path. A persistently
   failing sink means unforwarded rows accumulate — which is the correct signal
   ("go fix the sink") rather than silently discarding billing data. The batch
   is bounded at 100, so a broken sink costs one small request per sweep. Rows
   past 5 attempts log an error every sweep so it surfaces in monitoring.
2. **Rollups replace, never increment.** `foldUsageRows` returns absolute
   totals, so re-running the fold repairs a bad rollup instead of doubling it,
   and the ledger stays the single source of truth.
3. **Retention refuses to delete an un-rolled-up day.** Otherwise a fold that
   quietly stopped running would convert into permanent data loss; instead the
   table grows and the skip is logged.
4. **`provider` is excluded from the rollup key.** It is a function of the
   model, so including it would let a provider rename split one logical group
   into two rows that the console would then double-count.

Not yet verified live: a dev row actually landing in prod, and a fold over a
real day.

### Phase 4 as built ✅

| File | Purpose |
| --- | --- |
| `convex/aiUsage.ts` | `usageOverview`, `usageForTenant`, `usageLog` (all `requireSuperAdmin`) |
| `src/app/tenants-console/usage/page.tsx` | platform overview |
| `src/app/tenants-console/usage/[clerkOrgId]/page.tsx` | per-tenant detail + call log + CSV |
| `src/features/tenants-console/usage-format.ts` | micro-USD → display; the ONLY `/1e6` in the codebase |
| `src/features/tenants-console/usage-cost-chart.tsx` | daily cost line+area, crosshair tooltip |
| `src/features/tenants-console/usage-breakdown-table.tsx` | ranked magnitude tables with in-row bars |
| `src/features/tenants-console/usage-shared.tsx` | filters, stat tiles, caveat banner |
| `src/features/tenants-console/usage-export.ts` | CSV (both micro-USD and USD columns) |
| `usage-format.test.ts`, `aiUsageRollup.test.ts` | 18 new tests (324 total) |

**Palette validated, not eyeballed.** `scripts/validate_palette.js` passes all
checks in both modes for the single categorical slot: `#2a78d6` on the light card
(`#ffffff`) and `#3987e5` on the dark card (`oklch(0.205 0 0)` ≈ `#333332`). The
app's own `--chart-*` tokens are greyscale (chroma 0) — fine for the org-themed
workspace, but they fail the chroma floor and would render the platform console's
chart as chrome rather than data, so the console uses its own validated slot.

Deliberately **one series and one y-axis**: cost over time is the only measure on
the chart, and tokens (a different scale) live in tiles and tables. A single
series needs no legend, which also sidesteps a 4-way categorical palette that
would have needed adjacent-pair CVD clearance.

Ranked breakdowns are **tables with in-row magnitude bars** rather than bar
charts — long labels read better as rows, and the table doubles as the
colour-free view. The bar is one hue at one step; rank is not identity, so it is
never coloured per row.

**One schema change this phase forced:** `aiUsageRollups.tokenClass`. Without it
the console would have had to infer synthesis-vs-agent tokens from `operation`,
and display rule 1 (never sum them) would rest on a naming convention. It is now
stored and carried through `foldUsageRows`, with tests for the carry-through and
for the undefined case.

Removed as scaffolding: the Phase 0 `listRecent` query, now fully superseded by
`usageLog`.

Not yet verified live: the pages have not been opened against real rollup data —
`next build` compiles both routes and the queries typecheck, but no fold has run
in a real deployment yet.

### Phase 4 spec (as planned)

Written before implementing so the shape survived a context compaction. Retained
for the rationale; the table above is what shipped.

**Convex reads** (all `requireSuperAdmin`, in `convex/aiUsage.ts`):

| Query | Returns |
| --- | --- |
| `usageOverview({ from, to, deployment? })` | totals, per-day series, per-tenant, per-operation, per-model |
| `usageForTenant({ clerkOrgId, from, to, deployment? })` | same, scoped, plus per-operation detail |
| `usageLog({ clerkOrgId?, deployment?, paginationOpts })` | paginated ledger rows for the log table |

`from`/`to` are `YYYY-MM-DD` UTC. Closed days come from `aiUsageRollups`
(O(rollup rows)); if the range includes **today**, also scan today's ledger with
a bounded `.take()` and fold it through the *same* `foldUsageRows` so live and
historical numbers cannot diverge. If the cap trips, return `partial: true` and
have the UI say so rather than showing a quietly truncated total.

**Routes**: `src/app/tenants-console/usage/page.tsx` (overview) and
`usage/[clerkOrgId]/page.tsx` (tenant detail). Add a `Usage` entry to
`navItems` in `src/app/tenants-console/layout.tsx`. Components under
`src/features/tenants-console/`; CSV export follows
`src/features/admin/conversations-export.ts`.

**Charting constraints** (from the `dataviz` skill — these are not optional):

- Pick the form before the color. Daily spend over time → line/area; the KPI row
  → stat tiles, not charts.
- **One y-axis, never two.** Cost and tokens are different scales, so they are
  two charts or indexed — not a dual axis.
- Categorical hues assigned in fixed order and never cycled; colour follows the
  entity, so changing the deployment filter must not repaint the surviving
  series.
- Run `scripts/validate_palette.js` on the chosen palette for **both** light and
  dark before shipping; dark mode is a selected set of steps, not a flip.
- Legend present for ≥2 series; ≤4 series also directly labelled; a table view
  exists (the breakdown tables satisfy this).
- Hover/crosshair tooltip on the time series by default.

**Display rules specific to this data** — these matter more than the chart:

1. **Never sum `fabric-synthesis` and `agent-llm` tokens.** Different models on
   different bills (§4.3). Split every token column by `tokenClass`.
2. **Show notional cost by default**, with `providerReportedCostMicroUsd`
   available beside it; the gap is the plan discount, not an error (§4.2).
3. **Surface `unpricedCount`** — those rows have missing cost, not zero cost.
   A total that silently excludes them is a wrong number.
4. Deployment filter defaults to **prod**; dev is opt-in.
5. Cost is integer micro-USD; format at the edge (`/1e6`), never accumulate in
   floats.
6. State that the ledger starts at deploy time (open item 8) rather than
   implying lifetime totals.

## 9. Testing

- `aiPricing.test.ts` — rate math in micro-USD, cache-token pricing, unknown
  model → zero cost + `unpriced`, no float drift over 10k rows.
- `aiUsageMeter.test.ts` — success/failed/truncated rows; **a throwing recorder
  does not affect the completion returned**; idempotency key stability.
- `aiUsageRollups.test.ts` — folding a day of ledger rows equals a direct scan;
  re-running the fold is idempotent.
- Ingest handler — rejects a bad secret, rejects a self-labelled row, dedupes on
  replay.
- Extend `tenantIsolation.test.ts` — a super-admin query is the *only* way to
  read cross-tenant usage; no tenant-scoped function exposes another tenant's
  rows.
- The existing `processFlowActions.test.ts` end-to-end pipeline test must pass
  unchanged, proving metering is transparent to the pipeline.

## 10. Open items

1. **gpt-5-mini Azure Global Standard rate** — unconfirmed; ships as `unpriced`
   until verified against the Azure OpenAI pricing page.
2. ~~**`metadata.charging` nested shape**~~ — **resolved**, see §4.1a.
3. ~~**Which ElevenLabs plan are we on**~~ — **resolved**: `tier: "pro"`,
   1,238 included minutes/month.
4. ~~**Burst pricing is invisible**~~ — **wrong**: `charging.is_burst` is
   reported, so bursted minutes price correctly (§4.2).
5. **The voice-populated `charging` shape is unverified.** The probed sample was
   `text_only: true`, so `tts_usage.total_audio_output_seconds`,
   `asr_usage.total_audio_input_seconds` and the voice-minutes portion were all
   zero. Unknown: whether `cost` and `cost_fiat` include `call_charge` once
   minutes are actually billed. Re-run the probe against a real voice interview
   and check the parser's `warnings` array — it flags an itemised total that
   exceeds `cost_fiat`, which is exactly what a wrong model would produce.
6. ~~**Foundry cache-token fields**~~ — **resolved.**
   `@anthropic-ai/foundry-sdk` ships no `resources/` of its own and declares
   `@anthropic-ai/sdk` as a peer dependency, so its message type *is*
   `Anthropic.Message` (which is why `anthropicText(message)` type-checks at
   `aiProvider.ts:505`). `usage.cache_creation_input_tokens` and
   `usage.cache_read_input_tokens` are therefore available, typed
   `number | null` — coerce with the existing `asFiniteTokenCount`
   (`aiProvider.ts:321`). On the OpenAI path the equivalent is
   `usage.prompt_tokens_details.cached_tokens` (`number | undefined`); there is
   no cache-*write* charge on that provider, so `cacheWriteTokens` stays 0.
7. **Dev/prod Clerk org id mismatch** — confirm whether the dev deployment uses
   a separate Clerk instance; determines whether dev rows can ever join to prod
   tenants.
8. **No historical backfill.** Past usage exists only as `console.info` lines in
   Convex logs, which are not queryable and expire. The tracker starts at deploy
   time; the page should say so rather than imply totals are lifetime.
9. **Retry undercount** (§2) — optionally close it later by dropping
   `maxRetries` to 0 and retrying in our own loop so each attempt is metered.
   Not in this plan's scope: it changes reliability behaviour that
   `docs/pipeline-reliability-and-scale-plan.md` deliberately tuned.

---

## Sources

- [Tracking Every Token: Granular Cost and Usage Metrics for Microsoft Foundry Agents](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/tracking-every-token-granular-cost-and-usage-metrics-for-microsoft-foundry-agent/4503143)
- [Microsoft Foundry Models quotas and limits](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/quotas-limits?view=foundry-classic)
- [OpenRouter — Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [OpenRouter — Control Costs with the Analytics API](https://openrouter.ai/docs/cookbook/administration/analytics-cost-control)
- [Azure OpenAI Service pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/)
- [Foundry Models sold by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure)
- [ElevenLabs — Get conversation (API reference)](https://elevenlabs.io/docs/api-reference/conversations/get) — the `metadata.charging` model
- [ElevenAgents pricing](https://elevenlabs.io/pricing/agents) — $0.08/min, burst $0.16/min, per-plan included minutes and concurrency
- [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) — Scribe v2 $0.22/hr, add-ons, TTS per-character
- [How much does ElevenAgents cost?](https://help.elevenlabs.io/hc/en-us/articles/29298065878929-How-much-does-ElevenAgents-cost) — connection-duration billing, 95% silence discount, LLM/telephony billed separately
- [ElevenLabs — Optimizing LLM costs](https://elevenlabs.io/docs/eleven-agents/customization/llm/optimizing-costs)
- [ElevenLabs — Calculate expected LLM usage](https://elevenlabs.io/docs/agents-platform/api-reference/llm-usage/calculate)
