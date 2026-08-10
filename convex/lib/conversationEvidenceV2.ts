import type { AIJsonSchema, AIRequest } from "./aiProvider";
import {
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_CAPS,
  SUMMARY_V2_PROMPT_VERSIONS,
  type ProcessSummaryEvidenceV2,
} from "../summaryV2";

export const CONVERSATION_EVIDENCE_V2_OPERATION =
  "conversation-summary-evidence-v2";
export const CONVERSATION_EVIDENCE_V2_TOOL_NAME =
  "return_conversation_evidence";

export type EvidenceTranscriptMessage = {
  role: string;
  content: string;
  speakerName?: string;
};

export type ConversationEvidenceNormalizationMetadata = {
  transcriptHash: string;
  promptVersion: string;
  generatedAt: number;
  provider: string;
  model: string;
};

/**
 * The schema caps are ceilings, not targets, and the model cannot see the token
 * budget that has to hold its answer — so the prompt states the shape of an
 * economical answer in words. Without this, faithful extraction reads the caps
 * as an invitation and writes until it is cut off.
 */
const CONVERSATION_EVIDENCE_V2_SYSTEM_PROMPT = `You extract one contributor's account of a business process into structured evidence for later synthesis.

Faithfulness rules:
- Report only what this contributor said. Do not add standard practice or inferred steps.
- Preserve uncertainty, disagreement, optional paths, and reported variations.
- Keep steps in the order described. If the order is uncertain, state that in the step body.
- Distinguish actors, tools, handoffs/dependencies, variations, friction, and uncertainties.
- Echo the sourceKey from the request exactly.
- Return only the required tool call.

Output budget — the schema limits are ceilings for unusually rich interviews, not targets:
- Merge related actions into one step instead of splitting every sentence. Most accounts need well under ${SUMMARY_V2_CAPS.conversationSteps} steps.
- Keep each step body to one or two sentences of what happened, typically under 200 characters. Do not restate the title or quote the transcript.
- List only distinct items in each array — names and short phrases, not sentences. Most arrays hold a handful of items; empty arrays are valid when evidence is absent.
- Nothing is scored on length. A complete, compact answer is the requirement; a cut-off answer is discarded entirely.`;

/**
 * Appended on the one retry after a truncated first attempt. The transcript
 * genuinely carried more than the budget holds, so this asks for the same
 * evidence at lower resolution rather than repeating a doomed request.
 */
const CONVERSATION_EVIDENCE_V2_CONCISE_SUFFIX = `

Retry after a truncated response: your previous answer exceeded the output budget and was discarded. Return the same evidence more compactly — cover at most ${Math.ceil(
  SUMMARY_V2_CAPS.conversationSteps / 2,
)} steps by merging closely related actions, hold every step body to one sentence, and keep each array to its most significant few items. Losing detail is acceptable; being cut off again is not.`;

export const CONVERSATION_EVIDENCE_V2_SCHEMA: AIJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceKey",
    "steps",
    "actors",
    "tools",
    "handoffsAndDependencies",
    "reportedVariations",
    "frictionPoints",
    "uncertainties",
  ],
  properties: {
    sourceKey: { type: "string", maxLength: 40 },
    steps: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.conversationSteps,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body"],
        properties: {
          title: {
            type: "string",
            maxLength: SUMMARY_V2_CAPS.conversationStepTitleChars,
          },
          body: {
            type: "string",
            maxLength: SUMMARY_V2_CAPS.conversationStepBodyChars,
          },
        },
      },
    },
    actors: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.conversationEvidenceGroup,
      items: {
        type: "string",
        maxLength: SUMMARY_V2_CAPS.conversationEvidenceItemChars,
      },
    },
    tools: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.conversationEvidenceGroup,
      items: {
        type: "string",
        maxLength: SUMMARY_V2_CAPS.conversationEvidenceItemChars,
      },
    },
    handoffsAndDependencies: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.conversationEvidenceGroup,
      items: {
        type: "string",
        maxLength: SUMMARY_V2_CAPS.conversationEvidenceItemChars,
      },
    },
    reportedVariations: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.conversationEvidenceGroup,
      items: {
        type: "string",
        maxLength: SUMMARY_V2_CAPS.conversationEvidenceItemChars,
      },
    },
    frictionPoints: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.conversationEvidenceGroup,
      items: {
        type: "string",
        maxLength: SUMMARY_V2_CAPS.conversationEvidenceItemChars,
      },
    },
    uncertainties: {
      type: "array",
      maxItems: SUMMARY_V2_CAPS.conversationEvidenceGroup,
      items: {
        type: "string",
        maxLength: SUMMARY_V2_CAPS.conversationEvidenceItemChars,
      },
    },
  },
};

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** Stable, opaque prompt key. Never expose a raw Convex document ID to the model. */
export function conversationEvidenceSourceKey(conversationId: string): string {
  return `C-${stableHash(`summary-v2:${conversationId}`)}-${stableHash(
    `${conversationId}:evidence`,
  )}`;
}

export function formatConversationEvidenceTranscript(
  transcript: EvidenceTranscriptMessage[] | null,
  contributorName: string,
): string {
  if (!transcript || transcript.length === 0) return "(No transcript available)";
  return transcript
    .map(
      (message) =>
        `${message.speakerName ?? (message.role === "user" ? contributorName : "Agent")}: ${message.content}`,
    )
    .join("\n");
}

