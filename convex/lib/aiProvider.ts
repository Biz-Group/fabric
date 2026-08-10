import Anthropic from "@anthropic-ai/sdk";
import AnthropicFoundry from "@anthropic-ai/foundry-sdk";
import OpenAI from "openai";
import { env } from "../_generated/server";

export type AICapability = "synthesis" | "safety";
export type AIProvider = "openrouter" | "foundry-claude" | "foundry-openai";
export type PersistedAIProvider = "fabric-openrouter" | "fabric-foundry";

export const FOUNDRY_CLAUDE_MODEL = "foundry:claude-haiku-4-5@2";
export const FOUNDRY_FALLBACK_MODEL = "foundry:gpt-5-mini@2025-08-07";
export const FOUNDRY_SAFETY_MODEL = "foundry:gpt-5-nano@2025-08-07";
export const OPENROUTER_CLAUDE_MODEL =
  "openrouter:anthropic/claude-haiku-4.5";
export const OPENROUTER_SAFETY_MODEL =
  "openrouter:google/gemma-4-26b-a4b-it";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Measured Foundry throughput for the synthesis deployment. Every call's
 * output budget is sized by TIME against these numbers, because output volume
 * — not capacity — is what has taken production down twice: once by hitting
 * the token cap (truncation), once by hitting the clock (timeout).
 *
 * These are the WORST observed values, not averages. Throughput varied ~1.5x
 * (65-99 tok/s) within a single afternoon, and four concurrent requests cost
 * another 15-20% while leaving TTFT flat.
 *
 * Re-measure on any model or deployment change, and paste the new worst-case
 * numbers here with a fresh `measuredOn`:
 *   npm run foundry:throughput -- 1500 1 4   # maxTokens, waves, concurrency
 */
export const MEASURED_THROUGHPUT = {
  measuredOn: "2026-07-17",
  deployment: "fabric-claude-haiku-4-5",
  /** Slowest post-first-token generation rate seen, under 4x concurrency. */
  worstGenRateTokensPerSecond: 65,
  /** Slowest time-to-first-token seen. */
  worstTtftMs: 4_000,
} as const;

/**
 * Halves the worst-case projection so a call still lands when conditions are
 * worse than anything measured. That is ~2x headroom, not a guarantee — the
 * backstops are retries and the near-miss telemetry in `logSuccess`.
 */
const BUDGET_SAFETY_FACTOR = 0.5;

/** Latency past this share of the timeout is logged as a near miss. */
const NEAR_MISS_TIMEOUT_FRACTION = 0.6;

/**
 * The largest `maxTokens` a request may ask for and still be expected to
 * finish inside `timeoutMs` at the worst measured throughput.
 *
 * This is the budget rule every AI call is meant to satisfy:
 *   maxTokens <= (timeoutMs - worstTtft) / 1000 * worstRate * safetyFactor
 */
export function maxTokensForTimeout(timeoutMs: number): number {
  const generatingMs = timeoutMs - MEASURED_THROUGHPUT.worstTtftMs;
  if (generatingMs <= 0) return 0;
  return Math.floor(
    (generatingMs / 1000) *
      MEASURED_THROUGHPUT.worstGenRateTokensPerSecond *
      BUDGET_SAFETY_FACTOR,
  );
}

/**
 * Inverse of `maxTokensForTimeout`: the smallest timeout that makes a given
 * `maxTokens` compliant. Use it to pick a timeout from a token count rather
 * than guessing one.
 *
 * Remember that the timeout is per attempt: `(1 + maxRetries) * timeoutMs`
 * must still fit inside the 10-minute Convex action ceiling.
 */
export function minTimeoutMsForMaxTokens(maxTokens: number): number {
  const tokensPerSecond =
    MEASURED_THROUGHPUT.worstGenRateTokensPerSecond * BUDGET_SAFETY_FACTOR;
  return Math.ceil(
    MEASURED_THROUGHPUT.worstTtftMs + (maxTokens / tokensPerSecond) * 1000,
  );
}

/** Whether a request's token ask fits its timeout at the worst measured rate. */
export function isWithinTimeBudget(
  maxTokens: number,
  timeoutMs: number,
): boolean {
  return maxTokens <= maxTokensForTimeout(timeoutMs);
}

export type AIJsonSchema = Readonly<Record<string, unknown>> & {
  readonly type: "object";
};

export type AITool = {
  name: string;
  description: string;
  inputSchema: AIJsonSchema;
};

