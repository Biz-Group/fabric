"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  AudioPlayerProvider,
  AudioPlayerButton,
  AudioPlayerProgress,
  AudioPlayerSkipButton,
  AudioPlayerSpeed,
  AudioPlayerTimeToggle,
  useAudioPlayer,
  useAudioPlayerTime,
} from "@/components/ui/audio-player";
import { AudioScrubber } from "@/components/ui/waveform";
import {
  Bot,
  MessageSquare,
  Mic,
  ChevronRight,
  User,
  Loader2,
  AlertCircle,
  Check,
  ArrowDown,
  Download,
  Upload,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SpeakerLabelReview } from "@/features/recording/speaker-label-review";
import { useConversationAudioUrl } from "@/features/conversations/use-conversation-audio-url";

// --- Helpers ---

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatRelativeDate(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${months}mo ago`;
  return `${years}y ago`;
}

// --- localStorage Hooks ---

function useListenedState(id: string) {
  const key = `fabric:listened:${id}`;
  const [listened, setListened] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });

  const markListened = useCallback(() => {
    if (listened) return;
    try {
      localStorage.setItem(key, "1");
    } catch {}
    setListened(true);
  }, [key, listened]);

  return [listened, markListened] as const;
}

function usePlaybackPosition(id: string) {
  const key = `fabric:position:${id}`;
  const lastSaveRef = useRef(0);

  const save = useCallback(
    (time: number) => {
      const now = Date.now();
      if (now - lastSaveRef.current < 5000) return;
      lastSaveRef.current = now;
      try {
        localStorage.setItem(key, String(time));
      } catch {}
    },
    [key]
  );

  const restore = useCallback(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? parseFloat(saved) : null;
    } catch {
      return null;
    }
  }, [key]);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(key);
    } catch {}
  }, [key]);

  return { save, restore, clear };
}

// --- Active Card Ref Context ---

interface ActiveCardContextValue {
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  cardRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
}

const ActiveCardContext = createContext<ActiveCardContextValue | null>(null);

// --- Types ---

interface TranscriptMessage {
  role: string;
  content: string;
  time_in_call_secs: number;
  speakerId?: string;
  speakerName?: string;
}

type ConversationInputMode = Doc<"conversations">["inputMode"];

function getConversationTypeLabel(inputMode: ConversationInputMode) {
  if (inputMode === "voiceRecord") return "Voice Recording";
  if (inputMode === "audioUpload") return "Audio Upload";
  return "AI Interview";
}

function ConversationTypeBadge({
  inputMode,
}: {
  inputMode: ConversationInputMode;
}) {
  const isAgent = (inputMode ?? "agent") === "agent";
  const Icon = inputMode === "audioUpload" ? Upload : isAgent ? Bot : Mic;

  return (
    <Badge variant="secondary" className="gap-1.5">
      <Icon />
      {getConversationTypeLabel(inputMode)}
    </Badge>
  );
}

function transcriptSpeakerName(
  msg: TranscriptMessage,
  contributorName: string,
): string {
  return msg.speakerName ?? (msg.role === "ai" ? "Fabric" : contributorName);
}

// --- PDF Export ---

type PdfFont = "F1" | "F2";

interface PdfLine {
  text: string;
  x: number;
  y: number;
  size: number;
  font: PdfFont;
}

const PDF_PAGE_WIDTH = 612;
const PDF_PAGE_HEIGHT = 792;
const PDF_MARGIN = 54;
const PDF_BODY_SIZE = 10;

const PDF_TEXT_REPLACEMENTS: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2022": "-",
  "\u2026": "...",
  "\u00a0": " ",
};

function normalizeForPdf(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, (char) =>
      PDF_TEXT_REPLACEMENTS[char] ?? ""
    );
}

function estimatePdfTextWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) {
    if (char === " ") width += 0.28;
    else if (/[ilI.,'!:;]/.test(char)) width += 0.28;
    else if (/[mwMW@#%&]/.test(char)) width += 0.82;
    else if (/[A-Z0-9]/.test(char)) width += 0.62;
    else width += 0.5;
  }
  return width * size;
}

function splitLongPdfWord(word: string, maxWidth: number, size: number) {
  const parts: string[] = [];
  let current = "";

  for (const char of word) {
    const candidate = `${current}${char}`;
    if (current && estimatePdfTextWidth(candidate, size) > maxWidth) {
      parts.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }

  if (current) parts.push(current);
  return parts;
}

function wrapPdfText(text: string, maxWidth: number, size: number) {
  const words = text.replace(/[ \t]+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimatePdfTextWidth(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);

    if (estimatePdfTextWidth(word, size) > maxWidth) {
      const parts = splitLongPdfWord(word, maxWidth, size);
      lines.push(...parts.slice(0, -1));
      current = parts[parts.length - 1] ?? "";
    } else {
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function escapePdfString(value: string): string {
  return normalizeForPdf(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function sanitizeFilenamePart(value: string): string {
  return (
    normalizeForPdf(value)
      .trim()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "conversation"
  );
}

function buildConversationPdfPages(
  conversation: Doc<"conversations">,
  transcript: TranscriptMessage[] | undefined
) {
  const pages: PdfLine[][] = [[]];
  let cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;

  const currentPage = () => pages[pages.length - 1];
  const newPage = () => {
    pages.push([]);
    cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
  };

  const addLine = (
    text: string,
    {
      x = PDF_MARGIN,
      size = PDF_BODY_SIZE,
      font = "F1",
      lineHeight = size * 1.35,
      gapBefore = 0,
    }: {
      x?: number;
      size?: number;
      font?: PdfFont;
      lineHeight?: number;
      gapBefore?: number;
    } = {}
  ) => {
    let gap = gapBefore;
    if (cursorY - gap - lineHeight < PDF_MARGIN) {
      newPage();
      gap = 0;
    }

    cursorY -= gap;
    currentPage().push({
      text: normalizeForPdf(text),
      x,
      y: cursorY,
      size,
      font,
    });
    cursorY -= lineHeight;
  };

  const addWrappedText = (
    text: string,
    {
      x = PDF_MARGIN,
      size = PDF_BODY_SIZE,
      font = "F1",
      lineHeight = 14,
      gapBefore = 0,
    }: {
      x?: number;
      size?: number;
      font?: PdfFont;
      lineHeight?: number;
      gapBefore?: number;
    } = {}
  ) => {
    const normalized = normalizeForPdf(text);
    const blocks = normalized.trim() ? normalized.split(/\n{2,}/) : [""];
    const maxWidth = PDF_PAGE_WIDTH - PDF_MARGIN - x;
    let isFirstLine = true;

    for (const block of blocks) {
      const sourceLines = block.split("\n");
      for (const sourceLine of sourceLines) {
        const wrapped = wrapPdfText(sourceLine, maxWidth, size);
        for (const line of wrapped) {
          addLine(line || " ", {
            x,
            size,
            font,
            lineHeight,
            gapBefore: isFirstLine ? gapBefore : 0,
          });
          isFirstLine = false;
        }
      }
      addLine(" ", { x, size, font, lineHeight: 6 });
    }
  };

  const addSectionHeading = (title: string) => {
    addLine(title, { size: 12, font: "F2", lineHeight: 16, gapBefore: 12 });
  };

  addLine("Conversation Export", { size: 18, font: "F2", lineHeight: 24 });
  addLine(`Contributor: ${conversation.contributorName}`, {
    size: 9,
    lineHeight: 12,
    gapBefore: 3,
  });
  // Only on rows filed for someone else. The export leaves the client's hands,
  // so the distinction between subject and submitter has to travel with it.
  if (conversation.submittedByName) {
    addLine(`Submitted by: ${conversation.submittedByName}`, {
      size: 9,
      lineHeight: 12,
    });
  }
  addLine(`Recorded: ${formatDate(conversation._creationTime)}`, {
    size: 9,
    lineHeight: 12,
  });
  if (conversation.durationSeconds != null) {
    addLine(`Duration: ${formatDuration(conversation.durationSeconds)}`, {
      size: 9,
      lineHeight: 12,
    });
  }

  addSectionHeading("Summary");
  addWrappedText(
    conversation.summary?.trim() || "No summary available.",
    { gapBefore: 2 }
  );

  addSectionHeading("Transcript");
  if (!transcript || transcript.length === 0) {
    addWrappedText("No transcript available.", { gapBefore: 2 });
  } else {
    transcript.forEach((msg, index) => {
      const speaker = transcriptSpeakerName(msg, conversation.contributorName);
      addWrappedText(`[${formatDuration(msg.time_in_call_secs)}] ${speaker}`, {
        font: "F2",
        lineHeight: 13,
        gapBefore: index === 0 ? 2 : 8,
      });
      addWrappedText(msg.content, {
        x: PDF_MARGIN + 12,
        lineHeight: 14,
      });
    });
  }

  return pages;
}

function createPdfBlob(pages: PdfLine[][]): Blob {
  const encoder = new TextEncoder();
  const pageObjectIds = pages.map((_, index) => 3 + index * 2);
  const contentObjectIds = pages.map((_, index) => 4 + index * 2);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] /Count ${pages.length} >>`,
  ];

  pages.forEach((page, index) => {
    const content = page
      .map(
        (line) =>
          `BT /${line.font} ${line.size} Tf ${line.x.toFixed(2)} ${line.y.toFixed(
            2
          )} Td (${escapePdfString(line.text)}) Tj ET`
      )
      .join("\n");
    const contentLength = encoder.encode(content).length;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> >> /Contents ${contentObjectIds[index]} 0 R >>`
    );
    objects.push(`<< /Length ${contentLength} >>\nstream\n${content}\nendstream`);
  });

  const chunks: string[] = [];
  const offsets: number[] = [0];
  let byteOffset = 0;
  const append = (chunk: string) => {
    chunks.push(chunk);
    byteOffset += encoder.encode(chunk).length;
  };

  append("%PDF-1.4\n");
  objects.forEach((body, index) => {
    const objectNumber = index + 1;
    offsets[objectNumber] = byteOffset;
    append(`${objectNumber} 0 obj\n${body}\nendobj\n`);
  });

  const xrefOffset = byteOffset;
  append(`xref\n0 ${objects.length + 1}\n`);
  append("0000000000 65535 f \n");
  for (let i = 1; i <= objects.length; i++) {
    append(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  append(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  );

  return new Blob(chunks, { type: "application/pdf" });
}

function downloadConversationPdf(
  conversation: Doc<"conversations">,
  transcript: TranscriptMessage[] | undefined
) {
  const pages = buildConversationPdfPages(conversation, transcript);
  const blob = createPdfBlob(pages);
  const date = new Date(conversation._creationTime).toISOString().slice(0, 10);
  const filename = `${sanitizeFilenamePart(
    conversation.contributorName
  )}-${date}-conversation.pdf`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// --- Waveform Data ---

function useTranscriptWaveform(
  transcript: TranscriptMessage[] | undefined,
  durationSeconds: number | undefined
) {
  return useMemo(() => {
    if (!transcript || !durationSeconds || durationSeconds <= 0) return [];
    const buckets = 60;
    const bucketSize = durationSeconds / buckets;
    // Accumulate speech density per bucket
    const raw = new Array(buckets).fill(0);
    for (const msg of transcript) {
      const idx = Math.min(
        buckets - 1,
        Math.floor(msg.time_in_call_secs / bucketSize)
      );
      raw[idx] += 1 + msg.content.length * 0.005;
    }
    // Normalize to 0-1 range
    const max = Math.max(...raw, 1);
    const normalized = raw.map((v) => v / max);
    // Smooth with neighbors for a natural look
    const smoothed = normalized.map((v, i) => {
      const prev = normalized[i - 1] ?? v;
      const next = normalized[i + 1] ?? v;
      return prev * 0.2 + v * 0.6 + next * 0.2;
    });
    // Map to a comfortable visual range (0.15 – 0.7)
    return smoothed.map((v) => 0.15 + v * 0.55);
  }, [transcript, durationSeconds]);
}

// --- Per-Conversation Audio Controls ---

function ConversationAudioControls({
  conversationId,
  audioUrl,
  durationSeconds,
  transcript,
  contributorName,
  onListened,
}: {
  conversationId: Id<"conversations">;
  audioUrl: string | null;
  durationSeconds?: number;
  transcript?: TranscriptMessage[];
  contributorName: string;
  onListened?: () => void;
}) {
  const player = useAudioPlayer();
  const time = useAudioPlayerTime();
  const isActive = player.isItemActive(conversationId);
  const waveformData = useTranscriptWaveform(transcript, durationSeconds);
  const position = usePlaybackPosition(String(conversationId));
  const restoredRef = useRef(false);
  const listenedRef = useRef(false);

  // The focused playback panel reuses this instance across conversations, so
  // reset the per-conversation flags when the conversation changes — otherwise
  // a prior conversation's "listened" state suppresses tracking for the new one.
  useEffect(() => {
    restoredRef.current = false;
    listenedRef.current = false;
  }, [conversationId]);

  // Save playback position periodically & track listened state
  useEffect(() => {
    if (!isActive) {
      restoredRef.current = false;
      return;
    }
    if (time > 0) position.save(time);
    const dur = player.duration ?? durationSeconds ?? 0;
    if (dur > 0 && time / dur > 0.8 && !listenedRef.current) {
      listenedRef.current = true;
      position.clear();
      onListened?.();
    }
  }, [isActive, time, player.duration, durationSeconds, position, onListened]);

  // Restore saved position when becoming active
  useEffect(() => {
    if (isActive && !restoredRef.current) {
      restoredRef.current = true;
      const saved = position.restore();
      if (saved && saved > 1) {
        player.seek(saved);
      }
    }
  }, [isActive, player, position]);

  const item = useMemo(
    () => ({ id: conversationId, src: audioUrl ?? "", data: { contributorName } }),
    [conversationId, audioUrl, contributorName]
  );

  if (!audioUrl) return null;

  return (
    <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
      <AudioPlayerSkipButton
        seconds={-10}
        variant="ghost"
        size="icon"
        onClick={() => {
          if (!isActive) player.play(item);
        }}
      />
      <AudioPlayerButton
        item={item}
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
      />
      <AudioPlayerSkipButton
        seconds={10}
        variant="ghost"
        size="icon"
        onClick={() => {
          if (!isActive) player.play(item);
        }}
      />
      {isActive && waveformData.length > 0 ? (
        <AudioScrubber
          data={waveformData}
          currentTime={time}
          duration={player.duration ?? durationSeconds ?? 0}
          onSeek={(t) => player.seek(t)}
          height={24}
          barWidth={2}
          barGap={2}
          barRadius={1}
          showHandle={false}
          className="min-w-0 flex-1 overflow-hidden"
        />
      ) : waveformData.length > 0 ? (
        <AudioScrubber
          data={waveformData}
          currentTime={0}
          duration={durationSeconds ?? 1}
          onSeek={(t) => {
            player.play(item).then(() => player.seek(t));
          }}
          height={24}
          barWidth={2}
          barGap={2}
          barRadius={1}
          showHandle={false}
          className="min-w-0 flex-1 overflow-hidden"
        />
      ) : isActive ? (
        <AudioPlayerProgress className="min-w-0 flex-1" />
      ) : (
        <div className="flex h-4 min-w-0 flex-1 items-center overflow-hidden">
          <div className="h-[4px] w-full rounded-full bg-muted" />
        </div>
      )}
      <AudioPlayerSpeed
        speeds={[1, 1.5, 2]}
        variant="ghost"
        size="icon"
        className="shrink-0"
      />
      {isActive ? (
        <AudioPlayerTimeToggle className="shrink-0 text-xs" />
      ) : (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {durationSeconds != null ? formatDuration(durationSeconds) : "--:--"}
        </span>
      )}
    </div>
  );
}

// --- Synced Transcript ---

function SyncedTranscript({
  conversationId,
  transcript,
  contributorName,
  audioUrl,
  expanded = false,
}: {
  conversationId: Id<"conversations">;
  transcript: TranscriptMessage[];
  contributorName: string;
  audioUrl: string | null;
  expanded?: boolean;
}) {
  const player = useAudioPlayer();
  const time = useAudioPlayerTime();
  const isActive = player.isItemActive(conversationId);
  const [userToggled, setUserToggled] = useState(false);
  const [open, setOpen] = useState(expanded);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const prevIndexRef = useRef(-1);
  const autoOpen = !expanded && isActive && player.isPlaying && !userToggled;
  const collapsibleOpen = open || autoOpen;

  // Derive active message index from playback time
  const activeIndex = useMemo(() => {
    if (!isActive || !player.isPlaying) return -1;
    let idx = -1;
    for (let i = 0; i < transcript.length; i++) {
      if (transcript[i].time_in_call_secs <= time) idx = i;
      else break;
    }
    return idx;
  }, [isActive, player.isPlaying, transcript, time]);

  useEffect(() => {
    if (!isActive && userToggled) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setUserToggled(false);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [isActive, userToggled]);

  // Scroll active line to center of the fixed-height container
  useEffect(() => {
    if (activeIndex !== prevIndexRef.current && activeIndex >= 0) {
      prevIndexRef.current = activeIndex;
      const container = scrollRef.current;
      const lineEl = lineRefs.current.get(activeIndex);
      if (container && lineEl) {
        const containerH = container.clientHeight;
        const lineTop = lineEl.offsetTop;
        const lineH = lineEl.offsetHeight;
        const target = lineTop - containerH / 2 + lineH / 2;
        container.scrollTo({ top: target, behavior: "smooth" });
      }
    }
  }, [activeIndex]);

  const transcriptContent = (
    <div className={cn("relative overflow-hidden rounded-lg", expanded && "overflow-visible")}>
      {!expanded && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-background to-transparent" />
        </>
      )}

      <div
        ref={scrollRef}
        className={cn(
          "scroll-smooth scrollbar-none",
          expanded ? "overflow-visible" : "max-h-[240px] overflow-y-auto py-8",
        )}
        style={{ scrollbarWidth: "none" }}
      >
        <div className={cn("space-y-1", expanded ? "px-0" : "px-2")}>
          {transcript.map((msg, i) => {
            const isCurrent = i === activeIndex;
            const isPast = activeIndex >= 0 && i < activeIndex;
            const isFuture = activeIndex >= 0 && i > activeIndex;

            return (
              <div
                key={i}
                ref={(el) => {
                  if (el) lineRefs.current.set(i, el);
                  else lineRefs.current.delete(i);
                }}
                onClick={async () => {
                  if (isActive) {
                    player.seek(msg.time_in_call_secs);
                    if (!player.isPlaying) player.play();
                  } else if (audioUrl) {
                    await player.play({
                      id: conversationId,
                      src: audioUrl,
                      data: { contributorName },
                    });
                    player.seek(msg.time_in_call_secs);
                  }
                }}
                className={cn(
                  "group/msg cursor-pointer rounded-md px-3 py-2 text-sm leading-relaxed transition-all duration-300",
                  isCurrent && "bg-org-accent-selected text-foreground ring-1 ring-org-accent-border",
                  !isCurrent && msg.role === "ai" && "bg-muted/90",
                  !isCurrent && msg.role !== "ai" && "bg-muted/55",
                  isPast && "opacity-40",
                  isFuture && "opacity-50",
                  !isCurrent && "hover:opacity-80 hover:bg-muted/70",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "font-medium transition-all duration-300",
                        isCurrent && "text-base",
                        msg.role === "ai" ? "text-org-accent" : "text-foreground",
                      )}
                    >
                      {transcriptSpeakerName(msg, contributorName)}
                    </span>
                    <span
                      className={cn(
                        "transition-all duration-300",
                        isCurrent
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {" \u2014 "}
                      {msg.content}
                    </span>
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100">
                    {formatDuration(msg.time_in_call_secs)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (expanded) {
    return transcriptContent;
  }

  return (
    <Collapsible
      open={collapsibleOpen}
      onOpenChange={(val) => {
        setOpen(val);
        setUserToggled(true);
      }}
    >
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[panel-open]:rotate-90" />
        Full Transcript
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2">{transcriptContent}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- Keyboard Shortcuts ---

function KeyboardShortcuts() {
  const player = useAudioPlayer();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;
      if (!player.activeItem) return;

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          if (player.isPlaying) player.pause();
          else player.play();
          break;
        case "ArrowLeft":
          e.preventDefault();
          player.seek(
            Math.max(0, (player.ref.current?.currentTime ?? 0) - 5)
          );
          break;
        case "ArrowRight":
          e.preventDefault();
          player.seek(
            Math.min(
              player.duration ?? 0,
              (player.ref.current?.currentTime ?? 0) + 5
            )
          );
          break;
        case "j":
          e.preventDefault();
          player.seek(
            Math.max(0, (player.ref.current?.currentTime ?? 0) - 10)
          );
          break;
        case "l":
          e.preventDefault();
          player.seek(
            Math.min(
              player.duration ?? 0,
              (player.ref.current?.currentTime ?? 0) + 10
            )
          );
          break;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [player]);

  return null;
}

// --- Sticky Mini-Player ---

function StickyMiniPlayer() {
  const player = useAudioPlayer<{ contributorName: string }>();
  const time = useAudioPlayerTime();
  const activeCardCtx = useContext(ActiveCardContext);
  const activeItemId = player.activeItem ? String(player.activeItem.id) : null;
  const [cardVisibility, setCardVisibility] = useState<{
    itemId: string | null;
    outOfView: boolean;
  }>({ itemId: null, outOfView: false });

  useEffect(() => {
    if (!activeItemId || !activeCardCtx) return;

    const cardEl = activeCardCtx.cardRefs.current.get(
      activeItemId
    );
    if (!cardEl) return;

    const observer = new IntersectionObserver(
      ([entry]) =>
        setCardVisibility({
          itemId: activeItemId,
          outOfView: !entry.isIntersecting,
        }),
      { threshold: 0 }
    );
    observer.observe(cardEl);
    return () => observer.disconnect();
  }, [activeItemId, activeCardCtx]);

  const cardOutOfView =
    cardVisibility.itemId === activeItemId && cardVisibility.outOfView;
  if (!player.activeItem || !player.isPlaying || !cardOutOfView) return null;

  const name = player.activeItem.data?.contributorName ?? "Playing";

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 px-4 py-2 shadow-lg backdrop-blur-sm">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <AudioPlayerButton variant="ghost" size="icon" className="h-8 w-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{name}</p>
          <AudioPlayerProgress className="mt-1" />
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {formatDuration(time)}
        </span>
        <button
          type="button"
          onClick={() => {
            const cardEl = activeCardCtx?.cardRefs.current.get(
              String(player.activeItem?.id)
            );
            cardEl?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Scroll to conversation"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// --- Conversation Entry ---

function ConversationEntry({
  conversation,
  canLabelSpeakers,
}: {
  conversation: Doc<"conversations">;
  canLabelSpeakers: boolean;
}) {
  const isProcessing = conversation.status === "processing";
  const isAwaitingSpeakerLabels =
    conversation.status === "needs_speaker_labels";
  const isFailed = conversation.status === "failed";
  const audioUrl = useConversationAudioUrl(
    conversation.clerkOrgId,
    conversation._id,
  );
  const transcript = conversation.transcript as
    | TranscriptMessage[]
    | undefined;
  const [listened, markListened] = useListenedState(String(conversation._id));
  const activeCardCtx = useContext(ActiveCardContext);
  const canExportPdf = Boolean(conversation.summary || transcript?.length);

  return (
    <Card
      ref={(el) =>
        activeCardCtx?.registerRef(String(conversation._id), el)
      }
      className={cn(
        "transition-shadow hover:shadow-md",
        isFailed && "border-destructive/30 opacity-60"
      )}
    >
      <CardContent className="space-y-3">
        {/* Header: contributor name + date */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-org-accent-subtle">
              <User className="h-3.5 w-3.5 text-org-accent" />
            </div>
            <span className="min-w-0 truncate text-sm font-medium">
              {conversation.contributorName}
            </span>
            {/* Present only when an admin filed this on the contributor's
                behalf. The card is headed by the contributor's name, so leaving
                this out would present it as their own submission. */}
            {conversation.submittedByName && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                submitted by {conversation.submittedByName}
              </span>
            )}
            <ConversationTypeBadge inputMode={conversation.inputMode} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {listened && (
              <Check className="h-3 w-3 text-green-500" aria-label="Listened" />
            )}
            <Tooltip>
              <TooltipTrigger
                render={<span />}
                className="cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {formatRelativeDate(conversation._creationTime)}
              </TooltipTrigger>
              <TooltipContent>{formatDate(conversation._creationTime)}</TooltipContent>
            </Tooltip>
            {canExportPdf && (
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  onClick={() => downloadConversationPdf(conversation, transcript)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Export conversation PDF"
                >
                  <Download className="h-3.5 w-3.5" />
                </TooltipTrigger>
                <TooltipContent>Export PDF</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Status: processing */}
        {isProcessing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Processing conversation...
          </div>
        )}

        {isAwaitingSpeakerLabels && (
          <div className="flex items-center gap-2 text-xs text-amber-600">
            <Mic className="h-3 w-3" />
            Speaker labels needed
          </div>
        )}

        {/* Status: failed */}
        {isFailed && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" />
            Processing failed
          </div>
        )}

        {/* AI-generated summary — collapsible, default collapsed */}
        {conversation.summary && (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[panel-open]:rotate-90" />
              Summary
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="mt-2 pl-[18px] text-sm leading-relaxed text-muted-foreground">
                {conversation.summary}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}

        {isAwaitingSpeakerLabels && canLabelSpeakers && (
          <SpeakerLabelReview conversation={conversation} />
        )}

        {isAwaitingSpeakerLabels && !canLabelSpeakers && (
          <p className="text-sm text-muted-foreground">
            Waiting for a contributor to name speakers before analysis runs.
          </p>
        )}

        {/* Audio Player — play/pause + scrub bar + duration */}
        {conversation.status === "done" && (
          <ConversationAudioControls
            conversationId={conversation._id}
            audioUrl={audioUrl}
            durationSeconds={conversation.durationSeconds ?? undefined}
            transcript={transcript}
            contributorName={conversation.contributorName}
            onListened={markListened}
          />
        )}

        {/* Full transcript — synced to audio playback */}
        {transcript && transcript.length > 0 && (
          <SyncedTranscript
            conversationId={conversation._id}
            transcript={transcript}
            contributorName={conversation.contributorName}
            audioUrl={audioUrl}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function FocusedConversationPlayback({
  conversation,
  canLabelSpeakers,
}: {
  conversation: Doc<"conversations">;
  canLabelSpeakers: boolean;
}) {
  const isProcessing = conversation.status === "processing";
  const isAwaitingSpeakerLabels =
    conversation.status === "needs_speaker_labels";
  const isFailed = conversation.status === "failed";
  const isDone = conversation.status === "done";
  const audioUrl = useConversationAudioUrl(
    conversation.clerkOrgId,
    conversation._id,
  );
  const transcript = conversation.transcript as
    | TranscriptMessage[]
    | undefined;
  const [, markListened] = useListenedState(String(conversation._id));
  const canExportPdf = Boolean(conversation.summary || transcript?.length);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const registerRef = useCallback(
    (id: string, el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(id, el);
      else cardRefs.current.delete(id);
    },
    []
  );

  const ctxValue = useMemo(
    () => ({ registerRef, cardRefs }),
    [registerRef]
  );

  return (
    <AudioPlayerProvider>
      <TooltipProvider>
        <ActiveCardContext.Provider value={ctxValue}>
          <KeyboardShortcuts />
          <div
            ref={(el) => registerRef(String(conversation._id), el)}
            className="flex h-full min-h-0 w-full flex-col bg-background"
          >
            <div className="shrink-0 space-y-3 border-b p-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="min-w-0 flex-1">
                  {isDone ? (
                    audioUrl ? (
                      <ConversationAudioControls
                        conversationId={conversation._id}
                        audioUrl={audioUrl}
                        durationSeconds={conversation.durationSeconds ?? undefined}
                        transcript={transcript}
                        contributorName={conversation.contributorName}
                        onListened={markListened}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Audio is loading or unavailable.
                      </p>
                    )
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Playback will be available when processing is complete.
                    </p>
                  )}
                </div>
                {canExportPdf && (
                  <Tooltip>
                    <TooltipTrigger
                      type="button"
                      onClick={() => downloadConversationPdf(conversation, transcript)}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="Export conversation PDF"
                    >
                      <Download className="h-4 w-4" />
                    </TooltipTrigger>
                    <TooltipContent>Export PDF</TooltipContent>
                  </Tooltip>
                )}
              </div>

              {isProcessing && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Processing conversation...
                </div>
              )}

              {isAwaitingSpeakerLabels && (
                <div className="flex items-center gap-2 text-xs text-amber-600">
                  <Mic className="h-3 w-3" />
                  Speaker labels needed
                </div>
              )}

              {isFailed && (
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3 w-3" />
                  Processing failed
                </div>
              )}

            </div>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
              {isAwaitingSpeakerLabels && canLabelSpeakers && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Speaker Labels</h3>
                  <SpeakerLabelReview conversation={conversation} />
                </section>
              )}

              {isAwaitingSpeakerLabels && !canLabelSpeakers && (
                <p className="text-sm text-muted-foreground">
                  Waiting for a contributor to name speakers before analysis runs.
                </p>
              )}

              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Summary</h3>
                {conversation.summary ? (
                  <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    {conversation.summary}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No conversation summary is available yet.
                  </p>
                )}
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">Transcript</h3>
                  {transcript && transcript.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {transcript.length} entries
                    </span>
                  )}
                </div>
                {transcript && transcript.length > 0 ? (
                  <SyncedTranscript
                    conversationId={conversation._id}
                    transcript={transcript}
                    contributorName={conversation.contributorName}
                    audioUrl={audioUrl}
                    expanded
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No transcript is available yet.
                  </p>
                )}
              </section>
            </div>
          </div>
          <StickyMiniPlayer />
        </ActiveCardContext.Provider>
      </TooltipProvider>
    </AudioPlayerProvider>
  );
}

// --- Player Wrapper (provides card ref context + mini-player) ---

export function ConversationListWithPlayer({
  conversations,
  canLabelSpeakers,
}: {
  conversations: Doc<"conversations">[];
  canLabelSpeakers: boolean;
}) {
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const registerRef = useCallback(
    (id: string, el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(id, el);
      else cardRefs.current.delete(id);
    },
    []
  );

  const ctxValue = useMemo(
    () => ({ registerRef, cardRefs }),
    [registerRef]
  );

  return (
    <AudioPlayerProvider>
      <TooltipProvider>
        <ActiveCardContext.Provider value={ctxValue}>
          <KeyboardShortcuts />
          <div className="mt-3 space-y-3">
            {conversations.map((conv) => (
              <ConversationEntry
                key={conv._id}
                conversation={conv}
                canLabelSpeakers={canLabelSpeakers}
              />
            ))}
          </div>
          <StickyMiniPlayer />
        </ActiveCardContext.Provider>
      </TooltipProvider>
    </AudioPlayerProvider>
  );
}

// --- Main Component ---

export function ConversationLog({
  processId,
}: {
  processId: Id<"processes">;
}) {
  const conversations = useQuery(api.conversations.listByProcess, {
    processId,
  });
  const membership = useQuery(api.users.getMyMembership);
  const canLabelSpeakers =
    membership?.role === "admin" || membership?.role === "contributor";

  return (
    <div>
      <div className="flex items-center gap-2 pb-3">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Conversations</h3>
        {conversations && conversations.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {conversations.length}
          </span>
        )}
      </div>
      <Separator />

      {conversations === undefined ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : conversations.length === 0 ? (
        <Card className="mt-3">
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <div className="rounded-xl bg-muted/60 p-3">
              <Mic className="h-6 w-6 text-muted-foreground/70" />
            </div>
            <p className="max-w-[260px] text-center text-sm text-muted-foreground">
              No conversations yet — be the first to record how this process
              works.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ConversationListWithPlayer
          conversations={conversations}
          canLabelSpeakers={canLabelSpeakers}
        />
      )}
    </div>
  );
}
