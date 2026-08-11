import { Fragment } from "react";
import { Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import { splitEmphasisRuns } from "@/lib/inline-emphasis";
import { COLORS } from "./pdf-theme";

type TextStyle = Style | Style[];

// A deliberately small markdown renderer for the rolling process summary.
// It mirrors the subset that markdown-summary.tsx renders on the web:
// `##`/`###` headings, `**bold**`, unordered (`-`/`*`) and ordered (`1.`)
// lists, and paragraphs. Anything fancier degrades gracefully to plain text.
// Emphasis is split by the shared parser the web overview uses, so the same
// words come out bold on screen and in the report.
const parseInline = splitEmphasisRuns;

/**
 * A single paragraph of text with its `**bold**` spans emphasized. Exported
 * because the structured overview brief is one such paragraph and must not
 * print its markers.
 */
export function InlineText({
  text,
  style,
}: {
  text: string;
  style?: TextStyle;
}) {
  return (
    <Text style={style}>
      {parseInline(text).map((run, i) => (
        <Fragment key={i}>
          {run.emphasized ? (
            <Text style={{ fontFamily: "Helvetica-Bold", color: COLORS.ink }}>
              {run.text}
            </Text>
          ) : (
            run.text
          )}
        </Fragment>
      ))}
    </Text>
  );
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", text: heading[1].trim() });
      continue;
    }

    const unordered = trimmed.match(/^[-*•]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "ul") last.items.push(unordered[1].trim());
      else blocks.push({ kind: "ul", items: [unordered[1].trim()] });
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "ol") last.items.push(ordered[1].trim());
      else blocks.push({ kind: "ol", items: [ordered[1].trim()] });
      continue;
    }

    paragraph.push(trimmed);
  }
  flushParagraph();
  return blocks;
}

export function PdfMarkdown({ content }: { content: string }) {
  const blocks = parseBlocks(content);

  return (
    <View>
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          return (
            <Text
              key={i}
              style={{
                fontFamily: "Helvetica-Bold",
                fontSize: 9,
                letterSpacing: 0.8,
                textTransform: "uppercase",
                color: COLORS.ink,
                marginTop: i === 0 ? 0 : 9,
                marginBottom: 3,
              }}
            >
              {block.text}
            </Text>
          );
        }

        if (block.kind === "ul" || block.kind === "ol") {
          const ordered = block.kind === "ol";
          return (
            <View key={i} style={{ marginVertical: 4 }}>
              {block.items.map((item, j) => (
                // Block text (not a flex row) so wrapped lines stack correctly;
                // hanging indent aligns continuation lines under the content.
                <Text
                  key={j}
                  style={{
                    fontSize: 9.5,
                    color: COLORS.body,
                    lineHeight: 1.45,
                    marginBottom: 2.5,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: ordered ? "Helvetica-Bold" : "Helvetica",
                      color: ordered ? COLORS.accent : COLORS.faint,
                    }}
                  >
                    {ordered ? `${j + 1}.  ` : "•  "}
                  </Text>
                  {parseInline(item).map((run, k) =>
                    run.emphasized ? (
                      <Text
                        key={k}
                        style={{ fontFamily: "Helvetica-Bold", color: COLORS.ink }}
                      >
                        {run.text}
                      </Text>
                    ) : (
                      <Text key={k}>{run.text}</Text>
                    ),
                  )}
                </Text>
              ))}
            </View>
          );
        }

        return (
          <InlineText
            key={i}
            text={block.text}
            style={{
              fontSize: 9.5,
              color: COLORS.body,
              lineHeight: 1.55,
              marginBottom: 5,
            }}
          />
        );
      })}
    </View>
  );
}
