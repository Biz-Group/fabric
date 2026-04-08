"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

const components: Components = {
  h2: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-xs font-semibold uppercase tracking-wider text-foreground first:mt-0">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="my-1.5 text-sm leading-relaxed text-muted-foreground">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 ml-4 list-disc space-y-1 text-sm text-muted-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-1 text-sm text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="leading-relaxed">{children}</li>
  ),
};

/**
 * Renders a summary string as styled markdown.
 * Falls back gracefully for plain-text summaries (pre-upgrade).
 */
export function MarkdownSummary({ content }: { content: string }) {
  return (
    <div className="max-w-none">
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  );
}
