// Foundry Claude throughput probe.
//
// Measures sustained generation throughput for the Claude synthesis deployment.
// Originally written to diagnose why process-flow generation timed out; its
// standing job now is to refresh MEASURED_THROUGHPUT in convex/lib/aiProvider.ts,
// which is what every call's token budget is sized against. Re-run it on any
// model or deployment change — the budgets are only as good as these numbers.
//
// It reports, per run:
//   - TTFT (time to first token): mostly queue/scheduling wait. High TTFT with a
//     healthy post-TTFT rate => capacity contention (raising capacity helps).
//   - gen rate (tokens/sec after the first token): the model's actual streaming
//     speed. If THIS is low, more capacity will not help; the deployment
//     tier/region is the constraint.
//   - projected time for the largest single stage (the graph pass).
//
// Usage (PowerShell), with the same env the smoke test uses:
//   $env:FOUNDRY_ENDPOINT = "https://<account>.services.ai.azure.com"
//   $env:FOUNDRY_API_KEY = "<key>"
//   $env:FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude-haiku-4-5"
//   node scripts/foundry-throughput.mjs            # defaults: 4000 tokens, 3 runs, 1 concurrent
//   node scripts/foundry-throughput.mjs 8000 5     # 8000 max tokens, 5 sequential runs
//   node scripts/foundry-throughput.mjs 1500 1 4   # one wave of 4 CONCURRENT probes
//
// Concurrency > 1 approximates several teams generating at once — use it to
// measure how much per-request throughput degrades under load (the WORST
// observed gen rate is what call budgets must be sized against).
// Run it before and after a capacity change to compare.

import AnthropicFoundry from "@anthropic-ai/foundry-sdk";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const endpoint = required("FOUNDRY_ENDPOINT")
  .replace(/\/+$/, "")
  .replace(/\/anthropic$/i, "")
  .replace(/\/openai\/v1$/i, "");
const apiKey = required("FOUNDRY_API_KEY");
const claudeDeployment = required("FOUNDRY_CLAUDE_DEPLOYMENT");

const maxTokens = Number(process.argv[2] ?? 4000);
const runs = Number(process.argv[3] ?? 3);
const concurrency = Number(process.argv[4] ?? 1);

// The largest single call the pipeline now makes: the graph pass, 6144 tokens in
// 210 s (see GRAPH_MAX_TOKENS / GRAPH_TIMEOUT_MS in convex/lib/flowStages.ts).
//
// These were 32768 / 450_000 while flow generation was one giant call. Both are
// gone: no stage asks for anywhere near the cap now, which is the point. Keeping
// the projection pointed at the *current* largest stage is what makes it useful —
// if that stage stops fitting, the budgets need re-sizing.
const FLOW_GENERATION_MAX_TOKENS = 6144;
const FLOW_TIMEOUT_MS = 210_000;

const anthropic = new AnthropicFoundry({
  apiKey,
  baseURL: `${endpoint}/anthropic`,
  maxRetries: 0,
  timeout: FLOW_TIMEOUT_MS,
});

const system =
  "You are a process-analysis assistant that writes detailed, structured output.";
const user =
  "Write a long, detailed description of a generic corporate procurement " +
  "process. Cover every step, every actor, every decision point, common pain " +
  "points, risks, and automation opportunities. Be exhaustive and verbose; " +
  "keep writing until you have produced a very long document.";

async function probe(label) {
  const startedAt = Date.now();
  let firstTokenAt = null;

  const stream = anthropic.messages.stream({
    model: claudeDeployment,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });

  for await (const event of stream) {
    if (
      firstTokenAt === null &&
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta"
    ) {
      firstTokenAt = Date.now();
    }
  }

  const finalMessage = await stream.finalMessage();
  const finishedAt = Date.now();

  const outputTokens = finalMessage.usage?.output_tokens ?? 0;
  const ttftMs = firstTokenAt
    ? firstTokenAt - startedAt
    : finishedAt - startedAt;
  const genMs = firstTokenAt ? finishedAt - firstTokenAt : 0;
  const genRate = genMs > 0 ? outputTokens / (genMs / 1000) : 0;
  const overallRate = outputTokens / ((finishedAt - startedAt) / 1000);

  console.log(
    `${label}: ` +
      `${outputTokens} out tok, ` +
      `TTFT ${ttftMs} ms, ` +
      `gen ${genMs} ms (${genRate.toFixed(1)} tok/s), ` +
      `overall ${overallRate.toFixed(1)} tok/s, ` +
      `stop=${finalMessage.stop_reason}`,
  );

  return { ttftMs, genRate, overallRate, outputTokens };
}

console.log(
  `Probing ${claudeDeployment} @ ${endpoint} — ` +
    `${maxTokens} max tokens, ${runs} wave(s) x ${concurrency} concurrent\n`,
);

const results = [];
for (let wave = 0; wave < runs; wave++) {
  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, (_, i) =>
      probe(`wave ${wave + 1}/${runs} req ${i + 1}/${concurrency}`),
    ),
  );
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      const error = outcome.reason;
      console.error(`wave ${wave + 1}/${runs} req ${i + 1}: FAILED`, {
        name: error?.name,
        status: error?.status,
        message: error?.message,
      });
    }
  }
}

if (results.length > 0) {
  const avg = (key) =>
    results.reduce((sum, r) => sum + r[key], 0) / results.length;
  const avgTtft = avg("ttftMs");
  const avgGenRate = avg("genRate");
  const worstTtft = Math.max(...results.map((r) => r.ttftMs));
  const worstGenRate = Math.min(...results.map((r) => r.genRate));

  console.log("\n--- summary ---");
  console.log(
    `avg TTFT:        ${avgTtft.toFixed(0)} ms (worst ${worstTtft} ms)`,
  );
  console.log(
    `avg gen rate:    ${avgGenRate.toFixed(1)} tok/s (worst ${worstGenRate.toFixed(1)} tok/s)`,
  );
  console.log(`avg overall:     ${avg("overallRate").toFixed(1)} tok/s`);

  // Budgets must be sized against the WORST observed rate/TTFT, not the average.
  if (worstGenRate > 0) {
    const projectedMs =
      worstTtft + (FLOW_GENERATION_MAX_TOKENS / worstGenRate) * 1000;
    console.log(
      `\nProjected worst-case graph pass (${FLOW_GENERATION_MAX_TOKENS} tok @ worst rate): ` +
        `~${(projectedMs / 1000).toFixed(0)} s ` +
        `(${projectedMs <= FLOW_TIMEOUT_MS ? "fits" : "EXCEEDS"} its ` +
        `${FLOW_TIMEOUT_MS / 1000} s timeout).`,
    );
    console.log(
      `Budget rule input: maxTokens <= (timeoutMs - ${worstTtft} TTFT) / 1000 * ` +
        `${worstGenRate.toFixed(1)} tok/s * 0.5 safety.`,
    );
    console.log(
      "Interpretation: high TTFT + healthy gen rate => capacity queuing " +
        "(a capacity raise should help). Low gen rate throughout => the " +
        "deployment tier/region is the limit (capacity will not help).",
    );
  }
}
