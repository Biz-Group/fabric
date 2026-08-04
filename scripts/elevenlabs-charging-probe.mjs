// ElevenLabs agent-conversation billing probe.
//
// Prints the `metadata.charging` block from a real conversation so the ledger's
// parser can be written against the actual payload instead of the API reference.
//
// Why this exists: the Get Conversation reference documents `charging`'s members
// (`llm_usage`, `tts_usage`, `asr_usage`, `llm_charge`, `call_charge`,
// `platform_charge`, ...) but NOT their internals — so the field names inside
// `llm_usage`, and whether the `*_charge` integers are credits while `cost_fiat`
// is USD, are unknown from docs alone. Guessing produces a ledger that is
// silently off by whatever the credit-to-dollar ratio is.
//
// This is a read-only GET against a conversation that already exists. It bills
// nothing and changes nothing.
//
// Usage (PowerShell):
//   $env:ELEVENLABS_API_KEY = npx convex env get ELEVENLABS_API_KEY
//   node scripts/elevenlabs-charging-probe.mjs <conversationId>
//
// With no id, it lists recent conversations and probes the newest one:
//   node scripts/elevenlabs-charging-probe.mjs
//
// The transcript and analysis are deliberately NOT printed — only billing
// metadata — so the output is safe to paste into a chat or an issue.

const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "Missing ELEVENLABS_API_KEY.\n" +
      "  PowerShell: $env:ELEVENLABS_API_KEY = npx convex env get ELEVENLABS_API_KEY",
  );
  process.exit(1);
}

const BASE = "https://api.elevenlabs.io/v1/convai/conversations";

async function getJson(url) {
  const response = await fetch(url, { headers: { "xi-api-key": apiKey } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${response.status} ${response.statusText} for ${url}\n${body.slice(0, 400)}`,
    );
  }
  return await response.json();
}

async function newestConversationId() {
  const list = await getJson(BASE);
  const conversations = list.conversations ?? [];
  if (conversations.length === 0) {
    throw new Error(
      "No conversations found on this account. Pass an id explicitly.",
    );
  }
  // The list endpoint returns newest-first; take the first with a duration, so
  // we probe a call that actually ran rather than an abandoned connection.
  const usable =
    conversations.find((c) => (c.call_duration_secs ?? 0) > 0) ??
    conversations[0];
  console.log(
    `No id given — using newest conversation ${usable.conversation_id} ` +
      `(status ${usable.status}, ${usable.call_duration_secs ?? 0}s)\n`,
  );
  return usable.conversation_id;
}

/**
 * Reports the *shape* of a value rather than dumping it, so a large nested
 * object is legible and no transcript text can leak into the output.
 */
function describeShape(value, depth = 0) {
  const pad = "  ".repeat(depth + 1);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[] (empty)";
    return `[${value.length} item(s)] first item:\n${pad}${describeShape(value[0], depth + 1)}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{} (empty)";
    return entries
      .map(([k, v]) => `\n${pad}${k}: ${describeShape(v, depth + 1)}`)
      .join("");
  }
  return `${JSON.stringify(value)}  (${typeof value})`;
}

const conversationId = process.argv[2] ?? (await newestConversationId());
const data = await getJson(`${BASE}/${conversationId}`);
const metadata = data.metadata ?? {};

console.log("=".repeat(72));
console.log(`conversation_id : ${data.conversation_id ?? conversationId}`);
console.log(`status          : ${data.status}`);
console.log(`environment     : ${data.environment ?? "(absent)"}`);
console.log("=".repeat(72));

console.log("\n--- billing scalars on metadata -------------------------------");
for (const field of [
  "call_duration_secs",
  "cost",
  "cost_fiat",
  "start_time_unix_secs",
  "accepted_time_unix_secs",
  "termination_reason",
  "text_only",
]) {
  const present = Object.prototype.hasOwnProperty.call(metadata, field);
  console.log(
    `${field.padEnd(24)}: ${present ? describeShape(metadata[field]) : "(absent)"}`,
  );
}

console.log("\n--- metadata.charging ----------------------------------------");
if (metadata.charging === undefined) {
  console.log("(absent — this account/plan may not itemise, or the call is still processing)");
} else {
  console.log(describeShape(metadata.charging));
}

console.log("\n--- raw metadata.charging JSON -------------------------------");
console.log(JSON.stringify(metadata.charging ?? null, null, 2));

// The arithmetic the ledger depends on: does the itemised split reconcile to the
// totals? If these disagree, the components are in different units (credits vs
// USD) and the parser must convert rather than sum.
const charging = metadata.charging ?? {};
const parts = ["llm_charge", "call_charge", "platform_charge"]
  .map((k) => charging[k])
  .filter((n) => typeof n === "number");
if (parts.length > 0) {
  const sum = parts.reduce((a, b) => a + b, 0);
  console.log("\n--- reconciliation -------------------------------------------");
  console.log(`llm+call+platform : ${sum}`);
  console.log(`metadata.cost     : ${metadata.cost ?? "(absent)"}`);
  console.log(`metadata.cost_fiat: ${metadata.cost_fiat ?? "(absent)"}`);
  console.log(
    sum === metadata.cost
      ? "=> components sum to `cost`, so both are the same unit (credits)."
      : "=> components do NOT sum to `cost`; check units before summing.",
  );
}

console.log("\n--- top-level metadata keys present --------------------------");
console.log(Object.keys(metadata).sort().join(", "));