export type AIRequest = {
  capability: AICapability;
  operation: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  tool?: AITool;
};

/**
 * Token counts exactly as the provider reported them — deliberately NOT
 * normalised. This feeds a billing ledger, so raw fidelity matters for auditing
 * against an invoice.
 *
 * The consequence is that `inputTokens` means different things per provider:
 * Anthropic reports three disjoint buckets, while OpenAI folds cached tokens
 * into `prompt_tokens`. `aiPricing.ts` owns that reconciliation via
 * `TokenRate.inputIncludesCached` — do not pre-subtract here.
 */
export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
};

export type AICompletion = {
  provider: AIProvider;
  model: string;
  deployment: string;
  text: string | null;
  toolInput: unknown | null;
  finishReason: string | null;
  usage: AIUsage | null;
  requestId: string | null;
  /**
   * Provider-reported cost in USD, when the provider gives one. OpenRouter
   * does; Foundry does not, so this is undefined there and the ledger prices
   * from `aiPricing.ts` instead.
   */
  costUsd?: number;
};

type ResolvedAIBackend = {
  provider: AIProvider;
  model: string;
  deployment: string;
  endpoint: string;
  apiKey: string;
};

type OpenRouterChoice = {
  finish_reason?: unknown;
  native_finish_reason?: unknown;
  message?: {
    content?: unknown;
    tool_calls?: Array<{
      function?: { name?: unknown; arguments?: unknown };
    }>;
  };
};

type OpenRouterResponse = {
  id?: unknown;
  choices?: OpenRouterChoice[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    // Always returned now; the old `usage: {include: true}` opt-in is a no-op.
    cost?: unknown;
    prompt_tokens_details?: {
      cached_tokens?: unknown;
      cache_write_tokens?: unknown;
    };
  };
};

export class AIConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIConfigurationError";
  }
}

export class AIRequestError extends Error {
  readonly provider: AIProvider;
  readonly status: number | undefined;
  readonly requestId: string | null;

  constructor(
    message: string,
    details: {
      provider: AIProvider;
      status?: number;
      requestId?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = "AIRequestError";
    this.provider = details.provider;
    this.status = details.status;
    this.requestId = details.requestId ?? null;
  }
}

/**
 * Thrown when a completion stopped because it ran out of output tokens.
 * Distinct from `AIRequestError`: the call succeeded, the content is just
 * incomplete — and incomplete content must never be persisted as if it were
 * whole.
 */
export class AITruncationError extends Error {
  readonly operation: string;
  readonly finishReason: string | null;
  readonly maxTokens: number | undefined;

  constructor(
    operation: string,
    finishReason: string | null,
    maxTokens?: number,
  ) {
    super(
      `${operation} hit the AI response token limit ` +
        `(finish_reason: ${finishReason}` +
        `${maxTokens === undefined ? "" : `, maxTokens: ${maxTokens}`}). ` +
        `The response was truncated and was not saved.`,
    );
    this.name = "AITruncationError";
    this.operation = operation;
    this.finishReason = finishReason;
    this.maxTokens = maxTokens;
  }
}

function requireSetting(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new AIConfigurationError(
      `AI is not configured: missing ${name}.`,
    );
  }
  return value.trim();
}

function normalizeEndpoint(value: string): string {
  const endpoint = value.trim().replace(/\/+$/, "");
  return endpoint
    .replace(/\/anthropic$/i, "")
    .replace(/\/openai\/v1$/i, "");
}

