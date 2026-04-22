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
import { api } from "../../convex/_generated/api";
import type { Id, Doc } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
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
  MessageSquare,
  Mic,
  ChevronRight,
  User,
  Loader2,
  AlertCircle,
  Check,
  ArrowDown,
} from "lucide-react";

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

function getAudioUrl(
  clerkOrgId: string | null | undefined,
  elevenlabsConversationId: string,
): string | null {
  if (!clerkOrgId) return null;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
  const siteUrl = convexUrl.replace(".cloud", ".site");
  return `${siteUrl}/audio/${clerkOrgId}/${elevenlabsConversationId}`;
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
    <div className="flex items-center gap-2">
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
          className="flex-1"
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
          className="flex-1"
        />
      ) : isActive ? (
        <AudioPlayerProgress className="flex-1" />
      ) : (
        <div className="flex h-4 flex-1 items-center">
          <div className="h-[4px] w-full rounded-full bg-muted" />
        </div>
      )}
      <AudioPlayerSpeed speeds={[1, 1.5, 2]} variant="ghost" size="icon" />
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
}: {
  conversationId: Id<"conversations">;
  transcript: TranscriptMessage[];
  contributorName: string;
  audioUrl: string | null;
}) {
  const player = useAudioPlayer();
  const time = useAudioPlayerTime();
  const isActive = player.isItemActive(conversationId);
  const [userToggled, setUserToggled] = useState(false);
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const prevIndexRef = useRef(-1);

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

  // Auto-expand transcript when playback starts
  useEffect(() => {
    if (isActive && player.isPlaying && !userToggled) {
      setOpen(true);
    }
    if (!isActive) {
      setUserToggled(false);
    }
  }, [isActive, player.isPlaying, userToggled]);

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

  return (
    <Collapsible
      open={open}
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
        {/* Fixed-height scrollable container with gradient masks */}
        <div className="relative mt-2 overflow-hidden rounded-lg">
          {/* Top fade */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent" />
          {/* Bottom fade */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-background to-transparent" />

          <div
            ref={scrollRef}
            className="max-h-[240px] overflow-y-auto scroll-smooth py-8 scrollbar-none"
            style={{ scrollbarWidth: "none" }}
          >
            <div className="space-y-1 px-2">
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
                      isCurrent && "bg-primary/10 text-foreground",
                      !isCurrent && msg.role === "ai" && "bg-muted/90",
                      !isCurrent && msg.role !== "ai" && "bg-muted/55",
                      isPast && "opacity-40",
                      isFuture && "opacity-50",
                      !isCurrent && "hover:opacity-80 hover:bg-muted/70"
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "font-medium transition-all duration-300",
                            isCurrent && "text-base",
                            msg.role === "ai"
                              ? "text-primary"
                              : "text-foreground"
                          )}
                        >
                          {msg.role === "ai" ? "Fabric" : contributorName}
                        </span>
                        <span
                          className={cn(
                            "transition-all duration-300",
                            isCurrent
                              ? "font-medium text-foreground"
                              : "text-muted-foreground"
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
  const [cardOutOfView, setCardOutOfView] = useState(false);

  useEffect(() => {
    if (!player.activeItem || !activeCardCtx) {
      setCardOutOfView(false);
      return;
    }

    const cardEl = activeCardCtx.cardRefs.current.get(
      String(player.activeItem.id)
    );
    if (!cardEl) return;

    const observer = new IntersectionObserver(
      ([entry]) => setCardOutOfView(!entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(cardEl);
    return () => observer.disconnect();
  }, [player.activeItem, activeCardCtx]);

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
}: {
  conversation: Doc<"conversations">;
}) {
  const isProcessing = conversation.status === "processing";
  const isFailed = conversation.status === "failed";
  const audioUrl = getAudioUrl(
    conversation.clerkOrgId,
    conversation.elevenlabsConversationId,
  );
  const transcript = conversation.transcript as
    | TranscriptMessage[]
    | undefined;
  const [listened, markListened] = useListenedState(String(conversation._id));
  const activeCardCtx = useContext(ActiveCardContext);

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
        {/* Header: contributor name + date + duration */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <User className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="text-sm font-medium">
              {conversation.contributorName}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {listened && (
              <Check className="h-3 w-3 text-green-500" aria-label="Listened" />
            )}
            <span>{formatDate(conversation._creationTime)}</span>
            {conversation.durationSeconds != null && (
              <>
                <span>·</span>
                <span>{formatDuration(conversation.durationSeconds)}</span>
              </>
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

// --- Player Wrapper (provides card ref context + mini-player) ---

function ConversationListWithPlayer({
  conversations,
}: {
  conversations: Doc<"conversations">[];
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
      <ActiveCardContext.Provider value={ctxValue}>
        <KeyboardShortcuts />
        <div className="mt-3 space-y-3">
          {conversations.map((conv) => (
            <ConversationEntry key={conv._id} conversation={conv} />
          ))}
        </div>
        <StickyMiniPlayer />
      </ActiveCardContext.Provider>
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
        <ConversationListWithPlayer conversations={conversations} />
      )}
    </div>
  );
}
