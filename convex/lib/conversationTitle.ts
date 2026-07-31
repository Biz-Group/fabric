/**
 * A conversation's one-line title.
 *
 * ElevenLabs post-call analysis returns `call_summary_title` — a short headline
 * for the call — alongside the paragraph `transcript_summary`. We denormalize it
 * onto `conversations.title` so list surfaces can label a row by what was
 * discussed instead of "<input mode> with <contributor>". The voice-recording /
 * audio-upload analysis prompt asks our own model for the same field, so all
 * three input modes populate the column identically.
 *
 * Rows written before the column existed still carry the title inside the
 * opaque `analysis` blob (as do rows copied by the tenant migration, which
 * moves `analysis` verbatim), so read models fall back to extracting it there
 * rather than requiring a backfill.
 */

/** Guards against a model returning a paragraph where a headline was asked for. */
const MAX_TITLE_LENGTH = 120;

/** Trims, collapses whitespace, unwraps quotes, and caps length. */
export function normalizeSummaryTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const cleaned = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned;

  const clipped = cleaned.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/** Reads `call_summary_title` out of a provider analysis payload. */
export function summaryTitleFromAnalysis(analysis: unknown): string | undefined {
  if (!analysis || typeof analysis !== "object") return undefined;
  return normalizeSummaryTitle(
    (analysis as { call_summary_title?: unknown }).call_summary_title,
  );
}

/**
 * The stored title, falling back to the analysis blob for rows written before
 * the column existed. Read models call this so legacy rows are titled too.
 */
export function conversationTitle(conversation: {
  title?: string;
  analysis?: unknown;
}): string | undefined {
  return (
    normalizeSummaryTitle(conversation.title) ??
    summaryTitleFromAnalysis(conversation.analysis)
  );
}