function resolveBackend(capability: AICapability): ResolvedAIBackend {
  const provider = env.AI_PROVIDER ?? "openrouter";

  if (provider === "openrouter") {
    const apiKey = requireSetting(
      "OPENROUTER_API_KEY",
      env.OPENROUTER_API_KEY,
    );
    const isSafety = capability === "safety";
    return {
      provider: "openrouter",
      model: isSafety ? OPENROUTER_SAFETY_MODEL : OPENROUTER_CLAUDE_MODEL,
      deployment: isSafety
        ? "google/gemma-4-26b-a4b-it"
        : "anthropic/claude-haiku-4.5",
      endpoint: OPENROUTER_URL,
      apiKey,
    };
  }

  const endpoint = normalizeEndpoint(
    requireSetting("FOUNDRY_ENDPOINT", env.FOUNDRY_ENDPOINT),
  );
  const apiKey = requireSetting("FOUNDRY_API_KEY", env.FOUNDRY_API_KEY);

  if (capability === "safety") {
    return {
      provider: "foundry-openai",
      model: FOUNDRY_SAFETY_MODEL,
      deployment: requireSetting(
        "FOUNDRY_SAFETY_DEPLOYMENT",
        env.FOUNDRY_SAFETY_DEPLOYMENT,
      ),
      endpoint,
      apiKey,
    };
  }

  if ((env.FOUNDRY_SYNTHESIS_BACKEND ?? "claude") === "gpt5mini") {
    return {
      provider: "foundry-openai",
      model: FOUNDRY_FALLBACK_MODEL,
      deployment: requireSetting(
        "FOUNDRY_OPENAI_FALLBACK_DEPLOYMENT",
        env.FOUNDRY_OPENAI_FALLBACK_DEPLOYMENT,
      ),
      endpoint,
      apiKey,
    };
  }

  return {
    provider: "foundry-claude",
    model: FOUNDRY_CLAUDE_MODEL,
    deployment: requireSetting(
      "FOUNDRY_CLAUDE_DEPLOYMENT",
      env.FOUNDRY_CLAUDE_DEPLOYMENT,
    ),
    endpoint,
    apiKey,
  };
}

export function isAIConfigured(capability: AICapability): boolean {
  try {
    resolveBackend(capability);
    return true;
  } catch (error) {
    if (error instanceof AIConfigurationError) return false;
    throw error;
  }
}

export function getPersistedAIProvider(): PersistedAIProvider {
  return (env.AI_PROVIDER ?? "openrouter") === "foundry"
    ? "fabric-foundry"
    : "fabric-openrouter";
}

function asNonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asFiniteTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Unlike token counts, an absent cost and a zero cost are different facts — a
 * free model legitimately reports 0 — so this returns undefined rather than
 * collapsing "not reported" into "free".
 */
function asReportedCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseToolArguments(value: unknown): unknown | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(
      `AI tool arguments contained invalid JSON: ${
        error instanceof Error ? error.message : "unknown parse error"
      }`,
      { cause: error },
    );
  }
}

function requestIdFrom(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return (
    asNonEmptyText(record._request_id) ??
    asNonEmptyText(record.request_id) ??
    asNonEmptyText(record.id)
  );
}

/**
 * Warns when a request asks for more output than its timeout can cover at the
 * worst measured rate. Deliberately a warning, not a throw: several call sites
 * are over budget today and work fine in practice, and failing them closed
 * would take down working features to enforce a projection.
 */
function warnIfOverTimeBudget(request: AIRequest, timeoutMs: number): void {
  if (isWithinTimeBudget(request.maxTokens, timeoutMs)) return;
  console.warn("AI request exceeds its time budget", {
    operation: request.operation,
    maxTokens: request.maxTokens,
    timeoutMs,
    maxTokensAtThisTimeout: maxTokensForTimeout(timeoutMs),
    minTimeoutMsForTheseTokens: minTimeoutMsForMaxTokens(request.maxTokens),
    measuredOn: MEASURED_THROUGHPUT.measuredOn,
  });
}

function logSuccess(
  request: AIRequest,
  completion: AICompletion,
  startedAt: number,
): void {
  const latencyMs = Date.now() - startedAt;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  console.info("AI request completed", {
    operation: request.operation,
    provider: completion.provider,
    model: completion.model,
    deployment: completion.deployment,
    latencyMs,
    finishReason: completion.finishReason,
    inputTokens: completion.usage?.inputTokens,
    outputTokens: completion.usage?.outputTokens,
    requestId: completion.requestId,
  });

  // Near-miss telemetry: a call that succeeded but spent most of its timeout
  // is the early warning that throughput has drifted. It is the difference
  // between noticing a problem in the logs and noticing it in an incident.
  if (latencyMs > timeoutMs * NEAR_MISS_TIMEOUT_FRACTION) {
    const outputTokens = completion.usage?.outputTokens;
    console.warn("AI request latency neared its timeout", {
      operation: request.operation,
      latencyMs,
      timeoutMs,
      usedShareOfTimeout: Number((latencyMs / timeoutMs).toFixed(2)),
      outputTokens,
      observedOverallTokensPerSecond:
        outputTokens === undefined || latencyMs <= 0
          ? undefined
          : Number((outputTokens / (latencyMs / 1000)).toFixed(1)),
      worstMeasuredTokensPerSecond:
        MEASURED_THROUGHPUT.worstGenRateTokensPerSecond,
      requestId: completion.requestId,
    });
  }
}

