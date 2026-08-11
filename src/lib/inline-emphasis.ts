/**
 * Bold spans inside generated overview text.
 *
 * The overview generator is allowed to emphasize the load-bearing facts of an
 * executive brief with `**bold**`, and nothing else — no headings, lists, or
 * links. Every surface that shows that text splits it here so the same words
 * come out bold on the web, in the PDF, and in the legacy Markdown projection.
 *
 * Unpaired markers are left alone rather than guessed at: the normalizer that
 * stores the artifact is responsible for not persisting a half-open span.
 */
export type EmphasisRun = { text: string; emphasized: boolean };

// `__bold__` is accepted because the legacy Markdown projection already carried
// it; new generation only ever emits the `**` form.
const EMPHASIS_PATTERN = /\*\*([^*]+)\*\*|__([^_]+)__/g;

export function splitEmphasisRuns(value: string): EmphasisRun[] {
  const runs: EmphasisRun[] = [];
  const pattern = new RegExp(EMPHASIS_PATTERN.source, EMPHASIS_PATTERN.flags);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      runs.push({ text: value.slice(lastIndex, match.index), emphasized: false });
    }
    runs.push({ text: match[1] ?? match[2] ?? "", emphasized: true });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < value.length) {
    runs.push({ text: value.slice(lastIndex), emphasized: false });
  }
  return runs.length > 0 ? runs : [{ text: value, emphasized: false }];
}

/**
 * The same text with its emphasis dropped, for the places that render a bounded
 * plain-text line — previews, tooltips, and titles — where a marker would show
 * as literal asterisks.
 */
export function stripEmphasisMarkers(value: string): string {
  return splitEmphasisRuns(value)
    .map((run) => run.text)
    .join("")
    .replace(/\*\*/g, "");
}
