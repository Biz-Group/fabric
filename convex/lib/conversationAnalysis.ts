/**
 * One shape for a conversation's structured analysis, whoever produced it.
 *
 * Fabric analyses its own voice recordings and uploads, and writes a flat
 * `data_collection` object (see `coerceAnalysisPayload` in voiceRecordings.ts).
 * ElevenLabs Conversational AI writes the same fields under
 * `data_collection_results`, but wraps each one in an envelope carrying the
 * extraction's schema and rationale, with the payload at `.value`:
 *
 *   data_collection_results: {
 *     process_steps: { data_collection_id, json_schema, rationale, value }
 *   }
 *
 * Consumers only ever wanted the values. Reading `data_collection` directly —
 * which is what the process-flow graph stage did — meant every agent-mode
 * conversation looked like it carried no structured data at all: a 909-second
 * interview with 16 extracted steps and 10 connections in the envelope was
 * handed to the model as "No structured data available.", and the model
 * answered with a bare start → end graph. This normalizes both shapes to the
 * flat one so that never depends on which input mode recorded the interview.
 */

/** The envelope ElevenLabs wraps each extracted field in. */
type DataCollectionEnvelope = {
  data_collection_id?: unknown;
  value?: unknown;
};

/**
 * ElevenLabs reports "the model found nothing here" in three different ways
 * depending on the declared field type: JSON `null`, the string `"null"`, or an
 * empty string. All three mean absent, and the key is dropped rather than
 * forwarded — a literal `"null"` rendered into a prompt is worse than an
 * omitted field, because the model reads it as content.
 */
function isAbsent(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.toLowerCase() === "null";
}

function unwrapEnvelopes(
  entries: ReadonlyArray<readonly [string, unknown]>,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    if (!key) continue;
    const isEnvelope =
      raw !== null && typeof raw === "object" && "value" in (raw as object);
    const value = isEnvelope ? (raw as DataCollectionEnvelope).value : raw;
    if (isAbsent(value)) continue;
    flat[key] = value;
  }
  return flat;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The flat `data_collection` view of a conversation's analysis, or null when the
 * conversation genuinely carries no structured extraction.
 *
 * Null means "nothing was extracted", never "the shape was unfamiliar" — the
 * distinction matters because callers render the null case as an explicit gap in
 * the evidence they hand to a model.
 */
export function extractDataCollection(
  analysis: unknown,
): Record<string, unknown> | null {
  if (!isPlainObject(analysis)) return null;

  // Fabric-owned analysis (voice recordings, uploads, seed fixtures) is already
  // flat and already coerced. Trust it as-is.
  if (isPlainObject(analysis.data_collection)) {
    return analysis.data_collection;
  }

  // ElevenLabs keyed form — the one every agent conversation actually has.
  if (isPlainObject(analysis.data_collection_results)) {
    const flat = unwrapEnvelopes(
      Object.entries(analysis.data_collection_results),
    );
    if (Object.keys(flat).length > 0) return flat;
  }

  // ElevenLabs list form, keyed by the id each envelope carries. Same payloads;
  // ElevenLabs returns both and has changed which one it populates before.
  if (Array.isArray(analysis.data_collection_results_list)) {
    const flat = unwrapEnvelopes(
      analysis.data_collection_results_list.map((raw) => {
        const envelope = (raw ?? {}) as DataCollectionEnvelope;
        return [
          String(envelope.data_collection_id ?? ""),
          envelope,
        ] as readonly [string, unknown];
      }),
    );
    if (Object.keys(flat).length > 0) return flat;
  }

  return null;
}