export function buildConversationEvidenceV2Request(args: {
  conversationId: string;
  contributorName: string;
  transcript: EvidenceTranscriptMessage[] | null;
  /** Second attempt after a truncated first one. See the suffix above. */
  concise?: boolean;
}): AIRequest {
  const sourceKey = conversationEvidenceSourceKey(args.conversationId);
  const budget = SUMMARY_V2_AI_BUDGETS.conversationEvidence;
  return {
    capability: "synthesis",
    operation: CONVERSATION_EVIDENCE_V2_OPERATION,
    system: args.concise
      ? `${CONVERSATION_EVIDENCE_V2_SYSTEM_PROMPT}${CONVERSATION_EVIDENCE_V2_CONCISE_SUFFIX}`
      : CONVERSATION_EVIDENCE_V2_SYSTEM_PROMPT,
    user: `Source key: ${sourceKey}\nContributor: ${args.contributorName}\n\nTranscript:\n${formatConversationEvidenceTranscript(
      args.transcript,
      args.contributorName,
    )}`,
    maxTokens: budget.maxTokens,
    timeoutMs: budget.timeoutMs,
    // The retry spends no transport retries of its own. Both attempts share one
    // action, and 2 x (1 + budget.maxRetries) x timeoutMs must stay inside the
    // 10-minute action ceiling: 4 x 120s = 480s does, 6 x 120s = 720s does not.
    // A provider that is failing transport-wise already consumed its retries on
    // the first attempt; the next refresh picks the conversation up again.
    maxRetries: args.concise ? 0 : budget.maxRetries,
    temperature: 0,
    tool: {
      name: CONVERSATION_EVIDENCE_V2_TOOL_NAME,
      description:
        "Return faithful, structured evidence from this single process conversation.",
      inputSchema: CONVERSATION_EVIDENCE_V2_SCHEMA,
    },
  };
}

export function isConversationEvidenceV2Current(
  evidence: ProcessSummaryEvidenceV2 | null | undefined,
  transcriptHash: string,
): boolean {
  return (
    evidence?.transcriptHash === transcriptHash &&
    evidence.promptVersion === SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence
  );
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function normalizeInlineText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxChars).trim() : null;
}

function normalizeBlockText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized ? normalized.slice(0, maxChars).trim() : null;
}

function normalizedSemanticText(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? ""
  );
}

function normalizeStringGroup(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = normalizeInlineText(
      raw,
      SUMMARY_V2_CAPS.conversationEvidenceItemChars,
    );
    if (!item) continue;
    const key = normalizedSemanticText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    values.push(item);
    if (values.length === SUMMARY_V2_CAPS.conversationEvidenceGroup) break;
  }
  return values;
}

/** Validates strict tool output and adds authoritative provenance metadata. */
export function normalizeProcessSummaryEvidenceV2(
  value: unknown,
  expectedSourceKey: string,
  metadata: ConversationEvidenceNormalizationMetadata,
): ProcessSummaryEvidenceV2 | null {
  const raw = asRecord(value);
  if (!raw || raw.sourceKey !== expectedSourceKey || !Array.isArray(raw.steps)) {
    return null;
  }

  const transcriptHash = normalizeInlineText(metadata.transcriptHash, 256);
  const promptVersion = normalizeInlineText(metadata.promptVersion, 120);
  const provider = normalizeInlineText(metadata.provider, 160);
  const model = normalizeInlineText(metadata.model, 200);
  if (
    !transcriptHash ||
    !promptVersion ||
    !provider ||
    !model ||
    !Number.isFinite(metadata.generatedAt)
  ) {
    return null;
  }

  const groups = {
    actors: normalizeStringGroup(raw.actors),
    tools: normalizeStringGroup(raw.tools),
    handoffsAndDependencies: normalizeStringGroup(raw.handoffsAndDependencies),
    reportedVariations: normalizeStringGroup(raw.reportedVariations),
    frictionPoints: normalizeStringGroup(raw.frictionPoints),
    uncertainties: normalizeStringGroup(raw.uncertainties),
  };
  if (Object.values(groups).some((group) => group === null)) return null;

  const steps: ProcessSummaryEvidenceV2["steps"] = [];
  const seenSteps = new Set<string>();
  for (const rawStep of raw.steps) {
    const step = asRecord(rawStep);
    if (!step) continue;
    const title = normalizeInlineText(
      step.title,
      SUMMARY_V2_CAPS.conversationStepTitleChars,
    );
    const body = normalizeBlockText(
      step.body,
      SUMMARY_V2_CAPS.conversationStepBodyChars,
    );
    if (!title || !body) continue;
    const key = normalizedSemanticText(title);
    if (!key || seenSteps.has(key)) continue;
    seenSteps.add(key);
    steps.push({ id: `step-${stableHash(`${key}|${body}`)}`, title, body });
    if (steps.length === SUMMARY_V2_CAPS.conversationSteps) break;
  }

  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    steps,
    actors: groups.actors!,
    tools: groups.tools!,
    handoffsAndDependencies: groups.handoffsAndDependencies!,
    reportedVariations: groups.reportedVariations!,
    frictionPoints: groups.frictionPoints!,
    uncertainties: groups.uncertainties!,
    transcriptHash,
    promptVersion,
    generatedAt: Math.max(0, Math.floor(metadata.generatedAt)),
    provider,
    model,
  };
}