function errorStatus(error: unknown): number | undefined {
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    return error.status;
  }
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorRequestId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  return requestIdFrom(error);
}

function logFailure(
  request: AIRequest,
  backend: ResolvedAIBackend,
  startedAt: number,
  error: unknown,
): void {
  console.error("AI request failed", {
    operation: request.operation,
    provider: backend.provider,
    model: backend.model,
    deployment: backend.deployment,
    latencyMs: Date.now() - startedAt,
    status: errorStatus(error),
    requestId: errorRequestId(error),
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
}

function anthropicText(message: Anthropic.Message): string | null {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return text || null;
}

function anthropicToolInput(
  message: Anthropic.Message,
  toolName: string | undefined,
): unknown | null {
  const block = message.content.find(
    (item): item is Anthropic.ToolUseBlock =>
      item.type === "tool_use" && (!toolName || item.name === toolName),
  );
  return block?.input ?? null;
}

async function callFoundryClaude(
  backend: ResolvedAIBackend,
  request: AIRequest,
): Promise<AICompletion> {
  const client = new AnthropicFoundry({
    apiKey: backend.apiKey,
    baseURL: `${backend.endpoint}/anthropic`,
    maxRetries: request.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const tools: Anthropic.Tool[] | undefined = request.tool
    ? [
        {
          name: request.tool.name,
          description: request.tool.description,
          input_schema: request.tool.inputSchema as Anthropic.Tool.InputSchema,
        },
      ]
    : undefined;

  const message = await client.messages.create({
    model: backend.deployment,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
    max_tokens: request.maxTokens,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(tools
      ? {
          tools,
          tool_choice: { type: "tool" as const, name: request.tool!.name },
        }
      : {}),
  });

  return {
    provider: backend.provider,
    model: backend.model,
    deployment: backend.deployment,
    text: anthropicText(message),
    toolInput: anthropicToolInput(message, request.tool?.name),
    finishReason: message.stop_reason,
    usage: {
      // Anthropic reports these three as disjoint buckets — `input_tokens`
      // excludes both cache figures. `aiPricing.ts` relies on that.
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cachedReadTokens: asFiniteTokenCount(
        message.usage.cache_read_input_tokens,
      ),
      cacheWriteTokens: asFiniteTokenCount(
        message.usage.cache_creation_input_tokens,
      ),
    },
    requestId: requestIdFrom(message),
  };
}

async function callFoundryOpenAI(
  backend: ResolvedAIBackend,
  request: AIRequest,
): Promise<AICompletion> {
  const client = new OpenAI({
    apiKey: backend.apiKey,
    baseURL: `${backend.endpoint}/openai/v1/`,
    maxRetries: request.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const completion = await client.chat.completions.create({
    model: backend.deployment,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    max_completion_tokens: request.maxTokens,
    reasoning_effort: "minimal",
    ...(request.tool
      ? {
          tools: [
            {
              type: "function" as const,
              function: {
                name: request.tool.name,
                description: request.tool.description,
                parameters: request.tool.inputSchema as Record<string, unknown>,
                strict: true,
              },
            },
          ],
          tool_choice: {
            type: "function" as const,
            function: { name: request.tool.name },
          },
          parallel_tool_calls: false,
        }
      : {}),
  });

  const choice = completion.choices[0];
  const toolCall = choice?.message.tool_calls?.find(
    (item) =>
      item.type === "function" &&
      (!request.tool || item.function.name === request.tool.name),
  );

  return {
    provider: backend.provider,
    model: backend.model,
    deployment: backend.deployment,
    text: asNonEmptyText(choice?.message.content),
    toolInput: parseToolArguments(
      toolCall?.type === "function" ? toolCall.function.arguments : undefined,
    ),
    finishReason: choice?.finish_reason ?? null,
    usage: completion.usage
      ? {
          // OpenAI folds cached tokens INTO prompt_tokens; left as reported,
          // and reconciled by `TokenRate.inputIncludesCached`.
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
          cachedReadTokens: asFiniteTokenCount(
            completion.usage.prompt_tokens_details?.cached_tokens,
          ),
          // Azure's automatic caching has no separate write step to report.
          cacheWriteTokens: 0,
        }
      : null,
    requestId: requestIdFrom(completion),
  };
}

function retryDelayMs(response: Response, retryNumber: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }
  }
  return Math.min(250 * 2 ** retryNumber, 4_000);
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOpenRouter(
  backend: ResolvedAIBackend,
  request: AIRequest,
  body: Record<string, unknown>,
): Promise<Response> {
  let lastError: unknown;
  const maxRetries = request.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(backend.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${backend.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok || !shouldRetry(response.status)) return response;
      lastError = new AIRequestError(
        `OpenRouter request failed with status ${response.status}.`,
        { provider: backend.provider, status: response.status },
      );
      if (attempt < maxRetries) {
        await response.body?.cancel();
        await wait(retryDelayMs(response, attempt));
      }
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await wait(Math.min(250 * 2 ** attempt, 4_000));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error("OpenRouter request failed.");
}

async function callOpenRouter(
  backend: ResolvedAIBackend,
  request: AIRequest,
): Promise<AICompletion> {
  const body: Record<string, unknown> = {
    model: backend.deployment,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    max_tokens: request.maxTokens,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.tool
      ? {
          tools: [
            {
              type: "function",
              function: {
                name: request.tool.name,
                description: request.tool.description,
                parameters: request.tool.inputSchema,
                strict: true,
              },
            },
          ],
          tool_choice: {
            type: "function",
            function: { name: request.tool.name },
          },
        }
      : {}),
  };

  const response = await fetchOpenRouter(backend, request, body);
  if (!response.ok) {
    await response.body?.cancel();
    throw new AIRequestError(
      `OpenRouter request failed with status ${response.status}.`,
      { provider: backend.provider, status: response.status },
    );
  }

  const result = (await response.json()) as OpenRouterResponse;
  const choice = result.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.find(
    (item) =>
      !request.tool || item.function?.name === request.tool.name,
  );
  const finishReason =
    asNonEmptyText(choice?.finish_reason) ??
    asNonEmptyText(choice?.native_finish_reason);

  return {
    provider: backend.provider,
    model: backend.model,
    deployment: backend.deployment,
    text: asNonEmptyText(choice?.message?.content),
    toolInput: parseToolArguments(toolCall?.function?.arguments),
    finishReason,
    usage: result.usage
      ? {
          // OpenAI-shaped: prompt_tokens includes cached_tokens.
          inputTokens: asFiniteTokenCount(result.usage.prompt_tokens),
          outputTokens: asFiniteTokenCount(result.usage.completion_tokens),
          cachedReadTokens: asFiniteTokenCount(
            result.usage.prompt_tokens_details?.cached_tokens,
          ),
          cacheWriteTokens: asFiniteTokenCount(
            result.usage.prompt_tokens_details?.cache_write_tokens,
          ),
        }
      : null,
    // OpenRouter is the one provider that prices the request for us.
    costUsd: asReportedCost(result.usage?.cost),
    requestId: requestIdFrom(result),
  };
}

export async function generateAICompletion(
  request: AIRequest,
): Promise<AICompletion> {
  const backend = resolveBackend(request.capability);
  const startedAt = Date.now();
  warnIfOverTimeBudget(request, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const completion =
      backend.provider === "foundry-claude"
        ? await callFoundryClaude(backend, request)
        : backend.provider === "foundry-openai"
          ? await callFoundryOpenAI(backend, request)
          : await callOpenRouter(backend, request);
    logSuccess(request, completion, startedAt);
    return completion;
  } catch (error) {
    logFailure(request, backend, startedAt, error);
    if (error instanceof AIRequestError) throw error;
    throw new AIRequestError("AI request failed.", {
      provider: backend.provider,
      status: errorStatus(error),
      requestId: errorRequestId(error),
      cause: error,
    });
  }
}

export function isTokenLimitFinishReason(reason: string | null): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  return (
    normalized === "length" ||
    normalized === "max_tokens" ||
    normalized.includes("max_token") ||
    normalized.includes("token_limit")
  );
}

/**
 * Throws `AITruncationError` if the completion was cut off at the token limit.
 *
 * Every synthesis call should run its completion through this before saving.
 * Truncated output is the failure mode that reads as success: valid-looking
 * prose or half a JSON document, persisted silently, discovered later.
 */
export function assertCompletionNotTruncated(
  completion: Pick<AICompletion, "finishReason">,
  operation: string,
  maxTokens?: number,
): void {
  if (!isTokenLimitFinishReason(completion.finishReason)) return;
  throw new AITruncationError(operation, completion.finishReason, maxTokens);
}
